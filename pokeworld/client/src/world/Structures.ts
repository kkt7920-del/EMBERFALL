import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { RegionDef } from "@shared/types/content";
import { OVERWORLD, caveZoneId } from "@shared/world/terrain";
import { coloredBox } from "../engine/meshUtil";
import type { ClientTerrain } from "./ClientTerrain";

const SIGN_COLOR: Record<string, string> = { center: "#e84a4a", shop: "#3a7ae0", lab: "#3fae5a", house: "#c8a070" };

/**
 * Hand-placed details on top of the voxel terrain: doors, windows and signs
 * on buildings, the cave mouth, the cave ceiling, glowing ruin objects.
 * Built per zone and merged into a few static meshes.
 */
export class Structures {
  private meshes: Mesh[] = [];
  private readonly mat: StandardMaterial;
  private readonly glowMat: StandardMaterial;
  private glowMeshes: Mesh[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly region: RegionDef,
    private readonly terrain: ClientTerrain,
  ) {
    this.mat = new StandardMaterial("structMat", scene);
    this.mat.specularColor = Color3.Black();
    this.glowMat = new StandardMaterial("glowMat", scene);
    this.glowMat.emissiveColor = new Color3(0.45, 0.9, 1);
    this.glowMat.diffuseColor = new Color3(0.4, 0.8, 1);
    this.glowMat.alpha = 0.85;
  }

  build(zone: string): void {
    this.dispose();
    const parts: Mesh[] = [];
    const box = (size: [number, number, number], color: string, x: number, y: number, z: number, rotY = 0) => {
      const m = coloredBox("s", size, color, this.scene);
      m.position.set(x, y, z);
      m.rotation.y = rotY;
      parts.push(m);
      return m;
    };

    if (zone === OVERWORLD) {
      const town = this.region.town;
      for (const b of this.region.buildings) {
        const base = Math.round(town.height);
        const facing = { n: [0, 1], s: [0, -1], e: [1, 0], w: [-1, 0] }[b.door] as [number, number];
        const half = facing[0] !== 0 ? b.w / 2 : b.d / 2;
        const dx = b.x + facing[0] * (half + 0.06) - (facing[0] !== 0 ? 0 : 0.5);
        const dz = b.z + facing[1] * (half + 0.06) - (facing[1] !== 0 ? 0 : 0.5);
        const rot = facing[0] !== 0 ? Math.PI / 2 : 0;
        // Door + frame
        box([1.6, 2.5, 0.12], "#5a3a22", dx, base + 1.25, dz, rot);
        box([2.0, 0.25, 0.16], "#e8dcc4", dx, base + 2.6, dz, rot);
        // Sign above the door
        box([2.6, 0.9, 0.14], SIGN_COLOR[b.kind], dx, base + Math.min(b.h - 0.9, 3.6), dz, rot);
        // Windows along the door side
        const span = facing[0] !== 0 ? b.d : b.w;
        for (const off of [-span / 2 + 1.6, span / 2 - 1.6]) {
          const wx = facing[0] !== 0 ? dx : dx + off;
          const wz = facing[1] !== 0 ? dz : dz + off;
          box([1.3, 1.1, 0.1], "#9cc8f0", wx, base + 1.9, wz, rot);
        }
      }

      for (const cave of this.region.caves) {
        const f = this.terrain.world.overworld.caveFacing(cave);
        const base = this.terrain.height(OVERWORLD, cave.entrance.x + f.x * 2, cave.entrance.z + f.z * 2);
        // Dark mouth at the back of the corridor
        const portal = CreatePlane("cavePortal", { width: 3, height: 4.5 }, this.scene);
        const pm = new StandardMaterial("portalMat", this.scene);
        pm.diffuseColor = Color3.Black();
        pm.emissiveColor = new Color3(0.02, 0.02, 0.04);
        pm.specularColor = Color3.Black();
        pm.backFaceCulling = false;
        portal.material = pm;
        portal.position.set(cave.entrance.x + 0.5 - f.x * 1.45, base + 2.25, cave.entrance.z + 0.5 - f.z * 1.45);
        portal.rotation.y = Math.atan2(f.x, f.z);
        this.meshes.push(portal);
      }

      for (const it of this.region.interactables) {
        if (it.zone && it.zone !== OVERWORLD) continue;
        const h = this.terrain.height(OVERWORLD, it.x, it.z);
        if (it.kind === "tablet") this.glow([0.9, 0.18, 0.12], it.x + 0.5, h - 0.6, it.z - 0.06 + 0.5);
        if (it.kind === "altar") this.glow([0.8, 0.12, 0.8], it.x + 0.5, h + 0.07, it.z + 0.5);
        if (it.kind === "sign") {
          const g = this.terrain.height(OVERWORLD, it.x, it.z);
          box([0.2, 1.2, 0.2], "#7a5a3a", it.x, g + 0.6, it.z);
          box([1.4, 0.8, 0.12], "#c8a070", it.x, g + 1.4, it.z);
        }
      }
    } else {
      const cave = this.region.caves.find((c) => caveZoneId(c.id) === zone);
      if (cave) {
        const ceiling = this.terrain.ceiling(zone) ?? 26;
        const roof = CreatePlane("caveCeiling", { size: cave.size + 20 }, this.scene);
        roof.rotation.x = -Math.PI / 2;
        roof.position.set(cave.size / 2, ceiling, cave.size / 2);
        const rm = new StandardMaterial("ceilMat", this.scene);
        rm.diffuseColor = new Color3(0.16, 0.14, 0.2);
        rm.specularColor = Color3.Black();
        rm.backFaceCulling = false;
        roof.material = rm;
        this.meshes.push(roof);
        for (const it of this.region.interactables) {
          if (it.zone !== zone) continue;
          const g = this.terrain.height(zone, it.x, it.z);
          if (it.kind === "crystal") this.glow([0.9, 1.8, 0.9], it.x + 0.5, g + 0.9, it.z + 0.5);
          if (it.kind === "cave_exit") {
            const shaft = CreatePlane("exitLight", { width: 3, height: 5 }, this.scene);
            const sm = new StandardMaterial("exitMat", this.scene);
            sm.emissiveColor = new Color3(1, 0.95, 0.75);
            sm.disableLighting = true;
            sm.alpha = 0.55;
            sm.backFaceCulling = false;
            shaft.material = sm;
            shaft.position.set(it.x + 0.5, g + 2.5, it.z - 1);
            this.meshes.push(shaft);
          }
        }
      }
    }

    if (parts.length) {
      const merged = Mesh.MergeMeshes(parts, true, true);
      if (merged) {
        merged.material = this.mat;
        merged.isPickable = false;
        merged.freezeWorldMatrix();
        this.meshes.push(merged);
      }
    }
  }

  private glow(size: [number, number, number], x: number, y: number, z: number): void {
    const m = coloredBox("glow", size, "#8ae0f0", this.scene);
    m.material = this.glowMat;
    m.position.set(x, y, z);
    this.glowMeshes.push(m);
    this.meshes.push(m);
  }

  update(t: number): void {
    const pulse = 0.55 + Math.sin(t * 2.4) * 0.35;
    this.glowMat.emissiveColor = new Color3(0.3 * pulse + 0.1, 0.75 * pulse + 0.15, pulse + 0.1);
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose();
    this.meshes = [];
    this.glowMeshes = [];
  }
}
