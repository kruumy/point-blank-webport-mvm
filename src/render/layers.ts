import type * as THREE from "three";

// layers: 0 everything, 1 a watched player's own body (no camera draws it), FX_LAYER effects, split out by the theater's effects pass
export const FX_LAYER = 3;

export function markFx(o: THREE.Object3D): void {
  o.userData.fx = true;
  o.layers.set(FX_LAYER);
}
