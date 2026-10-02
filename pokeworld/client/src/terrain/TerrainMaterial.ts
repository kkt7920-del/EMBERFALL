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
import { ATLAS_COLUMNS, Tile } from "@shared/world/blocks";
import { paintAtlas } from "./Atlas";

const C = ATLAS_COLUMNS.toFixed(1);

/** Values shared by every terrain material, updated once per frame by the game. */
export interface TerrainUniforms {
  time: number;
  /** Player lantern: x, y, z, radius (0 = off). */
  light: [number, number, number, number];
  /** Minimum brightness in unlit places (caves, night). */
  ambientFloor: number;
  /** Far-LOD meshes are not drawn inside this x/z rectangle (minX, minZ, maxX, maxZ): full chunks are. */
  hole: [number, number, number, number];
}

type Variant = "solid" | "water" | "cutout" | "lod" | "lodWater";

const EMISSIVE = [Tile.LAVA, Tile.MAGMA, Tile.CRYSTAL, Tile.LAMP, Tile.FLORA_GLOW_SHROOM, Tile.ANCIENT_CARVED];

/**
 * Voxel shading on top of StandardMaterial (so sun, shadows and fog still
 * work): atlas tiling across greedy-merged faces, per-vertex ambient
 * occlusion (vertex colour), sky light that darkens caves and overhangs, warm
 * block light from lava, crystals and lamps, the player's lantern, animated
 * water and swaying plants. GLSL (WebGL2) and WGSL (WebGPU).
 */
class VoxelPlugin extends MaterialPluginBase {
  constructor(
    material: StandardMaterial,
    private readonly atlas: BaseTexture,
    private readonly variant: Variant,
    private readonly u: TerrainUniforms,
  ) {
    super(material, "VoxelPlugin", 200, { VOXEL: false, VOXEL_WATER: false, VOXEL_CUTOUT: false, VOXEL_LOD: false });
    this._enable(true);
  }

  override getClassName(): string {
    return "VoxelPlugin";
  }

  override isCompatible(lang: ShaderLanguage): boolean {
    return lang === ShaderLanguage.GLSL || lang === ShaderLanguage.WGSL;
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines.VOXEL = true;
    defines.VOXEL_WATER = this.variant === "water" || this.variant === "lodWater";
    defines.VOXEL_CUTOUT = this.variant === "cutout";
    defines.VOXEL_LOD = this.variant === "lod" || this.variant === "lodWater";
  }

  override getAttributes(attributes: string[]): void {
    attributes.push("atlasData", "lightData");
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("atlasSampler");
  }

  override getUniforms(lang: ShaderLanguage = ShaderLanguage.GLSL) {
    const ubo = [
      { name: "voxelTime", size: 1, type: "float" },
      { name: "voxelLight", size: 4, type: "vec4" },
      { name: "voxelFloor", size: 1, type: "float" },
      { name: "voxelHole", size: 4, type: "vec4" },
    ];
    if (lang === ShaderLanguage.WGSL) return { ubo };
    return {
      ubo,
      vertex: "uniform float voxelTime;",
      fragment: "uniform float voxelTime;\nuniform vec4 voxelLight;\nuniform float voxelFloor;\nuniform vec4 voxelHole;",
    };
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine): void {
    ubo.setTexture("atlasSampler", this.atlas);
    ubo.updateFloat("voxelTime", this.u.time);
    ubo.updateFloat4("voxelLight", this.u.light[0], this.u.light[1], this.u.light[2], this.u.light[3]);
    ubo.updateFloat("voxelFloor", this.u.ambientFloor);
    ubo.updateFloat4("voxelHole", this.u.hole[0], this.u.hole[1], this.u.hole[2], this.u.hole[3]);
  }

  override getCustomCode(shaderType: string, lang?: ShaderLanguage): { [point: string]: string } | null {
    const emissiveGlsl = EMISSIVE.map((t) => `abs(tileF - ${t}.0) < 0.5`).join(" || ");
    const emissiveWgsl = EMISSIVE.map((t) => `abs(tileF - ${t}.0) < 0.5`).join(" || ");
    if (lang === ShaderLanguage.WGSL) {
      if (shaderType === "vertex")
        return {
          CUSTOM_VERTEX_DEFINITIONS: "attribute atlasData: vec3f;\nattribute lightData: vec2f;\nvarying vAtlasData: vec3f;\nvarying vLightData: vec2f;",
          CUSTOM_VERTEX_UPDATE_POSITION: `
          #ifdef VOXEL_CUTOUT
          if (input.atlasData.z >= 63.5 && input.atlasData.y > 0.3) {
            let sway = sin(uniforms.voxelTime * 1.7 + input.position.x * 0.6 + input.position.z * 0.8) * 0.07 * min(input.atlasData.y, 3.0);
            positionUpdated = vec3f(positionUpdated.x + sway, positionUpdated.y, positionUpdated.z + sway * 0.6);
          }
          #endif`,
          CUSTOM_VERTEX_MAIN_END: "vertexOutputs.vAtlasData = input.atlasData;\nvertexOutputs.vLightData = input.lightData;",
        };
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: "varying vAtlasData: vec3f;\nvarying vLightData: vec2f;\nvar atlasSamplerSampler: sampler;\nvar atlasSampler: texture_2d<f32>;",
        CUSTOM_FRAGMENT_MAIN_BEGIN: `
          #ifdef VOXEL_LOD
          let hp = fragmentInputs.vPositionW;
          if (hp.x > uniforms.voxelHole.x && hp.x < uniforms.voxelHole.z && hp.z > uniforms.voxelHole.y && hp.z < uniforms.voxelHole.w) { discard; }
          #endif`,
        CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `{
          let tile = floor(fragmentInputs.vAtlasData.z + 0.5);
          let cell = vec2f(tile - ${C} * floor(tile / ${C}), ${C} - 1.0 - floor(tile / ${C}));
          var uv = fragmentInputs.vAtlasData.xy;
          #ifdef VOXEL_WATER
          uv = uv + vec2f(uniforms.voxelTime * 0.11, uniforms.voxelTime * 0.06);
          #endif
          let f = clamp(fract(uv), vec2f(0.002), vec2f(0.998));
          let texel = textureSample(atlasSampler, atlasSamplerSampler, (cell + f) / ${C});
          #ifdef VOXEL_CUTOUT
          if (texel.a < 0.5) { discard; }
          #endif
          baseColor = vec4f(baseColor.rgb * texel.rgb, baseColor.a);
        }`,
        CUSTOM_FRAGMENT_BEFORE_FOG: `{
          let tileF = floor(fragmentInputs.vAtlasData.z + 0.5);
          let skyL = fragmentInputs.vLightData.x;
          var blkL = fragmentInputs.vLightData.y;
          let pd = distance(fragmentInputs.vPositionW, uniforms.voxelLight.xyz);
          if (uniforms.voxelLight.w > 0.0) { blkL = max(blkL, clamp(1.0 - pd / uniforms.voxelLight.w, 0.0, 1.0) * 0.85); }
          let skyF = uniforms.voxelFloor + (1.0 - uniforms.voxelFloor) * pow(skyL, 1.5);
          var rgb = color.rgb * skyF + baseColor.rgb * blkL * blkL * vec3f(1.0, 0.8, 0.55) * 1.1;
          if (${emissiveWgsl}) { rgb = max(rgb, baseColor.rgb * 0.95); }
          color = vec4f(rgb, color.a);
        }`,
      };
    }
    if (shaderType === "vertex")
      return {
        CUSTOM_VERTEX_DEFINITIONS: "attribute vec3 atlasData;\nattribute vec2 lightData;\nvarying vec3 vAtlasData;\nvarying vec2 vLightData;",
        CUSTOM_VERTEX_UPDATE_POSITION: `
        #ifdef VOXEL_CUTOUT
        if (atlasData.z >= 63.5 && atlasData.y > 0.3) {
          float sway = sin(voxelTime * 1.7 + position.x * 0.6 + position.z * 0.8) * 0.07 * min(atlasData.y, 3.0);
          positionUpdated.x += sway;
          positionUpdated.z += sway * 0.6;
        }
        #endif`,
        CUSTOM_VERTEX_MAIN_END: "vAtlasData = atlasData;\nvLightData = lightData;",
      };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: "varying vec3 vAtlasData;\nvarying vec2 vLightData;\nuniform sampler2D atlasSampler;",
      CUSTOM_FRAGMENT_MAIN_BEGIN: `
        #ifdef VOXEL_LOD
        if (vPositionW.x > voxelHole.x && vPositionW.x < voxelHole.z && vPositionW.z > voxelHole.y && vPositionW.z < voxelHole.w) discard;
        #endif`,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `{
        float tile = floor(vAtlasData.z + 0.5);
        vec2 cell = vec2(mod(tile, ${C}), ${C} - 1.0 - floor(tile / ${C}));
        vec2 uv = vAtlasData.xy;
        #ifdef VOXEL_WATER
        uv += vec2(voxelTime * 0.11, voxelTime * 0.06);
        #endif
        vec2 f = clamp(fract(uv), 0.002, 0.998);
        vec4 texel = texture2D(atlasSampler, (cell + f) / ${C});
        #ifdef VOXEL_CUTOUT
        if (texel.a < 0.5) discard;
        #endif
        baseColor.rgb *= texel.rgb;
      }`,
      CUSTOM_FRAGMENT_BEFORE_FOG: `{
        float tileF = floor(vAtlasData.z + 0.5);
        float skyL = vLightData.x;
        float blkL = vLightData.y;
        if (voxelLight.w > 0.0) blkL = max(blkL, clamp(1.0 - distance(vPositionW, voxelLight.xyz) / voxelLight.w, 0.0, 1.0) * 0.85);
        float skyF = voxelFloor + (1.0 - voxelFloor) * pow(skyL, 1.5);
        color.rgb = color.rgb * skyF + baseColor.rgb * blkL * blkL * vec3(1.0, 0.8, 0.55) * 1.1;
        if (${emissiveGlsl}) color.rgb = max(color.rgb, baseColor.rgb * 0.95);
      }`,
    };
  }
}

export interface TerrainMaterials {
  terrain: StandardMaterial;
  water: StandardMaterial;
  flora: StandardMaterial;
  lod: StandardMaterial;
  lodWater: StandardMaterial;
  atlas: DynamicTexture;
  uniforms: TerrainUniforms;
}

export function createTerrainMaterial(scene: Scene): TerrainMaterials {
  const canvas = paintAtlas();
  // Nearest filtering, no mipmaps: crisp pixel-art blocks at every distance
  const atlas = new DynamicTexture("terrainAtlas", { width: canvas.width, height: canvas.height }, scene, false, Texture.NEAREST_SAMPLINGMODE);
  atlas.getContext().drawImage(canvas, 0, 0);
  atlas.update(true);
  atlas.hasAlpha = true;
  atlas.wrapU = Texture.CLAMP_ADDRESSMODE;
  atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
  atlas.anisotropicFilteringLevel = 1;

  const uniforms: TerrainUniforms = { time: 0, light: [0, 0, 0, 0], ambientFloor: 0.14, hole: [0, 0, 0, 0] };

  const terrain = new StandardMaterial("terrain", scene);
  terrain.specularColor = Color3.Black();
  terrain.diffuseColor = Color3.White();
  new VoxelPlugin(terrain, atlas, "solid", uniforms);

  const water = new StandardMaterial("water", scene);
  water.specularColor = new Color3(0.35, 0.4, 0.45);
  water.specularPower = 48;
  water.diffuseColor = new Color3(0.55, 0.75, 1);
  water.alpha = 0.78;
  water.backFaceCulling = false;
  new VoxelPlugin(water, atlas, "water", uniforms);

  const flora = new StandardMaterial("flora", scene);
  flora.specularColor = Color3.Black();
  flora.diffuseColor = Color3.White();
  flora.backFaceCulling = false;
  new VoxelPlugin(flora, atlas, "cutout", uniforms);

  const lod = new StandardMaterial("terrainLod", scene);
  lod.specularColor = Color3.Black();
  lod.diffuseColor = Color3.White();
  new VoxelPlugin(lod, atlas, "lod", uniforms);

  const lodWater = new StandardMaterial("waterLod", scene);
  lodWater.specularColor = new Color3(0.35, 0.4, 0.45);
  lodWater.specularPower = 48;
  lodWater.diffuseColor = new Color3(0.55, 0.75, 1);
  lodWater.alpha = 0.85;
  new VoxelPlugin(lodWater, atlas, "lodWater", uniforms);

  return { terrain, water, flora, lod, lodWater, atlas, uniforms };
}
