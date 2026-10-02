// Desktop playthrough: title -> new game -> 3D field -> move -> camera -> starter
// -> wild creature -> approach -> battle -> capture -> party -> save/load.
import { BASE, check, collectErrors, launch, newGame, pw, summary, waitGame, walkTo, walkToCreature } from "./lib.mjs";

const SHOTS = "tests/e2e/screenshots";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = collectErrors(page);

// 1-3. Title, new game, 3D field
await newGame(page);
await page.waitForFunction(() => window.__pokeworld.chunks.loaded >= 9, null, { timeout: 60000 }).catch(() => {});
const loaded = await pw(page, () => ({ chunks: window.__pokeworld.chunks, engine: window.__pokeworld.engineKind, meshes: window.__pokeworld.game.scene.meshes.length }));
check("3D field loads with terrain chunks", loaded.chunks.loaded >= 9, JSON.stringify(loaded));
await page.screenshot({ path: `${SHOTS}/play-01-field.png` });

// 5. Player movement (keyboard)
const p0 = await pw(page, () => window.__pokeworld.pos);
await page.keyboard.down("KeyD");
await page.waitForTimeout(1200);
await page.keyboard.up("KeyD");
const p1 = await pw(page, () => window.__pokeworld.pos);
check("WASD moves the player", Math.hypot(p1.x - p0.x, p1.z - p0.z) > 1.5, `moved ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2)} m`);

// 6. Camera (mouse drag)
const yaw0 = await pw(page, () => window.__pokeworld.yaw);
await page.mouse.move(700, 400);
await page.mouse.down();
await page.mouse.move(820, 400, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const yaw1 = await pw(page, () => window.__pokeworld.yaw);
check("mouse turns the camera", Math.abs(yaw1 - yaw0) > 0.1, `yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}`);
await page.keyboard.press("Escape");

// Starter: walk to the professor and talk (E)
const prof = { x: 0.5, z: 23.5 };
check("can walk to the professor", await walkTo(page, prof.x, prof.z, 2.6));
await page.waitForTimeout(300);
const prompt = await page.textContent(".hud-prompt");
check("interaction prompt shows the professor", /레아 박사/.test(prompt ?? ""), prompt ?? "");
await page.keyboard.press("KeyE");
await page.waitForSelector(".dialog:not(.hidden)", { timeout: 8000 });
await page.screenshot({ path: `${SHOTS}/play-02-dialog.png` });
for (let i = 0; i < 4 && (await page.$(".dialog:not(.hidden)")); i++) {
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(200);
}
await page.waitForSelector('[data-species="emberpup"]', { timeout: 8000 });
await page.screenshot({ path: `${SHOTS}/play-03-starter.png` });
await page.click('[data-species="emberpup"]');
await page.waitForFunction(() => window.__pokeworld.state?.party.length === 1, null, { timeout: 8000 });
for (let i = 0; i < 4 && (await page.$(".dialog:not(.hidden)")); i++) {
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(200);
}
check("starter joins the party", (await pw(page, () => window.__pokeworld.state.party[0].species)) === "emberpup");

// 7. Wild creatures spawn in the grassland (walk out of town on route 1)
await pw(page, () => window.__pokeworld.debug.teleport("overworld", -20, 95));
await page.waitForTimeout(800);
await page.waitForFunction(() => window.__pokeworld.creatures().length > 0, null, { timeout: 30000 }).catch(() => {});
const wild = await pw(page, () => window.__pokeworld.creatures());
check("wild placeholder creatures spawn nearby", wild.length > 0, wild.map((w) => `${w.species}@${w.level}`).join(", "));
await page.screenshot({ path: `${SHOTS}/play-04-wild.png` });

// 8. Approach a wild creature (a neutral one placed ahead so it doesn't flee)
const wid = await pw(page, () => window.__pokeworld.debug.spawn("mudpup", 3, 9));
await page.waitForTimeout(400);
const target = await pw(page, (id) => window.__pokeworld.creatures().find((c) => c.id === id), wid);
check("approach the creature on foot", await walkToCreature(page, wid, 2.8), `target ${target?.species}`);

// 9. Battle (F)
await page.keyboard.press("KeyF");
await page.waitForTimeout(1500);
if (!(await pw(page, () => window.__pokeworld.battle))) {
  console.log("toasts:", await page.$$eval(".toast", (els) => els.map((e) => e.textContent).join(" | ")), "dialog:", await page.$eval(".dialog", (e) => e.className), "target:", JSON.stringify(await pw(page, () => window.__pokeworld.target)));
}
await page.waitForFunction(() => window.__pokeworld.battle !== null, null, { timeout: 8000 }).catch(() => {});
check("battle starts", (await pw(page, () => window.__pokeworld.battle)) !== null);
await page.waitForSelector(".bmenu button.fight", { timeout: 15000 });
await page.screenshot({ path: `${SHOTS}/play-05-battle.png` });

// Fight one turn with the first move
await page.click(".bmenu button.fight");
await page.click(".bmenu button[data-move]");
await page.waitForFunction(() => document.querySelector(".bmenu button.fight") || !window.__pokeworld.battle, null, { timeout: 30000 });
const afterHit = await pw(page, () => window.__pokeworld.battle?.foe ?? null);
check("attack resolves on the server and damages the foe", !afterHit || afterHit.hp < afterHit.maxHp, afterHit ? `${afterHit.hp}/${afterHit.maxHp}` : "foe fainted");

// 10. Capture (button in battle; give extra orbs in case of misses)
await pw(page, () => window.__pokeworld.debug.give("great_orb", 20));
let captured = false;
for (let i = 0; i < 8 && !captured; i++) {
  if (!(await pw(page, () => window.__pokeworld.battle))) break;
  await page.waitForSelector(".bmenu button.catch", { timeout: 30000 });
  await page.click(".bmenu button.catch");
  try {
    await page.waitForFunction(() => document.querySelector(".bmenu button.catch") || !window.__pokeworld.battle, null, { timeout: 30000 });
  } catch (e) {
    await page.screenshot({ path: `${SHOTS}/play-debug-capture.png` });
    console.log("capture wait timed out:", await page.textContent(".bmessage"), JSON.stringify(await pw(page, () => window.__pokeworld.battle)), errors.join(" | "));
    throw e;
  }
  captured = (await pw(page, () => window.__pokeworld.state.party.length)) >= 2;
}
if (!captured) {
  // Fallback: overworld throw (R) at a fresh creature
  for (let i = 0; i < 10 && !captured; i++) {
    await page.waitForFunction(() => !window.__pokeworld.battle, null, { timeout: 30000 });
    await pw(page, () => window.__pokeworld.debug.spawn("meadowbug", 2, 5));
    await page.waitForTimeout(500);
    await page.keyboard.press("KeyR");
    await page.waitForTimeout(3500);
    captured = (await pw(page, () => window.__pokeworld.state.party.length)) >= 2;
  }
}
await page.screenshot({ path: `${SHOTS}/play-06-capture.png` });
check("capture succeeds", captured);

// 11. Party registration
await page.waitForFunction(() => !window.__pokeworld.battle, null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.keyboard.press("KeyP");
await page.waitForSelector(".modal .card", { timeout: 5000 });
const cards = await page.$$eval(".modal .card .card-title", (els) => els.map((e) => e.textContent));
await page.screenshot({ path: `${SHOTS}/play-07-party.png` });
check("party panel lists the captured creature", cards.length >= 2, cards.join(" | "));
await page.keyboard.press("Escape");

// Map panel renders
await page.keyboard.press("KeyM");
await page.waitForSelector(".map-wrap canvas", { timeout: 5000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SHOTS}/play-08-map.png` });
check("map panel opens", true);
await page.keyboard.press("Escape");

// Save -> reload -> continue
const before = await pw(page, () => ({ party: window.__pokeworld.state.party.map((c) => c.species), money: window.__pokeworld.state.money }));
await page.keyboard.press("KeyQ");
await page.waitForSelector(".modal .btn-primary");
await page.click(".modal .btn-primary");
await page.waitForTimeout(1500);
await page.goto(BASE);
await page.waitForSelector('[data-action="continue"]', { timeout: 20000 });
await page.click('[data-action="continue"]');
await waitGame(page);
const after = await pw(page, () => ({ party: window.__pokeworld.state.party.map((c) => c.species), money: window.__pokeworld.state.money }));
check("save/load restores the party", JSON.stringify(after.party) === JSON.stringify(before.party), `${before.party} -> ${after.party}`);

const perf = await pw(page, () => window.__pokeworld.stats());
console.log("perf (software GL):", JSON.stringify(perf));
check("no runtime errors", errors.length === 0, errors.slice(0, 5).join(" || "));
await browser.close();
process.exit(summary() ? 0 : 1);
