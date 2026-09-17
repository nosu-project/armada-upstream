import { describe, expect, it } from "vitest";

import { coastRadius, islandsInSector, isLand, sail, type Island, type Vessel } from "./sailingWorld";

describe("the sailing world", () => {
  it("recreates the same coasts when returning to a sector, including negative coordinates", () => {
    const first = islandsInSector(-3, 7);
    islandsInSector(10, -8);
    expect(islandsInSector(-3, 7)).toEqual(first);
    expect(islandsInSector(7, -3)).not.toEqual(first);
    expect(isLand(0, 0, islandsInSector(0, 0))).toBe(false);
  });

  it("collides with the actual coves and stretched coastline", () => {
    const island: Island = { x: -20, z: 100, radius: 90, stretch: 1.7, height: 40, seed: 12 };
    for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
      const radius = coastRadius(island, angle);
      const point = (scale: number) => [island.x + Math.cos(angle) * radius * scale,
        island.z + Math.sin(angle) * radius * scale * island.stretch] as const;
      expect(isLand(...point(0.97), [island])).toBe(true);
      expect(isLand(...point(1.15), [island])).toBe(false);
    }
  });

  it("stops at shore and lets the ship reverse back out", () => {
    const islands: Island[] = [{ x: 0, z: 0, radius: 80, stretch: 1, height: 30, seed: 4 }];
    const vessel: Vessel = { x: 0, z: 130, heading: 0, speed: 0 };
    for (let i = 0; i < 600; i++) {
      sail(vessel, 1, 0, 1 / 60, islands);
      expect(isLand(vessel.x, vessel.z, islands)).toBe(false);
    }
    expect(vessel.z).toBeLessThan(130);
    const shore = vessel.z;
    for (let i = 0; i < 240; i++) sail(vessel, -0.65, 0, 1 / 60, islands);
    expect(vessel.z).toBeGreaterThan(shore + 20);
  });

  it("keeps speed and travel consistent across display refresh rates", () => {
    const journey = (fps: number) => {
      const vessel: Vessel = { x: 0, z: 0, heading: 0, speed: 0 };
      for (let i = 0; i < fps * 10; i++) sail(vessel, 1, 0, 1 / fps, []);
      return vessel;
    };
    const slow = journey(30), fast = journey(120);
    expect(slow.speed).toBeCloseTo(fast.speed, 8);
    expect(Math.abs(slow.z - fast.z)).toBeLessThan(0.4);
    expect(slow.z).toBeLessThan(-230);
  });

  it("turns to starboard and coasts to rest after releasing input", () => {
    const vessel: Vessel = { x: 0, z: 0, heading: 0, speed: 0 };
    for (let i = 0; i < 120; i++) sail(vessel, 1, 1, 1 / 60, []);
    expect(vessel.x).toBeGreaterThan(0);
    for (let i = 0; i < 600; i++) sail(vessel, 0, 0, 1 / 60, []);
    expect(vessel.speed).toBeLessThan(0.01);
  });
});
