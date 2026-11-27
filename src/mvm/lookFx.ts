import * as THREE from "three";
import { QUAD_VS } from "./post";

/** [RECRIADO] theater ambient occlusion: the i3 renderer has none */
export interface LookFxParams {
  /** 0 = off; radius in metres */
  aoStrength: number; aoRadius: number;
}

export const LOOK_FX_DEFAULT: LookFxParams = { aoStrength: 0, aoRadius: 0.6 };

export const aoOn = (p: LookFxParams): boolean => p.aoStrength > 0;

// Alchemy-style AO from the depth alone: a disk of samples around the pixel, each occluding by how far it rises above the
// face (view-space positions from the depth, the face normal from their screen derivatives)
const AO_N = 16;
const AO_FS = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 invProj;
uniform float radius;
uniform vec2 radiusUv;
varying vec2 vUv;
vec3 viewPos(vec2 uv) {
  vec4 p = invProj * vec4(uv * 2.0 - 1.0, texture2D(tDepth, uv).x * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
void main() {
  if (texture2D(tDepth, vUv).x >= 1.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv);
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));
  if (dot(N, P) > 0.0) N = -N;
  float spin = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  vec2 r = radiusUv / -P.z;
  float occ = 0.0;
  for (int i = 0; i < ${AO_N}; i++) {
    float t = (float(i) + 0.5) / ${AO_N}.0, a = float(i) * 2.39996323 + spin;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r * sqrt(t);
    vec3 v = viewPos(uv) - P;
    float d2 = dot(v, v);
    occ += max(dot(v, N) - 0.02 * -P.z, 0.0) / (d2 + 0.01) * step(d2, radius * radius * 4.0);
  }
  gl_FragColor = vec4(vec3(max(1.0 - 2.0 * radius * occ / ${AO_N}.0, 0.0)), 1.0);
}`;

// depth-aware 4x4 blur of the AO (its noise is a 4x4 pattern), multiplied into the colour
const AO_APPLY_FS = /* glsl */ `
#include <packing>
uniform sampler2D tColor, tAo, tDepth;
uniform vec2 texel;
uniform float near, far, strength;
varying vec2 vUv;
float viewZ(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far); }
void main() {
  float z = viewZ(vUv), sum = 0.0, w = 0.0;
  for (int x = -2; x < 2; x++) for (int y = -2; y < 2; y++) {
    vec2 uv = vUv + (vec2(x, y) + 0.5) * texel;
    float k = 1.0 / (1e-3 + abs(viewZ(uv) - z) / z);
    sum += texture2D(tAo, uv).x * k;
    w += k;
  }
  vec4 c = texture2D(tColor, vUv);
  gl_FragColor = vec4(c.rgb * mix(1.0, sum / w, strength), c.a);
}`;

const quadMat = (fs: string, uniforms: Record<string, THREE.IUniform>) =>
  new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
const plainTarget = () => new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });

export class LookFx {
  private readonly aoMat = quadMat(AO_FS, { tDepth: { value: null }, invProj: { value: new THREE.Matrix4() }, radius: { value: 1 }, radiusUv: { value: new THREE.Vector2() } });
  private readonly aoApply = quadMat(AO_APPLY_FS, { tColor: { value: null }, tAo: { value: null }, tDepth: { value: null }, texel: { value: new THREE.Vector2() }, near: { value: 0.1 }, far: { value: 1000 }, strength: { value: 1 } });
  private readonly aoRt = plainTarget();
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private readonly cam = new THREE.OrthographicCamera();

  constructor(private readonly r: THREE.WebGLRenderer) {
    this.quad.frustumCulled = false;
  }

  private draw(m: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = m;
    this.r.setRenderTarget(target);
    this.r.render(this.quad, this.cam);
  }

  /** `color` with ambient occlusion from `depth`, into `target` (same size as the frame) */
  ao(color: THREE.Texture, depth: THREE.Texture, camera: THREE.PerspectiveCamera, p: LookFxParams, w: number, h: number, target: THREE.WebGLRenderTarget): void {
    if (this.aoRt.width !== w || this.aoRt.height !== h) this.aoRt.setSize(w, h);
    const a = this.aoMat.uniforms, b = this.aoApply.uniforms;
    a.tDepth.value = depth;
    a.invProj.value.copy(camera.projectionMatrixInverse);
    const radius = Math.max(0.05, p.aoRadius); // a look file may hold any number: a negative radius would brighten
    a.radius.value = radius;
    const e = camera.projectionMatrix.elements;
    a.radiusUv.value.set(e[0], e[5]).multiplyScalar(radius * 0.5); // the radius at 1 m, in uv
    this.draw(this.aoMat, this.aoRt);
    b.tColor.value = color; b.tAo.value = this.aoRt.texture; b.tDepth.value = depth;
    b.texel.value.set(1 / w, 1 / h); b.near.value = camera.near; b.far.value = camera.far; b.strength.value = THREE.MathUtils.clamp(p.aoStrength, 0, 1);
    this.draw(this.aoApply, target);
  }

  dispose(): void {
    for (const m of [this.aoMat, this.aoApply]) m.dispose();
    this.aoRt.dispose();
    this.quad.geometry.dispose();
  }
}
