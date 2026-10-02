import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Bone } from "@babylonjs/core/Bones/bone";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Scene } from "@babylonjs/core/scene";
import { type MolangContext, type MolangFn, compileMolang } from "./molang";

/**
 * Bedrock entity geometry (*.geo.json) and animations (*.animation.json):
 * the format Blockbench exports and Cobblemon-style packs use. Units are
 * pixels (16 per block). Converted to this engine's space by a 180° turn
 * about Y (Bedrock models face -Z; ours face +Z).
 */

const DEG = Math.PI / 180;
const PX = 1 / 16;

export interface GeoCube {
  origin: [number, number, number];
  size: [number, number, number];
  uv?: [number, number] | Record<string, { uv: [number, number]; uv_size?: [number, number] }>;
  inflate?: number;
  mirror?: boolean;
  pivot?: [number, number, number];
  rotation?: [number, number, number];
}

export interface GeoBone {
  name: string;
  parent?: string;
  pivot?: [number, number, number];
  rotation?: [number, number, number];
  mirror?: boolean;
  cubes?: GeoCube[];
}

export interface BedrockGeometry {
  id: string;
  textureWidth: number;
  textureHeight: number;
  bones: GeoBone[];
}

/** Reads the first geometry of a .geo.json (1.12+ and legacy 1.8 layouts). */
export function parseGeometry(json: unknown): BedrockGeometry {
  const j = json as Record<string, unknown>;
  const list = j["minecraft:geometry"] as Record<string, unknown>[] | undefined;
  if (Array.isArray(list) && list.length) {
    const g = list[0];
    const d = (g.description ?? {}) as Record<string, unknown>;
    return {
      id: String(d.identifier ?? "geometry.unknown"),
      textureWidth: Number(d.texture_width ?? 64),
      textureHeight: Number(d.texture_height ?? 64),
      bones: ((g.bones ?? []) as GeoBone[]).map(normBone),
    };
  }
  // Legacy: { "geometry.x": { texturewidth, bones } }
  const key = Object.keys(j).find((k) => k.startsWith("geometry."));
  if (key) {
    const g = j[key] as Record<string, unknown>;
    return { id: key, textureWidth: Number(g.texturewidth ?? 64), textureHeight: Number(g.textureheight ?? 64), bones: ((g.bones ?? []) as GeoBone[]).map(normBone) };
  }
  throw new Error("not a Bedrock geometry file");
}

function normBone(b: GeoBone): GeoBone {
  return { ...b, name: String(b.name).toLowerCase(), parent: b.parent ? String(b.parent).toLowerCase() : undefined };
}

/** Bedrock -> engine space: 180° about Y. */
const conv = (x: number, y: number, z: number): [number, number, number] => [-x * PX, y * PX, -z * PX];

/** Bedrock euler (degrees, applied X then Y then Z) -> quaternion in engine space. */
export function bedrockRotation(rx: number, ry: number, rz: number, out = new Quaternion()): Quaternion {
  const m = Matrix.RotationX(rx * DEG).multiply(Matrix.RotationY(-ry * DEG)).multiply(Matrix.RotationZ(-rz * DEG));
  return Quaternion.FromRotationMatrixToRef(m, out);
}

interface FaceSpec {
  name: string;
  normal: [number, number, number];
  /** Corners TL, TR, BR, BL as (x?, y?, z?) picks: 0 = min, 1 = max. */
  corners: [number, number, number][];
}

const FACES: FaceSpec[] = [
  { name: "north", normal: [0, 0, -1], corners: [[1, 1, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0]] },
  { name: "south", normal: [0, 0, 1], corners: [[0, 1, 1], [1, 1, 1], [1, 0, 1], [0, 0, 1]] },
  { name: "east", normal: [1, 0, 0], corners: [[1, 1, 1], [1, 1, 0], [1, 0, 0], [1, 0, 1]] },
  { name: "west", normal: [-1, 0, 0], corners: [[0, 1, 0], [0, 1, 1], [0, 0, 1], [0, 0, 0]] },
  { name: "up", normal: [0, 1, 0], corners: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] },
  { name: "down", normal: [0, -1, 0], corners: [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]] },
];

/** Box-UV rectangles (Minecraft layout) for a cube. */
function boxUv(u: number, v: number, w: number, h: number, d: number, mirror: boolean): Record<string, [number, number, number, number]> {
  const east: [number, number, number, number] = [u, v + d, d, h];
  const west: [number, number, number, number] = [u + d + w, v + d, d, h];
  const r: Record<string, [number, number, number, number]> = {
    east: mirror ? west : east,
    north: [u + d, v + d, w, h],
    west: mirror ? east : west,
    south: [u + 2 * d + w, v + d, w, h],
    up: [u + d, v, w, d],
    down: [u + d + w, v + d, w, -d],
  };
  if (mirror) for (const k of Object.keys(r)) r[k] = [r[k][0] + r[k][2], r[k][1], -r[k][2], r[k][3]];
  return r;
}

export interface RigBone {
  name: string;
  index: number;
  parent: number;
  /** Rest offset from the parent pivot (engine space, blocks). */
  offset: Vector3;
  rest: Quaternion;
  restEuler: [number, number, number];
}

export interface BedrockModel {
  geometry: BedrockGeometry;
  /** Hidden source mesh; instances clone it with their own skeleton. */
  mesh: Mesh;
  skeleton: Skeleton;
  bones: RigBone[];
  byName: Map<string, RigBone>;
  /** Model height (blocks) at scale 1, from its bounding box. */
  height: number;
  width: number;
}

/** Builds one skinned mesh for the whole model: one draw call per Pokémon, every bone animates separately. */
export function buildBedrockModel(geo: BedrockGeometry, material: Material, scene: Scene, name: string): BedrockModel {
  const bones: RigBone[] = [];
  const byName = new Map<string, RigBone>();
  const pivots = new Map<string, [number, number, number]>();
  for (const b of geo.bones) pivots.set(b.name, b.pivot ?? [0, 0, 0]);

  // Parents before children
  const ordered: GeoBone[] = [];
  const visit = (b: GeoBone, depth = 0) => {
    if (ordered.includes(b) || depth > 64) return;
    const parent = b.parent ? geo.bones.find((x) => x.name === b.parent) : undefined;
    if (parent) visit(parent, depth + 1);
    ordered.push(b);
  };
  for (const b of geo.bones) visit(b);

  const skeleton = new Skeleton(`${name}_skel`, `${name}_skel`, scene);
  const babylonBones: Bone[] = [];
  for (const b of ordered) {
    const pivot = conv(...(b.pivot ?? [0, 0, 0]));
    const parent = b.parent ? byName.get(b.parent) : undefined;
    const parentPivot = parent ? conv(...(pivots.get(parent.name) ?? [0, 0, 0])) : [0, 0, 0];
    const offset = new Vector3(pivot[0] - parentPivot[0], pivot[1] - parentPivot[1], pivot[2] - parentPivot[2]);
    const restEuler: [number, number, number] = [b.rotation?.[0] ?? 0, b.rotation?.[1] ?? 0, b.rotation?.[2] ?? 0];
    const rb: RigBone = { name: b.name, index: bones.length, parent: parent ? parent.index : -1, offset, rest: bedrockRotation(...restEuler), restEuler };
    bones.push(rb);
    byName.set(b.name, rb);
    const bone = new Bone(b.name, skeleton, parent ? babylonBones[parent.index] : null, Matrix.Translation(offset.x, offset.y, offset.z));
    babylonBones.push(bone);
  }

  const pos: number[] = [];
  const nrm: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const mi: number[] = [];
  const mw: number[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  const tw = geo.textureWidth;
  const th = geo.textureHeight;

  for (const b of ordered) {
    const rb = byName.get(b.name)!;
    for (const c of b.cubes ?? []) {
      const inf = c.inflate ?? 0;
      const [ox, oy, oz] = c.origin;
      const [sx, sy, sz] = c.size;
      const min = [ox - inf, oy - inf, oz - inf];
      const max = [ox + sx + inf, oy + sy + inf, oz + sz + inf];
      const mirror = c.mirror ?? b.mirror ?? false;
      let rects: Record<string, [number, number, number, number] | null>;
      if (Array.isArray(c.uv) || c.uv === undefined) {
        const [u, v] = (c.uv as [number, number]) ?? [0, 0];
        rects = boxUv(u, v, Math.floor(sx), Math.floor(sy), Math.floor(sz), mirror);
      } else {
        rects = {};
        for (const f of FACES) {
          const fu = (c.uv as Record<string, { uv: [number, number]; uv_size?: [number, number] }>)[f.name];
          rects[f.name] = fu ? [fu.uv[0], fu.uv[1], fu.uv_size?.[0] ?? 0, fu.uv_size?.[1] ?? 0] : null;
        }
      }
      // Optional per-cube rotation around its own pivot (Bedrock space)
      const cubeRot = c.rotation && (c.rotation[0] || c.rotation[1] || c.rotation[2]) ? bedrockRotation(c.rotation[0], c.rotation[1], c.rotation[2]) : null;
      const cubePivot = c.pivot ? conv(...c.pivot) : null;
      const bonePivot = conv(...(b.pivot ?? [0, 0, 0]));
      for (const f of FACES) {
        const rect = rects[f.name];
        if (!rect) continue;
        const [ru, rv, rw, rh] = rect;
        if (rw === 0 && rh === 0) continue;
        const base = pos.length / 3;
        const uvCorners: [number, number][] = [
          [ru, rv],
          [ru + rw, rv],
          [ru + rw, rv + rh],
          [ru, rv + rh],
        ];
        let n = new Vector3(...conv(f.normal[0] * 16, f.normal[1] * 16, f.normal[2] * 16));
        if (cubeRot) n = n.applyRotationQuaternion(cubeRot);
        for (let k = 0; k < 4; k++) {
          const cc = f.corners[k];
          let p = new Vector3(...conv(cc[0] ? max[0] : min[0], cc[1] ? max[1] : min[1], cc[2] ? max[2] : min[2]));
          if (cubeRot && cubePivot) {
            const pv = new Vector3(...cubePivot);
            p = p.subtract(pv).applyRotationQuaternion(cubeRot).add(pv);
          }
          pos.push(p.x, p.y, p.z);
          nrm.push(n.x, n.y, n.z);
          uvs.push(uvCorners[k][0] / tw, uvCorners[k][1] / th);
          mi.push(rb.index, 0, 0, 0);
          mw.push(1, 0, 0, 0);
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          void bonePivot;
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }

  const mesh = new Mesh(`${name}_src`, scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nrm;
  vd.uvs = uvs;
  vd.indices = idx;
  vd.matricesIndices = mi;
  vd.matricesWeights = mw;
  vd.applyToMesh(mesh, false);
  mesh.skeleton = skeleton;
  mesh.numBoneInfluencers = 1;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.setEnabled(false);
  return {
    geometry: geo,
    mesh,
    skeleton,
    bones,
    byName,
    height: Number.isFinite(maxY) ? maxY - Math.min(0, minY) : 1,
    width: Number.isFinite(maxX) ? maxX - minX : 1,
  };
}

// ---------------------------------------------------------------- animations

type Vec3Src = [number | string, number | string, number | string] | number | string;
interface KeyframeRaw {
  pre?: Vec3Src;
  post?: Vec3Src;
  lerp_mode?: string;
}

interface Channel {
  /** Constant expression vector, or keyframes. */
  constant?: [MolangFn, MolangFn, MolangFn];
  keys?: { t: number; pre: [MolangFn, MolangFn, MolangFn]; post: [MolangFn, MolangFn, MolangFn]; smooth: boolean }[];
}

export interface BoneTrack {
  rotation?: Channel;
  position?: Channel;
  scale?: Channel;
}

export interface BedrockAnimation {
  name: string;
  loop: boolean | "hold_on_last_frame";
  length: number;
  bones: Map<string, BoneTrack>;
}

function vec(src: Vec3Src): [MolangFn, MolangFn, MolangFn] {
  if (Array.isArray(src)) return [compileMolang(src[0] ?? 0), compileMolang(src[1] ?? 0), compileMolang(src[2] ?? 0)];
  const f = compileMolang(src);
  return [f, f, f];
}

function channel(raw: unknown): Channel | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw) || typeof raw === "number" || typeof raw === "string") return { constant: vec(raw as Vec3Src) };
  if (typeof raw === "object") {
    const keys = Object.entries(raw as Record<string, unknown>)
      .map(([t, v]) => {
        let pre: Vec3Src;
        let post: Vec3Src;
        let smooth = false;
        if (Array.isArray(v) || typeof v !== "object") pre = post = v as Vec3Src;
        else {
          const k = v as KeyframeRaw;
          pre = (k.pre ?? k.post ?? [0, 0, 0]) as Vec3Src;
          post = (k.post ?? k.pre ?? [0, 0, 0]) as Vec3Src;
          smooth = k.lerp_mode === "catmullrom";
        }
        return { t: parseFloat(t), pre: vec(pre), post: vec(post), smooth };
      })
      .filter((k) => Number.isFinite(k.t))
      .sort((a, b) => a.t - b.t);
    if (keys.length) return { keys };
  }
  return undefined;
}

/** Reads every animation of a .animation.json file. */
export function parseAnimations(json: unknown): Map<string, BedrockAnimation> {
  const out = new Map<string, BedrockAnimation>();
  const anims = ((json as Record<string, unknown>).animations ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, a] of Object.entries(anims)) {
    const bones = new Map<string, BoneTrack>();
    for (const [bone, t] of Object.entries((a.bones ?? {}) as Record<string, Record<string, unknown>>)) {
      bones.set(bone.toLowerCase(), { rotation: channel(t.rotation), position: channel(t.position), scale: channel(t.scale) });
    }
    let length = Number(a.animation_length ?? 0);
    if (!length)
      for (const t of bones.values())
        for (const c of [t.rotation, t.position, t.scale]) if (c?.keys?.length) length = Math.max(length, c.keys[c.keys.length - 1].t);
    out.set(name, { name, loop: a.loop === "hold_on_last_frame" ? "hold_on_last_frame" : a.loop === true || a.loop === "true", length: length || 1, bones });
  }
  return out;
}

const tmp: [number, number, number] = [0, 0, 0];

function evalVec(f: [MolangFn, MolangFn, MolangFn], ctx: MolangContext, out: [number, number, number]): void {
  out[0] = f[0](ctx);
  out[1] = f[1](ctx);
  out[2] = f[2](ctx);
}

/** Samples a channel at time t into `out`. Returns false if the channel is absent. */
export function sampleChannel(ch: Channel | undefined, t: number, ctx: MolangContext, out: [number, number, number]): boolean {
  if (!ch) return false;
  if (ch.constant) {
    evalVec(ch.constant, ctx, out);
    return true;
  }
  const keys = ch.keys!;
  if (t <= keys[0].t) {
    evalVec(keys[0].pre, ctx, out);
    return true;
  }
  const last = keys[keys.length - 1];
  if (t >= last.t) {
    evalVec(last.post, ctx, out);
    return true;
  }
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  evalVec(a.post, ctx, out);
  evalVec(b.pre, ctx, tmp);
  if (a.smooth || b.smooth) {
    // Catmull-Rom through the neighbouring keys
    const p0: [number, number, number] = [0, 0, 0];
    const p3: [number, number, number] = [0, 0, 0];
    evalVec((keys[i - 1] ?? a).post, ctx, p0);
    evalVec((keys[i + 2] ?? b).pre, ctx, p3);
    const k2 = k * k;
    const k3 = k2 * k;
    for (let j = 0; j < 3; j++) {
      const p1 = out[j];
      const p2 = tmp[j];
      out[j] = 0.5 * (2 * p1 + (-p0[j] + p2) * k + (2 * p0[j] - 5 * p1 + 4 * p2 - p3[j]) * k2 + (-p0[j] + 3 * p1 - 3 * p2 + p3[j]) * k3);
    }
  } else for (let j = 0; j < 3; j++) out[j] = out[j] + (tmp[j] - out[j]) * k;
  return true;
}

/** Converts a Bedrock animation position offset (pixels) to engine space (blocks). */
export function convertOffset(p: [number, number, number], out: Vector3): Vector3 {
  out.set(-p[0] * PX, p[1] * PX, -p[2] * PX);
  return out;
}
