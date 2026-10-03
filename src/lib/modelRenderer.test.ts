// @vitest-environment jsdom
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseModel } from "./modelRenderer";

/** Bytes in this realm's ArrayBuffer: jsdom's differs from TextEncoder's, and GLTFLoader checks `instanceof`. */
function bytesOf(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out.buffer;
}

/** A one-triangle glTF whose only buffer lives at `uri`. */
function triangleGltf(uri: string): ArrayBuffer {
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ uri, byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
  };
  return bytesOf(JSON.stringify(json));
}

function triangleBufferBase64(): string {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return btoa(String.fromCharCode(...new Uint8Array(positions.buffer)));
}

describe("parseModel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loads a glTF buffer embedded as a data: URI, through a blob: URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { model, release } = await parseModel(
      triangleGltf(`data:application/octet-stream;base64,${triangleBufferBase64()}`),
      "gltf",
    );
    let meshes = 0;
    model.traverse((child) => {
      if (child instanceof THREE.Mesh) meshes++;
    });
    expect(meshes).toBe(1);
    // The CSP has no `data:` in connect-src, so the loader must never fetch one.
    for (const [input] of fetchSpy.mock.calls) {
      expect(String(input instanceof Request ? input.url : input)).toMatch(/^blob:/);
    }
    release();
  });

  it("never requests a resource a model names outside itself", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(parseModel(triangleGltf("https://tracker.example/buffer.bin"), "gltf")).rejects.toBeDefined();
    for (const [input] of fetchSpy.mock.calls) {
      expect(String(input instanceof Request ? input.url : input)).not.toMatch(/tracker\.example/);
    }
  });

  it("parses an ASCII STL", async () => {
    const stl = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
    const { model } = await parseModel(bytesOf(stl), "stl");
    expect(model).toBeInstanceOf(THREE.Mesh);
  });
});
