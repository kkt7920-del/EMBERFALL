// Town services, trainer battle, the cave (part of the voxel world), riding and flying.
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
const talk = async (x, z, yaw, id) => {
  await dbg(([x, z, yaw]) => { window.__pokeworld.debug.teleport(x, z); window.__pokeworld.yaw = yaw; }, [x, z, yaw]);
  // Wait until the world has loaded there and something is in reach before pressing E
  await page.waitForFunction((id) => window.__pokeworld.target?.id === id, id, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.keyboard.press("KeyE");
  await page.waitForSelector(".dialog:not(.hidden)", { timeout: 8000 }).catch(() => {});
};

// Shop
await dbg(() => window.__pokeworld.debug.addCreature("charmander", 8));
await talk(22.5, 1, 0, "clerk_tae");
await closeDialogs();
const shopOpen = await page.waitForSelector(".modal", { timeout: 5000 }).then(() => true).catch(() => false);
const before = await dbg(() => ({ money: window.__pokeworld.state.money, orbs: window.__pokeworld.state.inventory.poke_ball ?? 0 }));
if (shopOpen) {
  await page.click(".modal .btn-primary");
  await page.waitForFunction((m) => window.__pokeworld.state.money < m, before.money, { timeout: 5000 }).catch(() => {});
}
const after = await dbg(() => ({ money: window.__pokeworld.state.money, orbs: window.__pokeworld.state.inventory.poke_ball ?? 0 }));
check("shop sells a Poké Ball (server-validated money)", shopOpen && after.money === before.money - 200 && after.orbs === before.orbs + 1, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
await page.keyboard.press("Escape");

// Nurse heals
const hurt = await dbg(() => { const s = window.__pokeworld.game.connection.sim.playerSave("local"); s.party[0].hp = 1; return s.party[0].hp; });
await talk(-21.5, 0, 0, "nurse_hana");
await closeDialogs();
await page.waitForTimeout(500);
const healed = await dbg(() => window.__pokeworld.game.connection.sim.playerSave("local").party[0].hp);
const nurseTarget = await dbg(() => window.__pokeworld.target);
check("recovery center nurse heals the party (server save)", healed > hurt, `${hurt} -> ${healed} target ${JSON.stringify(nurseTarget?.id)}`);

// Trainer battle
await talk(-19.5, 107.5, 0, "trainer_jihun");
await closeDialogs();
await page.waitForFunction(() => window.__pokeworld.battle?.kind === "trainer", null, { timeout: 10000 }).catch(() => {});
check("route trainer starts a trainer battle", (await dbg(() => window.__pokeworld.battle?.kind)) === "trainer");
await page.waitForSelector(".bmenu button.fight", { timeout: 20000 }).catch(() => {});
await page.screenshot({ path: `${SHOTS}/features-01-trainer.png` });
const tlog = [];
for (let i = 0; i < 80 && (await dbg(() => !!window.__pokeworld.battle)); i++) {
  if (await page.$(".bmenu button.fight")) {
    await page.click(".bmenu button.fight");
    // Strongest damaging move (not a stat move like Growl)
    const best = await page.evaluate(() => {
      const db = window.__pokeworld.game.db;
      const ids = [...document.querySelectorAll(".bmenu button[data-move]:not([disabled])")].map((b) => b.dataset.move);
      ids.sort((a, b) => (db.moves.get(b)?.power ?? 0) - (db.moves.get(a)?.power ?? 0));
      return ids[0];
    });
    await page.click(`.bmenu button[data-move="${best}"]`);
    tlog.push(best);
  }
  const msg = (await page.textContent(".bmessage").catch(() => "")) + ` [hp ${await dbg(() => window.__pokeworld.battle?.party?.[0]?.hp ?? window.__pokeworld.battle?.mine?.hp)}]`;
  if (msg && tlog[tlog.length - 1] !== msg) tlog.push(msg);
  await page.waitForTimeout(1500);
}
const won = await dbg(() => window.__pokeworld.state.flags.trainersDefeated.includes("bugboy_jihun"));
const tstate = await dbg(() => ({ battle: window.__pokeworld.battle, party: window.__pokeworld.state.party.map((c) => `${c.species}:${c.hp}`) }));
check("defeating the trainer is recorded by the server", won, JSON.stringify(tstate).slice(0, 300) + " | " + tlog.join(" / ").slice(0, 1500));
await closeDialogs();

// The cave is part of the block world: walk in through the mouth and down the tunnel
await dbg(() => { window.__pokeworld.debug.teleport(-240, 49); window.__pokeworld.debug.setHour(12); });
await page.waitForTimeout(5000);
const outside = await dbg(() => ({ biome: window.__pokeworld.biome(Math.floor(window.__pokeworld.pos.x), Math.floor(window.__pokeworld.pos.y), Math.floor(window.__pokeworld.pos.z)), sky: window.__pokeworld.game.voxels.skyVisible(window.__pokeworld.pos.x, window.__pokeworld.pos.y + 1, window.__pokeworld.pos.z) }));
await dbg(() => window.__pokeworld.debug.teleport(-284, 60, 64));
await page.waitForTimeout(5000);
const inside = await dbg(() => {
  const w = window.__pokeworld;
  const p = w.pos;
  return { p, biome: w.biome(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), sky: w.game.voxels.skyVisible(p.x, p.y + 1, p.z), location: document.querySelector(".hud-location")?.textContent };
});
await page.screenshot({ path: `${SHOTS}/features-02-cave.png` });
check("cave tunnels are carved into the terrain (underground biome, no sky)", /cave|cavern/.test(inside.biome) && !inside.sky && outside.sky, JSON.stringify({ outside, inside }));
check("HUD names the cave", /동굴/.test(inside.location ?? ""), inside.location);

// Riding (land) and flying
await dbg(() => window.__pokeworld.debug.addCreature("pidgeot", 36));
await page.waitForTimeout(400);
await dbg(() => { window.__pokeworld.debug.teleport(-20, 80); });
await page.waitForTimeout(600);
await page.keyboard.press("KeyT");
await page.waitForFunction(() => window.__pokeworld.state.mounted, null, { timeout: 5000 }).catch(() => {});
check("mount button rides a party creature", await dbg(() => window.__pokeworld.state.mounted));
const y0 = await dbg(() => window.__pokeworld.pos.y);
await page.keyboard.down("Space");
await page.keyboard.down("KeyW");
await page.waitForTimeout(5000);
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
