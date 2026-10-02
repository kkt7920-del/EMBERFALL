import { Device } from "../mobile/Device";
import { h } from "./dom";

export interface TitleChoice {
  mode: "continue" | "new" | "online";
  name: string;
}

export interface TitleInfo {
  save: { name: string; partySize: number; playTime: number } | null;
  onlineAvailable: Promise<boolean>;
  error?: string;
}

const NAME_KEY = "pokeworld.name";

function storedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

let installPrompt: (Event & { prompt: () => Promise<void> }) | null = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e as Event & { prompt: () => Promise<void> };
});

/** Title screen: continue / new game / online, with trainer name entry. */
export function showTitle(root: HTMLElement, info: TitleInfo): Promise<TitleChoice> {
  return new Promise((resolve) => {
    const screen = h("div", { class: "title-screen" });
    const card = h("div", { class: "title-card" });
    screen.append(card);
    root.append(screen);

    const done = (choice: TitleChoice) => {
      try {
        localStorage.setItem(NAME_KEY, choice.name);
      } catch {
        // ignore
      }
      screen.remove();
      resolve(choice);
    };

    const fmtTime = (s: number) => `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;

    const main = () => {
      const onlineBtn = h("button", { "data-action": "online", disabled: true }, "🌐 온라인 플레이 (확인 중…)");
      const buttons = h("div", { class: "title-buttons" });
      if (info.save)
        buttons.append(
          h(
            "button",
            { class: "btn-primary", "data-action": "continue", onclick: () => done({ mode: "continue", name: info.save!.name }) },
            `▶ 이어하기 — ${info.save.name}`,
          ),
        );
      buttons.append(h("button", { class: info.save ? "" : "btn-primary", "data-action": "new", onclick: () => nameForm("new") }, "✦ 새 게임"));
      buttons.append(onlineBtn);
      const installHint = h("div", { class: "title-save hidden" }, Device.iOS ? "Safari 공유 버튼 → '홈 화면에 추가'를 선택하세요." : "브라우저 메뉴 → '홈 화면에 추가'(또는 '앱 설치')를 선택하세요.");
      const installBtn = h("button", { "data-action": "install" }, "📲 앱으로 설치");
      installBtn.addEventListener("click", async () => {
        // alert()/confirm() are unavailable in embedded viewers, so hints are shown in the page
        if (installPrompt) await installPrompt.prompt();
        else installHint.classList.remove("hidden");
      });
      if (!Device.standalone && !import.meta.env.VITE_EMBEDDED) buttons.append(installBtn, installHint);

      const parts: (Node | null)[] = [
        h("div", { class: "title-logo" }, "PokeWorld"),
        h("div", { class: "title-sub" }, "크리처와 함께하는 오픈월드 모험 · 알파"),
        info.error ? h("div", { class: "toast bad", style: { animation: "none" } }, info.error) : null,
        buttons,
        info.save ? h("div", { class: "title-save" }, `저장 데이터: ${info.save.name} · 파티 ${info.save.partySize}마리 · 플레이 ${fmtTime(info.save.playTime)}`) : null,
        h("div", { class: "title-footer" }, Device.touch ? "가로 화면을 권장합니다 · 전체 화면은 메뉴에서" : "WASD 이동 · 마우스 카메라 · E 상호작용"),
      ];
      card.replaceChildren(...parts.filter((p): p is Node => p !== null));
      void info.onlineAvailable.then((ok) => {
        onlineBtn.disabled = !ok;
        onlineBtn.textContent = ok ? "🌐 온라인 플레이" : "🌐 온라인 서버 없음";
        if (ok) onlineBtn.onclick = () => nameForm("online");
      });
    };

    const nameForm = (mode: "new" | "online") => {
      const input = h("input", { class: "text-input", maxlength: "12", placeholder: "트레이너 이름", value: storedName() || "트레이너", "aria-label": "트레이너 이름" }) as HTMLInputElement;
      const warn = h("div", { class: "toast bad hidden", style: { animation: "none" } }, "기존 저장 데이터가 지워집니다. 계속하려면 한 번 더 누르세요.");
      let confirmed = false;
      const start = () => {
        const name = input.value.trim().slice(0, 12) || "트레이너";
        // Overwriting a save asks for a second press (in-page; no confirm())
        if (mode === "new" && info.save && !confirmed) {
          confirmed = true;
          warn.classList.remove("hidden");
          startBtn.textContent = "저장 지우고 새로 시작";
          return;
        }
        done({ mode, name });
      };
      const startBtn = h("button", { class: "btn btn-primary", "data-action": "start", onclick: () => start() }, mode === "new" ? "모험 시작!" : "접속하기");
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") start();
      });
      card.replaceChildren(
        h("div", { class: "title-logo", style: { fontSize: "clamp(26px,6vmin,48px)" } }, mode === "new" ? "새 게임" : "온라인 플레이"),
        h(
          "div",
          { class: "title-form" },
          h("div", { class: "title-sub" }, mode === "new" ? "당신의 이름을 알려 주세요." : "같은 서버의 다른 플레이어와 같은 세계를 탐험합니다."),
          input,
          warn,
          startBtn,
          h("button", { class: "btn", onclick: main }, "← 돌아가기"),
        ),
      );
      if (!Device.touch) input.focus();
    };

    main();
  });
}
