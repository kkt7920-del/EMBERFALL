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
      row("블록 청크 (32m)", seg<2 | 3>([["5×5", 2], ["7×7", 3]], s.chunkRadius, (v) => set({ chunkRadius: v }))),
      row("먼 지형 (LOD)", seg<1 | 2 | 3>([["가까이", 1], ["중간", 2], ["멀리", 3]], s.lodTiles, (v) => set({ lodTiles: v }))),
      row("그림자", seg<ClientSettings["shadows"]>([["끔", "off"], ["낮음", "low"], ["중간", "medium"], ["높음", "high"]], s.shadows, (v) => set({ shadows: v }))),
      row("풀·꽃 거리", seg<0 | 1 | 2>([["끔", 0], ["가까이", 1], ["멀리", 2]], s.vegetationRadius, (v) => set({ vegetationRadius: v }))),
      row("파티클", seg<number>(PARTICLES, s.particleBudget, (v) => set({ particleBudget: v }))),
      row("프레임 제한", seg<0 | 30 | 60>([["30", 30], ["60", 60], ["제한 없음", 0]], s.maxFps, (v) => set({ maxFps: v }))),
      row("FPS 표시", seg<boolean>([["끔", false], ["켬", true]], s.showFps, (v) => set({ showFps: v }))),
      row("터치 컨트롤", seg<ClientSettings["touchControls"]>([["자동", "auto"], ["켬", "on"], ["끔", "off"]], s.touchControls, (v) => set({ touchControls: v }))),
      row("카메라 감도", seg<number>([["느림", 0.6], ["보통", 1], ["빠름", 1.6]], s.cameraSensitivity, (v) => set({ cameraSensitivity: v }))),
      row("카메라 상하 반전", seg<boolean>([["끔", false], ["켬", true]], s.invertY, (v) => set({ invertY: v }))),
      row("효과음", seg<boolean>([["끔", false], ["켬", true]], s.sound, (v) => set({ sound: v }))),
      row("진동 (포획)", seg<boolean>([["끔", false], ["켬", true]], s.vibration, (v) => set({ vibration: v }))),
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
        h("button", { class: "btn", onclick: () => game.panels.pokedex() }, "📖 포켓몬 도감"),
        h("button", { class: "btn", onclick: () => game.panels.pc() }, "🖥 PC 보관함"),
        h("button", { class: "btn", "data-action": "models", onclick: () => game.panels.models() }, "🧩 포켓몬 3D 모델"),
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
      <p><b>WASD</b> 이동 · <b>Shift</b> 달리기 · <b>Space</b> 점프 / 물속에서 위로 · <b>C</b> 물속·비행 중 아래로 · <b>마우스</b> 카메라(클릭하면 포인터 고정, Esc로 해제) · <b>휠</b> 줌</p>
      <p><b>E</b> 대화·조사·포켓몬 정보 · <b>F</b> 근처 야생 포켓몬과 배틀 · <b>T</b> 탑승 · <b>P</b> 파티 · <b>B</b> 가방 · <b>X</b> 도감 · <b>M</b> 지도 · <b>Q</b> 메뉴</p>
      <h3>몬스터볼 던지기</h3>
      <p><b>R</b> 또는 <b>1~9</b>로 볼을 손에 들면 화면 가운데 조준점이 나타납니다. 포켓몬을 조준하면 조준점이 <b>노란색</b>으로 바뀌고 이름과 레벨이 보입니다.</p>
      <p><b>왼쪽 클릭을 짧게</b> 누르면 자동 궤도로 빠른 투척, <b>길게 누르면 힘을 모으고</b> 놓는 순간 던집니다. 들고 있는 동안 <b>휠</b>로 볼 종류를 바꾸고, <b>G</b> 또는 오른쪽 아래 볼 칩으로 볼 휠을 엽니다.</p>
      <p>빗나간 볼은 땅에 굴러가 멈춥니다. 가까이 가면 다시 주울 수 있습니다.</p>
      <h3>모바일 · 태블릿</h3>
      <p>왼쪽 <b>조이스틱</b>으로 이동, 오른쪽 화면 <b>드래그</b>로 카메라·조준, 두 손가락으로 확대/축소.</p>
      <p><b>BALL</b> 버튼: 탭 = 볼 들기, 누르고 있기 = 조준·힘 모으기, 손을 떼면 = 던지기. 볼 칩을 탭하면 <b>볼 휠</b>. 포켓몬을 <b>길게 누르면</b> 정보가 보입니다.</p>
      <h3>포획 요령</h3>
      <p>HP가 낮을수록, 잠듦·얼음(크게) 또는 마비·독·화상(조금) 상태일수록 잘 잡힙니다. 볼마다 효과가 다릅니다: 퀵볼(첫 턴), 다크볼(밤·동굴), 다이브볼(물), 넷트볼(물·벌레), 타이마볼(긴 배틀), 리피트볼(잡아 본 종). 알파·전설·높은 레벨 포켓몬은 잘 잡히지 않고, 전설은 먼저 배틀해야 합니다.</p>`;
  });
}
