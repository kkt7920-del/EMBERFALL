import type { Material } from "@babylonjs/core/Materials/material";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { lerp } from "@shared/math/vec";
import type { AnimState } from "@shared/types/game";
import { coloredBox } from "./meshUtil";

export interface AvatarLook {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
}

export type AvatarPose = AnimState | "sit" | "throw" | "talk";

/** Blocky humanoid used for the player, other players and NPCs. Procedurally animated. */
export class Avatar {
  readonly root: TransformNode;
  private readonly body: TransformNode;
  private readonly head: TransformNode;
  private readonly armL: TransformNode;
  private readonly armR: TransformNode;
  private readonly legL: TransformNode;
  private readonly legR: TransformNode;
  private readonly meshes: Mesh[] = [];
  pose: AvatarPose = "idle";
  private t = Math.random() * 10;
  private throwT = 0;

  constructor(scene: Scene, material: Material, look: AvatarLook, name = "avatar") {
    this.root = new TransformNode(name, scene);
    this.body = new TransformNode(`${name}_body`, scene);
    this.body.parent = this.root;
    this.body.position.y = 0.76;

    const part = (n: string, size: [number, number, number], color: string, parent: TransformNode, y: number, x = 0, z = 0) => {
      const m = coloredBox(`${name}_${n}`, size, color, scene);
      m.material = material;
      m.parent = parent;
      m.position.set(x, y, z);
      this.meshes.push(m);
      return m;
    };

    part("torso", [0.52, 0.66, 0.3], look.shirt, this.body, 0.35);
    this.head = new TransformNode(`${name}_head`, scene);
    this.head.parent = this.body;
    this.head.position.y = 0.68;
    part("face", [0.46, 0.44, 0.42], look.skin, this.head, 0.2);
    part("hair", [0.5, 0.14, 0.46], look.hair, this.head, 0.45);
    part("hairBack", [0.5, 0.3, 0.1], look.hair, this.head, 0.3, 0, -0.2);
    part("eyeL", [0.07, 0.08, 0.02], "#1d1d24", this.head, 0.22, -0.1, 0.215);
    part("eyeR", [0.07, 0.08, 0.02], "#1d1d24", this.head, 0.22, 0.1, 0.215);

    const limb = (n: string, x: number, y: number, size: [number, number, number], color: string, parent: TransformNode, drop: number, hand?: string) => {
      const pivot = new TransformNode(`${name}_${n}`, scene);
      pivot.parent = parent;
      pivot.position.set(x, y, 0);
      part(`${n}m`, size, color, pivot, -drop);
      if (hand) part(`${n}h`, [size[0] * 0.95, 0.14, size[2] * 0.95], hand, pivot, -drop * 2 + 0.07);
      return pivot;
    };
    this.armL = limb("armL", -0.36, 0.64, [0.17, 0.56, 0.17], look.shirt, this.body, 0.26, look.skin);
    this.armR = limb("armR", 0.36, 0.64, [0.17, 0.56, 0.17], look.shirt, this.body, 0.26, look.skin);
    this.legL = limb("legL", -0.13, 0.02, [0.2, 0.74, 0.22], look.pants, this.body, 0.37);
    this.legR = limb("legR", 0.13, 0.02, [0.2, 0.74, 0.22], look.pants, this.body, 0.37);
  }

  allMeshes(): Mesh[] {
    return this.meshes;
  }

  setEnabled(on: boolean): void {
    this.root.setEnabled(on);
  }

  playThrow(): void {
    this.throwT = 0.5;
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    let swing = 0;
    let freq = 0;
    let armRaise = 0;
    let bob = 0;
    let lean = 0;
    let legsForward = 0;

    switch (this.pose) {
      case "walk":
        freq = 8.5;
        swing = 0.6;
        bob = 0.04;
        break;
      case "run":
        freq = 12.5;
        swing = 0.95;
        bob = 0.08;
        lean = 0.15;
        break;
      case "swim":
        freq = 4;
        swing = 0.4;
        armRaise = 1.2;
        lean = 1.1;
        break;
      case "jump":
        armRaise = 2.4;
        swing = 0.2;
        freq = 2;
        break;
      case "sit":
      case "fly":
        legsForward = 1.45;
        armRaise = 0.3;
        break;
      case "talk":
        freq = 3;
        swing = 0.08;
        break;
      default:
        freq = 2;
        swing = 0.03;
        bob = 0.012;
    }

    const s = Math.sin(t * freq) * swing;
    this.legL.rotation.x = legsForward ? -legsForward : s;
    this.legR.rotation.x = legsForward ? -legsForward : -s;
    this.legL.rotation.z = legsForward ? -0.2 : 0;
    this.legR.rotation.z = legsForward ? 0.2 : 0;
    this.armL.rotation.x = -s * 0.9 - armRaise;
    this.armR.rotation.x = s * 0.9 - armRaise;
    if (this.pose === "swim") {
      this.armL.rotation.x = -armRaise + Math.sin(t * freq) * 1.2;
      this.armR.rotation.x = -armRaise + Math.sin(t * freq + Math.PI) * 1.2;
    }
    if (this.throwT > 0) {
      this.throwT -= dt;
      const p = 1 - this.throwT / 0.5;
      this.armR.rotation.x = p < 0.4 ? lerp(0, 2.6, p / 0.4) * -1 : lerp(-2.6, 0.6, (p - 0.4) / 0.6);
    }
    this.body.position.y = 0.76 + Math.abs(Math.sin(t * freq)) * bob;
    this.body.rotation.x = lean;
    this.head.rotation.x = this.pose === "swim" ? -0.9 : 0;
  }

  dispose(): void {
    this.root.dispose(false, false);
  }
}
