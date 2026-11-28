import * as THREE from "three";
import { QUAD_VS, canvasTarget } from "./post";
import { withHidden } from "../render/onTop";
import { FX_LAYER } from "../render/layers";

export const PASSES = ["world", "players", "effects", "viewmodel", "hud", "depth", "normals", "wireframe"] as const;
/** "default": the world's pass with every layer joined, drawn as the game draws the frame (one scene render, not composited) */
export type PassName = "default" | (typeof PASSES)[number];
/** the frame's layers, bottom to top: each pass of them is a run of these, composited in this order */
export const LAYERS = ["world", "players", "effects", "viewmodel", "hud"] as const;
export type Layer = (typeof LAYERS)[number];

/** [RECRIADO] the layer passes: `joined` layers go into the pass of the layer under them; a pass is named by its first */
export function layerPasses(joined: readonly PassName[]): Layer[][] {
  const out: Layer[][] = [];
  for (const l of LAYERS) if (out.length && joined.includes(l)) out[out.length - 1].push(l); else out.push([l]);
  return out;
}

/** one simulated frame, split by what each pass keeps */
export interface PassFrame {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  players: THREE.Object3D[];
  viewmodel: THREE.Object3D[];
  /** in no pass: the campath and its handles */
  editor: THREE.Object3D[];
  /** depth: white at the camera, black from this distance (m) on */
  depthRange: number;
  /** the output format keeps alpha (ProRes 4444): mattes go there instead of onto green */
  alpha: boolean;
  /** the layers drawn into the pass under them (layerPasses) */
  joined: readonly PassName[];
  /** the game's HUD this frame (hudCapture.ts, premultiplied); null = none (outside first person) */
  hud: THREE.Texture | null;
  /** without alpha, the screen colour of a pass holding the HUD (hudKey) */
  hudKey: readonly [number, number, number];
  /** the default pass's depth of field (post.ts Post.blur); null = off. Never on depth / normals / wireframe: they are data */
  dof: ((color: THREE.Texture, depth: THREE.Texture, target: THREE.WebGLRenderTarget, matte: Matte) => void) | null;
}

/** a colour pass's alpha: 0 opaque, 1 coverage (players, gun), 2 light (smoke covers, flashes only add); 1 and 2 premultiplied */
export type Matte = 0 | 1 | 2;

/** [RECRIADO] the HUD's own green (HP, radar, the default crosshair) rules out a green screen: magenta, blue when the crosshair is near magenta */
export function hudKey(crosshair: readonly number[]): [number, number, number] {
  const [r, g, b] = crosshair, hi = Math.max(r, g, b), d = hi - Math.min(r, g, b);
  if (d < 40) return [1, 0, 1]; // grey or white
  const hue = 60 * (hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return Math.abs(hue - 300) < 60 ? [0, 0, 1] : [1, 0, 1];
}

// key 0 as drawn, 1 over green, 2 opaque, 3 over a checker; gain: main.ts's CSS brightness, unseen by a read back [INFERIDO: brightness() scales the sRGB bytes]
const OUT_FS = /* glsl */ `
uniform sampler2D t;
uniform float gain, key, straight;
uniform vec3 keyRgb;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(t, vUv);
  if (straight > 0.5 && c.a > 0.0) c.rgb /= c.a;
  vec3 rgb = min(c.rgb * gain, 1.0);
  vec3 chk = mod(floor(gl_FragCoord.x / 12.0) + floor(gl_FragCoord.y / 12.0), 2.0) < 1.0 ? vec3(0.3, 0.31, 0.34) : vec3(0.2, 0.21, 0.23);
  gl_FragColor = key > 2.5 ? vec4(min(rgb + (1.0 - c.a) * chk, 1.0), 1.0) : key > 1.5 ? vec4(rgb, 1.0)
    : key > 0.5 ? vec4(min(rgb + (1.0 - c.a) * keyRgb, 1.0), 1.0) : vec4(rgb, c.a);
}`;

// the gun's own depth where it drew (its target is cleared to far), else the world's: on top, like in the default pass
const DEPTH_GLSL = /* glsl */ `
#include <packing>
uniform sampler2D tDepth, tVm;
uniform float near, far;
varying vec2 vUv;
float rawDepth(vec2 uv) { float v = texture2D(tVm, uv).x; return v < 1.0 ? v : texture2D(tDepth, uv).x; }
`;

const DEPTH_FS = DEPTH_GLSL + /* glsl */ `
uniform float range, pack;
uniform vec2 size;
float lin(vec2 uv) { return 1.0 - clamp(-perspectiveDepthToViewZ(rawDepth(uv), near, far) / range, 0.0, 1.0); }
vec2 le16(float v) { float q = floor(v * 65535.0 + 0.5); return vec2(mod(q, 256.0), floor(q / 256.0)) / 255.0; }
void main() {
  if (pack < 0.5) { gl_FragColor = vec4(vec3(lin(vUv)), 1.0); return; }
  // grey16le as it comes off the GPU: each texel of the half-width target holds two pixels, low byte first
  float x = floor(gl_FragCoord.x) * 2.0;
  gl_FragColor = vec4(le16(lin(vec2((x + 0.5) / size.x, vUv.y))), le16(lin(vec2((x + 1.5) / size.x, vUv.y))));
}`;

// [RECRIADO] view-space normals rebuilt from the depth: they match it exactly (alpha-tested leaves too); faces, not smoothed normals
const NORMAL_FS = DEPTH_GLSL + /* glsl */ `
uniform mat4 projInv;
uniform vec2 texel;
vec3 viewPos(vec2 uv) {
  vec4 p = projInv * vec4(vec3(uv, rawDepth(uv)) * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
// of the two neighbours, the one on the same surface: across a depth edge the other would bend the normal
vec3 side(vec3 c, vec2 uv, vec2 d) {
  vec3 a = viewPos(uv + d) - c, b = c - viewPos(uv - d);
  return abs(a.z) < abs(b.z) ? a : b;
}
void main() {
  if (rawDepth(vUv) >= 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 c = viewPos(vUv), n = normalize(cross(side(c, vUv, vec2(texel.x, 0.0)), side(c, vUv, vec2(0.0, texel.y))));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`;

const quadMat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, extra: THREE.ShaderMaterialParameters = {}) =>
  new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader, uniforms, depthTest: false, depthWrite: false, ...extra });
const depthUniforms = () => ({ tDepth: { value: null }, tVm: { value: null }, near: { value: 0.1 }, far: { value: 1000 } });

type Bytes = Uint8Array<ArrayBuffer>;

/** [RECRIADO] effects' alpha as coverage: alpha-blended (smoke) covers, additive (flashes) adds light at 0; returns the undo (shared materials) */
function fxCoverage(roots: readonly THREE.Object3D[]): () => void {
  const saved = new Map<THREE.Material, [THREE.Blending, THREE.BlendingSrcFactor, THREE.BlendingDstFactor, number | null, number | null]>();
  for (const root of roots) root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!(o.layers.mask & (1 << FX_LAYER)) || !(m instanceof THREE.Material) || !m.transparent || saved.has(m)) return;
    const rgb: [THREE.BlendingSrcFactor, THREE.BlendingDstFactor] | null = m.blending === THREE.NormalBlending ? [THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor]
      : m.blending === THREE.AdditiveBlending ? [THREE.SrcAlphaFactor, THREE.OneFactor] : m.blending === THREE.CustomBlending ? [m.blendSrc, m.blendDst] : null;
    if (!rgb) return;
    saved.set(m, [m.blending, m.blendSrc, m.blendDst, m.blendSrcAlpha, m.blendDstAlpha]);
    const cover = rgb[1] === THREE.OneMinusSrcAlphaFactor;
    m.blending = THREE.CustomBlending;
    [m.blendSrc, m.blendDst] = rgb;
    m.blendSrcAlpha = cover ? THREE.OneFactor : THREE.ZeroFactor;
    m.blendDstAlpha = cover ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor;
  });
  return () => { for (const [m, [b, s, d, sa, da]] of saved) { m.blending = b; m.blendSrc = s; m.blendDst = d; m.blendSrcAlpha = sa; m.blendDstAlpha = da; } };
}

/** [RECRIADO] the meshes under `roots` all drawn with the material `use` sets, see-through ones (glass, cutouts) only when `seeThrough`;
 * skies (no depth test), sprites, lines and points hidden till `undo` */
function swapMeshes(roots: readonly THREE.Object3D[]): { use: (m: THREE.Material, seeThrough: boolean) => void; undo: () => void } {
  const meshes = new Map<THREE.Mesh, [THREE.Material | THREE.Material[], boolean, boolean]>(), hidden: THREE.Object3D[] = [];
  // the PB shaders are all flagged transparent and alpha-test by their own uniform (render/pbLighting.ts, -1 = off): blended ones skip the depth
  const see = (x: THREE.Material) => !x.depthWrite || x.alphaTest > 0 || ((x as THREE.ShaderMaterial).uniforms?.alphaTest?.value ?? 0) > 0 || !!(x as THREE.MeshBasicMaterial).alphaMap;
  for (const root of roots) root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m || meshes.has(o as THREE.Mesh)) return;
    if ((o as THREE.Mesh).isMesh && [m].flat().every((x) => x.depthTest)) meshes.set(o as THREE.Mesh, [m, [m].flat().some(see), o.visible]);
    else if (o.visible) { hidden.push(o); o.visible = false; }
  });
  return {
    use: (mat, seeThrough) => { for (const [o, [, s, v]] of meshes) { o.material = mat; if (s) o.visible = v && seeThrough; } },
    undo: () => { for (const [o, [m, , v]] of meshes) { o.material = m; o.visible = v; } for (const o of hidden) o.visible = true; },
  };
}

/** [RECRIADO] the theater's render passes (IWXMVM-style streams): all from one simulated frame, the world drawn once for all */
export class Passes {
  private readonly def: THREE.WebGLRenderTarget;
  private readonly geo: THREE.WebGLRenderTarget;
  private readonly vm: THREE.WebGLRenderTarget;
  // a colour pass after the depth of field
  private readonly soft: THREE.WebGLRenderTarget;
  private readonly wire: THREE.WebGLRenderTarget;
  // hidden-line wireframe: black faces pushed back fill the depth, the edges drawn over them
  private readonly wireFill = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  // three builds each geometry's line index on first use (a hitch on a big map) and again whenever a non-indexed one moves
  private readonly wireLine = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, fog: false, toneMapped: false });
  private readonly out = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private readonly half = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private readonly outMat = quadMat(OUT_FS, { t: { value: null }, gain: { value: 1 }, key: { value: 2 }, straight: { value: 0 }, keyRgb: { value: new THREE.Vector3(0, 1, 0) } });
  private readonly depthMat = quadMat(DEPTH_FS, { ...depthUniforms(), range: { value: 50 }, pack: { value: 0 }, size: { value: new THREE.Vector2() } });
  private readonly normalMat = quadMat(NORMAL_FS, { ...depthUniforms(), projInv: { value: new THREE.Matrix4() }, texel: { value: new THREE.Vector2() } });
  // the gun over a pass below it, both premultiplied
  private readonly overMat = quadMat("uniform sampler2D t; varying vec2 vUv; void main() { gl_FragColor = texture2D(t, vUv); }", { t: { value: null } }, {
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  // alpha = 1 where the stencil says a kept object drew, the colour left as it is
  private readonly matteMat = quadMat("void main() { gl_FragColor = vec4(1.0); }", {}, {
    blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.ZeroFactor,
    stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilRef: 1,
  });
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.outMat);
  private readonly cam = new THREE.OrthographicCamera();
  private readonly size = new THREE.Vector2();
  private readonly clear = new THREE.Color();

  constructor(private readonly r: THREE.WebGLRenderer) {
    this.def = canvasTarget(r);
    this.geo = canvasTarget(r, true);
    this.vm = canvasTarget(r, true);
    this.soft = canvasTarget(r);
    this.wire = canvasTarget(r);
    this.quad.frustumCulled = false;
  }

  /** one pass on the canvas; `drawDefault` runs only for the depth of field, whose focus the default frame moves */
  show(pass: Exclude<PassName, "default">, f: PassFrame, drawDefault: () => void): void {
    this.run([pass], f, null, drawDefault, pass);
  }

  /** every pass of this frame; the bytes (rgba, grey16le for depth) come back while the next frames draw. `monitor` goes on the canvas */
  capture(passes: readonly PassName[], f: PassFrame, gain: number, drawDefault: () => void, monitor: PassName): Promise<Bytes>[] {
    return this.run(passes, f, gain, drawDefault, monitor);
  }

  private run(passes: readonly PassName[], f: PassFrame, gain: number | null, drawDefault: () => void, monitor: PassName): Promise<Bytes>[] {
    const read = gain !== null;
    const r = this.r, { scene, camera } = f, has = (p: PassName) => passes.includes(p), reads = new Map<PassName, Promise<Bytes>>();
    r.getDrawingBufferSize(this.size);
    const { x: w, y: h } = this.size;
    for (const t of [this.def, this.geo, this.vm, this.soft, this.wire, this.out]) if (t.width !== w || t.height !== h) t.setSize(w, h);
    if (this.half.width !== Math.ceil(w / 2) || this.half.height !== h) this.half.setSize(Math.ceil(w / 2), h);
    // pass = read the target back as that pass's file; null = only drawn (the canvas)
    const emit = (pass: PassName | null, mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
      this.quad.material = mat;
      r.setRenderTarget(target);
      r.render(this.quad, this.cam);
      // the GPU copies the pixels out in order, so the target is free for the next pass at once
      if (target && pass) reads.set(pass, r.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height, new Uint8Array(target.width * target.height * 4)) as Promise<Bytes>);
    };
    // no alpha: mattes keyed on green, effects over black (their light adds, a key would not); straight alpha for editors, effects stay premultiplied
    const image = (pass: PassName, t: THREE.Texture, matte: Matte) => {
      const u = this.outMat.uniforms;
      u.t.value = t;
      const keyed = layerPasses(f.joined).find((g) => g[0] === pass)?.includes("hud");
      (u.keyRgb.value as THREE.Vector3).set(...(keyed ? f.hudKey : ([0, 1, 0] as const)));
      if (read) {
        u.gain.value = pass === "wireframe" ? 1 : gain; u.key.value = !matte ? 2 : f.alpha ? 0 : matte === 1 ? 1 : 2; u.straight.value = f.alpha && matte === 1 ? 1 : 0;
        emit(pass, this.outMat, this.out);
      }
      if (pass === monitor) {
        u.gain.value = 1; u.key.value = !matte ? 2 : f.alpha ? 3 : matte === 1 ? 1 : 2; u.straight.value = 0;
        emit(null, this.outMat, null);
      }
    };
    // a colour pass through the depth of field, by the depth now in geo
    const soft = (t: THREE.Texture, matte: Matte): THREE.Texture => {
      if (!f.dof) return t;
      f.dof(t, this.geo.depthTexture!, this.soft, matte);
      return this.soft.texture;
    };
    // the clear colour is set at each clear: drawing the scene leaves three's on its opaque background colour
    const clear = (color = true, depth = true, stencil = true) => { r.setClearColor(0x000000, 0); r.clear(color, depth, stencil); };

    // premultiplied `t` over the target, never cleared first: the default pass composites before the autoClear switch below
    const over = (t: THREE.Texture, target: THREE.WebGLRenderTarget) => {
      const auto = r.autoClear;
      this.overMat.uniforms.t.value = t; this.quad.material = this.overMat; r.setRenderTarget(target);
      r.autoClear = false;
      try { r.render(this.quad, this.cam); } finally { r.autoClear = auto; }
    };
    // the depth of field only blurs the colour layer passes (soft), never the viewmodel, HUD or data passes
    if ((read && has("default")) || (f.dof && layerPasses(f.joined).some((g) => has(g[0]) && g[0] !== "viewmodel" && g[0] !== "hud"))) {
      r.setRenderTarget(this.def);
      drawDefault();
      if (has("default")) {
        if (f.hud && layerPasses(f.joined).some((g) => g[0] === "world" && g.includes("hud"))) over(f.hud, this.def); // the HUD joined into the frame
        image("default", this.def.texture, 0);
      }
    }
    const depth = has("depth"), normals = has("normals");
    // the layer passes asked for, each drawn bottom up into geo over the depth of the layers under it
    const groups = layerPasses(f.joined).filter((g) => has(g[0])), of = (l: Layer) => groups.find((g) => g.includes(l));
    const first = (l: Layer) => of(l)?.[0] === l;
    // without alpha the effects alone go over black (their light adds, a key would not); with the players or gun, on green
    // the gun's pass holds its flash: light, like the effects
    const matteOf = (g: Layer[]): Matte => (g[0] === "world" || (g.length === 1 && g[0] === "effects" && !f.alpha) ? 0 : f.alpha && (g.includes("effects") || g.includes("viewmodel")) ? 2 : 1);
    // a pass done at its top layer: the depth of field, then the gun over it sharp, as in the default pass
    const end = (l: Layer) => {
      const g = of(l);
      if (!g || g[g.length - 1] !== l) return;
      const matte = matteOf(g), hud = g.includes("hud") ? f.hud : null;
      if (g[0] === "hud") { if (hud) image("hud", hud, 1); else { r.setRenderTarget(this.vm); clear(); image("hud", this.vm.texture, 1); } return; }
      if (g.includes("viewmodel")) {
        // the first-person flash goes with the gun, behind it by the gun's depth; drawn after depth / normals read that depth
        r.setRenderTarget(this.vm);
        camera.layers.set(FX_LAYER);
        const undo = fxCoverage(f.viewmodel);
        try { for (const o of f.viewmodel) if (o.visible) r.render(o, camera); } finally { undo(); }
      }
      if (g[0] === "viewmodel") { if (hud) over(hud, this.vm); image("viewmodel", this.vm.texture, matte); return; }
      const top = f.dof ? this.soft : this.geo;
      soft(this.geo.texture, matte);
      if (g.includes("viewmodel")) over(this.vm.texture, top);
      if (hud) over(hud, top);
      image(g[0], top.texture, matte);
    };
    const mask = camera.layers.mask, bg = scene.background, auto = r.autoClear, alpha = r.getClearAlpha();
    r.getClearColor(this.clear);
    r.autoClear = false;
    let restoreFx = () => {};
    try {
      camera.layers.set(0); // the effects are their own layer
      if (of("viewmodel") || depth || normals) {
        // the gun alone with its own depth, so in depth / normals it stays on top in walls
        r.setRenderTarget(this.vm);
        clear();
        this.matte(!!of("viewmodel"), () => { for (const o of f.viewmodel) if (o.visible) r.render(o, camera); });
      }
      if (depth || normals || groups.some((g) => g[0] !== "viewmodel" && g[0] !== "hud")) {
        r.setRenderTarget(this.geo);
        clear();
        withHidden([...f.editor, ...f.viewmodel, ...f.players], () => r.render(scene, camera));
        end("world");
        if (of("players") || of("effects") || depth || normals) {
          // the players over the world's depth: walls still hide them
          r.setRenderTarget(this.geo);
          if (first("players")) clear(true, false, true);
          this.matte(first("players"), () => { for (const p of f.players) r.render(p, camera); });
          end("players");
        }
      }
      for (const [pass, on, mat] of [["depth", depth, this.depthMat], ["normals", normals, this.normalMat]] as const) {
        if (!on) continue;
        const u = mat.uniforms;
        u.tDepth.value = this.geo.depthTexture; u.tVm.value = this.vm.depthTexture; u.near.value = camera.near; u.far.value = camera.far;
        if (mat === this.depthMat) { u.range.value = f.depthRange; u.size.value.set(w, h); }
        else { u.projInv.value.copy(camera.projectionMatrixInverse); u.texel.value.set(1 / w, 1 / h); }
        if (read) { if (pass === "depth") u.pack.value = 1; emit(pass, mat, pass === "depth" ? this.half : this.out); }
        if (pass === monitor) { if (pass === "depth") u.pack.value = 0; emit(null, mat, null); }
      }
      if (has("wireframe")) {
        // the gun after a depth clear, so walls cannot hide it (as in the default pass)
        r.setRenderTarget(this.wire);
        clear();
        scene.background = null;
        camera.layers.set(0);
        const swap = swapMeshes([scene, ...f.viewmodel]), vm = f.viewmodel.filter((o) => o.visible);
        try {
          for (const mat of [this.wireFill, this.wireLine]) { swap.use(mat, mat === this.wireLine); withHidden([...f.editor, ...f.viewmodel], () => r.render(scene, camera)); }
          if (vm.length) { r.clearDepth(); for (const mat of [this.wireFill, this.wireLine]) { swap.use(mat, mat === this.wireLine); for (const o of vm) r.render(o, camera); } }
        } finally { swap.undo(); scene.background = bg; }
        image("wireframe", this.wire.texture, 0);
      }
      const fx = of("effects");
      if (fx) {
        // behind the world and the players (their depth is still in geo); a colour background would clear it
        r.setRenderTarget(this.geo);
        if (first("effects")) clear(true, false, false);
        scene.background = null;
        camera.layers.set(FX_LAYER);
        if (matteOf(fx)) restoreFx = fxCoverage([scene]);
        withHidden([...f.editor, ...f.viewmodel], () => r.render(scene, camera));
        end("effects");
      }
      end("viewmodel");
      end("hud");
    } finally {
      restoreFx();
      camera.layers.mask = mask;
      scene.background = bg;
      r.autoClear = auto;
      r.setClearColor(this.clear, alpha);
    }
    r.setRenderTarget(null);
    // in the order asked for (one ffmpeg each), not the order drawn
    return read ? passes.map((p) => reads.get(p)!) : [];
  }

  /** draws with every passing fragment marking the stencil, then turns the marks into the alpha */
  private matte(on: boolean, draw: () => void): void {
    if (!on) { draw(); return; }
    const gl = this.r.getContext(), s = this.r.state.buffers.stencil;
    s.setTest(true); s.setMask(0xff); s.setFunc(gl.ALWAYS, 1, 0xff); s.setOp(gl.KEEP, gl.KEEP, gl.REPLACE); s.setLocked(true);
    try { draw(); } finally { s.setLocked(false); }
    this.quad.material = this.matteMat;
    this.r.render(this.quad, this.cam);
  }

  dispose(): void {
    for (const t of [this.def, this.geo, this.vm, this.soft, this.wire]) { t.depthTexture?.dispose(); t.dispose(); }
    this.out.dispose();
    this.half.dispose();
    for (const m of [this.outMat, this.depthMat, this.normalMat, this.matteMat, this.overMat, this.wireFill, this.wireLine]) m.dispose();
    this.quad.geometry.dispose();
  }
}
