// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { applySettingsFilter } from "./settingsSearch";

function page(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <section data-settings-group id="user">
      <div data-settings-section data-settings-title="Account" data-settings-body id="account">
        <div id="login">Log in or switch accounts</div>
      </div>
      <div data-settings-section data-settings-title="Account standing" id="standing"></div>
    </section>
    <section data-settings-group id="app">
      <div data-settings-section data-settings-title="Voice" id="voice">
        <button>Voice</button>
        <div data-settings-body>
          <div id="noise">Noise suppression <span>Filter out background hum</span></div>
          <div id="echo">Echo cancellation</div>
        </div>
      </div>
      <div data-settings-section data-settings-title="Direct messages" id="dms">
        <div data-settings-body>
          <div id="typing">Typing indicators</div>
        </div>
      </div>
    </section>`;
  return root;
}

const hidden = (root: HTMLElement, id: string) =>
  root.querySelector(`#${id}`)!.hasAttribute("data-search-hidden");

describe("applySettingsFilter", () => {
  it("keeps only matching rows and their sections", () => {
    const root = page();
    expect(applySettingsFilter(root, "HUM")).toBe(1);
    expect(hidden(root, "noise")).toBe(false);
    expect(hidden(root, "echo")).toBe(true);
    expect(hidden(root, "dms")).toBe(true);
    expect(hidden(root, "user")).toBe(true);
  });

  it("matches terms across the section title and a row", () => {
    const root = page();
    expect(applySettingsFilter(root, "voice  echo")).toBe(1);
    expect(hidden(root, "echo")).toBe(false);
    expect(hidden(root, "noise")).toBe(true);
  });

  it("keeps a whole section, and a bodiless one, when its title matches", () => {
    const root = page();
    expect(applySettingsFilter(root, "account")).toBe(2);
    expect(hidden(root, "login")).toBe(false);
    expect(hidden(root, "standing")).toBe(false);
    expect(hidden(root, "app")).toBe(true);
  });

  it("reports no sections when nothing matches, and an empty query restores everything", () => {
    const root = page();
    expect(applySettingsFilter(root, "zzz")).toBe(0);
    expect(applySettingsFilter(root, "  ")).toBe(4);
    expect(root.querySelectorAll("[data-search-hidden]")).toHaveLength(0);
  });
});
