import { describe, expect, it } from "vitest";
import { MemoryStore } from "@server/persistence/PlayerStore";
import { PROTOCOL_VERSION } from "@shared/config/constants";
import { migrateSave } from "@shared/types/save";
import { solveThrow } from "@shared/capture/ballPhysics";
import type { Simulation } from "@server/sim/Simulation";
import { setup } from "./helpers";

/** Throws a ball from the player's hand at a wild Pokémon, the way the client does. */
function throwAt(sim: Simulation, id: string, wid: string, ball: string, seq: number, miss = false): void {
  const p = sim.playerSave(id)!;
  const c = sim.creaturesNear(id).find((w) => w.id === wid)!;
  const from = { x: p.x, y: p.y + 1.5, z: p.z };
  const dx = c.x - from.x + (miss ? 6 : 0);
  const dy = c.y + 0.25 - from.y;
  const dz = c.z - from.z;
  const v = solveThrow(dx, dy, dz, 14)!;
  sim.handle(id, { type: "BALL_THROW", seq, ball, x: from.x, y: from.y, z: from.z, vx: v.vx, vy: v.vy, vz: v.vz });
}

describe("simulation", () => {
  it("welcomes a new player at the region spawn with starting money", async () => {
    const { last } = await setup();
    const w = last("WELCOME")!;
    expect(w.self.zone).toBe("overworld");
    expect(w.state.money).toBe(3000);
    expect(w.state.party).toHaveLength(0);
    expect(last("QUEST_UPDATE")?.started).toContain("q_first_partner");
  });

  it("starter flow: talk to professor, choose partner, quest completes", async () => {
    const { sim, id, last } = await setup();
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "prof_rhea" } });
    const dialog = last("DIALOG")!;
    expect(dialog.choice?.kind).toBe("starter");
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "choose_starter", species: "charmander" } });
    const st = last("PLAYER_STATE")!.state;
    expect(st.party[0].species).toBe("charmander");
    expect(st.inventory.poke_ball).toBe(10);
    expect(st.quests.completed).toContain("q_first_partner");
    expect(Object.keys(st.quests.active)).toContain("q_first_catch");
    // Cannot take a second starter
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "choose_starter", species: "bulbasaur" } });
    expect(sim.playerSave(id)!.party).toHaveLength(1);
  });

  it("rejects teleport-sized movement (server authoritative)", async () => {
    const { sim, id, last } = await setup();
    sim.handle(id, { type: "PLAYER_MOVE", seq: 1, x: 300, y: 30, z: 300, rotY: 0, anim: "run" });
    expect(last("PLAYER_CORRECT")?.reason).toBe("movement");
    expect(sim.playerSave(id)!.x).toBeLessThan(10);
  });

  it("spawns wild creatures near the player and replicates them", async () => {
    const { sim, id, advance, inbox } = await setup();
    sim.debugTeleport(id, -20, 110);
    advance(12);
    const spawned = inbox.filter((m) => m.type === "POKEMON_SPAWN").flatMap((m) => (m.type === "POKEMON_SPAWN" ? m.creatures : []));
    expect(spawned.length).toBeGreaterThan(2);
    expect(sim.creaturesNear(id).length).toBeGreaterThan(2);
  });

  it("battle catch: a real throw at the foe ends the battle and adds it to the party", async () => {
    const { sim, id, last, advance } = await setup({ seed: 11 });
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "prof_rhea" } });
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "choose_starter", species: "charmander" } });
    sim.debugTeleport(id, 30, -40);
    const wid = sim.debugSpawn(id, "caterpie", 3, 4, { hpFraction: 0.3 })!;
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "battle", target: wid } });
    const start = last("BATTLE_START")!;
    expect(start.battle.entityId).toBe(wid);
    sim.debugForceCapture("success");
    const balls = sim.playerSave(id)!.inventory.poke_ball;
    throwAt(sim, id, wid, "poke_ball", 1);
    expect(sim.playerSave(id)!.inventory.poke_ball).toBe(balls - 1);
    advance(1);
    const seqMsg = last("CAPTURE_SEQUENCE")!;
    expect(seqMsg.targetId).toBe(wid);
    expect(seqMsg.hit).toBeTruthy();
    expect(seqMsg.shakes).toBe(3);
    advance(8);
    const r = last("CAPTURE_RESULT")!;
    expect(r.success).toBe(true);
    expect(r.sentTo).toBe("party");
    const save = sim.playerSave(id)!;
    expect(save.party.map((c) => c.species)).toEqual(["charmander", "caterpie"]);
    expect(save.party[1].ball).toBe("poke_ball");
    expect(save.caught).toContain("caterpie");
    expect(save.quests.completed).toContain("q_first_catch");
    expect(last("BATTLE_RESULT")?.outcome).toBe("capture");
  });

  it("field throws: breakout keeps the Pokémon, a full party sends catches to the PC", async () => {
    const { sim, id, last, advance } = await setup({ seed: 3 });
    sim.debugTeleport(id, 30, -40);
    const save = sim.playerSave(id)!;
    save.inventory.great_ball = 10;
    for (const sp of ["bulbasaur", "squirtle", "pidgey", "rattata", "oddish", "caterpie"]) sim.debugAddCreature(id, sp, 5);
    expect(save.party).toHaveLength(6);

    const wid = sim.debugSpawn(id, "pikachu", 5, 5)!;
    sim.debugForceCapture("fail");
    throwAt(sim, id, wid, "great_ball", 1);
    advance(10);
    expect(last("CAPTURE_RESULT")!.success).toBe(false);
    expect(sim.creaturesNear(id).some((c) => c.id === wid)).toBe(true);
    expect(save.inventory.great_ball).toBe(9);

    sim.debugForceCapture("success");
    throwAt(sim, id, wid, "great_ball", 2);
    advance(10);
    const r = last("CAPTURE_RESULT")!;
    expect(r.success).toBe(true);
    expect(r.sentTo).toBe("box");
    expect(save.box.map((c) => c.species)).toContain("pikachu");
    expect(sim.creaturesNear(id).some((c) => c.id === wid)).toBe(false);
  });

  it("a missed ball lands, rests and is picked up again", async () => {
    const { sim, id, advance } = await setup({ seed: 4 });
    sim.debugTeleport(id, 30, -40);
    const save = sim.playerSave(id)!;
    save.inventory.poke_ball = 3;
    const wid = sim.debugSpawn(id, "pidgey", 3, 6)!;
    throwAt(sim, id, wid, "poke_ball", 1, true);
    expect(save.inventory.poke_ball).toBe(2);
    advance(6);
    const [ball] = sim.ballsNear(id);
    expect(ball.resting).toBe(true);
    sim.debugTeleport(id, ball.x, ball.z);
    advance(1);
    expect(sim.ballsNear(id)).toHaveLength(0);
    expect(save.inventory.poke_ball).toBe(3);
  });

  it("rejects throws without the ball or with impossible speed", async () => {
    const { sim, id, last } = await setup();
    const p = sim.playerSave(id)!;
    sim.handle(id, { type: "BALL_THROW", seq: 1, ball: "master_ball", x: p.x, y: p.y + 1.5, z: p.z, vx: 0, vy: 5, vz: 10 });
    expect(last("BALL_UPDATE")).toMatchObject({ id: "seq:1", kind: "remove" });
    p.inventory.poke_ball = 1;
    sim.handle(id, { type: "BALL_THROW", seq: 2, ball: "poke_ball", x: p.x, y: p.y + 1.5, z: p.z, vx: 0, vy: 0, vz: 500 });
    expect(last("BALL_UPDATE")).toMatchObject({ id: "seq:2", kind: "remove" });
    expect(p.inventory.poke_ball).toBe(1);
  });

  it("legendary event graph: rumor -> ruin -> tablet -> shard -> night offering -> guardian", async () => {
    const { sim, id, last } = await setup({ seed: 5 });
    const save = sim.playerSave(id)!;
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "prof_rhea" } });
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "choose_starter", species: "charmander" } });

    sim.debugTeleport(id, -14, -10);
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "elder_moru" } });
    expect(save.legendary.nodes.dawn_guardian).toContain("rumor");

    sim.debugTeleport(id, 230, 262);
    expect(save.legendary.nodes.dawn_guardian).toContain("find_ruin");
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "ruin_tablet" } });
    expect(save.legendary.nodes.dawn_guardian).toContain("tablet");

    // Altar does nothing special before the shard step
    sim.debugTeleport(id, 230, 269);
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "ruin_altar" } });
    expect(last("DIALOG")!.lines.join(" ")).toMatch(/제단/);
    expect(last("BATTLE_START")).toBeUndefined();

    sim.debugTeleport(id, -362, 72, 36);
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "cave_crystal" } });
    expect(save.inventory.crystal_shard).toBe(1);
    expect(save.legendary.nodes.dawn_guardian).toContain("shard");

    // Daytime offering is refused
    sim.debugTeleport(id, 230, 269);
    sim.debugSetHour(12);
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "ruin_altar" } });
    expect(last("DIALOG")!.lines.join(" ")).toMatch(/때가 아닌/);
    expect(save.inventory.crystal_shard).toBe(1);

    sim.debugSetHour(23);
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "ruin_altar" } });
    expect(save.legendary.nodes.dawn_guardian).toContain("offering");
    const start = last("BATTLE_START")!;
    expect(start.battle.kind).toBe("guardian");
    expect(start.battle.canCapture).toBe(false);
    expect(save.inventory.crystal_shard ?? 0).toBe(0);
  });

  it("saves, migrates and restores a player", async () => {
    const store = new MemoryStore();
    const a = await setup({ store });
    a.sim.handle(a.id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "prof_rhea" } });
    a.sim.handle(a.id, { type: "PLAYER_ACTION", action: { kind: "choose_starter", species: "squirtle" } });
    await a.sim.leave(a.id);

    const saved = store.players.get("local")!;
    expect(saved.party[0].species).toBe("squirtle");

    const b = await setup({ store });
    expect(b.last("WELCOME")!.state.party[0].species).toBe("squirtle");

    const old = { ...structuredClone(saved), version: 0 } as Record<string, unknown>;
    delete old.flags;
    delete old.legendary;
    const migrated = migrateSave(old);
    expect(migrated.version).toBe(2);
    expect(migrated.flags.starterChosen).toBe(true);
    // A version-1 save with the old placeholder creatures becomes real Pokémon
    const v1 = { ...structuredClone(saved), version: 1, inventory: { capture_orb: 4 } } as Record<string, unknown>;
    (v1.party as { species: string }[])[0].species = "leafbun";
    const m1 = migrateSave(v1);
    expect(m1.party[0].species).toBe("bulbasaur");
    expect(m1.inventory.poke_ball).toBe(4);
  });

  it("multiplayer requires the token to resume a player", async () => {
    const store = new MemoryStore();
    const a = await setup({ store, multiplayer: true });
    const welcome = a.last("WELCOME")!;
    await a.sim.leave(a.id);

    const inbox: { type: string; playerId?: string }[] = [];
    const resumed = await a.sim.join({ send: (m) => inbox.push(m as never) }, {
      type: "HELLO",
      protocol: PROTOCOL_VERSION,
      name: "x",
      playerId: welcome.playerId,
      token: welcome.token,
    });
    expect(resumed?.id).toBe(welcome.playerId);
    await a.sim.leave(resumed!.id);

    const forged = await a.sim.join({ send: () => {} }, { type: "HELLO", protocol: PROTOCOL_VERSION, name: "x", playerId: welcome.playerId, token: "wrong" });
    expect(forged?.id).not.toBe(welcome.playerId);
  });
});
