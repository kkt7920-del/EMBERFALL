import type { ContentDB } from "@shared/data/contentDb";
import { NATURES, creatureName, expForLevel, statsOf } from "@shared/data/stats";
import type { PlayerAction } from "@shared/protocol/messages";
import type { RegionDef, SpeciesDef } from "@shared/types/content";
import type { CreatureInstance, PlayerPrivateState, WildSnapshot } from "@shared/types/game";
import { MISSING_POKEMON_ASSET, type PokemonAssetRegistry } from "../pokemon/PokemonAssetRegistry";
import { ballIcon } from "./BallHud";
import { STATUS_LABEL } from "./BattleUI";
import { bar, h } from "./dom";
import { openModal } from "./Modal";

export interface PanelContext {
  db: ContentDB;
  region: RegionDef;
  assets: PokemonAssetRegistry;
  state: () => PlayerPrivateState | null;
  send: (a: PlayerAction) => void;
  /** Takes a ball in hand (bag "손에 들기"). */
  equipBall: (item: string) => void;
}

type Refreshable = { refresh: () => void; close: () => void } | null;

const STAT_LABEL: Record<string, string> = { hp: "HP", atk: "공격", def: "방어", spa: "특수공격", spd: "특수방어", spe: "스피드" };

export function typeChips(db: ContentDB, types: string[]): HTMLElement {
  return h("span", null, ...types.map((t) => h("span", { class: "type", style: { background: db.typeColor(t) } }, db.typeName(t))));
}

export function genderMark(g: string): HTMLElement | null {
  if (g === "male") return h("b", { class: "gender male" }, "♂");
  if (g === "female") return h("b", { class: "gender female" }, "♀");
  return null;
}

function dexTag(s: SpeciesDef): string {
  return `#${String(s.dexNumber).padStart(3, "0")}`;
}

/** Portrait badge: model status + dex number + type colour (no stand-in art). */
function portrait(db: ContentDB, assets: PokemonAssetRegistry, s: SpeciesDef, big = false): HTMLElement {
  const status = assets.statusOf(s);
  return h(
    "div",
    { class: `portrait${big ? " big" : ""} asset-${status}`, style: { borderColor: db.typeColor(s.types[0]) }, title: status === "missing" ? MISSING_POKEMON_ASSET : "" },
    h("span", { class: "dex" }, dexTag(s)),
    h("span", { class: "asset" }, status === "ready" ? "3D" : status === "loading" ? "…" : status === "error" ? "ERR" : "NO MODEL"),
  );
}

export function creatureCard(db: ContentDB, assets: PokemonAssetRegistry, c: CreatureInstance, extra?: HTMLElement, onDetail?: () => void): HTMLDivElement {
  const species = db.speciesOf(c);
  const stats = statsOf(db, c);
  const expFrom = expForLevel(c.level);
  const expTo = expForLevel(c.level + 1);
  const card = h(
    "div",
    { class: `card${c.hp <= 0 ? " fainted" : ""}`, "data-uid": c.uid },
    h(
      "div",
      { class: "card-row" },
      portrait(db, assets, species),
      h(
        "div",
        { style: { flex: "1", minWidth: "0" } },
        h("div", { class: "card-title" }, `${creatureName(db, c)} `, genderMark(c.gender), ` Lv.${c.level}`, c.alpha ? h("b", { class: "alpha-badge" }, "ALPHA") : null),
        typeChips(db, species.types),
        c.status ? h("span", { class: `status-chip s-${c.status}` }, STATUS_LABEL[c.status]) : null,
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
  if (onDetail) extra?.prepend(h("button", { class: "btn btn-small", onclick: onDetail }, "상세"));
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
    const { db, assets } = this.ctx;
    this.open(opts.title ?? "파티", (body) => {
      const st = this.ctx.state();
      if (!st || st.party.length === 0) {
        body.append(h("p", null, "아직 포켓몬이 없다. 새싹마을 연구소의 레아 박사를 찾아가자."));
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
            actions.append(h("button", { class: "btn btn-small", onclick: () => this.ctx.send({ kind: "use_item", item: id, partyIndex: i }) }, `${db.items.get(id)!.name} (${n})`));
        }
        grid.append(creatureCard(db, assets, c, actions, opts.pick ? undefined : () => this.detail(c)));
      });
      body.append(grid);
      body.append(
        h(
          "div",
          { class: "actions" },
          h("button", { class: "btn btn-small", onclick: () => this.pc() }, `PC 보관함 (${st.boxCount})`),
          h("button", { class: "btn btn-small", onclick: () => this.pokedex() }, `도감 — 발견 ${st.seen.length} · 포획 ${st.caught.length} / ${db.species.size}`),
        ),
      );
    });
  }

  /** Full summary of one owned Pokémon. */
  detail(c: CreatureInstance): void {
    const { db, assets } = this.ctx;
    const s = db.speciesOf(c);
    this.open(`${creatureName(db, c)} 상세`, (body) => {
      const stats = statsOf(db, c);
      const nature = NATURES[c.nature];
      const ball = c.ball ? db.items.get(c.ball) : undefined;
      body.append(
        h(
          "div",
          { class: "card-row" },
          portrait(db, assets, s, true),
          h(
            "div",
            null,
            h("div", { class: "card-title" }, `${dexTag(s)} ${s.name} `, genderMark(c.gender), ` Lv.${c.level}`, c.alpha ? h("b", { class: "alpha-badge" }, "ALPHA") : null),
            typeChips(db, s.types),
            h("div", { class: "card-sub" }, `키 ${(s.height * c.size).toFixed(2)} m · 몸무게 ${(s.weight * c.size ** 3).toFixed(1)} kg · 개체 크기 ×${c.size.toFixed(2)}`),
          ),
        ),
        h(
          "table",
          { class: "info-table" },
          h("tr", null, h("th", null, "특성"), h("td", null, c.ability)),
          h("tr", null, h("th", null, "성격"), h("td", null, `${c.nature} (${nature?.ko ?? ""})${nature?.up ? ` · ${STAT_LABEL[nature.up]}↑ ${STAT_LABEL[nature.down!]}↓` : ""}`)),
          h("tr", null, h("th", null, "상태"), h("td", null, c.status ? STATUS_LABEL[c.status] : "정상")),
          h("tr", null, h("th", null, "잡은 볼"), h("td", null, ball ? h("span", null, ballIcon(ball.ball, 16), ` ${ball.name}`) : "—")),
          h("tr", null, h("th", null, "만난 곳"), h("td", null, `${c.origin ?? "—"}${c.metLevel ? ` (Lv.${c.metLevel})` : ""}`)),
          h("tr", null, h("th", null, "모델"), h("td", null, assets.statusOf(s) === "missing" ? MISSING_POKEMON_ASSET : assets.statusOf(s))),
        ),
        h("h3", null, "능력치"),
        h(
          "div",
          { class: "stat-bars" },
          ...Object.entries(stats).map(([k, v]) =>
            h("div", { class: "stat-row" }, h("span", null, STAT_LABEL[k]), h("div", { class: "bar stat" }, h("div", { style: { width: `${Math.min(100, (v / (k === "hp" ? 250 : 200)) * 100)}%` } })), h("b", null, String(v))),
          ),
        ),
        h("h3", null, "기술"),
        h(
          "div",
          { class: "grid" },
          ...c.moves.map((m) => {
            const def = db.moves.get(m.id);
            return h(
              "div",
              { class: "card move-card", style: { borderColor: db.typeColor(def?.type ?? "normal") } },
              h("div", { class: "card-title" }, def?.name ?? m.id),
              h("div", { class: "card-sub" }, `${db.typeName(def?.type ?? "normal")} · ${def?.category === "physical" ? "물리" : def?.category === "special" ? "특수" : "변화"}${def?.power ? ` · 위력 ${def.power}` : ""} · PP ${m.pp}/${def?.pp ?? "?"}`),
            );
          }),
        ),
      );
    });
  }

  /** Quick info for a wild Pokémon (long-press / interaction key). */
  wildInfo(w: WildSnapshot, onBattle?: () => void): void {
    const { db, assets } = this.ctx;
    const s = db.species.get(w.species)!;
    this.open("포켓몬 정보", (body) => {
      body.append(
        h(
          "div",
          { class: "card-row" },
          portrait(db, assets, s, true),
          h(
            "div",
            null,
            h("div", { class: "card-title" }, `${s.name} `, genderMark(w.gender), ` Lv. ${w.level}`, w.alpha ? h("b", { class: "alpha-badge" }, "ALPHA") : null),
            typeChips(db, s.types),
            bar(w.hp / w.maxHp),
            h("div", { class: "card-sub" }, `HP ${w.hp} / ${w.maxHp} · 상태: ${w.status ? STATUS_LABEL[w.status] : "정상"}`),
            h("div", { class: "card-sub" }, `${dexTag(s)} · 키 ${(s.height * w.size).toFixed(2)} m${assets.statusOf(s) === "missing" ? ` · ${MISSING_POKEMON_ASSET}` : ""}`),
          ),
        ),
        h("div", { class: "actions" }, onBattle ? h("button", { class: "btn btn-primary", onclick: () => (this.current?.close(), onBattle()) }, "배틀") : null, h("button", { class: "btn", onclick: () => this.current?.close() }, "닫기")),
      );
    });
  }

  pc(): void {
    const { db, assets } = this.ctx;
    this.open("PC 보관함", (body) => {
      const st = this.ctx.state();
      const box = st?.box ?? [];
      body.append(h("p", { class: "card-sub" }, "파티가 6마리로 가득 찼을 때 잡은 포켓몬은 PC 보관함으로 보내집니다."));
      if (!box.length) {
        body.append(h("p", null, "보관함이 비어 있다."));
        return;
      }
      body.append(h("div", { class: "grid" }, ...box.map((c) => creatureCard(db, assets, c, h("div", { class: "actions" }), () => this.detail(c)))));
    });
  }

  pokedex(): void {
    const { db, assets } = this.ctx;
    this.open("포켓몬 도감", (body) => {
      const st = this.ctx.state();
      const seen = new Set(st?.seen ?? []);
      const caught = new Set(st?.caught ?? []);
      const list = [...db.species.values()].sort((a, b) => a.dexNumber - b.dexNumber);
      const r = assets.report();
      body.append(
        h("p", { class: "card-sub" }, `발견 ${seen.size} · 포획 ${caught.size} / ${list.length}  ·  3D 모델 ${r.available}/${r.total} (없으면 ${MISSING_POKEMON_ASSET})`),
        h(
          "div",
          { class: "dex-grid" },
          ...list.map((s) => {
            const state = caught.has(s.id) ? "caught" : seen.has(s.id) ? "seen" : "unknown";
            return h(
              "div",
              { class: `dex-entry ${state}`, "data-species": s.id },
              h("span", { class: "dex" }, dexTag(s)),
              h("span", { class: "dex-name" }, state === "unknown" ? "???" : s.name),
              state === "unknown" ? null : typeChips(db, s.types),
              h("span", { class: "dex-state" }, state === "caught" ? "◉ 포획" : state === "seen" ? "○ 발견" : ""),
            );
          }),
        ),
      );
    });
  }

  /** Pokémon model manager: status per species and file import. */
  models(): void {
    const { db, assets } = this.ctx;
    this.open("포켓몬 3D 모델", (body) => {
      const r = assets.report();
      body.append(
        h(
          "p",
          { class: "card-sub" },
          `모델이 있는 종 ${r.available} / ${r.total}. 모델이 없는 포켓몬은 다른 동물이나 임의의 크리처로 바꾸지 않고 ${MISSING_POKEMON_ASSET} 표시로 보여 줍니다. `,
          "본인이 사용할 권리가 있는 모델만 연결하세요. 지원 형식: Bedrock(.geo.json + .png + 선택 .animation.json) 또는 .glb. 가져온 파일은 이 브라우저에만 저장됩니다.",
        ),
      );
      const list = [...db.species.values()].sort((a, b) => a.dexNumber - b.dexNumber);
      const table = h("div", { class: "model-list" });
      for (const s of list) {
        const status = assets.statusOf(s);
        const entry = assets.entry(s.modelId);
        const input = h("input", { type: "file", multiple: true, accept: ".json,.png,.glb,.gltf,.ogg,.mp3,.wav", class: "hidden", "data-model": s.modelId }) as HTMLInputElement;
        input.onchange = async () => {
          const files = [...(input.files ?? [])];
          if (!files.length) return;
          const res = await assets.importFiles(s.modelId, files);
          if (!res.ok) alertBox(body, res.error);
          this.refresh();
        };
        table.append(
          h(
            "div",
            { class: `model-row asset-${status}`, "data-species": s.id },
            h("span", { class: "dex" }, dexTag(s)),
            h("span", { class: "dex-name" }, s.name),
            h("span", { class: "model-status" }, status === "missing" ? MISSING_POKEMON_ASSET : status === "ready" ? `✔ ${entry?.format}` : status === "error" ? `오류: ${assets.error(s.modelId) ?? ""}` : `${entry?.format ?? ""} (불러오는 중)`),
            input,
            h("button", { class: "btn btn-small", onclick: () => input.click() }, entry ? "교체" : "파일 연결"),
            entry?.source === "imported" ? h("button", { class: "btn btn-small", onclick: async () => (await assets.removeImport(s.modelId), this.refresh()) }, "제거") : null,
          ),
        );
      }
      body.append(table);
    });
  }

  bag(opts: { inBattle?: boolean; onHeal?: (item: string) => void } = {}): void {
    const { db } = this.ctx;
    this.open("가방", (body) => {
      const st = this.ctx.state();
      const items = Object.entries(st?.inventory ?? {}).filter(([, n]) => n > 0);
      if (items.length === 0) {
        body.append(h("p", null, "가방이 비어 있다. 마을 상점에서 물건을 살 수 있다."));
        return;
      }
      const groups: [string, string][] = [
        ["capture", "볼"],
        ["heal", "회복"],
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
          if (item.kind === "capture" && !opts.inBattle) {
            actions.append(
              h(
                "button",
                {
                  class: "btn btn-small btn-primary",
                  onclick: () => {
                    this.current?.close();
                    this.ctx.equipBall(id);
                  },
                },
                "손에 들기",
              ),
            );
          }
          grid.append(
            h(
              "div",
              { class: "card", "data-item": id },
              h("div", { class: "card-row" }, item.ball ? ballIcon(item.ball, 24) : h("div", { class: "swatch", style: { width: "22px", height: "22px", borderRadius: "50%", background: item.color, border: "2px solid #fff" } }), h("div", { class: "card-title" }, `${item.name}${item.nameKo ? ` (${item.nameKo})` : ""} ×${n}`)),
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
            { class: "card", "data-item": it.id },
            h("div", { class: "card-row" }, item.ball ? ballIcon(item.ball, 22) : null, h("div", { class: "card-title" }, `${item.name}${item.nameKo ? ` (${item.nameKo})` : ""} — ${it.price}원`)),
            h("div", { class: "card-sub" }, `${item.description} (보유 ${st?.inventory[it.id] ?? 0})`),
            h(
              "div",
              { class: "actions" },
              h("button", { class: "btn btn-small", onclick: () => (counts.set(it.id, Math.max(1, n - 1)), this.refresh()) }, "−"),
              h("span", { class: "card-title", style: { minWidth: "2em", textAlign: "center", alignSelf: "center" } }, String(n)),
              h("button", { class: "btn btn-small", onclick: () => (counts.set(it.id, Math.min(99, n + 1)), this.refresh()) }, "+"),
              h("button", { class: "btn btn-small btn-primary", disabled: (st?.money ?? 0) < total, onclick: () => this.ctx.send({ kind: "buy", item: it.id, count: n }) }, `${total}원 구입`),
            ),
          ),
        );
      }
      body.append(grid);
    });
  }

  starter(options: string[], onChoose: (species: string) => void): void {
    const { db, assets } = this.ctx;
    this.open("파트너 선택", (body) => {
      body.append(h("p", null, "함께 여행할 첫 번째 파트너 포켓몬을 골라 주세요."));
      const grid = h("div", { class: "grid" });
      for (const id of options) {
        const s = db.species.get(id)!;
        grid.append(
          h(
            "div",
            { class: "card selectable", "data-species": id, onclick: () => (this.current?.close(), onChoose(id)) },
            h("div", { class: "card-row" }, portrait(db, assets, s), h("div", null, h("div", { class: "card-title" }, `${dexTag(s)} ${s.name}`), typeChips(db, s.types))),
            h("div", { class: "card-sub" }, `${s.abilities.join(", ")} · 키 ${s.height} m · ${s.weight} kg`),
            h("button", { class: "btn btn-small btn-primary" }, `${s.name}(으)로 결정`),
          ),
        );
      }
      body.append(grid);
    });
  }

  map(opts: { image: Promise<ImageData>; bounds: { minX: number; minZ: number; span: number }; player: { x: number; z: number; rotY: number } }): void {
    const { region } = this.ctx;
    this.open(`지도 — ${region.name}`, (body) => {
      const canvas = h("canvas", { width: 1, height: 1 });
      const wrap = h("div", { class: "map-wrap" }, canvas);
      const place = (x: number, z: number) => ({
        left: `${((x - opts.bounds.minX) / opts.bounds.span) * 100}%`,
        top: `${(1 - (z - opts.bounds.minZ) / opts.bounds.span) * 100}%`,
      });
      const marker = (x: number, z: number, text: string) => wrap.append(h("div", { class: "map-marker", style: place(x, z) }, text));
      for (const a of region.areas) if (a.maxY === undefined && a.radius >= 40) marker(a.x, a.z, a.name);
      for (const b of region.buildings) if (b.kind !== "house") marker(b.x, b.z, b.kind === "center" ? "✚" : b.kind === "shop" ? "🛒" : "🔬");
      for (const r of region.ruins) marker(r.x, r.z, "🏛");
      for (const c of region.caves) marker(c.path[0][0], c.path[0][2], "⛰");
      const me = h("div", { class: "map-marker player", style: place(opts.player.x, opts.player.z) });
      wrap.append(me);
      body.append(wrap);
      body.append(h("p", { class: "card-sub", style: { textAlign: "center" } }, "● 현재 위치 · ✚ 포켓몬 센터 · 🛒 상점 · 🔬 연구소 · ⛰ 동굴 · 🏛 유적"));
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

function alertBox(body: HTMLElement, text: string): void {
  body.prepend(h("div", { class: "toast bad inline" }, text));
}
