import * as THREE from "three";

import type { Vessel } from "./sailingWorld";

const ROWS = 160;
const COLUMNS = 8;
const LIFETIME = 6;

interface WaterSample {
  x: number;
  z: number;
  heading: number;
  born: number;
  distance: number;
  strength: number;
}

/** A single swath of disturbed water following the hull's actual path. The
 * surface carries advected turbulence; there are no individual wave shapes. */
export function createSailingWake() {
  const geometry = new THREE.BufferGeometry();
  const vertices = ROWS * (COLUMNS + 1);
  const positions = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const waterState = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const flow = new THREE.BufferAttribute(new Float32Array(vertices * 2), 2).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positions);
  geometry.setAttribute("waterState", waterState);
  geometry.setAttribute("flow", flow);
  const indices: number[] = [];
  for (let row = 0; row < ROWS - 1; row++) for (let column = 0; column < COLUMNS; column++) {
    const a = row * (COLUMNS + 1) + column;
    const b = a + COLUMNS + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  geometry.setIndex(indices);
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      time: { value: 0 },
      lifetime: { value: LIFETIME },
      foam: { value: new THREE.Color(0xb9e8df) },
      churn: { value: new THREE.Color(0x428e96) },
    },
    vertexShader: `
      attribute vec3 waterState;
      attribute vec2 flow;
      uniform float time;
      varying vec3 state;
      varying vec2 current;
      varying vec3 world;
      void main() {
        state = waterState;
        current = flow;
        vec3 p = position;
        p.y = 0.5 + 0.3 * sin(p.x * 0.014 + time * 0.65) * cos(p.z * 0.012 + time * 0.4);
        world = p;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      uniform float time;
      uniform float lifetime;
      uniform vec3 foam;
      uniform vec3 churn;
      varying vec3 state;
      varying vec2 current;
      varying vec3 world;

      float hash(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * 0.1031);
        q += dot(q, q.yzx + 33.33);
        return fract((q.x + q.y) * q.z);
      }
      float noise(vec2 p) {
        vec2 cell = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), u.x),
          mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), u.x), u.y);
      }
      void main() {
        float age = state.y;
        // Stretch turbulence along the flow. Domain warping folds the foam
        // into irregular filaments and pools, with no tiled texture or pulses.
        vec2 p = current * vec2(1.15, 0.38);
        p.y += age * 0.55;
        vec2 eddy = vec2(noise(p * 0.55 + time * 0.12),
          noise(p * 0.55 + vec2(17.4, 8.2) - time * 0.09));
        p += (eddy - 0.5) * (2.0 + age * 0.3);
        float turbulence = noise(p) * 0.6 + noise(p * 2.13 + 7.8) * 0.28
          + noise(p * 4.37 - 3.1) * 0.12;
        float aa = fwidth(turbulence);
        float filaments = 1.0 - smoothstep(0.025, 0.095 + aa, abs(turbulence - 0.53));
        float froth = smoothstep(0.58, 0.76 + aa, turbulence);
        float edge = abs(state.x) + (noise(p * 0.7 + 12.0) - 0.5) * 0.45;
        float spread = 1.0 - smoothstep(0.3, 1.0, edge);
        float dissipate = pow(max(0.0, 1.0 - age / lifetime), 1.5);
        float fresh = smoothstep(0.0, 0.2, age);
        float foamAmount = min(1.0, filaments * 0.7 + froth * 0.7);
        float alpha = (0.06 + foamAmount * 0.44) * spread * dissipate * fresh * state.z;
        alpha *= exp(-pow(length(world.xz - cameraPosition.xz) * 0.00145, 2.0));
        gl_FragColor = vec4(mix(churn, foam, foamAmount), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const surface = new THREE.Mesh(geometry, material);
  surface.frustumCulled = false;
  const history: WaterSample[] = [];
  let previousX: number | undefined, previousZ = 0, distance = 0;

  function update(vessel: Vessel, time: number) {
    material.uniforms.time.value = time;
    while (history.length && time - history[history.length - 1].born > LIFETIME) history.pop();
    const travelled = previousX === undefined ? 0 : Math.hypot(vessel.x - previousX, vessel.z - previousZ);
    previousX = vessel.x;
    previousZ = vessel.z;
    distance += travelled;
    const heading = vessel.heading + (vessel.speed < 0 ? Math.PI : 0);
    const moving = travelled > 0.001 && Math.abs(vessel.speed) > 0.3;
    const stern: WaterSample = {
      x: vessel.x + Math.sin(heading) * 4.2,
      z: vessel.z + Math.cos(heading) * 4.2,
      heading,
      born: time,
      distance,
      strength: Math.min(1, Math.abs(vessel.speed) / 16),
    };
    if (moving && (!history.length || distance - history[0].distance >= 1
      || time - history[0].born > 0.2)) {
      history.unshift(stern);
      if (history.length > ROWS - 1) history.pop();
    }

    // The live end meets the stern; older cross-sections stay in the water.
    // A stopped ship adds nothing, leaving the entire existing trail to decay.
    const rows = history.length + (moving ? 1 : 0);
    for (let row = 0; row < rows; row++) {
      const sample = moving ? (row === 0 ? stern : history[row - 1]) : history[row];
      const age = time - sample.born;
      const width = 1.65 + age * 0.95;
      const drift = Math.sin(sample.x * 0.12 + sample.z * 0.09 + time * 0.6) * age * 0.12;
      for (let column = 0; column <= COLUMNS; column++) {
        const cross = column / COLUMNS * 2 - 1;
        const lateral = cross * width + drift;
        const i = row * (COLUMNS + 1) + column;
        positions.setXYZ(i, sample.x + Math.cos(sample.heading) * lateral, 0,
          sample.z - Math.sin(sample.heading) * lateral);
        waterState.setXYZ(i, cross, age, sample.strength);
        flow.setXY(i, cross * width, sample.distance);
      }
    }
    geometry.setDrawRange(0, Math.max(0, rows - 1) * COLUMNS * 6);
    positions.needsUpdate = waterState.needsUpdate = flow.needsUpdate = true;
  }

  // The scene owns surface disposal, alongside its other meshes.
  return { surface, update };
}
