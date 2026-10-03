import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import type { ModelFormat } from "@/lib/mediaUrls";

/**
 * three.js scene setup shared by the upload-time preview render and the
 * interactive viewer. Imported only on demand: three's loaders are several
 * hundred KB and nothing on the chat path needs them.
 */

/** Surface for formats that carry geometry but no material (STL, PLY, bare OBJ). */
const DEFAULT_MATERIAL_COLOR = 0x94a3b8;

/** Formats whose files are conventionally Z-up (3D printing), unlike three's Y-up. */
const Z_UP_FORMATS = new Set<ModelFormat>(["stl", "3mf"]);

function defaultMaterial(geometry: THREE.BufferGeometry): THREE.Material {
  return new THREE.MeshStandardMaterial({
    color: geometry.hasAttribute("color") ? 0xffffff : DEFAULT_MATERIAL_COLOR,
    vertexColors: geometry.hasAttribute("color"),
    roughness: 0.6,
    metalness: 0.1,
    flatShading: !geometry.hasAttribute("normal"),
  });
}

/** Decode a `data:` URI into a Blob, or undefined when it's malformed. */
function dataUriToBlob(uri: string): Blob | undefined {
  const comma = uri.indexOf(",");
  if (comma === -1) return undefined;
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const type = meta.split(";")[0] || "application/octet-stream";
  try {
    if (/;base64$/i.test(meta)) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type });
    }
    return new Blob([decodeURIComponent(payload)], { type });
  } catch {
    return undefined;
  }
}

/**
 * Loader manager that keeps a model self-contained. A model names its buffers
 * and textures by URL and the loaders fetch them as given, which would hand the
 * opener's IP to any host, or point their browser at the local network, past
 * the media policy. Only resources carried in the file load: `blob:` URLs the
 * loaders mint from embedded images, and `data:` URIs, re-served as `blob:`
 * since the CSP's `connect-src` has no `data:`. Anything else becomes an
 * unloadable URL, failing without a request.
 */
function selfContainedManager(): { manager: THREE.LoadingManager; release: () => void } {
  const minted: string[] = [];
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^blob:/i.test(url)) return url;
    if (/^data:/i.test(url)) {
      const blob = dataUriToBlob(url);
      if (!blob) return "blob:invalid";
      const objectUrl = URL.createObjectURL(blob);
      minted.push(objectUrl);
      return objectUrl;
    }
    return "blob:invalid";
  });
  return {
    manager,
    release: () => {
      for (const url of minted.splice(0)) URL.revokeObjectURL(url);
    },
  };
}

/** A parsed model; `release` frees the object URLs its embedded resources were served from. */
export interface ParsedModel {
  model: THREE.Object3D;
  release: () => void;
}

/** Parse a model file into a scene object. Outside resources it names are not loaded. */
export async function parseModel(data: ArrayBuffer, format: ModelFormat): Promise<ParsedModel> {
  const { manager, release } = selfContainedManager();
  try {
    return { model: await parseWith(manager, data, format), release };
  } catch (error) {
    release();
    throw error;
  }
}

async function parseWith(manager: THREE.LoadingManager, data: ArrayBuffer, format: ModelFormat): Promise<THREE.Object3D> {
  switch (format) {
    case "glb":
    case "gltf": {
      const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.parseAsync(data, "");
      return gltf.scene;
    }
    case "stl": {
      const geometry = new STLLoader().parse(data);
      return new THREE.Mesh(geometry, defaultMaterial(geometry));
    }
    case "ply": {
      const geometry = new PLYLoader().parse(data);
      if (!geometry.hasAttribute("normal") && geometry.index) geometry.computeVertexNormals();
      // A PLY with no faces is a point cloud.
      if (!geometry.index) {
        return new THREE.Points(geometry, new THREE.PointsMaterial({
          size: 0.01,
          sizeAttenuation: true,
          vertexColors: geometry.hasAttribute("color"),
          color: geometry.hasAttribute("color") ? 0xffffff : DEFAULT_MATERIAL_COLOR,
        }));
      }
      return new THREE.Mesh(geometry, defaultMaterial(geometry));
    }
    case "obj": {
      const group = new OBJLoader().parse(new TextDecoder().decode(data));
      // OBJ without an .mtl gets three's flat default; give it a lit surface.
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) child.material = defaultMaterial(child.geometry);
      });
      return group;
    }
    case "3mf":
      return new ThreeMFLoader(manager).parse(data);
    case "fbx":
      return new FBXLoader(manager).parse(data, "");
    case "dae": {
      const collada = new ColladaLoader(manager).parse(new TextDecoder().decode(data), "");
      if (!collada) throw new Error("Unreadable Collada file");
      return collada.scene;
    }
  }
}

/** A ready-to-render scene with the model centred and a camera framing it. */
export interface ModelStage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Holds the model, centred on its origin; turn this to turn the model. */
  pivot: THREE.Group;
  /** The model's bounding-sphere radius, for camera limits. */
  radius: number;
  dispose: () => void;
}

/** Light a model, centre it at the origin, and frame it from a three-quarter view. */
export function stageModel(model: THREE.Object3D, format: ModelFormat, renderer: THREE.WebGLRenderer, aspect: number): ModelStage {
  const scene = new THREE.Scene();

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envMap = pmrem.fromScene(room, 0.04).texture;
  scene.environment = envMap;
  room.dispose();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(3, 5, 4);
  scene.add(key);

  if (Z_UP_FORMATS.has(format)) model.rotation.x = -Math.PI / 2;

  // Centre on the origin; models arrive in arbitrary units and offsets.
  const pivot = new THREE.Group();
  pivot.add(model);
  scene.add(pivot);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 1;
  model.position.sub(sphere.center);

  // Point clouds sized in model units, not the default 0.01.
  model.traverse((child) => {
    if (child instanceof THREE.Points && child.material instanceof THREE.PointsMaterial) {
      child.material.size = radius / 200;
    }
  });

  const fov = 35;
  const camera = new THREE.PerspectiveCamera(fov, aspect, radius / 100, radius * 100);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(fov / 2)) * 1.05;
  camera.position.copy(new THREE.Vector3(1, 0.7, 1.2).normalize().multiplyScalar(distance));
  camera.lookAt(0, 0, 0);

  return {
    scene,
    camera,
    pivot,
    radius,
    dispose: () => {
      envMap.dispose();
      pmrem.dispose();
      disposeObject(scene);
    },
  };
}

/** Free every geometry, material and texture under an object. */
function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.Line) {
      child.geometry.dispose();
      const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose();
        }
        material.dispose();
      }
    }
  });
}

/**
 * Render a still of a model file on a transparent background, for the imeta
 * `image`/`thumb`. Resolves `undefined` when the file can't be parsed or WebGL
 * isn't available.
 */
export async function renderModelPreview(
  data: ArrayBuffer,
  format: ModelFormat,
  width = 1200,
  height = 900,
): Promise<Blob | undefined> {
  let renderer: THREE.WebGLRenderer | undefined;
  let stage: ModelStage | undefined;
  let parsed: ParsedModel | undefined;
  try {
    parsed = await parseModel(data, format);
    const canvas = document.createElement("canvas");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    stage = stageModel(parsed.model, format, renderer, width / height);
    renderer.render(stage.scene, stage.camera);

    return await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((blob) => resolve(blob ?? undefined), "image/png");
    });
  } catch {
    return undefined;
  } finally {
    stage?.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
    parsed?.release();
  }
}
