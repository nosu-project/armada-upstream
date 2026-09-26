import { describe, expect, it } from "vitest";

import { dragStep, expansion, peekHeight, presence, settleStop } from "./snapSheet";

const stops = { peek: 400, closed: 800 };

describe("settleStop", () => {
  it("snaps a slow release to the nearer rest height", () => {
    expect(settleStop(150, 0, stops)).toBe("full");
    expect(settleStop(250, 0, stops)).toBe("peek");
    expect(settleStop(480, 0, stops)).toBe("peek");
  });

  it("dismisses a slow release pulled well below peek", () => {
    expect(settleStop(560, 0, stops)).toBe("closed");
  });

  it("expands on an upward fling from anywhere", () => {
    expect(settleStop(390, -0.6, stops)).toBe("full");
    expect(settleStop(600, -0.6, stops)).toBe("full");
  });

  it("lands a downward fling from above peek on peek, and one from peek off screen", () => {
    expect(settleStop(40, 0.8, stops)).toBe("peek");
    expect(settleStop(420, 0.8, stops)).toBe("closed");
  });
});

describe("dragStep", () => {
  it("raises the sheet before scrolling the list, within one move", () => {
    expect(dragStep(30, 0, -50, 800)).toEqual({ offset: 0, scrollTop: 20 });
  });

  it("scrolls the list back to its top before lowering the sheet", () => {
    expect(dragStep(0, 20, 50, 800)).toEqual({ offset: 30, scrollTop: 0 });
  });

  it("never pushes the sheet past closed", () => {
    expect(dragStep(790, 0, 50, 800)).toEqual({ offset: 800, scrollTop: 0 });
  });
});

describe("expansion and presence", () => {
  it("runs 0..1 between peek and full, and between closed and peek", () => {
    expect(expansion(400, stops)).toBe(0);
    expect(expansion(200, stops)).toBe(0.5);
    expect(expansion(0, stops)).toBe(1);
    expect(expansion(600, stops)).toBe(0);
    expect(presence(400, stops)).toBe(1);
    expect(presence(600, stops)).toBe(0.5);
    expect(presence(800, stops)).toBe(0);
  });
});

describe("peekHeight", () => {
  it("is about a keyboard's height, and always leaves the top of the screen", () => {
    expect(peekHeight(800)).toBe(448);
    expect(peekHeight(400)).toBe(320);
  });
});
