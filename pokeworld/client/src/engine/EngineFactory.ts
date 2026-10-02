import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

export interface EngineInfo {
  engine: AbstractEngine;
  kind: "webgl2" | "webgl1" | "webgpu";
}

/** WebGL2 by default; WebGPU when selected in settings and supported (falls back to WebGL). */
export async function createEngine(canvas: HTMLCanvasElement, preferWebGPU: boolean): Promise<EngineInfo> {
  if (preferWebGPU && "gpu" in navigator) {
    try {
      const { WebGPUEngine } = await import("@babylonjs/core/Engines/webgpuEngine");
      if (await WebGPUEngine.IsSupportedAsync) {
        const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, powerPreference: "high-performance" });
        await engine.initAsync();
        return { engine, kind: "webgpu" };
      }
    } catch (e) {
      console.warn("WebGPU unavailable, using WebGL", e);
    }
  }
  const { Engine } = await import("@babylonjs/core/Engines/engine");
  const engine = new Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance", premultipliedAlpha: false }, true);
  return { engine, kind: engine.webGLVersion >= 2 ? "webgl2" : "webgl1" };
}
