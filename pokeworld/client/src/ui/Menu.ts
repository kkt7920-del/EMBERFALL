import type { QualityPresetId } from "@shared/config/quality";
import type { Game } from "../engine/Game";
import { Device } from "../mobile/Device";
import { applyPreset, type ClientSettings } from "../settings";
import { h } from "./dom";

const PARTICLES: [string, number][] = [
  ["낮음", 150],
  ["중간", 400],
  ["높음", 1200],
];

function seg<T>(options: [string, T][], value: T, onPick: (v: T) => void): HTMLElement {
  return h(
    "div",
    { class: "seg" },
    ...options.map(([label, v]) => h("button", { class: v === value ? "on" : "", onclick: () => onPick(v) }, label)),
  );
}

function row(label: string, control: HTMLElement): HTMLElement {
  return h("div", { class: "settings-row" }, h("span", null, label), control);
}

export function openSettings(game: Game): void {
  const render = (body: HTMLElement) => {
    const s = game.settings;
    const set = (patch: Partial<ClientSettings>) => {
      game.applySettings({ ...game.settings, ...patch, preset: patch.preset ?? "custom" });
      game.panels.refresh();
    };
    body.append(
      row(
        "품질 프리셋",
        seg<QualityPresetId | "custom">(
          [
            ["저사양(모바일)", "low"],
            ["중간", "medium"],
            ["고사양(PC)", "high"],
          ],
          s.preset,
          (v) => {
            if (v !== "custom") {
              game.applySettings(applyPreset(game.settings, v));
              game.panels.refresh();
            }
          },
        ),
      ),
      row("렌더 해상도", seg<number>([["50%", 0.5], ["65%", 0.65], ["75%", 0.75], ["90%", 0.9], ["100%", 1]], s.renderScale, (v) => set({ renderScale: v }))),
      row("시야 거리 (청크)", seg<1 | 2 | 3>([["3×3", 1], ["5×5", 2], ["7×7", 3]], s.chunkRadius, (v) => set({ chunkRadius: v }))),
      row("그림자", seg<ClientSettings["shadows"]>([["끔", "off"], ["낮음", "low"], ["중간", "medium"], ["높음", "high"]], s.shadows, (v) => set({ shadows: v }))),
      row("풀·꽃 거리", seg<0 | 1 | 2>([["끔", 0], ["가까이", 1], ["멀리", 2]], s.vegetationRadius, (v) => set({ vegetationRadius: v }))),
      row("파티클", seg<number>(PARTICLES, s.particleBudget, (v) => set({ particleBudget: v }))),
      row("프레임 제한", seg<0 | 30 | 60>([["30", 30], ["60", 60], ["제한 없음", 0]], s.maxFps, (v) => set({ maxFps: v }))),
      row("FPS 표시", seg<boolean>([["끔", false], ["켬", true]], s.showFps, (v) => set({ showFps: v }))),
      row("터치 컨트롤", seg<ClientSettings["touchControls"]>([["자동", "auto"], ["켬", "on"], ["끔", "off"]], s.touchControls, (v) => set({ touchControls: v }))),
      row("카메라 감도", seg<number>([["느림", 0.6], ["보통", 1], ["빠름", 1.6]], s.cameraSensitivity, (v) => set({ cameraSensitivity: v }))),
      row("카메라 상하 반전", seg<boolean>([["끔", false], ["켬", true]], s.invertY, (v) => set({ invertY: v }))),
      row("효과음", seg<boolean>([["끔", false], ["켬", true]], s.sound, (v) => set({ sound: v }))),
      row(
        "렌더러 (다시 시작 필요)",
        seg<ClientSettings["renderer"]>([["WebGL2", "webgl2"], ["WebGPU (실험적)", "webgpu"]], s.renderer, (v) => set({ renderer: v })),
      ),
      h("p", { class: "card-sub" }, `현재 렌더러: ${game.engineKind.toUpperCase()} · 기기: ${Device.mobile ? "모바일/태블릿" : "PC"}`),
    );
  };
  game.panels.custom("설정", render);
}

export function openMenu(game: Game): void {
  game.panels.custom("메뉴", (body) => {
    const install = Device.iOS
      ? "Safari 공유 버튼 → '홈 화면에 추가'로 앱처럼 실행할 수 있습니다."
      : "Chrome 메뉴(⋮) → '홈 화면에 추가' 또는 '앱 설치'로 앱처럼 실행할 수 있습니다.";
    body.append(
      h(
        "div",
        { class: "grid" },
        h("button", { class: "btn btn-primary", onclick: () => void game.saveGame() }, game.connection.mode === "local" ? "💾 저장하기" : "💾 서버에 저장"),
        h("button", { class: "btn", onclick: () => openSettings(game) }, "⚙ 설정"),
        h("button", { class: "btn", onclick: () => void Device.enterFullscreen() }, "⛶ 전체 화면"),
        h("button", { class: "btn", onclick: () => openHelp(game) }, "❔ 조작법"),
        h(
          "button",
          {
            class: "btn btn-danger",
            onclick: async () => {
              await game.saveGame();
              game.exit();
            },
          },
          "⏏ 저장 후 타이틀로",
        ),
      ),
      h("p", { class: "card-sub" }, install),
    );
  });
}

function openHelp(game: Game): void {
  game.panels.custom("조작법", (body) => {
    body.innerHTML = `
      <h3>PC</h3>
      <p><b>WASD</b> 이동 · <b>Shift</b> 달리기 · <b>Space</b> 점프(비행 중 상승) · <b>C</b> 비행 중 하강 · <b>마우스</b> 카메라(클릭하면 포인터 고정, Esc로 해제) · <b>휠</b> 줌</p>
      <p><b>E</b> 대화·조사 · <b>F</b> 근처 야생 크리처와 배틀 · <b>R</b> 포획구 던지기 · <b>T</b> 탑승/내리기 · <b>P</b> 파티 · <b>B</b> 가방 · <b>M</b> 지도 · <b>Q</b> 메뉴</p>
      <h3>모바일 · 태블릿</h3>
      <p>왼쪽 화면을 누르면 나타나는 <b>조이스틱</b>으로 이동(끝까지 밀면 달리기), 오른쪽 화면을 <b>드래그</b>해 카메라 회전, 두 손가락으로 <b>확대/축소</b>.</p>
      <p><b>A</b> 대화·조사 · <b>배틀</b> · <b>포획</b> · <b>점프</b> · <b>탑승</b> 버튼은 이동·카메라 조작과 동시에 누를 수 있습니다.</p>
      <h3>포획 요령</h3>
      <p>배틀로 HP를 줄인 뒤 포획구를 던지면 잘 잡힙니다. 필드에서 바로 던질 수도 있고, 크리처의 뒤에서 몰래 던지면 확률이 오릅니다.</p>`;
  });
}
