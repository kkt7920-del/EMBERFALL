import type { ContentDB } from "@shared/data/contentDb";
import { computeStats, creatureName, expForLevel } from "@shared/data/stats";
import type { PlayerAction } from "@shared/protocol/messages";
import type { RegionDef } from "@shared/types/content";
import type { CreatureInstance, PlayerPrivateState } from "@shared/types/game";
import { OVERWORLD } from "@shared/world/terrain";
import { bar, h } from "./dom";
import { openModal } from "./Modal";

export interface PanelContext {
  db: ContentDB;
  region: RegionDef;
  state: () => PlayerPrivateState | null;
  send: (a: PlayerAction) => void;
  /** Capture orb thrown by the Capture button. */
  preferredOrb: string;
}

type Refreshable = { refresh: () => void; close: () => void } | null;

export function typeChips(db: ContentDB, types: string[]): HTMLElement {
  return h("span", null, ...types.map((t) => h("span", { class: "type", style: { background: db.typeColor(t) } }, db.typeName(t))));
}

export function creatureCard(db: ContentDB, c: CreatureInstance, extra?: HTMLElement): HTMLDivElement {
  const species = db.speciesOf(c);
  const stats = computeStats(species, c.level, c.ivs);
  const expFrom = expForLevel(c.level);
  const expTo = expForLevel(c.level + 1);
  const card = h(
    "div",
    { class: `card${c.hp <= 0 ? " fainted" : ""}` },
    h(
      "div",
      { class: "card-row" },
      h("div", { class: "swatch-big", style: { background: species.model.colors.primary, borderColor: species.model.colors.secondary } }),
      h(
        "div",
        { style: { flex: "1", minWidth: "0" } },
        h("div", { class: "card-title" }, `${creatureName(db, c)}  Lv.${c.level}`),
        typeChips(db, species.types),
        bar(c.hp / stats.hp),
        h("div", { class: "card-sub" }, `HP ${c.hp} / ${stats.hp}${c.hp <= 0 ? " · 기절" : ""}`),
        bar((c.exp - expFrom) / Math.max(1, expTo - expFrom), "exp"),
      ),
    ),
    h(
      "div",
      { class: "card-sub" },
      c.moves
        .map((m) => {
          const def = db.moves.get(m.id);
          return `${def?.name ?? m.id} ${m.pp}/${def?.pp ?? "?"}`;
        })
        .join(" · "),
    ),
  );
  if (extra) card.appendChild(extra);
  return card;
}

export class Panels {
  current: Refreshable = null;

  constructor(private readonly ctx: PanelContext) {}

  refresh(): void {
    this.current?.refresh();
  }

  closeAll(): void {
    this.current?.close();
    this.current = null;
  }

  private open(title: string, render: (body: HTMLElement) => void, onClose?: () => void): void {
    const body = h("div");
    const modal = openModal(title, body, () => {
      if (this.current?.close === handle.close) this.current = null;
      onClose?.();
    });
    const handle = {
      refresh: () => {
        body.replaceChildren();
        render(body);
      },
      close: () => modal.close(),
    };
    this.current = handle;
    handle.refresh();
  }

  party(opts: { title?: string; pick?: (index: number) => void; pickLabel?: string; canPick?: (c: CreatureInstance, i: number) => boolean } = {}): void {
    const { db } = this.ctx;
    this.open(opts.title ?? "파티", (body) => {
      const st = this.ctx.state();
      if (!st || st.party.length === 0) {
        body.append(h("p", null, "아직 크리처가 없다. 새싹마을 연구소의 레아 박사를 찾아가자."));
        return;
      }
      const heals = Object.entries(st.inventory).filter(([id, n]) => n > 0 && db.items.get(id)?.kind === "heal");
      const grid = h("div", { class: "grid" });
      st.party.forEach((c, i) => {
        const actions = h("div", { class: "actions" });
        if (opts.pick) {
          const ok = opts.canPick ? opts.canPick(c, i) : true;
          actions.append(
            h(
              "button",
              {
                class: "btn btn-small btn-primary",
                disabled: !ok,
                onclick: () => {
                  this.current?.close();
                  opts.pick!(i);
                },
              },
              opts.pickLabel ?? "선택",
            ),
          );
        } else {
          if (i > 0) actions.append(h("button", { class: "btn btn-small", onclick: () => this.ctx.send({ kind: "party_swap", a: 0, b: i }) }, "선두로"));
          for (const [id, n] of heals)
            actions.append(
              h("button", { class: "btn btn-small", onclick: () => this.ctx.send({ kind: "use_item", item: id, partyIndex: i }) }, `${db.items.get(id)!.name} (${n})`),
            );
        }
        grid.append(creatureCard(db, c, actions));
      });
      body.append(grid);
      if (st.boxCount > 0) body.append(h("p", { class: "card-sub" }, `보관함: ${st.boxCount}마리`));
      body.append(h("p", { class: "card-sub" }, `도감 — 발견 ${st.seen.length} · 포획 ${st.caught.length} / ${db.species.size}`));
    });
  }

  bag(opts: { inBattle?: boolean; onHeal?: (item: string) => void; onCapture?: (item: string) => void } = {}): void {
    const { db } = this.ctx;
    this.open("가방", (body) => {
      const st = this.ctx.state();
      const items = Object.entries(st?.inventory ?? {}).filter(([, n]) => n > 0);
      if (items.length === 0) {
        body.append(h("p", null, "가방이 비어 있다. 마을 상점에서 물건을 살 수 있다."));
        return;
      }
      const groups: [string, string][] = [
        ["heal", "회복"],
        ["capture", "포획구"],
        ["key", "중요한 물건"],
        ["material", "재료"],
      ];
      for (const [kind, label] of groups) {
        const list = items.filter(([id]) => db.items.get(id)?.kind === kind);
        if (!list.length) continue;
        body.append(h("h3", null, label));
        const grid = h("div", { class: "grid" });
        for (const [id, n] of list) {
          const item = db.items.get(id)!;
          const actions = h("div", { class: "actions" });
          if (item.kind === "heal") {
            actions.append(
              h(
                "button",
                {
                  class: "btn btn-small",
                  onclick: () => {
                    if (opts.onHeal) {
                      this.current?.close();
                      opts.onHeal(id);
                    } else this.party({ title: `${item.name} 사용`, pickLabel: "사용", pick: (i) => this.ctx.send({ kind: "use_item", item: id, partyIndex: i }) });
                  },
                },
                "사용",
              ),
            );
          }
          if (item.kind === "capture") {
            if (opts.inBattle && opts.onCapture) {
              actions.append(
                h(
                  "button",
                  {
                    class: "btn btn-small btn-primary",
                    onclick: () => {
                      this.current?.close();
                      opts.onCapture!(id);
                    },
                  },
                  "던지기",
                ),
              );
            } else {
              const chosen = this.ctx.preferredOrb === id;
              actions.append(
                h(
                  "button",
                  {
                    class: `btn btn-small${chosen ? " btn-primary" : ""}`,
                    onclick: () => {
                      this.ctx.preferredOrb = id;
                      this.refresh();
                    },
                  },
                  chosen ? "✔ 포획 버튼에 사용 중" : "포획 버튼에 사용",
                ),
              );
            }
          }
          grid.append(
            h(
              "div",
              { class: "card" },
              h(
                "div",
                { class: "card-row" },
                h("div", { class: "swatch", style: { width: "22px", height: "22px", borderRadius: "50%", background: item.color, border: "2px solid #fff" } }),
                h("div", { class: "card-title" }, `${item.name} ×${n}`),
              ),
              h("div", { class: "card-sub" }, item.description),
              actions,
            ),
          );
        }
        body.append(grid);
      }
    });
  }

  shop(items: { id: string; price: number }[]): void {
    const { db } = this.ctx;
    const counts = new Map(items.map((i) => [i.id, 1]));
    this.open("상점", (body) => {
      const st = this.ctx.state();
      body.append(h("p", { class: "card-sub" }, `소지금: ${(st?.money ?? 0).toLocaleString()}원`));
      const grid = h("div", { class: "grid" });
      for (const it of items) {
        const item = db.items.get(it.id)!;
        const n = counts.get(it.id) ?? 1;
        const total = it.price * n;
        grid.append(
          h(
            "div",
            { class: "card" },
            h("div", { class: "card-title" }, `${item.name} — ${it.price}원`),
            h("div", { class: "card-sub" }, `${item.description} (보유 ${st?.inventory[it.id] ?? 0})`),
            h(
              "div",
              { class: "actions" },
              h("button", { class: "btn btn-small", onclick: () => (counts.set(it.id, Math.max(1, n - 1)), this.refresh()) }, "−"),
              h("span", { class: "card-title", style: { minWidth: "2em", textAlign: "center", alignSelf: "center" } }, String(n)),
              h("button", { class: "btn btn-small", onclick: () => (counts.set(it.id, Math.min(99, n + 1)), this.refresh()) }, "+"),
              h(
                "button",
                {
                  class: "btn btn-small btn-primary",
                  disabled: (st?.money ?? 0) < total,
                  onclick: () => this.ctx.send({ kind: "buy", item: it.id, count: n }),
                },
                `${total}원 구입`,
              ),
            ),
          ),
        );
      }
      body.append(grid);
    });
  }

  starter(options: string[], onChoose: (species: string) => void): void {
    const { db } = this.ctx;
    this.open("파트너 선택", (body) => {
      body.append(h("p", null, "함께 여행할 첫 번째 파트너를 골라 주세요."));
      const grid = h("div", { class: "grid" });
      for (const id of options) {
        const s = db.species.get(id)!;
        grid.append(
          h(
            "div",
            { class: "card selectable", "data-species": id, onclick: () => (this.current?.close(), onChoose(id)) },
            h(
              "div",
              { class: "card-row" },
              h("div", { class: "swatch-big", style: { background: s.model.colors.primary, borderColor: s.model.colors.secondary } }),
              h("div", null, h("div", { class: "card-title" }, s.name), typeChips(db, s.types)),
            ),
            h("div", { class: "card-sub" }, s.description),
            h("button", { class: "btn btn-small btn-primary" }, `${s.name}(으)로 결정`),
          ),
        );
      }
      body.append(grid);
    });
  }

  map(opts: { zone: string; image: Promise<ImageData>; bounds: { minX: number; minZ: number; span: number }; player: { x: number; z: number; rotY: number } }): void {
    const { region } = this.ctx;
    this.open(opts.zone === OVERWORLD ? `지도 — ${region.name}` : "지도 — 메아리 동굴", (body) => {
      const canvas = h("canvas", { width: 1, height: 1 });
      const wrap = h("div", { class: "map-wrap" }, canvas);
      const place = (x: number, z: number) => ({
        left: `${((x - opts.bounds.minX) / opts.bounds.span) * 100}%`,
        top: `${(1 - (z - opts.bounds.minZ) / opts.bounds.span) * 100}%`,
      });
      const marker = (x: number, z: number, text: string) => wrap.append(h("div", { class: "map-marker", style: place(x, z) }, text));

      if (opts.zone === OVERWORLD) {
        for (const a of region.areas) if (!a.zone) marker(a.x, a.z, a.name);
        for (const b of region.buildings) if (b.kind !== "house") marker(b.x, b.z, b.kind === "center" ? "✚" : b.kind === "shop" ? "🛒" : "🔬");
        for (const r of region.ruins) marker(r.x, r.z, "🏛");
        for (const c of region.caves) marker(c.entrance.x, c.entrance.z, "⛰");
      } else {
        for (const it of region.interactables) if (it.zone === opts.zone) marker(it.x, it.z, it.kind === "cave_exit" ? "출구" : "✦");
      }
      const me = h("div", { class: "map-marker player", style: place(opts.player.x, opts.player.z) });
      wrap.append(me);
      body.append(wrap);
      body.append(h("p", { class: "card-sub", style: { textAlign: "center" } }, "● 현재 위치 · ✚ 회복 센터 · 🛒 상점 · 🔬 연구소 · ⛰ 동굴 · 🏛 유적"));

      void opts.image.then((img) => {
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext("2d")!.putImageData(img, 0, 0);
      });
    });
  }

  custom(title: string, render: (body: HTMLElement) => void, onClose?: () => void): void {
    this.open(title, render, onClose);
  }
}
