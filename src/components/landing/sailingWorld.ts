/** World units are roughly metres. Sparse, repeatable land; the sea has no edge. */
export interface Island {
  x: number;
  z: number;
  radius: number;
  stretch: number;
  height: number;
  seed: number;
}

export const SECTOR_SIZE = 1600;

export function randomSource(seed: number) {
  let value = seed | 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let n = Math.imul(value ^ (value >>> 15), 1 | value);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

export function islandsInSector(x: number, z: number): Island[] {
  if (x === 0 && z === 0) return [
    { x: -190, z: -320, radius: 65, stretch: 1.2, height: 48, seed: 7 },
    { x: 290, z: -650, radius: 105, stretch: 1, height: 85, seed: 23 },
    { x: 20, z: -900, radius: 75, stretch: 1.1, height: 72, seed: 42 },
    { x: -950, z: -1150, radius: 440, stretch: 1.7, height: 190, seed: 91 },
  ];
  const random = randomSource(Math.imul(x, 73856093) ^ Math.imul(z, 19349663));
  return Array.from({ length: 2 }, () => ({
    x: x * SECTOR_SIZE + (random() - 0.5) * 1000,
    z: z * SECTOR_SIZE + (random() - 0.5) * 1000,
    radius: 40 + random() * 90,
    stretch: 0.8 + random() * 0.8,
    height: 35 + random() * 85,
    seed: random() * 1000,
  }));
}

/** The mesh and collision share this coastline, including its coves. */
export function coastRadius(island: Island, angle: number) {
  return island.radius * (1 + 0.12 * Math.sin(angle * 3 + island.seed)
    + 0.07 * Math.cos(angle * 5 - island.seed) + 0.035 * Math.sin(angle * 9));
}

export function isLand(x: number, z: number, islands: readonly Island[]) {
  return islands.some((island) => {
    const dx = x - island.x;
    const dz = (z - island.z) / island.stretch;
    return Math.hypot(dx, dz) < coastRadius(island, Math.atan2(dz, dx)) + 3;
  });
}

export interface Vessel { x: number; z: number; heading: number; speed: number }

export function sail(vessel: Vessel, throttle: number, rudder: number, dt: number, islands: readonly Island[]) {
  // Exponential damping is independent of frame rate. Reverse remains useful
  // when a bow meets a beach; a little steerage at rest prevents getting stuck.
  vessel.speed += (throttle * 27 - vessel.speed) * (1 - Math.exp(-dt * 0.8));
  vessel.heading -= rudder * dt * 0.75 * (0.25 + Math.min(1, Math.abs(vessel.speed) / 12))
    * (vessel.speed < -0.5 ? -1 : 1);
  const x = vessel.x - Math.sin(vessel.heading) * vessel.speed * dt;
  const z = vessel.z - Math.cos(vessel.heading) * vessel.speed * dt;
  if (!isLand(x, z, islands)) {
    vessel.x = x;
    vessel.z = z;
  } else {
    // Slide along the shore instead of bouncing or travelling through it.
    if (!isLand(x, vessel.z, islands)) vessel.x = x;
    if (!isLand(vessel.x, z, islands)) vessel.z = z;
    vessel.speed *= Math.exp(-dt * 5);
  }
}
