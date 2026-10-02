// Frame budget report. Software GL (SwiftShader) cannot show real GPU frame
// rates, so this measures what does not depend on the GPU: game-logic CPU time
// per frame, draw calls, vertices and chunk build times, per quality preset.
import { BASE, launch, pw, waitGame } from "./lib.mjs";

const browser = await launch();
const rows = [];
for (const [name, ctxOpts, preset] of [
  ["PC high", { viewport: { width: 1366, height: 768 } }, "high"],
  ["PC medium", { viewport: { width: 1366, height: 768 } }, "medium"],
  ["Mobile low", { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, "low"],
]) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForSelector(".title-screen", { timeout: 30000 });
  await page.click('[data-action="new"]');
  await page.click('[data-action="start"]');
  await waitGame(page);
  await pw(page, async (p) => {
    const { applyPreset } = await import("/client/src/settings.ts");
    const game = window.__pokeworld.game;
    game.applySettings(applyPreset(game.settings, p));
  }, preset);
  for (const [spot, x, z] of [["town", 0.5, 19.5], ["forest", -80, 240], ["coast", 40, -250], ["mountain", -200, 425]]) {
    await pw(page, ([x, z]) => window.__pokeworld.debug.teleport(x, z), [x, z]);
    await page.waitForTimeout(9000);
    await pw(page, () => (window.__pokeworld.game.cpuTimes.length = 0));
    // Walk forward while measuring (streams new chunks, moves creatures)
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(6000);
    await page.keyboard.up("KeyW");
    const s = await pw(page, () => ({ ...window.__pokeworld.stats(), q: window.__pokeworld.game.settings.preset, chunks: window.__pokeworld.chunks }));
    const build = s.chunks.buildMs.length ? s.chunks.buildMs.reduce((a, b) => a + b, 0) / s.chunks.buildMs.length : 0;
    rows.push({ name, spot, q: s.q, logicMs: s.logicMs.toFixed(2), logicP95: s.logicMsP95.toFixed(2), drawCalls: s.drawCalls, verticesK: Math.round(s.vertices / 1000), activeMeshes: s.activeMeshes, chunkBuildMs: build.toFixed(0) });
  }
  await ctx.close();
}
console.table(rows);
await browser.close();
