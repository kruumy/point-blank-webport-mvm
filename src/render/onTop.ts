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

/** The scene, then the camera's children (first-person arms and gun) on top. */
export function renderWithViewmodel(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  const shown = camera.children.filter((o) => o.visible);
  for (const o of shown) o.visible = false;
  r.render(scene, camera);
  for (const o of shown) o.visible = true;
  renderOnTop(r, shown, camera);
}
