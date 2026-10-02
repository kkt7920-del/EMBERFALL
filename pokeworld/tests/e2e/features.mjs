// Town services, trainer battle, cave travel, riding and flying.
import { check, collectErrors, launch, newGame, pw, summary } from "./lib.mjs";

const SHOTS = "tests/e2e/screenshots";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = collectErrors(page);
await newGame(page, "기능검사");
const dbg = (fn, arg) => pw(page, fn, arg);
const closeDialogs = async () => {
  for (let i = 0; i < 6 && (await page.$(".dialog:not(.hidden)")); i++) {
    await page.keyboard.press("KeyE");
    await page.waitForTimeout(150);
  }
};
const talk = async (zone, x, z, yaw) => {
  await dbg(([zone, x, z, yaw]) => { window.__pokeworld.debug.teleport(zone, x, z); window.__pokeworld.yaw = yaw; }, [zone, x, z, yaw]);
  await page.waitForTimeout(700);
  await page.keyboard.press("KeyE");
  await page.waitForSelector(".dialog:not(.hidden)", { timeout: 8000 }).catch(() => {});
};

// Shop
await dbg(() => window.__pokeworld.debug.addCreature("emberpup", 8));
await talk("overworld", 22.5, 1, 0);
await closeDialogs();
const shopOpen = await page.waitForSelector(".modal", { timeout: 5000 }).then(() => true).catch(() => false);
const before = await dbg(() => ({ money: window.__pokeworld.state.money, orbs: window.__pokeworld.state.inventory.capture_orb ?? 0 }));
if (shopOpen) {
  await page.click(".modal .btn-primary");
  await page.waitForFunction((m) => window.__pokeworld.state.money < m, before.money, { timeout: 5000 }).catch(() => {});
}
const after = await dbg(() => ({ money: window.__pokeworld.state.money, orbs: window.__pokeworld.state.inventory.capture_orb ?? 0 }));
check("shop sells a capture orb (server-validated money)", shopOpen && after.money === before.money - 200 && after.orbs === before.orbs + 1, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
await page.keyboard.press("Escape");

// Nurse heals
const hurt = await dbg(() => { const s = window.__pokeworld.game.connection.sim.playerSave("local"); s.party[0].hp = 1; return s.party[0].hp; });
await talk("overworld", -21.5, 0, 0);
await closeDialogs();
await page.waitForTimeout(500);
const healed = await dbg(() => window.__pokeworld.state.party[0].hp);
check("recovery center nurse heals the party", healed > hurt, `${hurt} -> ${healed}`);

// Trainer battle
await talk("overworld", -19.5, 107.5, 0);
await closeDialogs();
await page.waitForFunction(() => window.__pokeworld.battle?.kind === "trainer", null, { timeout: 10000 }).catch(() => {});
check("route trainer starts a trainer battle", (await dbg(() => window.__pokeworld.battle?.kind)) === "trainer");
await page.waitForSelector(".bmenu button.fight", { timeout: 20000 }).catch(() => {});
await page.screenshot({ path: `${SHOTS}/features-01-trainer.png` });
for (let i = 0; i < 80 && (await dbg(() => !!window.__pokeworld.battle)); i++) {
  if (await page.$(".bmenu button.fight")) {
    await page.click(".bmenu button.fight");
    await page.click(".bmenu button[data-move]");
  }
  await page.waitForTimeout(1500);
}
const won = await dbg(() => window.__pokeworld.state.flags.trainersDefeated.includes("bugboy_jihun"));
check("defeating the trainer is recorded by the server", won);
await closeDialogs();

// Cave travel
await talk("overworld", -258.5, 52.5, -Math.PI / 2);
await closeDialogs();
await page.waitForTimeout(1500);
const inCave = await dbg(() => window.__pokeworld.pos.zone);
check("cave entrance moves the player underground", inCave === "cave:echo_cave", inCave);
await page.waitForTimeout(2000);
await page.screenshot({ path: `${SHOTS}/features-02-cave.png` });
await talk("cave:echo_cave", 80.5, 11, Math.PI);
await closeDialogs();
await page.waitForTimeout(1500);
check("cave exit returns to the overworld", (await dbg(() => window.__pokeworld.pos.zone)) === "overworld");

// Riding (land) and flying
await dbg(() => window.__pokeworld.debug.addCreature("skyhawk", 22));
await page.waitForTimeout(400);
await dbg(() => { window.__pokeworld.debug.teleport("overworld", -20, 80); });
await page.waitForTimeout(600);
await page.keyboard.press("KeyT");
await page.waitForFunction(() => window.__pokeworld.state.mounted, null, { timeout: 5000 }).catch(() => {});
check("mount button rides a party creature", await dbg(() => window.__pokeworld.state.mounted));
const y0 = await dbg(() => window.__pokeworld.pos.y);
await page.keyboard.down("Space");
await page.keyboard.down("KeyW");
await page.waitForTimeout(2500);
await page.keyboard.up("Space");
await page.waitForTimeout(800);
const flying = await dbg(() => window.__pokeworld.pos);
await page.screenshot({ path: `${SHOTS}/features-03-flying.png` });
await page.keyboard.up("KeyW");
check("flying mount climbs into the air", flying.y > y0 + 4 && flying.anim === "fly", `y ${y0.toFixed(1)} -> ${flying.y.toFixed(1)} (${flying.anim})`);
await page.waitForTimeout(1200);
const corrected = await dbg(() => window.__pokeworld.pos);
check("server accepts the flight (no correction back)", corrected.y > y0 + 2, `y now ${corrected.y.toFixed(1)}`);
await page.keyboard.press("KeyT");
await page.waitForFunction(() => !window.__pokeworld.state.mounted, null, { timeout: 5000 }).catch(() => {});
check("dismount", !(await dbg(() => window.__pokeworld.state.mounted)));

check("no runtime errors", errors.length === 0, errors.slice(0, 4).join(" || "));
await browser.close();
process.exit(summary() ? 0 : 1);
