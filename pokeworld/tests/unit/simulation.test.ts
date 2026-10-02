import { describe, expect, it } from "vitest";
import { MemoryStore } from "@server/persistence/PlayerStore";
import { PROTOCOL_VERSION } from "@shared/config/constants";
import { migrateSave } from "@shared/types/save";
import { setup } from "./helpers";

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
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "choose_starter", species: "emberpup" } });
    const st = last("PLAYER_STATE")!.state;
    expect(st.party[0].species).toBe("emberpup");
    expect(st.inventory.capture_orb).toBe(5);
    expect(st.quests.completed).toContain("q_first_partner");
    expect(Object.keys(st.quests.active)).toContain("q_first_catch");
    // Cannot take a second starter
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "choose_starter", species: "leafbun" } });
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
    sim.debugTeleport(id, "overworld", -20, 110);
    advance(12);
    const spawned = inbox.filter((m) => m.type === "POKEMON_SPAWN").flatMap((m) => (m.type === "POKEMON_SPAWN" ? m.creatures : []));
    expect(spawned.length).toBeGreaterThan(2);
    expect(sim.creaturesNear(id).length).toBeGreaterThan(2);
  });

  it("wild battle -> capture adds to party and advances the catch quest", async () => {
    const { sim, id, last } = await setup({ seed: 11 });
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "prof_rhea" } });
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "choose_starter", species: "emberpup" } });
    sim.playerSave(id)!.inventory.great_orb = 30;

    let captured = false;
    for (let attempt = 0; attempt < 10 && !captured; attempt++) {
      const wid = sim.debugSpawn(id, "meadowbug", 2, 3)!;
      sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "battle", target: wid } });
      const start = last("BATTLE_START")!;
      expect(start.battle.entityId).toBe(wid);
      for (let i = 0; i < 6; i++) {
        sim.handle(id, { type: "BATTLE_ACTION", battleId: start.battle.id, action: { kind: "capture", item: "great_orb" } });
        const r = last("BATTLE_RESULT")!;
        if (r.outcome === "capture") captured = true;
        if (r.outcome) break;
      }
    }
    expect(captured).toBe(true);
    const save = sim.playerSave(id)!;
    expect(save.party.length).toBe(2);
    expect(save.caught).toContain("meadowbug");
    expect(save.quests.completed).toContain("q_first_catch");
  });

  it("overworld throw can capture without a battle", async () => {
    const { sim, id, last } = await setup({ seed: 3 });
    sim.playerSave(id)!.inventory.great_orb = 50;
    let success = false;
    for (let i = 0; i < 25 && !success; i++) {
      const wid = sim.debugSpawn(id, "meadowbug", 2, 5)!;
      sim.handle(id, { type: "CAPTURE_THROW", targetId: wid, item: "great_orb" });
      success = last("CAPTURE_RESULT")!.success;
    }
    expect(success).toBe(true);
    expect(sim.playerSave(id)!.party.length).toBe(1);
  });

  it("legendary event graph: rumor -> ruin -> tablet -> shard -> night offering -> guardian", async () => {
    const { sim, id, last } = await setup({ seed: 5 });
    const save = sim.playerSave(id)!;
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "prof_rhea" } });
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "choose_starter", species: "emberpup" } });

    sim.debugTeleport(id, "overworld", -14, -9);
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "elder_moru" } });
    expect(save.legendary.nodes.dawn_guardian).toContain("rumor");

    sim.debugTeleport(id, "overworld", 230, 260);
    expect(save.legendary.nodes.dawn_guardian).toContain("find_ruin");
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "ruin_tablet" } });
    expect(save.legendary.nodes.dawn_guardian).toContain("tablet");

    // Altar does nothing special before the shard step
    sim.debugTeleport(id, "overworld", 230, 267);
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "ruin_altar" } });
    expect(last("DIALOG")!.lines.join(" ")).toMatch(/제단/);
    expect(last("BATTLE_START")).toBeUndefined();

    sim.debugTeleport(id, "cave:echo_cave", 82, 141);
    sim.handle(id, { type: "PLAYER_ACTION", action: { kind: "interact", target: "cave_crystal" } });
    expect(save.inventory.crystal_shard).toBe(1);
    expect(save.legendary.nodes.dawn_guardian).toContain("shard");

    // Daytime offering is refused
    sim.debugTeleport(id, "overworld", 230, 267);
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
    a.sim.handle(a.id, { type: "PLAYER_ACTION", action: { kind: "choose_starter", species: "dropnewt" } });
    await a.sim.leave(a.id);

    const saved = store.players.get("local")!;
    expect(saved.party[0].species).toBe("dropnewt");

    const b = await setup({ store });
    expect(b.last("WELCOME")!.state.party[0].species).toBe("dropnewt");

    const old = { ...structuredClone(saved), version: 0 } as Record<string, unknown>;
    delete old.flags;
    delete old.legendary;
    const migrated = migrateSave(old);
    expect(migrated.version).toBe(1);
    expect(migrated.flags.starterChosen).toBe(true);
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
