import { isDesktop } from "@/lib/desktop";

/**
 * "Press Esc to exit full screen" for embeds (e.g. Mini Apps) taking the desktop
 * window full-screen. Electron shows no hint, so an iframe could fake the app
 * or OS. A `popover` sits in the top layer above the frame. Android shows its
 * own hint natively.
 */

const HINT_MS = 4000;

let hint: HTMLElement | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function hintElement(): HTMLElement {
  if (hint) return hint;
  const el = document.createElement("div");
  el.setAttribute("popover", "manual");
  el.setAttribute("role", "status");
  el.textContent = "Press Esc to exit full screen";
  Object.assign(el.style, {
    inset: "24px auto auto 50%",
    transform: "translateX(-50%)",
    margin: "0",
    padding: "10px 18px",
    border: "none",
    borderRadius: "9999px",
    background: "rgba(0, 0, 0, 0.8)",
    color: "#fff",
    font: "500 14px/1.4 system-ui, sans-serif",
    pointerEvents: "none",
  });
  document.body.appendChild(el);
  hint = el;
  return el;
}

function hideHint(): void {
  clearTimeout(timer);
  timer = undefined;
  if (!hint?.matches(":popover-open")) return;
  hint.hidePopover();
}

export function syncFullscreenHint(): void {
  hideHint();
  if (!(document.fullscreenElement instanceof HTMLIFrameElement)) return;
  const el = hintElement();
  if (typeof el.showPopover !== "function") return;
  el.showPopover();
  timer = setTimeout(hideHint, HINT_MS);
}

let installed = false;

/** Show the hint whenever an embed takes the desktop window full-screen (once). */
export function installFullscreenHint(): void {
  if (installed || !isDesktop()) return;
  installed = true;
  document.addEventListener("fullscreenchange", syncFullscreenHint);
}
