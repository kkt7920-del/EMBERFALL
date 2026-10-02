import { PROTOCOL_VERSION } from "@shared/config/constants";
import type { ServerMessage } from "@shared/protocol/messages";
import { loadContentFromDisk } from "@server/persistence/contentLoader";
import { MemoryStore } from "@server/persistence/PlayerStore";
import { Simulation } from "@server/sim/Simulation";

export const db = loadContentFromDisk(new URL("../../content", import.meta.url).pathname);

export async function setup(opts: { multiplayer?: boolean; store?: MemoryStore; seed?: number } = {}) {
  let t = 1_000_000;
  const store = opts.store ?? new MemoryStore();
  const sim = new Simulation({ db, store, multiplayer: opts.multiplayer ?? false, seed: opts.seed ?? 7, now: () => t });
  await sim.init();
  const inbox: ServerMessage[] = [];
  const player = await sim.join({ send: (m) => inbox.push(m) }, { type: "HELLO", protocol: PROTOCOL_VERSION, name: "테스터" });
  if (!player) throw new Error("join failed");
  const advance = (seconds: number) => {
    const ticks = Math.round(seconds * 20);
    for (let i = 0; i < ticks; i++) {
      t += 50;
      sim.tick();
    }
  };
  const last = <T extends ServerMessage["type"]>(type: T) =>
    [...inbox].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  return { sim, store, inbox, player, id: player.id, advance, last };
}
