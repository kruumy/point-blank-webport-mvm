import * as THREE from "three";
import type { Game } from "../game/game";
import { Campath, type CamKey, type CamPose } from "./campath";
import { DEMO_API, deleteDemo, listDemos, renameDemo, saveDemo, type DemoListing } from "./demo";
import type { DemoNet } from "./demoNet";
import { Post } from "./post";
import { charaChoices } from "../game/charModel";
import { actorEquip, hatChoices } from "../game/charEquip";
import { brightnessFactor } from "../gameplay/settings";
import { LookStage, deleteLook, listLooks, listSkies, readLook, writeLook, type Look } from "./looks";

export interface TheaterHost {
  game: Game;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  /** game.update + physics step */
  simulate(dt: number): void;
  render(): void;
  exit(): void;
}

type Mode = "pov" | "third" | "free" | "dolly";
const SPEEDS = [0.05, 0.1, 0.2, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8];
const SKIP = 5; // s per arrow press
/** depth of field (post.ts), kept apart from the looks: mode 0 off, 1 manual distance, 2 under the mouse, 3 a player;
 * blur in % of the image height; near / far scale it in front of / behind the focus; speed = mouse focus easing (1/s) */
const DOF_DEFAULT = { mode: 0, focus: 10, speed: 5, aperture: 1, maxBlur: 1, near: 1, far: 1 };
type Dof = typeof DOF_DEFAULT;
const FREE_SPEED = 6; // m/s
const LOOK = 0.0025; // rad per mouse px at 70 deg
// an exact seek replays this much from a reset world at a fixed step: longer than any death, reload or flinch clip
const WARM = 3, WARM_STEP = 1 / 60;
// the 3D campath draws over the world (no depth test): a path through a wall stays visible
const vizMat = (color: number) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
const PATH_MAT = vizMat(0xf0a830), NODE_MAT = new THREE.MeshBasicMaterial({ color: 0x5aa0ff, depthTest: false, transparent: true });
// demo editor selection: back faces of each mesh pushed out along the skinned normals in view space, scaled by depth so the
// outline keeps about the same width on screen whatever the model's units or distance
const OUTLINE_MAT = new THREE.MeshBasicMaterial({ color: 0xf0a830, side: THREE.BackSide });
OUTLINE_MAT.onBeforeCompile = (s) => {
  s.vertexShader = s.vertexShader.replace("#include <project_vertex>", `#include <project_vertex>
#ifndef USE_SKINNING
vec3 objectNormal = normal;
#endif
mvPosition.xyz += normalize(normalMatrix * objectNormal) * -mvPosition.z * 0.004;
gl_Position = projectionMatrix * mvPosition;`);
};
const SEL_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }), DIR_MAT = vizMat(0x5aa0ff);
// IWXMVM's capture rates: CoD steps its clock in whole ms, so 1000 / fps is an integer; the high ones are for frame-blended motion blur
const FRAMERATES = [50, 100, 125, 250, 500, 1000];
const CODECS: [string, string][] = [["prores4444xq", "ProRes 4444 XQ"], ["prores4444", "ProRes 4444"], ["prores422hq", "ProRes 422 HQ"],
  ["prores422", "ProRes 422"], ["prores422lt", "ProRes 422 LT"]];

const CSS = `
#mvm{position:fixed;inset:0;pointer-events:none;font:12px/1.4 Segoe UI,Arial,sans-serif;color:#ddd;z-index:50;user-select:none}
#mvm.off>*:not(.mvm-toast):not(.mvm-mask){display:none}#mvm.rendering .mvm-mask{display:none}
#mvm .mvm-mask{position:absolute;box-shadow:0 0 0 100vmax rgba(10,10,12,.6);outline:1px solid rgba(255,255,255,.25)}
#mvm .p{pointer-events:auto;background:rgba(18,20,24,.92);border:1px solid #333;border-radius:4px}
#mvm button,#mvm select,#mvm input{font:inherit;color:#eee;background:#2a2e35;border:1px solid #444;border-radius:3px;padding:2px 7px}
#mvm button:hover{background:#3a404a}#mvm button.on{background:#c47f12;border-color:#e09a2a;color:#111}
#mvm .top{position:absolute;left:8px;top:8px;padding:5px 9px;display:flex;gap:10px;align-items:center}
#mvm .side{position:absolute;right:8px;top:8px;width:270px;max-height:calc(100% - 120px);display:flex;flex-direction:column}
#mvm .tabs{display:flex;border-bottom:1px solid #333}#mvm .tabs button{flex:1;border:0;border-radius:0;background:none}
#mvm .tabs button.on{background:#2a2e35;color:#f0a830}
#mvm .body{padding:8px;overflow:auto;display:flex;flex-direction:column;gap:6px}
#mvm .row{display:flex;gap:6px;align-items:center}#mvm .row>label{flex:0 0 70px;color:#999}
#mvm .list{display:flex;flex-direction:column;gap:2px}
#mvm .item{display:flex;gap:6px;padding:2px 5px;border-radius:3px;cursor:pointer;align-items:center}
#mvm .item:hover{background:#2a2e35}#mvm .item.on{background:#3d3220}
#mvm .dot{width:8px;height:8px;border-radius:50%}
#mvm .bar{position:absolute;left:8px;right:8px;bottom:8px;padding:6px 8px;display:flex;flex-direction:column;gap:5px}
#mvm .ctl{display:flex;gap:8px;align-items:center}#mvm .time{font-family:Consolas,monospace;min-width:120px}
#mvm canvas.tl{width:100%;height:34px;cursor:pointer;display:block}
#mvm .keys td{padding:1px 6px}#mvm .keys td:first-child{color:#f0a830;font-family:Consolas,monospace;white-space:nowrap}
#mvm .mvm-toast{position:absolute;left:50%;top:40%;transform:translateX(-50%);padding:10px 16px;font-size:14px}
#mvm .hint{color:#888}
#mvm .edit{position:absolute;width:240px;padding:8px;display:flex;flex-direction:column;gap:6px}#mvm .edit select{width:100%}
body.mvm-clean #app>*:not(canvas):not(#mvm),body.mvm-clean>:not(#app){visibility:hidden}
`;

/** [RECRIADO] Movie theater: demo playback with a rewindable timeline, POV / third-person / free / dolly cameras, keyframed
 * campaths and a frame-exact offline render (scripts/mvm-server.ts pipes the frames into ffmpeg). Workflow and default
 * keys follow IWXMVM (Space play, arrows speed / skip, B / N in / out, F free camera, K / L / J dolly nodes). */
export class Theater {
  private time = 0;
  private playing = true;
  private speedIdx = SPEEDS.indexOf(1);
  private mode: Mode = "pov";
  private free: CamPose = { pos: [0, 0, 0], yaw: 0, pitch: 0, roll: 0, fov: 70 };
  /** POV / third person FOV; null = the game's (option FOV first person, 70 third) */
  private povFov: number | null = null;
  private path = new Campath();
  private readonly pathViz = new THREE.Group();
  private pathSig = "";
  private sel = -1;
  private inPt = 0;
  private outPt: number;
  private held = new Set<string>();
  private looking = false;
  private rendering = false;
  private cancelRender = false;
  private readonly ac = new AbortController();
  private readonly root = document.createElement("div");
  private readonly tl: HTMLCanvasElement;
  private tab = "camera";
  private kills: number[];
  private lastUi = 0;
  /** demo editor: the player whose menu is open, and edits not yet written to the file */
  private editId: string | null = null;
  private editSig = "";
  private outline: THREE.Mesh[] = [];
  /** the body the outline was made for: a model swap replaces it */
  private outlineRoot: THREE.Object3D | null = null;
  private charas: { itemId: number; label: string }[] = [];
  private hats: { itemId: number; slot: "head" | "beret"; label: string }[] = [];
  private dirty = false;
  private readonly looks: LookStage;
  /** saved looks / maps with a sky; null = not fetched yet */
  private lookNames: string[] | null = null;
  private skyNames: string[] = [];
  private lookName = "";
  /** depth of field: made on first use; the cursor over the canvas (0..1, origin bottom left) and the player in focus */
  private post: Post | null = null;
  private readonly mouseUv = new THREE.Vector2(0.5, 0.5);
  private dofActor: string | null = null;
  private dofZ = 10;
  private dof: Dof = { ...DOF_DEFAULT };

  constructor(private readonly net: DemoNet, private readonly host: TheaterHost) {
    const demo = net.demo;
    this.outPt = demo.dur;
    this.kills = demo.recs.filter((r) => r.k === "kill").map((r) => r.t);
    ensureCss();
    this.root.id = "mvm";
    this.root.innerHTML = `<div class="mvm-mask"></div>
      <div class="p top"><b>${esc(demo.name)}</b><span class="hint">${esc(demo.map)} · ${fmt(demo.dur)}</span>
        <button data-a="clean">Hide HUD (G)</button><button data-a="exit">Exit</button>
        <button data-a="save" class="on" style="display:none">Save changes</button></div>
      <div class="p edit" style="display:none"></div>
      <div class="p side"><div class="tabs">${["camera", "campath", "visuals", "render", "controls"].map((t) => `<button data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
        <div class="body"></div></div>
      <div class="p bar"><div class="ctl">
        <button data-a="back">⏮</button><button data-a="play"></button><button data-a="fwd">⏭</button>
        <span class="time"></span><span class="speed"></span><span class="hint mode"></span>
        <span style="flex:1"></span><span class="hint range"></span></div>
        <canvas class="tl"></canvas></div>`;
    document.getElementById("app")!.appendChild(this.root);
    this.tl = this.root.querySelector("canvas.tl")!;
    this.wire();
    this.layoutMask();
    this.pathViz.renderOrder = 999;
    this.looks = new LookStage(host.game.scene, host.renderer);
    host.game.scene.add(this.pathViz);
    this.seek(0);
    this.setMode("pov", demo.pov);
    this.drawSide();
  }

  /** a movie render owns the canvas size and the camera (main.ts resize waits) */
  get busyRendering(): boolean { return this.rendering; }

  // ---- frame ----
  /** one rAF frame (main.ts animate); during a render the render loop steps the world itself */
  frame(raw: number): void {
    if (this.rendering) return;
    const dt = Math.min(raw, 0.05);
    let sim = 0;
    if (this.playing) {
      sim = dt * SPEEDS[this.speedIdx];
      this.time += sim;
      if (this.time >= this.net.demo.dur) { this.time = this.net.demo.dur; this.playing = false; }
      this.net.advance(this.time);
    }
    this.host.game.poseRemotes(this.net.poses(this.time));
    this.host.simulate(sim);
    this.updateCamera(dt);
    this.drawPath3d();
    this.draw(dt);
    if (performance.now() - this.lastUi > 50) { this.lastUi = performance.now(); this.drawBar(); this.drawEdit(); }
  }

  private updateCamera(dt: number): void {
    if (this.mode === "free") {
      this.moveFree(dt);
      this.applyPose(this.free);
    } else if (this.mode === "dolly") {
      const p = this.path.sample(this.time);
      if (p) this.applyPose(p);
    }
  }

  private moveFree(dt: number): void {
    const f = this.free, h = this.held;
    let v = FREE_SPEED * dt * (h.has("ShiftLeft") || h.has("ShiftRight") ? 3 : 1) * (h.has("ControlLeft") || h.has("ControlRight") ? 0.1 : 1);
    const fwd = new THREE.Vector3(-Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), -Math.cos(f.yaw) * Math.cos(f.pitch));
    const right = new THREE.Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
    const d = new THREE.Vector3();
    if (h.has("KeyW")) d.add(fwd);
    if (h.has("KeyS")) d.sub(fwd);
    if (h.has("KeyD")) d.add(right);
    if (h.has("KeyA")) d.sub(right);
    if (h.has("KeyE")) d.y += 1;
    if (h.has("KeyQ")) d.y -= 1;
    if (!d.lengthSq()) return;
    v /= Math.max(1, d.length());
    f.pos[0] += d.x * v; f.pos[1] += d.y * v; f.pos[2] += d.z * v;
  }

  private setPovFov(fov: number | null): void {
    this.povFov = fov === null ? null : Math.max(5, Math.min(140, fov));
    this.host.game.setObserveFov(this.povFov);
    this.toast(this.povFov === null ? "FOV: game default" : `FOV ${this.povFov.toFixed(0)}°`, 800);
    if (this.tab === "camera") this.drawSide();
  }

  private applyPose(p: CamPose): void {
    const c = this.host.camera;
    c.position.set(p.pos[0], p.pos[1], p.pos[2]);
    c.rotation.order = "YXZ";
    c.rotation.set(p.pitch, p.yaw, p.roll);
    if (Math.abs(c.fov - p.fov) > 1e-4) { c.fov = p.fov; c.updateProjectionMatrix(); }
  }

  /** the pose the camera has now (to start the free camera or a key from) */
  private currentPose(): CamPose {
    const c = this.host.camera, e = new THREE.Euler().setFromQuaternion(c.quaternion, "YXZ");
    return { pos: [c.position.x, c.position.y, c.position.z], yaw: e.y, pitch: e.x, roll: e.z, fov: c.fov };
  }

  // ---- playback ----
  /**
   * jump to `t`. exact (default): reset every body WARM s earlier and replay up to `t` at a fixed step, so a seek, a
   * rewind, J and the render all land on the same animation frames. A timeline drag skips the replay until release.
   */
  private seek(t: number, exact = true): void {
    const target = Math.max(0, Math.min(this.net.demo.dur, t)), game = this.host.game;
    if (!exact) {
      this.time = target;
      game.snapRemotes(this.net.seek(target));
    } else {
      this.time = Math.max(0, target - WARM);
      game.snapRemotes(this.net.seek(this.time), this.time);
      silently(() => {
        while (this.time < target - 1e-9) {
          const h = Math.min(WARM_STEP, target - this.time);
          this.time += h;
          this.net.advance(this.time);
          game.poseRemotes(this.net.poses(this.time));
          this.host.simulate(h);
        }
      });
      this.time = target;
    }
    game.poseRemotes(this.net.poses(this.time));
  }

  private setMode(m: Mode, id?: string): void {
    if ((m === "free" || m === "dolly") && this.mode !== "free" && this.mode !== "dolly") this.free = this.currentPose();
    this.mode = m;
    this.host.game.observe(m === "pov" ? "fps" : m === "third" ? "third" : "fly", id);
    this.drawSide();
  }

  /** dolly off: the free camera where the dolly is now, same time */
  private leaveDolly(): void {
    if (this.mode !== "dolly") return;
    this.free = this.currentPose();
    this.setMode("free");
  }

  private cycleTarget(dir: 1 | -1): void {
    const ids = this.net.roster().map((a) => a.id), cur = this.host.game.observedId;
    const i = ids.indexOf(cur ?? "");
    const next = ids[(i + dir + ids.length) % ids.length];
    if (next) this.setMode(this.mode === "third" ? "third" : "pov", next);
  }

  // ---- campath ----
  private addKey(): void {
    const p = this.mode === "free" ? this.free : this.currentPose();
    this.sel = this.path.add({ t: this.time, ...p, pos: [...p.pos] as CamKey["pos"] });
    this.toast(`Node ${this.path.keys.length} at ${fmt(this.time)}`);
    this.drawSide();
  }

  /** the path and its nodes in the world; rebuilt only when a node changes. Hidden while the dolly camera rides it */
  private drawPath3d(): void {
    const g = this.pathViz, K = this.path.keys;
    g.visible = this.mode !== "dolly" && !this.root.classList.contains("off");
    const sig = `${this.sel}${JSON.stringify(K)}`;
    if (sig === this.pathSig) return;
    this.pathSig = sig;
    for (const c of [...g.children]) { g.remove(c); (c as THREE.Mesh).geometry.dispose(); }
    const add = (o: THREE.Object3D) => { o.renderOrder = 999; g.add(o); };
    if (K.length > 1) {
      const pts: THREE.Vector3[] = [], a = this.path.start, b = this.path.end, n = Math.min(400, K.length * 40);
      for (let i = 0; i <= n; i++) { const p = this.path.sample(a + (b - a) * i / n); if (p) pts.push(new THREE.Vector3(...p.pos)); }
      add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), PATH_MAT));
    }
    K.forEach((k, i) => {
      const at = new THREE.Vector3(...k.pos), cp = Math.cos(k.pitch);
      const node = new THREE.Mesh(new THREE.SphereGeometry(i === this.sel ? 0.1 : 0.07, 10, 8), i === this.sel ? SEL_MAT : NODE_MAT);
      node.position.copy(at);
      add(node);
      const look = at.clone().add(new THREE.Vector3(-Math.sin(k.yaw) * cp, Math.sin(k.pitch), -Math.cos(k.yaw) * cp).multiplyScalar(0.6));
      add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([at, look]), DIR_MAT));
    });
  }


  // ---- render ----
  private renderOpts = { w: window.innerWidth & ~1, h: window.innerHeight & ~1, fps: 250, codec: "prores422lt", name: "" };

  /** the part of the window the render keeps: the output size fitted inside it, centred */
  private frameBox(): { x: number; y: number; w: number; h: number } {
    const W = window.innerWidth, H = window.innerHeight, o = this.renderOpts, s = Math.min(W / o.w, H / o.h);
    return { x: (W - o.w * s) / 2, y: (H - o.h * s) / 2, w: o.w * s, h: o.h * s };
  }

  private layoutMask(): void {
    const b = this.frameBox(), st = this.root.querySelector<HTMLElement>(".mvm-mask")!.style;
    st.left = `${b.x}px`; st.top = `${b.y}px`; st.width = `${b.w}px`; st.height = `${b.h}px`;
  }

  private async renderMovie(): Promise<void> {
    if (this.rendering) return;
    const { w, h, fps } = this.renderOpts;
    const a = this.inPt, b = this.outPt;
    if (b - a < 0.1) { this.toast("Set an in / out range first (B / N)"); return; }
    // <demo or file name>_<player>_pov|third or _cine; the server appends the first free number
    const who = this.net.roster().find((p) => p.id === this.host.game.observedId)?.name ?? "player";
    const tag = this.mode === "pov" || this.mode === "third" ? `_${who}_${this.mode}` : "_cine";
    const name = `${this.renderOpts.name || this.net.demo.name.replace(/\.pbdemo$/, "")}${tag}`.replace(/[^\w.-]/g, "_");
    const start = await fetch(`${DEMO_API}/render/start`, { method: "POST", body: JSON.stringify({ w, h, fps, codec: this.renderOpts.codec, name }) });
    if (start.status === 503) {
      window.alert("Rendering needs ffmpeg, and none was found on PATH.\n\nInstall it (for example: winget install Gyan.FFmpeg), then restart start_server.cmd.");
      return;
    }
    if (!start.ok) { this.toast(`Render failed to start: ${await start.text()}`); return; }
    const { id } = await start.json() as { id: string };
    const { renderer, camera } = this.host;
    const ratio = renderer.getPixelRatio(), audio = THREE.AudioContext.getContext();
    this.openEdit(null);
    this.rendering = true;
    this.pathViz.visible = false;
    this.cancelRender = false;
    this.playing = false;
    this.root.classList.add("off", "rendering");
    void audio.suspend(); // sounds would play at the render's crawl
    renderer.setPixelRatio(1);
    // exactly the unmasked box of the window's view, whatever the output aspect (fov stays the window's)
    const box = this.frameBox();
    camera.setViewOffset(window.innerWidth, window.innerHeight, box.x, box.y, box.w, box.h);
    renderer.setSize(w, h, false);
    const gl = renderer.getContext(), px = new Uint8Array(w * h * 4), step = 1 / fps; // game time, like IWXMVM: the playback speed is a preview setting only
    const frames = Math.round((b - a) / step);
    // the preview's brightness is a CSS filter on the canvas (main.ts) that readPixels never sees [INFERIDO: brightness() scales the sRGB bytes]
    const bf = brightnessFactor(), shade = new Uint8ClampedArray(px.buffer);
    let ok = true;
    const inflight: Promise<void>[] = [];
    const t0 = performance.now();
    try {
      this.seek(a); // the exact seek: the in point looks as it did in the preview
      for (let i = 0; i < frames && ok && !this.cancelRender; i++) {
        if (i) this.step(step);
        else { this.host.simulate(0); this.updateCamera(0); this.draw(step); }
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (bf !== 1) for (let j = 0; j < shade.length; j += 4) { shade[j] *= bf; shade[j + 1] *= bf; shade[j + 2] *= bf; }
        // a Blob body (a copy, so px is free again) uploads ~8x faster than the typed array itself in Chromium
        inflight.push(fetch(`${DEMO_API}/render/frame?id=${id}&n=${i}`, { method: "POST", body: new Blob([px]) }).then(async (r) => {
          if (!r.ok && ok) { ok = false; this.toast(`Render failed: ${(await r.json().catch(() => ({}))).error ?? r.status}`, 0); }
        }).catch((e: unknown) => { if (ok) { ok = false; this.toast(`Render failed: ${String(e)}`, 0); } }));
        // the next frames render while these upload; ffmpeg's own pace holds the rest back
        if (inflight.length >= 3) await inflight.shift();
        const fps = (i + 1) / ((performance.now() - t0) / 1000);
        this.toast(`Rendering ${i + 1} / ${frames} · ${fps.toFixed(1)} fps  (Esc cancels)`, 0);
      }
      await Promise.all(inflight);
    } finally {
      // a cancel still finishes the file: every frame sent so far has been written in order (inflight awaited above)
      const end = await fetch(`${DEMO_API}/render/${ok ? "end" : "abort"}?id=${id}`, { method: "POST" });
      const res = await end.json().catch(() => ({})) as { file?: string; log?: string };
      this.rendering = false;
      this.root.classList.remove("off", "rendering");
      void audio.resume();
      renderer.setPixelRatio(ratio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight; // a resize meanwhile was held back (busyRendering)
      camera.clearViewOffset();
      this.toast(end.ok && ok ? `${this.cancelRender ? "Stopped early, saved" : "Saved"} ${res.file}` : `ffmpeg failed: ${res.log ?? end.status}`, 8000);
    }
  }

  /** one fixed render step: demo clock, world, camera, frame */
  private step(dt: number): void {
    this.time += dt;
    this.net.advance(this.time);
    this.host.game.poseRemotes(this.net.poses(this.time));
    this.host.simulate(dt);
    this.updateCamera(dt);
    this.draw(dt);
  }

  // ---- input ----
  private wire(): void {
    const sig = { signal: this.ac.signal };
    // capture on window: the match's own keys (chat, radio, T, Tab...) never see a theater key
    window.addEventListener("keydown", (e) => {
      if (e.altKey && e.code === "Enter") return; // fullscreen (ui/fullscreen.ts)
      if ((e.target as HTMLElement).closest?.("input,select")) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (this.rendering && e.code !== "Escape") return; // the clock and camera stay the render's
      this.held.add(e.code);
      if (!e.repeat) this.key(e);
    }, { capture: true, ...sig });
    window.addEventListener("keyup", (e) => { this.held.delete(e.code); e.stopImmediatePropagation(); }, { capture: true, ...sig });
    window.addEventListener("blur", () => { this.held.clear(); this.looking = false; }, sig);
    window.addEventListener("resize", () => this.layoutMask(), sig);
    const cv = this.host.renderer.domElement;
    cv.addEventListener("mousedown", (e) => {
      if (this.rendering) return;
      if (e.button === 2) this.looking = true;
      if (e.button === 1 && this.mode === "free") { e.preventDefault(); this.free.pitch = 0; this.free.roll = 0; this.free.fov = 70; }
      else if (e.button === 1 && this.mode !== "dolly") { e.preventDefault(); this.setPovFov(null); }
    }, sig);
    window.addEventListener("mouseup", (e) => { if (e.button === 2) this.looking = false; }, sig);
    // window, not canvas: the cursor keeps steering the mouse focus over the panels and while a render runs
    window.addEventListener("mousemove", (e) => {
      const r = cv.getBoundingClientRect();
      this.mouseUv.set(THREE.MathUtils.clamp((e.clientX - r.left) / r.width, 0, 1), THREE.MathUtils.clamp(1 - (e.clientY - r.top) / r.height, 0, 1));
    }, sig);
    window.addEventListener("mousemove", (e) => {
      if (!this.looking || this.mode !== "free" || this.rendering) return;
      const k = LOOK * this.free.fov / 70;
      this.free.yaw -= e.movementX * k;
      this.free.pitch = Math.max(-1.55, Math.min(1.55, this.free.pitch - e.movementY * k));
    }, sig);
    cv.addEventListener("wheel", (e) => {
      if (this.rendering) return;
      if (this.mode === "third") {
        e.preventDefault();
        this.setPovFov((this.povFov ?? Math.round(this.host.camera.fov)) + Math.sign(e.deltaY) * 2);
        return;
      }
      if (this.mode !== "free") return;
      e.preventDefault();
      if (e.altKey) this.free.roll += Math.sign(e.deltaY) * 0.02;
      else this.free.fov = Math.max(5, Math.min(140, this.free.fov + Math.sign(e.deltaY) * 2));
      this.toast(e.altKey ? `Roll ${(this.free.roll * 180 / Math.PI).toFixed(0)}°` : `FOV ${this.free.fov.toFixed(0)}°`, 800);
    }, { passive: false, ...sig });
    cv.addEventListener("contextmenu", (e) => e.preventDefault(), sig);
    cv.addEventListener("click", (e) => !this.rendering && this.openEdit(this.actorAt(e.clientX, e.clientY), e.clientX, e.clientY), sig);

    this.root.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a],[data-tab],[data-id],[data-key],[data-del]");
      if (!b) return;
      if (b.dataset.tab) { this.tab = b.dataset.tab; this.drawSide(); return; }
      if (b.dataset.id) { this.setMode(this.mode === "third" ? "third" : "pov", b.dataset.id); return; }
      if (b.dataset.key) { const k = this.path.keys[+b.dataset.key]; this.sel = +b.dataset.key; if (k) { this.seek(k.t); this.free = { ...k, pos: [...k.pos] as CamKey["pos"] }; } this.drawSide(); return; }
      if (b.dataset.del) { this.path.remove(+b.dataset.del); this.sel = -1; this.drawSide(); return; }
      this.action(b.dataset.a!);
    }, sig);
    this.root.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement;
      const o = this.renderOpts;
      // even sizes: the 4:2:2 ProRes profiles halve the width of the colour planes
      if (t.name === "w" || t.name === "h") { const v = Math.max(16, Math.min(t.name === "w" ? 7680 : 4320, Math.round(+t.value / 2) * 2 || 2)); o[t.name] = v; t.value = String(v); this.layoutMask(); }
      else if (t.name === "fps") o.fps = +t.value;
      else if (t.name === "codec") o.codec = t.value;
      else if (t.name === "povfov") this.setPovFov(t.value === "" ? null : +t.value || null);
      else if (t.name === "name") o.name = t.value;
      else if (t.name === "lookname") this.lookName = t.value;
      else if (t.name === "dofactor") this.dofActor = t.value || null;
      else if (t.name === "chara" && this.editId) {
        this.net.setChara(this.editId, +t.value || null);
        this.setDirty(true);
        this.seek(this.time); // the seek replays each actor's last state, now with the new character
      }
      else if (t.name === "hat" && this.editId) {
        // "" = recorded, "0" = bare head, else "<slot>:<itemId>"
        const [slot, id] = t.value.split(":");
        this.net.setHat(this.editId, t.value === "" ? null : { head: slot === "head" ? +id : 0, beret: slot === "beret" ? +id : 0 });
        this.setDirty(true);
      }
      else if (t.name === "deathclip" && t.dataset.key) {
        this.net.setDeathClip(t.dataset.key, t.value || null);
        this.setDirty(true);
        this.seek(this.time); // the exact seek replays the death with its new clip
      }
      else if ((t.name === "kfov" || t.name === "kroll") && this.path.keys[this.sel]) {
        const k = this.path.keys[this.sel];
        if (t.name === "kfov") k.fov = Math.max(5, Math.min(140, +t.value || k.fov));
        else k.roll = (+t.value || 0) * Math.PI / 180;
      }
    }, sig);
    this.root.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement, k = t.dataset.look as keyof Look | undefined, d = t.dataset.dof as keyof Dof | undefined;
      if (k) this.looks.set({ [k]: typeof this.looks.base[k] === "number" ? +t.value || 0 : t.value });
      else if (d) this.dof[d] = +t.value || 0;
      else return;
      if (t.type === "range") t.nextElementSibling!.textContent = t.value;
      if (d === "mode") this.drawSide(); // its own controls per mode
    }, sig);
    // right-click a look / depth of field control: back to the map's own value / the default
    this.root.addEventListener("contextmenu", (e) => {
      const t = e.target as HTMLInputElement, k = t.dataset.look as keyof Look | undefined, d = t.dataset.dof as keyof Dof | undefined;
      if (!k && !d) return;
      e.preventDefault();
      t.value = String(k ? this.looks.base[k] : DOF_DEFAULT[d!]);
      t.dispatchEvent(new Event("input", { bubbles: true }));
    }, sig);
    this.wireTimeline();
  }

  private key(e: KeyboardEvent): void {
    switch (e.code) {
      case "Space": this.action("play"); break;
      case "ArrowUp": this.speedIdx = Math.min(SPEEDS.length - 1, this.speedIdx + 1); break;
      case "ArrowDown": this.speedIdx = Math.max(0, this.speedIdx - 1); break;
      case "ArrowLeft": this.skip(-1); break;
      case "ArrowRight": this.skip(1); break;
      case "KeyB": this.inPt = Math.min(this.time, this.outPt); this.toast(`In ${fmt(this.inPt)}`); break;
      case "KeyN": this.outPt = Math.max(this.time, this.inPt); this.toast(`Out ${fmt(this.outPt)}`); break;
      case "KeyF": this.setMode("free"); break;
      case "F2": this.setMode("pov"); break;
      case "F3": this.setMode("third"); break;
      case "BracketLeft": this.cycleTarget(-1); break;
      case "BracketRight": this.cycleTarget(1); break;
      case "KeyK": this.addKey(); break;
      case "KeyL": this.path.clear(); this.sel = -1; this.leaveDolly(); this.toast("Campath cleared"); this.drawSide(); break;
      case "KeyJ": this.action("dolly"); break;
      case "Delete": if (this.sel >= 0) { this.path.remove(this.sel); this.sel = -1; this.drawSide(); } break;
      case "KeyH": this.root.classList.toggle("off"); break;
      case "KeyG": this.action("clean"); break;
      case "Escape": this.cancelRender = true; break;
    }
  }

  private action(a: string): void {
    switch (a) {
      case "play": if (this.time >= this.net.demo.dur) this.seek(0); this.playing = !this.playing; break;
      case "back": this.skip(-1); break;
      case "fwd": this.skip(1); break;
      case "pov": this.setMode("pov"); break;
      case "third": this.setMode("third"); break;
      case "free": this.setMode("free"); break;
      case "dolly":
        if (this.mode === "dolly") { this.leaveDolly(); break; }
        if (this.path.keys.length < 2) { this.toast("Add at least two nodes (K)"); break; }
        this.setMode("dolly"); // play / pause stays as it is
        this.seek(this.path.start);
        break;
      case "add": this.addKey(); break;
      case "clear": this.path.clear(); this.sel = -1; this.leaveDolly(); this.drawSide(); break;
      case "pathRange": if (this.path.keys.length > 1) { this.inPt = this.path.start; this.outPt = this.path.end; } break;
      case "fullRange": this.inPt = 0; this.outPt = this.net.demo.dur; break;
      case "render": void this.renderMovie(); break;
      case "clean": document.body.classList.toggle("mvm-clean"); break;
      case "save": void this.save(); break;
      case "closeEdit": this.openEdit(null); break;
      case "focusActor":
        this.dofActor = this.editId;
        this.dof.mode = 3;
        this.drawSide();
        break;
      case "lookLoad": void this.loadLook(); break;
      case "lookSave": void this.saveLook(); break;
      case "lookDel": void this.deleteLook(); break;
      case "lookReset": this.looks.set(this.looks.base); this.lookName = ""; this.drawSide(); break;
      case "exit": if (!this.dirty || window.confirm("Exit without saving your demo changes?")) this.host.exit(); break;
    }
  }

  private wireTimeline(): void {
    const cv = this.tl, sig = { signal: this.ac.signal };
    let drag: "seek" | number | null = null;
    const tAt = (x: number) => (x / cv.clientWidth) * this.net.demo.dur;
    const keyAt = (x: number) => this.path.keys.findIndex((k) => Math.abs((k.t / this.net.demo.dur) * cv.clientWidth - x) < 6);
    cv.addEventListener("mousedown", (e) => {
      const i = keyAt(e.offsetX);
      if (e.button === 2) { if (i >= 0) { this.path.remove(i); this.sel = -1; this.drawSide(); } return; }
      if (i >= 0 && e.offsetY < cv.clientHeight / 2) { drag = i; this.sel = i; this.drawSide(); return; }
      drag = "seek";
      this.seek(tAt(e.offsetX), false);
    }, sig);
    window.addEventListener("mousemove", (e) => {
      if (drag === null) return;
      const x = e.clientX - cv.getBoundingClientRect().left, t = Math.max(0, Math.min(this.net.demo.dur, tAt(x)));
      if (drag === "seek") this.seek(t, false);
      else { drag = this.sel = this.path.retime(drag, t); }
    }, sig);
    window.addEventListener("mouseup", () => {
      if (typeof drag === "number") this.drawSide();
      else if (drag === "seek") this.seek(this.time);
      drag = null;
    }, sig);
  }

  // ---- UI ----
  private drawBar(): void {
    const q = (s: string) => this.root.querySelector<HTMLElement>(s)!;
    q('[data-a="play"]').textContent = this.playing ? "❚❚" : "▶";
    q(".time").textContent = `${fmt(this.time)} / ${fmt(this.net.demo.dur)}`;
    q(".speed").textContent = `${SPEEDS[this.speedIdx]}x`;
    q(".mode").textContent = { pov: "First person", third: "Third person", free: "Free camera", dolly: "Dolly" }[this.mode];
    q(".range").textContent = `In ${fmt(this.inPt)} · Out ${fmt(this.outPt)}`;
    const cv = this.tl, w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext("2d")!, X = (t: number) => (t / this.net.demo.dur) * w;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#23262c"; g.fillRect(0, h / 2 - 3, w, 6);
    g.fillStyle = "rgba(240,168,48,.25)"; g.fillRect(X(this.inPt), 0, X(this.outPt) - X(this.inPt), h);
    g.fillStyle = "#c33"; for (const t of this.kills) g.fillRect(X(t) - 0.5, h - 9, 1.5, 7);
    if (this.path.keys.length > 1) { g.fillStyle = "rgba(90,160,255,.35)"; g.fillRect(X(this.path.start), 4, X(this.path.end) - X(this.path.start), 3); }
    this.path.keys.forEach((k, i) => {
      const x = X(k.t);
      g.fillStyle = i === this.sel ? "#fff" : "#5aa0ff";
      g.beginPath(); g.moveTo(x, 2); g.lineTo(x + 5, 8); g.lineTo(x, 14); g.lineTo(x - 5, 8); g.fill();
    });
    g.fillStyle = "#f0a830"; g.fillRect(X(this.time) - 1, 0, 2, h);
  }

  private drawSide(): void {
    for (const b of this.root.querySelectorAll<HTMLElement>("[data-tab]")) b.classList.toggle("on", b.dataset.tab === this.tab);
    const body = this.root.querySelector(".body")!;
    const m = this.mode, o = this.renderOpts;
    const btn = (a: string, t: string, on = false) => `<button data-a="${a}" class="${on ? "on" : ""}">${t}</button>`;
    if (this.tab === "camera") {
      const cur = this.host.game.observedId;
      body.innerHTML = `<div class="row">${btn("pov", "POV", m === "pov")}${btn("third", "Third", m === "third")}${btn("free", "Free", m === "free")}${btn("dolly", "Dolly", m === "dolly")}</div>
        <div class="row"><label>POV FOV</label><input name="povfov" type="number" min="5" max="140" step="1" placeholder="game" value="${this.povFov ?? ""}" style="width:60px"></div>
        <div class="hint">Players (click to watch, [ / ] to cycle)</div>
        <div class="list">${this.net.roster().map((a) => `<div class="item ${a.id === cur ? "on" : ""}" data-id="${esc(a.id)}"><span class="dot" style="background:${a.team ? "#2c6fd3" : "#d33a2c"}"></span>${esc(a.name)}</div>`).join("")}</div>
        <div class="hint">Free camera: hold right mouse to look, WASD / Q E to move, wheel = FOV, Alt + wheel = roll.</div>`;
    } else if (this.tab === "campath") {
      const k = this.path.keys[this.sel];
      body.innerHTML = `<div class="row">${btn("add", "Add (K)")}${btn("dolly", "Play (J)")}${btn("clear", "Clear (L)")}</div>
        <div class="list">${this.path.keys.map((key, i) => `<div class="item ${i === this.sel ? "on" : ""}" data-key="${i}"><span style="flex:1">#${i + 1} · ${fmt(key.t)} · ${key.fov.toFixed(0)}°</span><button data-del="${i}">✕</button></div>`).join("") || `<div class="hint">No nodes. Move the free camera (F) and press K.</div>`}</div>
        ${k ? `<div class="row"><label>FOV</label><input name="kfov" type="number" min="5" max="140" step="1" value="${k.fov.toFixed(1)}"></div>
        <div class="row"><label>Roll °</label><input name="kroll" type="number" step="1" value="${(k.roll * 180 / Math.PI).toFixed(1)}"></div>` : ""}
        <div class="hint">Drag a node on the timeline to retime it, right-click to delete it.</div>`;
    } else if (this.tab === "visuals") {
      if (!this.lookNames) void this.fetchLooks();
      const l = this.looks.current, d = this.dof, row = (label: string, html: string) => `<div class="row"><label>${label}</label>${html}</div>`;
      const color = (k: keyof Look) => `<input type="color" data-look="${k}" value="${l[k]}">`;
      const slider = (k: keyof Look | keyof Dof, min: number, max: number, step: number, set = "look") => {
        const v = set === "dof" ? this.dof[k as keyof Dof] : l[k as keyof Look];
        return `<input type="range" data-${set}="${k}" min="${min}" max="${Math.max(max, +v)}" step="${step}" value="${v}" style="flex:1;min-width:0"><span class="hint" style="width:34px;text-align:right">${v}</span>`;
      };
      const num = (k: keyof Look, step: number) => `<input type="number" data-look="${k}" min="0" step="${step}" value="${l[k]}" style="width:70px">`;
      const opts = (k: keyof Look, list: [string | number, string][]) => `<select data-look="${k}" style="flex:1;min-width:0">${list.map(([v, t]) => `<option value="${v}" ${v === l[k] ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
      const head = (t: string) => `<div class="hint" style="color:#f0a830;margin-top:4px">${t}</div>`;
      body.innerHTML = `<div class="row"><select name="looksel" style="flex:1;min-width:0">${(this.lookNames ?? []).map((n) => `<option ${n === this.lookName ? "selected" : ""}>${esc(n)}</option>`).join("") || "<option value=\"\">No saved looks</option>"}</select>${btn("lookLoad", "Load")}${btn("lookDel", "✕")}</div>
        <div class="row"><input name="lookname" placeholder="Look name" value="${esc(this.lookName)}" style="flex:1;min-width:0">${btn("lookSave", "Save")}${btn("lookReset", "Map default")}</div>
        ${head("World")}${row("Lit areas", color("worldLitColor") + slider("worldLit", 0, 3, 0.05))}
        ${row("Shade", color("worldShadeColor") + slider("worldShade", 0, 3, 0.05))}
        ${head("Players")}${row("Sun", color("sunColor") + slider("sunStrength", 0, 3, 0.05))}
        ${row("Azimuth", slider("sunAzimuth", -180, 180, 1))}
        ${row("Elevation", slider("sunElevation", -90, 90, 1))}
        ${row("Tint", color("ambientColor") + slider("ambientStrength", 0, 3, 0.05))}
        ${head("Fog")}${row("Mode", opts("fogMode", [[0, "Off"], [3, "Linear"], [1, "Exponential"], [2, "Exponential²"]]))}
        ${row("Colour", color("fogColor"))}
        ${row("Near / far", num("fogNear", 1) + num("fogFar", 1))}
        ${row("Density", num("fogDensity", 0.0005))}
        ${head("Sky")}${row("Sky", opts("sky", [["", "Map's own"], ["none", "None"], ...this.skyNames.map((n): [string, string] => [n, n])]))}
        ${row("Tint", color("skyColor") + slider("skyStrength", 0, 3, 0.05))}
        ${row("Background", color("background"))}
        ${head("Depth of field")}${row("Focus", `<select data-dof="mode" style="flex:1;min-width:0">${([[0, "Off"], [1, "Manual"], [2, "Mouse"], [3, "Player"]] as const).map(([v, t]) => `<option value="${v}" ${v === d.mode ? "selected" : ""}>${t}</option>`).join("")}</select>`)}
        ${d.mode === 1 ? row("Distance", slider("focus", 0.2, 100, 0.1, "dof")) : ""}
        ${d.mode === 2 ? row("Speed", slider("speed", 0.5, 30, 0.5, "dof")) + `<div class="hint">Focuses on what is under the cursor, also while rendering. Speed: how fast it follows.</div>` : ""}
        ${d.mode === 3 ? row("Player", `<select name="dofactor" style="flex:1;min-width:0">${this.net.roster().map((a) => `<option value="${esc(a.id)}" ${a.id === this.dofTarget() ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>`) : ""}
        ${d.mode ? row("Aperture", slider("aperture", 0, 5, 0.05, "dof")) + row("Near blur", slider("near", 0, 3, 0.05, "dof")) + row("Far blur", slider("far", 0, 3, 0.05, "dof")) + row("Max blur", slider("maxBlur", 0, 5, 0.05, "dof")) : ""}
        <div class="hint">Right-click a control to reset it. Looks are saved to point-blank-webport/mvm/looks.</div>`;
    } else if (this.tab === "render") {
      body.innerHTML = `<div class="row"><label>Resolution</label><input name="w" type="number" min="16" max="7680" step="2" value="${o.w}" style="width:70px"> ×
          <input name="h" type="number" min="16" max="4320" step="2" value="${o.h}" style="width:70px"></div>
        <div class="row"><label>FPS</label><select name="fps">${FRAMERATES.map((f) => `<option ${f === o.fps ? "selected" : ""}>${f}</option>`).join("")}</select></div>
        <div class="row"><label>Format</label><select name="codec">${CODECS.map(([v, l]) => `<option value="${v}" ${v === o.codec ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="row"><label>File</label><input name="name" placeholder="${esc(this.net.demo.name.replace(/\.pbdemo$/, ""))}" value="${esc(o.name)}"></div>
        <div class="row">${btn("pathRange", "Range = path")}${btn("fullRange", "Whole demo")}</div>
        <div class="hint">Renders the in / out range (B / N) with the current camera, in real time (1 s of demo = 1 s of video). Saved to point-blank-webport/mvm/movies.</div>
        <div class="row">${btn("render", "Render")}</div>`;
    } else {
      const rows: [string, string][] = [["Space", "Play / pause"], ["↑ / ↓", "Faster / slower"], ["← / →", `Skip ${SKIP} s back / forward, stopping at deaths, dolly nodes and in / out points`], ["B / N", "Set in / out point"],
        ["F", "Free camera"], ["F2 / F3", "First / third person"], ["[ / ]", "Previous / next player"], ["W A S D", "Move (free camera)"], ["Q / E", "Down / up"],
        ["Shift / Ctrl", "Faster / slower move"], ["Right mouse", "Look (free camera)"], ["Wheel", "FOV (free, third)"], ["Alt + wheel", "Roll"], ["Middle mouse", "Reset angle / FOV"],
        ["K", "Add dolly node"], ["L", "Clear nodes"], ["J", "Play dolly path"], ["Delete", "Remove selected node"],
        ["G", "Hide game HUD"], ["H", "Hide this UI"], ["Esc", "Cancel render"]];
      body.innerHTML = `<table class="keys">${rows.map(([k, t]) => `<tr><td>${k}</td><td>${t}</td></tr>`).join("")}</table>`;
    }
  }

  // ---- demo editor ----
  /** [RECRIADO] the player under the cursor (nearest body the view ray hits); the watched one is skipped in first person */
  private actorAt(x: number, y: number): string | null {
    const g = this.host.game, r = this.host.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), this.host.camera);
    let best: string | null = null, dist = Infinity;
    for (const [id, a] of g.remotes) {
      if (this.mode === "pov" && id === g.observedId) continue;
      const hit = ray.intersectObject(a.charVisual.root, true)[0];
      if (hit && hit.distance < dist) { dist = hit.distance; best = id; }
    }
    return best;
  }

  private openEdit(id: string | null, x = 0, y = 0): void {
    this.editId = id;
    this.editSig = "";
    this.setOutline(id);
    const el = this.root.querySelector<HTMLElement>(".edit")!;
    el.style.display = id ? "flex" : "none";
    if (!id) return;
    el.style.left = `${Math.min(x + 8, window.innerWidth - 250)}px`;
    el.style.top = `${Math.min(y + 8, window.innerHeight - 160)}px`;
    this.drawEdit();
  }

  private drawEdit(): void {
    const id = this.editId, el = this.root.querySelector<HTMLElement>(".edit")!;
    if (!id) return;
    const a = this.host.game.remotes.get(id), anim = a?.charVisual.anim;
    const name = this.net.roster().find((p) => p.id === id)?.name ?? id;
    const death = this.net.deathAt(id, this.time), ch = this.net.charaOf(id);
    if ((a?.charVisual.root ?? null) !== this.outlineRoot) this.setOutline(id); // the model was swapped in
    // redrawn only when what it shows changes: a rebuild would close an open dropdown
    const hat = this.net.hatOf(id), worn = actorEquip(id);
    const sig = `${death?.key}|${death?.clip}|${a?.alive}|${anim?.deathClip}|${ch.chara}|${ch.edited}|${this.charas.length}|${hat?.head}/${hat?.beret}|${this.hats.length}|${worn?.head}/${worn?.beret}`;
    if (sig === this.editSig) return;
    this.editSig = sig;
    if (!this.charas.length) void charaChoices().then((c) => { this.charas = c; });
    if (!this.hats.length) void hatChoices().then((h) => { this.hats = h; });
    const rec = ch.edited ? undefined : ch.chara;
    const model = `<div class="hint">Model</div><select name="chara"><option value="">Recorded${rec ? ` (${esc(this.charas.find((c) => c.itemId === rec)?.label ?? String(rec))})` : ""}</option>
      ${this.charas.map((c) => `<option value="${c.itemId}" ${ch.edited && c.itemId === ch.chara ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select>`;
    const recHat = hat ? undefined : this.hats.find((h) => h.itemId === (worn?.head || worn?.beret));
    const pickedHat = hat && (hat.head || hat.beret);
    const hats = `<div class="hint">Hat</div><select name="hat"><option value="">Recorded${recHat ? ` (${esc(recHat.label)})` : ""}</option>
      <option value="0" ${hat && !pickedHat ? "selected" : ""}>No item (default helmet)</option>
      ${this.hats.map((h) => `<option value="${h.slot}:${h.itemId}" ${pickedHat === h.itemId ? "selected" : ""}>${esc(h.label)}</option>`).join("")}</select>`;
    let body: string;
    if (!death || !a || a.alive || !anim) body = `<div class="hint">Not in a death animation now. Pause on a death to change it.</div>`;
    else {
      const clips = anim.deathClips(), now = anim.deathClip;
      body = `<div class="hint">Death animation${now ? ` (playing ${esc(now)})` : ""}</div>
        <select name="deathclip" data-key="${esc(death.key)}"><option value="">Recorded</option>
        ${clips.map((c) => `<option value="${esc(c)}" ${c === death.clip ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>`;
    }
    el.innerHTML = `<div class="row"><b style="flex:1">${esc(name)}</b><button data-a="focusActor" title="Depth of field: keep this player in focus">Focus</button><button data-a="closeEdit">✕</button></div>${model}${hats}${body}`;
  }

  /** outline copies of the selected body's meshes, children of each one (same transform, same skeleton) */
  private setOutline(id: string | null): void {
    for (const o of this.outline) o.removeFromParent();
    this.outline = [];
    const root = this.outlineRoot = (id ? this.host.game.remotes.get(id)?.charVisual.root : null) ?? null;
    const meshes: THREE.Mesh[] = [];
    root?.traverse((m) => { if (m instanceof THREE.Mesh) meshes.push(m); }); // collected first: adding children mid-traverse would visit them
    for (const m of meshes) {
      const o = m instanceof THREE.SkinnedMesh ? new THREE.SkinnedMesh(m.geometry, OUTLINE_MAT) : new THREE.Mesh(m.geometry, OUTLINE_MAT);
      if (o instanceof THREE.SkinnedMesh) o.bind((m as THREE.SkinnedMesh).skeleton, (m as THREE.SkinnedMesh).bindMatrix);
      o.frustumCulled = false; // a death clip carries the body out of the bind-pose bounds
      m.add(o);
      this.outline.push(o);
    }
  }

  // ---- looks ----
  /** the frame, through the depth of field when it is on; the first-person gun and the campath stay sharp on top */
  private draw(dt: number): void {
    const d = this.dof;
    if (!d.mode) { this.host.render(); return; }
    this.post ??= new Post(this.host.renderer);
    if (d.mode === 3) this.dofZ = this.actorDepth(this.dofTarget()) ?? this.dofZ; // held while the player is gone
    this.post.render(this.host.game.scene, this.host.camera, {
      focus: d.mode === 1 ? d.focus : this.dofZ, focusUv: d.mode === 2 ? this.mouseUv : null, focusLerp: 1 - Math.exp(-d.speed * dt),
      aperture: d.aperture / 100, maxBlur: d.maxBlur / 100, near: d.near, far: d.far,
    }, [...this.host.camera.children, this.pathViz]);
  }

  /** an arrow skip: SKIP s, stopping at the first death, dolly node or in / out point on the way */
  private skip(dir: 1 | -1): void {
    const t = this.time, eps = 0.05; // past the stop it sits on
    let to = t + dir * SKIP;
    for (const s of [...this.kills, ...this.path.keys.map((k) => k.t), this.inPt, this.outPt]) {
      if (dir > 0 ? s > t + eps && s < to : s < t - eps && s > to) to = s;
    }
    this.seek(to);
  }

  /** the focused player: the one picked, else the watched one */
  private dofTarget(): string | null {
    return this.dofActor ?? this.host.game.observedId;
  }

  /** view distance to a player's chest (Spine3), alive or ragdolled */
  private actorDepth(id: string | null): number | null {
    const v = id ? this.host.game.remotes.get(id)?.charVisual : null;
    if (!v) return null;
    const p = v.boneWorld("Spine3", new THREE.Vector3()) ?? v.root.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.2, 0));
    this.host.camera.updateMatrixWorld(); // this frame's pose, not the last render's
    return Math.max(0.05, -p.applyMatrix4(this.host.camera.matrixWorldInverse).z);
  }

  private async fetchLooks(): Promise<void> {
    this.lookNames = []; // one fetch at a time
    [this.lookNames, this.skyNames] = await Promise.all([listLooks().catch(() => []), listSkies()]);
    if (this.tab === "visuals") this.drawSide();
  }

  private pickedLook(): string {
    return this.root.querySelector<HTMLSelectElement>('[name="looksel"]')?.value ?? "";
  }

  private async loadLook(): Promise<void> {
    const n = this.pickedLook();
    if (!n) return;
    try {
      this.looks.set(await readLook(n, this.looks.base));
      this.lookName = n;
      this.drawSide();
      this.toast(`Look "${n}" loaded`);
    } catch (e) {
      this.toast(`Could not load: ${String(e)}`, 5000);
    }
  }

  private async saveLook(): Promise<void> {
    // the dev server takes one plain file name
    const n = this.lookName.trim().replace(/[^\w.-]/g, "_").replace(/^[.-]+/, "").slice(0, 100);
    if (!n) { this.toast("Name the look first"); return; }
    if (this.lookNames?.includes(n) && !window.confirm(`Replace the look "${n}"?`)) return;
    try {
      await writeLook(n, this.looks.current);
      this.lookName = n;
      this.lookNames = null;
      this.drawSide();
      this.toast(`Look "${n}" saved`);
    } catch (e) {
      this.toast(`Could not save: ${String(e)}`, 5000);
    }
  }

  private async deleteLook(): Promise<void> {
    const n = this.pickedLook();
    if (!n || !window.confirm(`Delete the look "${n}"?`)) return;
    if (!(await deleteLook(n))) { this.toast("Could not delete"); return; }
    if (this.lookName === n) this.lookName = "";
    this.lookNames = null;
    this.drawSide();
  }

  private setDirty(v: boolean): void {
    this.dirty = v;
    this.root.querySelector<HTMLElement>('[data-a="save"]')!.style.display = v ? "" : "none";
  }

  private async save(): Promise<void> {
    try {
      await saveDemo(this.net.demo);
      this.setDirty(false);
      this.toast("Demo saved");
    } catch (e) {
      this.toast(`Could not save: ${String(e)}`, 5000);
    }
  }

  private toastT = 0;
  private toast(text: string, ms = 1500): void {
    let el = this.root.querySelector<HTMLElement>(".mvm-toast");
    if (!el) { el = document.createElement("div"); el.className = "p mvm-toast"; this.root.appendChild(el); }
    el.textContent = text;
    el.style.display = "";
    clearTimeout(this.toastT);
    if (ms) this.toastT = window.setTimeout(() => { el!.style.display = "none"; }, ms);
  }

  dispose(): void {
    this.setOutline(null);
    this.looks.dispose();
    this.post?.dispose();
    this.cancelRender = true;
    this.ac.abort();
    this.root.remove();
    this.pathViz.removeFromParent();
    for (const c of this.pathViz.children) (c as THREE.Mesh).geometry.dispose();
    document.body.classList.remove("mvm-clean");
  }
}

/** demo browser: resolves with the picked demo, or null on close */
export function pickDemo(): Promise<string | null> {
  return new Promise((done) => {
    ensureCss();
    const root = document.createElement("div");
    root.id = "mvm";
    root.innerHTML = `<div class="p" style="position:absolute;left:50%;top:12%;transform:translateX(-50%);width:min(560px,94vw);max-height:76%;display:flex;flex-direction:column">
      <div class="row" style="padding:10px 12px;border-bottom:1px solid #333"><b style="flex:1;font-size:14px">Theater · demos</b><button data-a="close">Close</button></div>
      <div class="row" style="padding:8px 12px 0"><input class="search" placeholder="Search demos" style="flex:1"></div>
      <div class="body list"><div class="hint">Loading…</div></div>
      <div class="hint" style="padding:0 12px 8px">Right-click a demo to rename or delete it.</div></div>
      <div class="p menu" style="position:fixed;display:none;flex-direction:column;padding:3px;min-width:110px">
        <button data-a="rename" style="border:0;text-align:left">Rename</button><button data-a="delete" style="border:0;text-align:left">Delete</button></div>`;
    document.body.appendChild(root);
    const list = root.querySelector(".body")!, search = root.querySelector<HTMLInputElement>(".search")!, menu = root.querySelector<HTMLElement>(".menu")!;
    let demos: DemoListing[] = [], target = "";
    const finish = (v: string | null) => { root.remove(); done(v); };
    const draw = () => {
      const q = search.value.trim().toLowerCase(), shown = demos.filter((d) => d.name.toLowerCase().includes(q));
      list.innerHTML = shown.length
        ? shown.map((d) => `<div class="item" data-demo="${esc(d.name)}"><span style="flex:1">${esc(d.name)}</span><span class="hint">${(d.size / 1e6).toFixed(1)} MB</span></div>`).join("")
        : `<div class="hint">${demos.length ? "No demo matches." : "No demos yet. Every match you play is recorded to point-blank-webport/mvm/demos."}</div>`;
    };
    const load = () => listDemos().then((ds) => { demos = ds; draw(); }).catch((e) => { list.innerHTML = `<div class="hint">Could not list demos: ${esc(String(e))}</div>`; });
    search.addEventListener("input", draw);
    search.addEventListener("keydown", (e) => e.stopPropagation()); // the lobby's own keys stay out of the search
    root.addEventListener("contextmenu", (e) => {
      const it = (e.target as HTMLElement).closest<HTMLElement>("[data-demo]");
      e.preventDefault();
      if (!it) return;
      target = it.dataset.demo!;
      Object.assign(menu.style, { display: "flex", left: `${e.clientX}px`, top: `${e.clientY}px` });
    });
    root.addEventListener("click", async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a],[data-demo]");
      menu.style.display = "none";
      if (b?.dataset.demo) finish(b.dataset.demo);
      else if (b?.dataset.a === "close") finish(null);
      else if (b?.dataset.a === "rename") {
        const to = window.prompt("Rename demo", target.replace(/\.pbdemo$/, ""))?.trim().replace(/\.pbdemo$/, "").replace(/[^\w.-]/g, "_");
        if (!to || `${to}.pbdemo` === target) return;
        const err = await renameDemo(target, `${to}.pbdemo`);
        if (err) window.alert(`Could not rename: ${err}`);
        void load();
      } else if (b?.dataset.a === "delete") {
        if (!window.confirm(`Delete ${target}? This cannot be undone.`)) return;
        if (!(await deleteDemo(target))) window.alert("Could not delete the demo.");
        void load();
      }
    });
    void load();
    search.focus();
  });
}

function fmt(t: number): string {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function ensureCss(): void {
  if (document.getElementById("mvm-css")) return;
  const st = document.createElement("style");
  st.id = "mvm-css";
  st.textContent = CSS;
  document.head.appendChild(st);
}

/** runs fn with one-shot sounds silenced: an exact seek replays seconds of shots and steps in a few ms */
function silently(fn: () => void): void {
  const p = AudioScheduledSourceNode.prototype, start = p.start;
  // started at its own end, a one-shot plays nothing yet ends like any sound (three's Audio clears isPlaying, a voice can
  // be stopped); a loop (ambient) wraps the offset and keeps playing as it would after a real seek
  p.start = function (this: AudioScheduledSourceNode, ...a: number[]) {
    if (this instanceof AudioBufferSourceNode && this.buffer && !this.loop) (start as AudioBufferSourceNode["start"]).call(this, 0, this.buffer.duration);
    else start.apply(this, a as [number?]);
  };
  try { fn(); } finally { p.start = start; }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
