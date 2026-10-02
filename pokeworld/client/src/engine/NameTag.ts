import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

/** Billboard name label (other players). */
export function createNameTag(scene: Scene, text: string, parent: TransformNode, y = 2.25): Mesh {
  const tex = new DynamicTexture(`tag_${text}`, { width: 256, height: 64 }, scene, false);
  const g = tex.getContext() as CanvasRenderingContext2D;
  g.clearRect(0, 0, 256, 64);
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.beginPath();
  g.roundRect(4, 8, 248, 48, 20);
  g.fill();
  g.font = "bold 30px sans-serif";
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text.slice(0, 14), 128, 33);
  tex.hasAlpha = true;
  tex.update();
  const mat = new StandardMaterial(`tagMat_${text}`, scene);
  mat.diffuseTexture = tex;
  mat.emissiveColor = Color3.White();
  mat.disableLighting = true;
  mat.useAlphaFromDiffuseTexture = true;
  mat.backFaceCulling = false;
  const plane = CreatePlane(`tagPlane_${text}`, { width: 1.6, height: 0.4 }, scene);
  plane.material = mat;
  plane.billboardMode = 7;
  plane.parent = parent;
  plane.position.y = y;
  plane.isPickable = false;
  return plane;
}
