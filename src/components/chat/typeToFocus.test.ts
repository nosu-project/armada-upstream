// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mayFocusOnSwitch, registerTypeToFocus } from "@/components/chat/typeToFocus";

let composer: HTMLTextAreaElement;
let unregister: () => void;

function press(init: KeyboardEventInit, target: EventTarget = document.activeElement ?? document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = `
    <nav><a href="/c/1" id="channel">general</a></nav>
    <main id="page"><button id="timeline-button">react</button><textarea id="composer"></textarea></main>
    <input id="search" />
  `;
  composer = document.getElementById("composer") as HTMLTextAreaElement;
  unregister = registerTypeToFocus({ current: composer });
  (document.activeElement as HTMLElement | null)?.blur();
});

afterEach(() => {
  unregister();
  document.body.innerHTML = "";
});

describe("stray-keystroke routing", () => {
  it("sends a printable key typed with nothing focused to the composer", () => {
    press({ key: "h" });
    expect(document.activeElement).toBe(composer);
  });

  it("leaves a key typed in another field alone", () => {
    const search = document.getElementById("search") as HTMLInputElement;
    search.focus();
    press({ key: "h" });
    expect(document.activeElement).toBe(search);
  });

  it("stands down while a dialog is open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    press({ key: "h" });
    expect(document.activeElement).toBe(document.body);
  });

  it("stands down while the page holding the composer is inert", () => {
    document.getElementById("page")!.setAttribute("inert", "");
    press({ key: "h" });
    expect(document.activeElement).toBe(document.body);
  });

  it("stands down while the composer is not visible", () => {
    composer.checkVisibility = () => false;
    press({ key: "h" });
    expect(document.activeElement).toBe(document.body);
  });

  it("stands down while something else is fullscreen", () => {
    const stage = document.createElement("div");
    document.body.append(stage);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => stage });
    try {
      press({ key: "h" });
      expect(document.activeElement).toBe(document.body);
    } finally {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
    }
  });

  it("ignores shortcuts and non-printable keys", () => {
    press({ key: "k", ctrlKey: true });
    press({ key: "k", metaKey: true });
    press({ key: "k", altKey: true });
    press({ key: "Enter" });
    press({ key: "ArrowDown" });
    expect(document.activeElement).toBe(document.body);
  });

  it("takes AltGr characters", () => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "@", ctrlKey: true, altKey: true });
    Object.defineProperty(event, "getModifierState", { value: (key: string) => key === "AltGraph" });
    document.body.dispatchEvent(event);
    expect(document.activeElement).toBe(composer);
  });

  it("ignores keys that are part of an IME composition", () => {
    press({ key: "a", isComposing: true });
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves Space to a focused button", () => {
    const button = document.getElementById("timeline-button") as HTMLButtonElement;
    button.focus();
    press({ key: " " });
    expect(document.activeElement).toBe(button);
  });
});

describe("focus on conversation switch", () => {
  it("takes focus from nothing", () => {
    expect(mayFocusOnSwitch(composer)).toBe(true);
  });

  it("leaves focus on a channel link reached from the keyboard", () => {
    const link = document.getElementById("channel") as HTMLAnchorElement;
    link.focus();
    const matches = link.matches.bind(link);
    link.matches = (selector: string) => selector === ":focus-visible" || matches(selector);
    expect(mayFocusOnSwitch(composer)).toBe(false);
  });

  it("takes focus from a channel link that was clicked", () => {
    const link = document.getElementById("channel") as HTMLAnchorElement;
    link.focus();
    const matches = link.matches.bind(link);
    link.matches = (selector: string) => selector !== ":focus-visible" && matches(selector);
    expect(mayFocusOnSwitch(composer)).toBe(true);
  });

  it("does not take focus under an inert page", () => {
    document.getElementById("page")!.setAttribute("inert", "");
    expect(mayFocusOnSwitch(composer)).toBe(false);
  });
});
