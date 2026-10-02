import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import { ATLAS_COLUMNS } from "@shared/world/blocks";
import { paintAtlas } from "./Atlas";

const C = ATLAS_COLUMNS.toFixed(1);

/**
 * Texture-atlas tiling for greedy-meshed voxel faces. Each vertex carries
 * (u, v, tile); u/v are in metres so one atlas cell repeats per block via
 * fract(), even across a 20 m merged quad. Works on WebGL2 (GLSL) and WebGPU (WGSL).
 */
class AtlasPlugin extends MaterialPluginBase {
  constructor(
    material: StandardMaterial,
    private readonly atlas: BaseTexture,
  ) {
    super(material, "AtlasPlugin", 200, { ATLAS_TILING: false });
    this._enable(true);
  }

  override getClassName(): string {
    return "AtlasPlugin";
  }

  override isCompatible(lang: ShaderLanguage): boolean {
    return lang === ShaderLanguage.GLSL || lang === ShaderLanguage.WGSL;
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines.ATLAS_TILING = true;
  }

  override getAttributes(attributes: string[]): void {
    attributes.push("atlasData");
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("atlasSampler");
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine): void {
    ubo.setTexture("atlasSampler", this.atlas);
  }

  override getCustomCode(shaderType: string, lang?: ShaderLanguage): { [point: string]: string } | null {
    if (lang === ShaderLanguage.WGSL) {
      if (shaderType === "vertex")
        return {
          CUSTOM_VERTEX_DEFINITIONS: "attribute atlasData: vec3f;\nvarying vAtlasData: vec3f;",
          CUSTOM_VERTEX_MAIN_END: "vertexOutputs.vAtlasData = input.atlasData;",
        };
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: "varying vAtlasData: vec3f;\nvar atlasSamplerSampler: sampler;\nvar atlasSampler: texture_2d<f32>;",
        CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `{
          let tile = floor(fragmentInputs.vAtlasData.z + 0.5);
          let cell = vec2f(tile - ${C} * floor(tile / ${C}), ${C} - 1.0 - floor(tile / ${C}));
          let f = clamp(fract(fragmentInputs.vAtlasData.xy), vec2f(0.002), vec2f(0.998));
          let texel = textureSample(atlasSampler, atlasSamplerSampler, (cell + f) / ${C});
          baseColor = vec4f(baseColor.rgb * texel.rgb, baseColor.a);
        }`,
      };
    }
    if (shaderType === "vertex")
      return {
        CUSTOM_VERTEX_DEFINITIONS: "attribute vec3 atlasData;\nvarying vec3 vAtlasData;",
        CUSTOM_VERTEX_MAIN_END: "vAtlasData = atlasData;",
      };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: "varying vec3 vAtlasData;\nuniform sampler2D atlasSampler;",
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `{
        float tile = floor(vAtlasData.z + 0.5);
        vec2 cell = vec2(mod(tile, ${C}), ${C} - 1.0 - floor(tile / ${C}));
        vec2 f = clamp(fract(vAtlasData.xy), 0.002, 0.998);
        baseColor.rgb *= texture2D(atlasSampler, (cell + f) / ${C}).rgb;
      }`,
    };
  }
}

export interface TerrainMaterials {
  terrain: StandardMaterial;
  atlas: DynamicTexture;
}

export function createTerrainMaterial(scene: Scene): TerrainMaterials {
  const canvas = paintAtlas();
  const atlas = new DynamicTexture("terrainAtlas", { width: canvas.width, height: canvas.height }, scene, false, Texture.NEAREST_SAMPLINGMODE);
  atlas.getContext().drawImage(canvas, 0, 0);
  atlas.update(true);
  atlas.wrapU = Texture.CLAMP_ADDRESSMODE;
  atlas.wrapV = Texture.CLAMP_ADDRESSMODE;

  const terrain = new StandardMaterial("terrain", scene);
  terrain.specularColor = Color3.Black();
  terrain.diffuseColor = Color3.White();
  new AtlasPlugin(terrain, atlas);
  return { terrain, atlas };
}
