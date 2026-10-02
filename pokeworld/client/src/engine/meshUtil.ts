import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Scene } from "@babylonjs/core/scene";

/** Box with baked vertex colours and simple per-face shading (voxel look, no textures). */
export function coloredBox(name: string, size: [number, number, number], color: string | Color3, scene: Scene): Mesh {
  const box = CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene);
  const c = typeof color === "string" ? Color3.FromHexString(color) : color;
  const normals = box.getVerticesData("normal")!;
  const count = normals.length / 3;
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const nx = normals[i * 3];
    const ny = normals[i * 3 + 1];
    const shade = ny > 0.5 ? 1.08 : ny < -0.5 ? 0.62 : Math.abs(nx) > 0.5 ? 0.86 : 0.94;
    colors[i * 4] = Math.min(1, c.r * shade);
    colors[i * 4 + 1] = Math.min(1, c.g * shade);
    colors[i * 4 + 2] = Math.min(1, c.b * shade);
    colors[i * 4 + 3] = 1;
  }
  box.setVerticesData("color", colors, false, 4);
  box.isPickable = false;
  return box;
}
