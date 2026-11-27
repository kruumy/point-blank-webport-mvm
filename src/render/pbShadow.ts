import * as THREE from "three";
import { getSettings } from "../gameplay/settings";
import { pbLighting, pbUniforms as U } from "./pbLighting";

// Shadow_Quality_Type -> map size: CGameFramework::setShadowQuality 0x51f510 / stage load 0x75b510
export const SHADOW_SIZES = [0, 512, 1024, 2048] as const;
/** [INFERIDO] the exe fits a LSPSM frustum (i3ShadowMap::CalcLSPSMShadowMatrix2) to the scene bound; an ortho box this big around the view stands in */
const HALF = 18; // 36 m box: 3.5 cm texels at 1024, 1.8 cm at 2048
const DEPTH = 160;
/** [INFERIDO] the shaders reach full shadow 0.01 of their depth range behind the caster: here a fixed distance in metres */
const SOFT_M = 0.12;
/** [INFERIDO] plus 1.5 texels of slope bias: a texel of the 4-tap filter on a sloped chara face otherwise shadows the face itself */
const BIAS_TEXELS = 1.5;
const LAYER = 30; // the pass's own layer bit, set on the casters for the draw only

const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
const cam = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, 0, DEPTH);
cam.layers.set(LAYER);
const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
let rt: THREE.WebGLRenderTarget | null = null;
const _fwd = new THREE.Vector3(), _c = new THREE.Vector3(), _l = new THREE.Vector3(), _q = new THREE.Quaternion();
const _p = new THREE.Vector3(), _clear = new THREE.Color();
const casters: THREE.Mesh[] = [], unhid: THREE.Object3D[] = [], swapped: THREE.Material[][] = [];
const alphaDepth = new WeakMap<THREE.Material, THREE.Material>();

/** a depth material keeping the caster's alpha cut (hair cards, mesh gear); null = a fading caster, which drops no shadow */
function depthFor(m: THREE.Material): THREE.Material | null {
  if (m.transparent && m.opacity < 0.5) return null;
  const u = (m as THREE.ShaderMaterial).uniforms;
  const map = (u ? u.map?.value : (m as THREE.MeshStandardMaterial).map) as THREE.Texture | null | undefined;
  const cut = (u ? u.alphaTest?.value : m.alphaTest) as number | undefined;
  if (!map || !(cut! > 0)) return depthMat;
  let d = alphaDepth.get(m);
  if (!d) alphaDepth.set(m, (d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide, map, alphaTest: cut })));
  return d;
}

/** the casters under `o`; hidden shadow-only bodies (charModel makeShadowOnly) count, other hidden subtrees do not */
function collect(o: THREE.Object3D): void {
  if (!o.visible && !o.userData.shadowOnly) return;
  if ((o as THREE.Mesh).isMesh && o.castShadow) casters.push(o as THREE.Mesh);
  for (const c of o.children) collect(c);
}

/** Renders the shadow map for this frame from `view` (before the frame's own render); off = the shaders skip it. */
export function renderPbShadows(r: THREE.WebGLRenderer, scene: THREE.Scene, view: THREE.Camera): void {
  const size = SHADOW_SIZES[getSettings().shadowQuality] ?? 0;
  if (!size || !pbLighting()?.light || U.pbLightDir.value.y <= 0) { U.pbShadowOn.value = 0; return; }
  if (rt?.width !== size) {
    rt?.dispose();
    rt = new THREE.WebGLRenderTarget(size, size, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  }
  // the box centre half a box ahead of the eye, snapped to whole texels in light space (no crawl while the view moves)
  view.getWorldDirection(_fwd).setY(0);
  if (_fwd.lengthSq() > 1e-6) _fwd.normalize();
  view.getWorldPosition(_c).addScaledVector(_fwd, HALF * 0.5);
  _l.copy(U.pbLightDir.value).normalize();
  cam.position.copy(_c).addScaledVector(_l, DEPTH * 0.5);
  cam.up.set(0, Math.abs(_l.y) > 0.99 ? 0 : 1, Math.abs(_l.y) > 0.99 ? 1 : 0); // a sun straight overhead has no "up"
  cam.lookAt(_c);
  cam.updateMatrixWorld();
  const texel = (2 * HALF) / size;
  _q.copy(cam.quaternion).invert();
  const p = _p.copy(cam.position).applyQuaternion(_q);
  p.x = Math.round(p.x / texel) * texel;
  p.y = Math.round(p.y / texel) * texel;
  cam.position.copy(p.applyQuaternion(cam.quaternion));
  cam.updateMatrixWorld();

  casters.length = unhid.length = swapped.length = 0;
  collect(scene);
  for (let i = casters.length - 1; i >= 0; i--) {
    const o = casters[i], mats = Array.isArray(o.material) ? o.material : [o.material], depth = mats.map(depthFor);
    if (depth.includes(null)) { casters.splice(i, 1); continue; }
    swapped.push(mats);
    o.material = Array.isArray(o.material) ? (depth as THREE.Material[]) : depth[0]!;
    o.layers.enable(LAYER);
    if (!o.visible) { o.visible = true; unhid.push(o); }
  }
  swapped.reverse(); // filled from the end: same order as casters now
  const prevTarget = r.getRenderTarget(), prevBg = scene.background, prevFog = scene.fog;
  const prevClear = r.getClearColor(_clear), prevAlpha = r.getClearAlpha(), prevAuto = r.autoClear;
  try {
    scene.background = null;
    scene.fog = null;
    r.setRenderTarget(rt);
    r.setClearColor(0xffffff, 1); // packed depth 1 = nothing in front
    r.autoClear = true;
    r.render(scene, cam);
  } finally {
    casters.forEach((o, i) => { o.layers.disable(LAYER); o.material = Array.isArray(o.material) ? swapped[i] : swapped[i][0]; });
    for (const o of unhid) o.visible = false;
    scene.background = prevBg;
    scene.fog = prevFog;
    r.setClearColor(prevClear, prevAlpha);
    r.autoClear = prevAuto;
    r.setRenderTarget(prevTarget);
  }
  U.pbShadowMap.value = rt.texture;
  U.pbShadowMatrix.value.multiplyMatrices(bias, cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  U.pbShadowFactor.value.set(size, 1 / size, DEPTH / SOFT_M, 1 + (BIAS_TEXELS * texel) / SOFT_M);
  U.pbShadowOn.value = 1;
}

/** the match is over: the lobby's PB shaders must not read a stale map */
export function disposePbShadows(): void {
  U.pbShadowOn.value = 0;
  U.pbShadowMap.value = null;
  rt?.dispose();
  rt = null;
}
