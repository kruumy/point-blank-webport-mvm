import type * as THREE from "three";

/** Draws `objects` over what is already in the target, against a cleared depth buffer (the world cannot hide them). */
export function renderOnTop(r: THREE.WebGLRenderer, objects: THREE.Object3D[], camera: THREE.Camera): void {
  if (!objects.length) return;
  const auto = r.autoClear;
  r.autoClear = false;
  r.clearDepth();
  for (const o of objects) r.render(o, camera);
  r.autoClear = auto;
}

/** Runs `draw` with `objects` hidden; returns the ones that were visible. */
export function withHidden(objects: THREE.Object3D[], draw: () => void): THREE.Object3D[] {
  const shown = objects.filter((o) => o.visible);
  for (const o of shown) o.visible = false;
  try { draw(); } finally { for (const o of shown) o.visible = true; }
  return shown;
}

/** The scene, then the camera's children (first-person arms and gun) on top. */
export function renderWithViewmodel(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  renderOnTop(r, withHidden(camera.children, () => r.render(scene, camera)), camera);
}
