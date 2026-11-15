import * as THREE from 'three';
import { buildVehicle, vehicleById } from '../car/vehicles.ts';

export interface VehiclePreview {
  /** Creates the renderer and starts turning the vehicle. */
  start(id: string): void;
  /** Shows another vehicle while running. */
  show(id: string): void;
  /** Stops, and frees the renderer and its WebGL context. */
  stop(): void;
}

/** Empties the root and frees its geometry. Materials are cached and shared, so they stay. */
function release(root: THREE.Group): void {
  root.traverse(object => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
  root.clear();
}

/** A turntable in the settings dialog. It only exists while the dialog is open. */
export function createVehiclePreview(container: HTMLElement, name: HTMLElement, size: HTMLElement): VehiclePreview {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let live: {
    canvas: HTMLCanvasElement;
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    root: THREE.Group;
    frame: number;
  } | null = null;

  function fit(): void {
    if (!live) return;
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    live.renderer.setSize(width, height, false);
    live.camera.aspect = width / height;
    live.camera.updateProjectionMatrix();
  }

  function show(id: string): void {
    if (!live) return;
    release(live.root);
    const spec = vehicleById(id);
    const built = buildVehicle(spec);
    live.root.add(built.group);
    const span = Math.max(spec.length, spec.height * 2.2);
    live.camera.position.set(span * 1.25, span * 0.55, span * 1.35);
    live.camera.lookAt(0, spec.height * 0.45, 0);
    name.textContent = spec.name;
    size.textContent = `${spec.length} m · ${Math.round(built.triangles)} tris`;
  }

  return {
    start(id) {
      if (live) return;
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      container.prepend(canvas);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xdff1ff, 0x5a7a3a, 0.9));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(100, 150, 62);
      const root = new THREE.Group();
      scene.add(sun, root);
      live = { canvas, renderer, scene, camera: new THREE.PerspectiveCamera(30, 1, 0.5, 200), root, frame: 0 };
      fit();
      show(id);

      const spin = (now: number) => {
        if (!live) return;
        live.root.rotation.y = reduceMotion ? 0.6 : now * 0.0006;
        live.renderer.render(live.scene, live.camera);
        live.frame = requestAnimationFrame(spin);
      };
      live.frame = requestAnimationFrame(spin);
    },
    show,
    stop() {
      if (!live) return;
      cancelAnimationFrame(live.frame);
      release(live.root);
      live.renderer.dispose();
      live.renderer.forceContextLoss();
      live.canvas.remove();
      live = null;
    },
  };
}
