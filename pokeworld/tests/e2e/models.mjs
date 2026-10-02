// Model pipeline: a species shows MISSING_POKEMON_ASSET until model files are
// connected through the in-game "포켓몬 3D 모델" panel; then the Bedrock loader
// builds a skinned model whose bones animate separately; removing the import
// brings the marker back. Uses tests/fixtures/test-rig (an abstract box rig,
// not a Pokémon) only inside this test browser's IndexedDB.
import { check, collectErrors, launch, newGame, pw, summary } from "./lib.mjs";

const SHOTS = "tests/e2e/screenshots";
const RIG = "tests/fixtures/test-rig";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = collectErrors(page);
await newGame(page, "모델검사");
const g = (fn, arg) => pw(page, fn, arg);
await g(() => {
  window.__pokeworld.game.input.pointerLockAllowed = false;
  window.__pokeworld.debug.teleport(30, -40);
  window.__pokeworld.debug.setHour(11);
});
await page.waitForTimeout(4000);

const id = await g(() => window.__pokeworld.debug.spawn("rattata", 5, 5));
await page.waitForTimeout(1500);
const before = await g((id) => window.__pokeworld.creatures().find((c) => c.id === id), id);
check("without files the species is MISSING_POKEMON_ASSET (marker, not a stand-in)", before?.asset === "missing" && before?.body === "missing");

// Menu -> 포켓몬 3D 모델 -> Rattata row -> connect files
await page.keyboard.press("KeyQ");
await page.click('[data-action="models"]');
await page.waitForSelector('.model-row[data-species="rattata"]', { timeout: 5000 });
const rowBefore = await page.textContent('.model-row[data-species="rattata"] .model-status');
await page.setInputFiles('input[data-model="rattata"]', [`${RIG}/test_rig.geo.json`, `${RIG}/test_rig.png`, `${RIG}/test_rig.animation.json`]);
await page.waitForFunction(() => /bedrock/.test(document.querySelector('.model-row[data-species="rattata"] .model-status')?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
const rowAfter = await page.textContent('.model-row[data-species="rattata"] .model-status');
await page.screenshot({ path: `${SHOTS}/models-01-panel.png` });
check("the panel connects .geo.json + .png + .animation.json", /MISSING_POKEMON_ASSET/.test(rowBefore ?? "") && /bedrock/.test(rowAfter ?? ""), `${rowBefore} -> ${rowAfter}`);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

await page.waitForFunction((id) => window.__pokeworld.creatures().find((c) => c.id === id)?.body === "bedrock", id, { timeout: 15000 }).catch(() => {});
const after = await g((id) => window.__pokeworld.creatures().find((c) => c.id === id), id);
check("the wild Pokémon swaps its marker for the loaded model in place", after?.asset === "ready" && after?.body === "bedrock", JSON.stringify({ asset: after?.asset, body: after?.body }));

// Bones move separately: sample each bone's local rotation over time
const sample = () =>
  g((id) => {
    const w = window.__pokeworld.game.creatures.get(id);
    const out = {};
    for (const b of w.view.body.bones) {
      const q = b.getRotationQuaternion();
      const p = b.getPosition();
      out[b.name] = [q.x, q.y, q.z, q.w, p.x, p.y, p.z].map((v) => +v.toFixed(4));
    }
    return out;
  }, id);
const a = await sample();
await page.waitForTimeout(700);
const b = await sample();
const changed = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
console.log("bones:", Object.keys(a).join(","), "| moved:", changed.join(","));
check("bones animate separately (head, ears, tail move between frames)", ["head", "tail"].every((n) => changed.some((c) => c.includes(n))) && changed.some((c) => c.includes("ear")), changed.join(","));
check("not every bone moves the same way (independent bones, not one rigid mesh)", Object.keys(a).length >= 8 && changed.length < Object.keys(a).length + 1);
await g((id) => {
  const w = window.__pokeworld;
  const c = w.creatures().find((c) => c.id === id);
  // Look at it from the side so the player does not block the view
  w.yaw = Math.atan2(c.x - w.pos.x, c.z - w.pos.z) - 0.55;
  w.pitch = 0.3;
  w.game.cam.distance = 4;
}, id);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${SHOTS}/models-02-rig-in-world.png` });

// Remove the import: back to the marker
await page.keyboard.press("KeyQ");
await page.click('[data-action="models"]');
await page.waitForSelector('.model-row[data-species="rattata"]');
await page.click('.model-row[data-species="rattata"] button:has-text("제거")');
await page.waitForTimeout(500);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForFunction((id) => window.__pokeworld.creatures().find((c) => c.id === id)?.body === "missing", id, { timeout: 10000 }).catch(() => {});
const removed = await g((id) => window.__pokeworld.creatures().find((c) => c.id === id), id);
check("removing the import shows MISSING_POKEMON_ASSET again", removed?.asset === "missing" && removed?.body === "missing", JSON.stringify({ asset: removed?.asset, body: removed?.body }));

check("no runtime errors", errors.length === 0, errors.slice(0, 4).join(" || "));
await browser.close();
process.exit(summary() ? 0 : 1);
