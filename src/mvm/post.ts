import * as THREE from "three";
import { renderOnTop } from "../render/onTop";

/**
 * focus = view-space distance (m), or with focusUv the depth under that point of the image (0..1, origin bottom left),
 * eased towards by focusLerp per frame (1 = at once); aperture = blur at infinity and maxBlur = largest blur, both fractions
 * of the image height; near / far scale the blur in front of / behind the focus
 */
export interface DofParams {
  focus: number; focusUv: THREE.Vector2 | null; focusLerp: number;
  aperture: number; maxBlur: number; near: number; far: number;
}

const QUAD_VS = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

// one texel: the mouse focus distance, eased from last frame's on the GPU (the depth is never read back to the CPU)
const FOCUS_FS = /* glsl */ `
#include <packing>
uniform sampler2D tDepth, tPrev;
uniform vec2 focusUv;
uniform float near, far, k;
void main() {
  float z = -perspectiveDepthToViewZ(texture2D(tDepth, focusUv).x, near, far);
  gl_FragColor = vec4(mix(texture2D(tPrev, vec2(0.5)).x, z, k), 0.0, 0.0, 1.0);
}`;

// [RECRIADO] single-pass gather depth of field: Vogel-disk samples out to the largest blur, each counted where its own blur
// circle reaches the centre pixel. A sample behind the centre is held to about the centre's blur, so a sharp subject never
// smears onto the background while a blurred foreground still spreads over what is behind it. Blurred in linear light, so
// bright spots bloom into discs like a lens.
const N = 80;
const DOF_FS = /* glsl */ `
#include <packing>
uniform sampler2D tColor, tDepth, tFocus;
uniform vec2 texel;
uniform float near, far, focus, autoFocus, aperture, maxBlur, nearBlur, farBlur;
float F;
varying vec2 vUv;
float viewZ(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far); }
// blur radius in pixels: thin lens, |z - focus| / z
float coc(float z) { return min(maxBlur, aperture * abs(z - F) / max(z, 1e-3) * (z < F ? nearBlur : farBlur)); }
vec3 lin(vec2 uv) { return pow(texture2D(tColor, uv).rgb, vec3(2.2)); }
void main() {
  if (maxBlur < 0.5) { gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0); return; }
  F = autoFocus > 0.5 ? texture2D(tFocus, vec2(0.5)).x : focus;
  float zc = viewZ(vUv), cc = coc(zc);
  vec3 acc = lin(vUv);
  float tot = 1.0;
  float spacing = maxBlur * sqrt(3.14159 / ${N}.0);
  for (int i = 0; i < ${N}; i++) {
    float r = maxBlur * sqrt((float(i) + 0.5) / ${N}.0), a = float(i) * 2.39996323;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r * texel;
    float z = viewZ(uv), c = coc(z);
    if (z > zc) c = min(c, cc * 2.0);
    float m = smoothstep(r, r + spacing, c);
    acc += mix(acc / tot, lin(uv), m);
    tot += 1.0;
  }
  gl_FragColor = vec4(pow(acc / tot, vec3(1.0 / 2.2)), 1.0);
}`;

const focusTarget = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });

/** [RECRIADO] theater post effects: the frame drawn off-screen with its depth, filtered, then put on the canvas */
export class Post {
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly mat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VS,
    fragmentShader: DOF_FS,
    uniforms: {
      tColor: { value: null }, tDepth: { value: null }, tFocus: { value: null }, texel: { value: new THREE.Vector2() },
      near: { value: 0.1 }, far: { value: 1000 }, focus: { value: 10 }, autoFocus: { value: 0 },
      aperture: { value: 1 }, maxBlur: { value: 1 }, nearBlur: { value: 1 }, farBlur: { value: 1 },
    },
    depthTest: false, depthWrite: false,
  });
  private readonly focusMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VS,
    fragmentShader: FOCUS_FS,
    uniforms: { tDepth: { value: null }, tPrev: { value: null }, focusUv: { value: new THREE.Vector2() }, near: { value: 0.1 }, far: { value: 1000 }, k: { value: 1 } },
    depthTest: false, depthWrite: false,
  });
  /** ping-pong: this frame's focus is written from last frame's */
  private readonly focusRt = [focusTarget(), focusTarget()];
  private focusLive = false;
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
  private readonly cam = new THREE.OrthographicCamera();
  private readonly size = new THREE.Vector2();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture: new THREE.DepthTexture(1, 1),
      samples: renderer.getContextAttributes()?.antialias ? 4 : 0, // the canvas' own MSAA
    });
    // the canvas path, byte for byte: three's own materials encode sRGB in the shader and the PB shaders write their raw
    // gamma-space values (render/pbLighting.ts). A plain target would get linear output from the former; the XR flag is
    // three's one switch for "render like the canvas" (r169: output colour space, tone mapping, no sRGB storage format)
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    // plain bytes in both the MSAA buffer and the texture it resolves to (three gives the texture SRGB8 otherwise: no resolve)
    this.rt.texture.internalFormat = "RGBA8";
    (this.rt as { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
    this.quad.frustumCulled = false;
  }

  /** the scene with depth of field; `overlays` are drawn sharp on top (first-person gun, campath) */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, dof: DofParams, overlays: THREE.Object3D[]): void {
    const r = this.renderer, u = this.mat.uniforms;
    r.getDrawingBufferSize(this.size);
    if (this.rt.width !== this.size.x || this.rt.height !== this.size.y) this.rt.setSize(this.size.x, this.size.y);
    const shown = overlays.filter((o) => o.visible);
    for (const o of shown) o.visible = false;
    r.setRenderTarget(this.rt);
    r.render(scene, camera);
    for (const o of shown) o.visible = true;
    if (dof.focusUv) {
      const f = this.focusMat.uniforms, [prev, next] = this.focusRt;
      f.tDepth.value = this.rt.depthTexture;
      f.tPrev.value = prev.texture;
      f.focusUv.value.copy(dof.focusUv);
      f.near.value = camera.near;
      f.far.value = camera.far;
      f.k.value = this.focusLive ? dof.focusLerp : 1; // a fresh start lands on the point at once
      this.quad.material = this.focusMat;
      r.setRenderTarget(next);
      r.render(this.quad, this.cam);
      this.quad.material = this.mat;
      this.focusRt.reverse();
    }
    this.focusLive = !!dof.focusUv;
    r.setRenderTarget(null);
    u.tColor.value = this.rt.texture;
    u.tDepth.value = this.rt.depthTexture;
    u.tFocus.value = this.focusRt[0].texture; // the one just written (reversed above)
    u.texel.value.set(1 / this.size.x, 1 / this.size.y);
    u.near.value = camera.near;
    u.far.value = camera.far;
    u.focus.value = dof.focus;
    u.autoFocus.value = dof.focusUv ? 1 : 0;
    // both in pixels of this image: the same look at any render size
    u.aperture.value = dof.aperture * this.size.y;
    u.maxBlur.value = dof.maxBlur * this.size.y;
    u.nearBlur.value = dof.near;
    u.farBlur.value = dof.far;
    r.render(this.quad, this.cam);
    renderOnTop(r, shown, camera);
  }

  dispose(): void {
    this.rt.depthTexture?.dispose();
    this.rt.dispose();
    for (const t of this.focusRt) t.dispose();
    this.mat.dispose();
    this.focusMat.dispose();
    this.quad.geometry.dispose();
  }
}
