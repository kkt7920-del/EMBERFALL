import { PROTOCOL_VERSION, TICK_RATE } from "@shared/config/constants";
import type { ContentDB } from "@shared/data/contentDb";
import type { VoxelWorld } from "@shared/world/voxelWorld";
import type { ClientMessage, ServerMessage } from "@shared/protocol/messages";
import { Simulation } from "@server/sim/Simulation";
import { IndexedDbStore } from "../save/IndexedDbStore";
import type { ConnectionStatus, GameConnection } from "./Connection";

/**
 * Runs the authoritative Simulation inside the browser for single player.
 * Messages are delivered asynchronously and cloned, exactly as if they had
 * crossed a network, so gameplay code cannot tell the difference.
 */
export class LocalConnection implements GameConnection {
  readonly mode = "local" as const;
  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (status: ConnectionStatus, detail?: string) => void = () => {};

  readonly store = new IndexedDbStore();
  sim: Simulation | null = null;
  private timer: number | null = null;
  private playerId = "local";
  private closed = false;
  private voxels: VoxelWorld | undefined;

  constructor(private readonly db: ContentDB) {}

  /** Shares the renderer's voxel store with the simulation (no duplicate world generation). */
  setVoxels(v: VoxelWorld): void {
    this.voxels = v;
  }

  async connect(name: string): Promise<void> {
    this.onStatus("connecting");
    const sim = new Simulation({ db: this.db, store: this.store, multiplayer: false, voxels: this.voxels, log: (m) => console.debug("[local]", m) });
    await sim.init();
    this.sim = sim;
    const player = await sim.join(
      {
        send: (m) => {
          const copy = structuredClone(m);
          queueMicrotask(() => {
            if (!this.closed) this.onMessage(copy);
          });
        },
      },
      { type: "HELLO", protocol: PROTOCOL_VERSION, name, playerId: this.playerId },
    );
    if (!player) throw new Error("local join failed");
    this.timer = window.setInterval(() => sim.tick(), 1000 / TICK_RATE);

    // Save when the tab is hidden or closed (mobile browsers may kill it any time after)
    document.addEventListener("visibilitychange", this.onHide);
    window.addEventListener("pagehide", this.onHide);
    this.onStatus("open");
  }

  private onHide = (e: Event) => {
    if (e.type === "visibilitychange" && document.visibilityState !== "hidden") return;
    void this.sim?.saveNow(this.playerId);
  };

  send(msg: ClientMessage): void {
    const copy = structuredClone(msg);
    queueMicrotask(() => this.sim?.handle(this.playerId, copy));
  }

  async saveNow(): Promise<void> {
    await this.sim?.saveNow(this.playerId);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.onHide);
    window.removeEventListener("pagehide", this.onHide);
    void this.sim?.leave(this.playerId);
    this.onStatus("closed");
  }
}
