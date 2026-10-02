// Desktop playthrough (keyboard + mouse): title -> new game -> voxel field -> move -> camera
// -> starter -> real Pokémon from the registry -> ball in hand, aim (name/Lv on the reticle)
// -> projectile throw -> absorb, shakes, breakout -> catch to party -> miss, land, pick up
// -> ball keys / wheel -> battle "포획" with a real throw -> info panel -> party / Pokédex / map -> save/load.
import { BASE, aimAt, check, collectErrors, launch, newGame, pw, soundsSince, summary, waitGame, waitSound, walkTo } from "./lib.mjs";

const SHOTS = "tests/e2e/screenshots";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = collectErrors(page);
const g = (fn, arg) => pw(page, fn, arg);

// Title, new game, voxel field
await newGame(page);
await page.waitForFunction(() => window.__pokeworld.chunks.loaded >= 9, null, { timeout: 60000 }).catch(() => {});
const loaded = await g(() => ({ chunks: window.__pokeworld.chunks, engine: window.__pokeworld.engineKind }));
check("3D field loads with terrain chunks", loaded.chunks.loaded >= 9, JSON.stringify(loaded.chunks));
const ground = await g(() => {
  const w = window.__pokeworld;
  const p = w.pos;
  return { under: w.block(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)), at: w.block(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) };
});
check("the world is made of 1x1x1 blocks (solid block under the feet, air at them)", ground.under > 0 && ground.at === 0, JSON.stringify(ground));
await page.screenshot({ path: `${SHOTS}/play-01-field.png` });

// Headless Chromium reports absolute positions as movementX under pointer lock; drag-look instead
await g(() => (window.__pokeworld.game.input.pointerLockAllowed = false));

// Movement (keyboard)
const p0 = await g(() => window.__pokeworld.pos);
await page.keyboard.down("KeyD");
await page.waitForTimeout(2500);
await page.keyboard.up("KeyD");
const p1 = await g(() => window.__pokeworld.pos);
check("WASD moves the player", Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.5, `moved ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2)} m`);

// Camera (mouse drag)
const yaw0 = await g(() => window.__pokeworld.yaw);
await page.mouse.move(700, 400);
await page.mouse.down();
await page.mouse.move(820, 400, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const yaw1 = await g(() => window.__pokeworld.yaw);
check("mouse turns the camera", Math.abs(yaw1 - yaw0) > 0.1, `yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}`);
await page.keyboard.press("Escape");

// Starter: walk to the professor and talk (E)
check("can walk to the professor", await walkTo(page, 0.5, 23.5, 2.6));
await page.waitForTimeout(300);
const prompt = await page.textContent(".hud-prompt");
check("interaction prompt shows the professor", /레아 박사/.test(prompt ?? ""), prompt ?? "");
await page.keyboard.press("KeyE");
await page.waitForSelector(".dialog:not(.hidden)", { timeout: 8000 });
for (let i = 0; i < 4 && (await page.$(".dialog:not(.hidden)")); i++) {
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(200);
}
await page.waitForSelector('[data-species="charmander"]', { timeout: 8000 });
await page.screenshot({ path: `${SHOTS}/play-02-starter.png` });
await page.click('[data-species="charmander"] button');
await page.waitForFunction(() => window.__pokeworld.state?.party.length === 1, null, { timeout: 8000 });
for (let i = 0; i < 4 && (await page.$(".dialog:not(.hidden)")); i++) {
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(200);
}
check("starter Charmander joins the party", (await g(() => window.__pokeworld.state.party[0].species)) === "charmander");

// TEST 1: Pokémon spawn from the species registry (route 1 grassland)
await g(() => window.__pokeworld.debug.teleport(-20, 95));
await page.waitForFunction(() => window.__pokeworld.creatures().length > 0, null, { timeout: 40000 }).catch(() => {});
const wild = await g(() => window.__pokeworld.creatures().map((c) => ({ species: c.species, level: c.level, asset: c.asset, body: c.body })));
const registry = await g(() => [...window.__pokeworld.game.db.species.keys()]);
check("TEST 1: wild Pokémon spawn from the registry", wild.length > 0 && wild.every((w) => registry.includes(w.species)), wild.map((w) => `${w.species} Lv${w.level}`).join(", "));
check("Pokémon without a model show MISSING_POKEMON_ASSET (no stand-in creature)", wild.every((w) => w.asset !== "missing" || w.body === "missing"), JSON.stringify(wild.slice(0, 3)));
await page.screenshot({ path: `${SHOTS}/play-03-wild.png` });

// Flat ground in town for the throwing tests
await g(() => {
  const d = window.__pokeworld.debug;
  d.teleport(30, -40);
  d.setHour(10);
  d.give("great_ball", 3);
});
await page.waitForTimeout(4000);
let wid = await g(() => window.__pokeworld.debug.spawn("pikachu", 8, 7, { hpFraction: 0.3 }));
await page.waitForTimeout(1500);

// TEST 12 (part): R takes a ball in hand; the HUD shows "Poké Ball ×N"
await page.mouse.move(683, 384);
await page.keyboard.press("KeyR");
await page.waitForFunction(() => window.__pokeworld.aim.equipped, null, { timeout: 5000 }).catch(() => {});
const chip = await page.textContent(".ball-chip");
const equipped = await g(() => window.__pokeworld.aim.equipped);
check("R equips a ball; bottom-right shows the ball and count", equipped && /Pok.+ Ball\s*×\d+/u.test(chip ?? ""), `${equipped} ${chip}`);

// TEST 2 / 5: aim — reticle turns yellow on a Pokémon in range with "Pikachu / Lv. 8"
const locked = await aimAt(page, wid);
const label = await page.textContent(".aim-label");
const reticleLocked = await page.$eval(".reticle", (el) => el.classList.contains("locked"));
await page.screenshot({ path: `${SHOTS}/play-04-aim.png` });
check("TEST 5: aiming locks onto the Pokémon (reticle turns yellow)", locked && reticleLocked);
check("TEST 2: name and level shown on the reticle", /Pikachu/.test(label ?? "") && /Lv\. 8/.test(label ?? ""), JSON.stringify(label));

// TEST 6 / 8 / 9 / 10: projectile -> absorb -> shakes -> breakout
await g(() => window.__pokeworld.debug.forceCapture("fail"));
let s0 = await g(() => window.__pokeworld.sounds.length);
const inv0 = await g(() => window.__pokeworld.state.inventory.poke_ball);
await page.mouse.down();
await page.waitForTimeout(90);
await page.mouse.up();
const track = [];
for (let i = 0; i < 10; i++) {
  const b = await g(() => window.__pokeworld.balls().flying[0] ?? null);
  if (b) track.push(b);
  if (track.length >= 3) break;
  await page.waitForTimeout(40);
}
await page.screenshot({ path: `${SHOTS}/play-05-flying.png` });
const moved = track.length >= 2 && Math.hypot(track[track.length - 1].x - track[0].x, track[track.length - 1].z - track[0].z) > 0.05;
check("TEST 6: the throw is a moving projectile", moved, JSON.stringify(track.map((b) => [b.x.toFixed(2), b.y.toFixed(2), b.z.toFixed(2)])));
let snd = await waitSound(page, s0, ["capture_breakout", "capture_success"]);
await page.screenshot({ path: `${SHOTS}/play-06-breakout.png` });
check("TEST 8: absorb sequence (hit, open, beam, close)", ["ball_hit", "ball_open", "capture_beam", "ball_close"].every((n) => snd.includes(n)), snd.join(","));
const shakes = snd.filter((n) => n === "ball_shake").length;
check("TEST 9: up to 3 shakes", shakes >= 1 && shakes <= 3, `${shakes} shakes`);
await page.waitForTimeout(1500);
const back = await g((id) => window.__pokeworld.creatures().find((c) => c.id === id), wid);
check("TEST 10: breakout — the Pokémon reappears and the ball is used up", snd.includes("capture_breakout") && back?.visible && (await g(() => window.__pokeworld.state.inventory.poke_ball)) === inv0 - 1, JSON.stringify({ visible: back?.visible }));

// TEST 11: success -> party (fresh, unalerted Pokémon)
wid = await g(() => window.__pokeworld.debug.spawn("pikachu", 8, 6, { hpFraction: 0.3 }));
await page.waitForTimeout(1500);
await aimAt(page, wid);
await g(() => window.__pokeworld.debug.forceCapture("success"));
s0 = await g(() => window.__pokeworld.sounds.length);
// Hold to charge, release to throw
await page.mouse.down();
const ring = await page.waitForSelector(".power-ring:not(.hidden)", { timeout: 5000 }).then(() => true).catch(() => false);
await page.mouse.up();
check("holding the button charges (power ring)", ring);
snd = await waitSound(page, s0, ["capture_success", "capture_breakout"]);
const banner = await g(() => document.querySelector(".gotcha")?.textContent ?? "");
await page.screenshot({ path: `${SHOTS}/play-07-gotcha.png` });
await page.waitForTimeout(2000);
const party = await g(() => window.__pokeworld.state.party.map((c) => c.species));
check("TEST 11: a catch goes to the party with Gotcha!", snd.includes("capture_success") && party.includes("pikachu") && /Gotcha!/.test(banner), `${party} | ${banner}`);

// TEST 7: a miss lands, rolls, rests and can be picked up
await g(() => {
  // Away from the Pokémon, at the ground ~10 m ahead: it lands, bounces and rolls
  window.__pokeworld.yaw += Math.PI;
  window.__pokeworld.pitch = 0.3;
});
await page.waitForTimeout(300);
const inv1 = await g(() => window.__pokeworld.state.inventory.poke_ball);
s0 = await g(() => window.__pokeworld.sounds.length);
await page.mouse.down();
await page.waitForTimeout(90);
await page.mouse.up();
let rest = null;
for (let i = 0; i < 80 && !rest; i++) {
  await page.waitForTimeout(250);
  rest = await g(() => window.__pokeworld.debug.serverBalls().find((b) => b.resting) ?? null);
}
snd = await soundsSince(page, s0);
if (snd.includes("ball_hit")) console.log("note: the 'miss' hit a wild Pokémon:", snd.join(","));
const restDist = rest ? Math.hypot(rest.x - (await g(() => window.__pokeworld.pos.x)), rest.z - (await g(() => window.__pokeworld.pos.z))) : 0;
check("TEST 7: a missed ball bounces, rolls and comes to rest on the ground", !!rest && rest.bounces > 0 && restDist > 3 && (await g(() => window.__pokeworld.state.inventory.poke_ball)) === inv1 - 1, rest ? `${rest.x.toFixed(1)},${rest.y.toFixed(2)},${rest.z.toFixed(1)} after ${rest.bounces} bounces, ${restDist.toFixed(1)} m away` : "no rest");
await page.screenshot({ path: `${SHOTS}/play-08-miss.png` });
if (rest) {
  await page.keyboard.press("KeyR");
  await g(([x, z]) => window.__pokeworld.debug.teleport(x + 4, z), [rest.x, rest.z]);
  await page.waitForTimeout(3000);
  await walkTo(page, rest.x, rest.z, 0.8, 30000);
  await page.waitForTimeout(1500);
}
check("TEST 7: walking over it picks it up again", (await g(() => window.__pokeworld.state.inventory.poke_ball)) === inv1 && (await g(() => window.__pokeworld.debug.serverBalls().length)) === 0);

// TEST 12: number keys and the mouse wheel select balls, G opens the wheel
await page.keyboard.press("Digit2");
await page.waitForFunction(() => window.__pokeworld.aim.selected === "great_ball" && window.__pokeworld.aim.equipped, null, { timeout: 6000 }).catch(() => {});
const sel2 = await g(() => window.__pokeworld.aim);
await page.mouse.wheel(0, 120);
await page.waitForFunction(() => window.__pokeworld.aim.selected !== "great_ball", null, { timeout: 6000 }).catch(() => {});
const selW = await g(() => window.__pokeworld.aim.selected);
await page.keyboard.press("KeyG");
await page.waitForSelector(".ball-wheel", { timeout: 4000 }).catch(() => {});
const wheel = await page.$$eval(".ball-wheel .wheel-slot", (els) => els.map((e) => e.dataset.ball));
await page.screenshot({ path: `${SHOTS}/play-09-wheel.png` });
await page.click('.ball-wheel [data-ball="poke_ball"]').catch(() => {});
check("TEST 12: number key 2 selects the second ball", sel2.equipped && sel2.selected === "great_ball", JSON.stringify(sel2));
check("TEST 12: mouse wheel cycles balls", selW !== "great_ball", selW);
check("TEST 12: G opens the ball wheel with every ball type", ["poke_ball", "great_ball", "ultra_ball", "quick_ball", "dive_ball", "dusk_ball", "net_ball", "timer_ball"].every((b) => wheel.includes(b)), wheel.join(","));
await page.keyboard.press("Escape");

// Info: E on a nearby wild Pokémon (back on dry land in town)
await g(() => window.__pokeworld.debug.teleport(30, -40));
await page.waitForTimeout(3000);
wid = await g(() => window.__pokeworld.debug.spawn("rattata", 4, 2));
await page.waitForTimeout(1500);
await g((id) => {
  const w = window.__pokeworld;
  const c = w.creatures().find((c) => c.id === id);
  w.yaw = Math.atan2(c.x - w.pos.x, c.z - w.pos.z);
}, wid);
await page.waitForTimeout(500);
// E opens the nearest wild Pokémon's info: use whichever it is for the battle catch below
const tgt = await g(() => window.__pokeworld.target);
if (tgt?.kind === "wild") wid = tgt.id;
const tgtSpecies = await g((id) => window.__pokeworld.creatures().find((c) => c.id === id)?.species, wid);
const tgtName = await g((sp) => window.__pokeworld.game.db.species.get(sp)?.name, tgtSpecies);
const tgtLevel = await g((id) => window.__pokeworld.creatures().find((c) => c.id === id)?.level, wid);
await page.keyboard.press("KeyE");
await page.waitForSelector(".modal", { timeout: 4000 }).catch(() => {});
const info = (await page.$eval(".modal", (el) => el.textContent).catch(() => "")) ?? "";
await page.screenshot({ path: `${SHOTS}/play-10-info.png` });
check("info: name, Lv, type, HP, gender, status", info.includes(tgtName) && info.includes(`Lv. ${tgtLevel}`) && /HP/.test(info) && /상태/.test(info) && /[♂♀]|성별/.test(info), info.slice(0, 120));

// Battle "포획": wheel -> aim -> real throw -> sequence -> result
const battleBtn = await page.$(".modal .btn-primary");
if (battleBtn) await battleBtn.click();
else {
  await page.keyboard.press("Escape");
  await page.keyboard.press("KeyF");
}
await page.waitForSelector(".bmenu button.catch", { timeout: 20000 });
// Throw at whoever the battle is against
wid = await g(() => window.__pokeworld.battle?.entityId ?? null);
const foeSpecies = await g((id) => window.__pokeworld.creatures().find((c) => c.id === id)?.species, wid);
await page.screenshot({ path: `${SHOTS}/play-11-battle.png` });
await page.click(".bmenu button.catch");
await page.waitForSelector(".ball-wheel", { timeout: 5000 });
await page.click('.ball-wheel [data-ball="great_ball"]');
await page.waitForTimeout(500);
const battleLock = await aimAt(page, wid);
await g(() => window.__pokeworld.debug.forceCapture("success"));
s0 = await g(() => window.__pokeworld.sounds.length);
await page.mouse.down();
await page.waitForTimeout(90);
await page.mouse.up();
snd = await waitSound(page, s0, ["capture_success", "capture_breakout"]);
await page.waitForFunction(() => !window.__pokeworld.battle, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1000);
const after = await g(() => window.__pokeworld.state.party.map((c) => `${c.species}:${c.ball}`));
check("battle catch: 포획 -> wheel -> aim -> throw -> caught in the chosen ball", battleLock && after.includes(`${foeSpecies}:great_ball`) && !(await g(() => window.__pokeworld.battle)), after.join(", "));

// Party, Pokédex, map
await page.keyboard.press("KeyP");
await page.waitForSelector(".modal .card", { timeout: 5000 });
const cards = await page.$$eval(".modal .card .card-title", (els) => els.map((e) => e.textContent));
await page.screenshot({ path: `${SHOTS}/play-12-party.png` });
check("party panel lists the caught Pokémon", cards.length >= 3, cards.join(" | "));
await page.keyboard.press("Escape");
await page.keyboard.press("KeyX");
await page.waitForSelector(".dex-grid", { timeout: 5000 });
const dex = await page.$$eval(".dex-entry.caught .dex-name", (els) => els.map((e) => e.textContent));
await page.screenshot({ path: `${SHOTS}/play-13-dex.png` });
check("Pokédex marks caught species", dex.includes("Pikachu") && dex.length >= 3, dex.join(","));
await page.keyboard.press("Escape");
await page.keyboard.press("KeyM");
await page.waitForSelector(".map-wrap canvas", { timeout: 5000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SHOTS}/play-14-map.png` });
check("map panel opens", true);
await page.keyboard.press("Escape");

// Save -> reload -> continue
const before = await g(() => ({ party: window.__pokeworld.state.party.map((c) => c.species), money: window.__pokeworld.state.money }));
await page.keyboard.press("KeyQ");
await page.waitForSelector(".modal .btn-primary");
await page.click(".modal .btn-primary");
await page.waitForTimeout(1500);
await page.goto(BASE);
await page.waitForSelector('[data-action="continue"]', { timeout: 20000 });
await page.click('[data-action="continue"]');
await waitGame(page);
const restored = await g(() => ({ party: window.__pokeworld.state.party.map((c) => c.species), money: window.__pokeworld.state.money }));
check("save/load restores the party", JSON.stringify(restored.party) === JSON.stringify(before.party), `${before.party} -> ${restored.party}`);

const perf = await g(() => window.__pokeworld.stats());
console.log("perf (software GL):", JSON.stringify(perf));
check("no runtime errors", errors.length === 0, errors.slice(0, 5).join(" || "));
await browser.close();
process.exit(summary() ? 0 : 1);
