import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { Game } from "../game/game";
import { Campath, unwrap, type CamKey, type CamPose } from "./campath";
import { DEMO_API, demoInfo, deleteDemo, listDemos, renameDemo, saveDemo, type Demo, type DemoInfo, type DemoListing } from "./demo";
import { MAP_SHAPE, STAGE_SHAPE, mapShapeCell } from "../lobby/screensCross/crossMap";
import { assetUrl } from "../assetMap";
import { mapIndexEntry } from "../config";
import type { DemoNet } from "./demoNet";
import { Post, type DofParams } from "./post";
import { LAYERS, PASSES, Passes, layerPasses, type PassFrame, type PassName } from "./passes";
import { renderOnTop } from "../render/onTop";
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
const STEP_DELAY = 300, STEP_RATE = 30; // a held Ctrl + arrow: ms before it repeats, then ticks per second
const ZOOMS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const ZOOM_KEY = "mvm.uiZoom";
const demoEdits = (d: Demo) => JSON.stringify({ deaths: d.deaths, charas: d.charas, hats: d.hats });
/** depth of field (post.ts), kept apart from the looks: mode 0 off, 1 manual distance, 2 under the mouse, 3 a player;
 * blur in % of the image height; near / far scale it in front of / behind the focus; speed = mouse focus easing (1/s) */
const DOF_DEFAULT = { mode: 0, focus: 10, speed: 5, aperture: 1, maxBlur: 1, near: 1, far: 1 };
type Dof = typeof DOF_DEFAULT;
const FREE_SPEED = 6; // m/s
const LOOK = 0.0025; // rad per mouse px at 70 deg
// an exact seek replays this much from a reset world at a fixed step: longer than any death, reload or flinch clip
const WARM = 3, WARM_STEP = 1 / 60;
// the 3D campath draws over the world (no depth test): a path through a wall stays visible
const vizMat = (o: THREE.MeshBasicMaterialParameters) => new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, ...o });
// path colour runs with time: amber at the first node, blue at the last
const PATH_A = new THREE.Color(0xf0a830), PATH_B = new THREE.Color(0x5aa0ff);
const TINT_MAT = vizMat({ vertexColors: true, opacity: 0.9, side: THREE.DoubleSide }), FILL_MAT = vizMat({ color: 0xffffff, opacity: 0.1, side: THREE.DoubleSide });
const LINE_MAT = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
const HEAD_MAT = vizMat({ color: 0xffffff }), HALO_MAT = vizMat({ color: 0xffffff, opacity: 0.4 });
const paint = <G extends THREE.BufferGeometry>(g: G, c: THREE.Color): G =>
  g.setAttribute("color", new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count }, () => c.toArray()).flat(), 3)) as G;
function nodeLabel(text: string, c: THREE.Color, cache: Map<string, THREE.SpriteMaterial>): THREE.Sprite {
  const key = `${text}|${c.getHexString()}`;
  let mat = cache.get(key);
  if (!mat) cache.set(key, (mat = new THREE.SpriteMaterial({ map: labelTexture(text, c), depthTest: false, depthWrite: false, transparent: true })));
  const sp = new THREE.Sprite(mat);
  sp.scale.setScalar(0.16);
  return sp;
}
function labelTexture(text: string, c: THREE.Color): THREE.CanvasTexture {
  const cv = document.createElement("canvas"), x = cv.getContext("2d")!;
  cv.width = cv.height = 64;
  x.fillStyle = "rgba(14,16,20,.85)"; x.strokeStyle = `#${c.getHexString()}`; x.lineWidth = 5;
  x.beginPath(); x.arc(32, 32, 27, 0, Math.PI * 2); x.fill(); x.stroke();
  x.fillStyle = "#fff"; x.font = "bold 30px Segoe UI,Arial,sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(text, 32, 34);
  return new THREE.CanvasTexture(cv);
}
function disposeViz(o: THREE.Object3D): void {
  o.traverse((x) => (x as THREE.Mesh).geometry?.dispose());
}
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
// IWXMVM's capture rates: CoD steps its clock in whole ms, so 1000 / fps is an integer; the high ones are for frame-blended motion blur
const FRAMERATES = [50, 100, 125, 250, 500, 1000];
// the render tab's pass list: what each file holds (alpha = the format keeps a matte) and a swatch of what it looks like
// 30 x 20 pictures: a street with a crate (world), a player, a first-person gun; the mattes over a checkerboard where the
// format keeps alpha, else over the green they are keyed on
const WORLD_SVG = `<rect width="30" height="11" fill="#a9c8e4"/><rect y="8" width="30" height="3" fill="#cadded"/>
  <path d="M0 11V7h4V5h3v6h2V6h4v5h3V8h3v3z" fill="#8193a6"/><rect y="11" width="30" height="9" fill="#7d6e52"/>
  <path d="M15 11L8 20M15 11l7 9" stroke="#9a8866" stroke-width=".8"/><path d="M0 5.5l5 1.6v9.2L0 18.5z" fill="#6f6152"/>
  <path d="M21 9h7v8h-7z" fill="#a8743f"/><path d="M21 9h7v1.3h-7z" fill="#c78d52"/><path d="M21 10.3l7 6.7m0-6.7l-7 6.7" stroke="#87592e" stroke-width=".6"/>`;
const PLAYER_SVG = `<path d="M12.6 13.4h2.2l-.4 5.8h-1.9zm2.6 0h2.2l.3 5.8h-1.9z" fill="#36414f"/>
  <path d="M12.2 8.3q2.8-1.5 5.6 0l.5 5.3h-6.6zm0 .2l-1.7 4.7 1.4.4 1.2-3.9zm5.6 0l1.7 4.7-1.4.4-1.2-3.9z" fill="#b94a3c"/>
  <circle cx="15" cy="5.3" r="2.2" fill="#e2b48c"/><path d="M12.8 5a2.2 2.2 0 0 1 4.4 0q-2.2-1.3-4.4 0z" fill="#4a3426"/>`;
const GUN_SVG = `<path d="M30 13.6L16.2 8.1l-1.1 1.6L28.6 17z" fill="#5d636d"/><path d="M30 13.6L16.2 8.1l.3-.6 13.5 5.2z" fill="#949ba6"/>
  <path d="M23.3 12.1l-1.5 4 1.9.8 1.3-3.7z" fill="#454a52"/><path d="M23.6 15.6q2.2-1.7 4.4.3l2 1.1V20h-7.2z" fill="#d9a77e"/>
  <path d="M26 17.6l4-1.1V20h-5z" fill="#4b5a44"/>`;
const CHECK_SVG = Array.from({ length: 24 }, (_, i) => `<rect x="${(i % 6) * 5}" y="${Math.floor(i / 6) * 5}" width="5" height="5" fill="${(i % 6 + Math.floor(i / 6)) % 2 ? "#2e3036" : "#4a4d55"}"/>`).join("");
const svg = (inner: string) => `<svg viewBox="0 0 30 20" width="30" height="20">${inner}</svg>`;
const matteSvg = (alpha: boolean, inner: string) => svg((alpha ? CHECK_SVG : `<rect width="30" height="20" fill="#14b814"/>`) + inner);
/** swatch: an svg, or a CSS background */
const PASS_INFO: Record<PassName, { label: string; note: (alpha: boolean) => string; swatch: (alpha: boolean) => string }> = {
  default: { label: "Default", note: () => "The frame as you see it",
    swatch: () => svg(`${WORLD_SVG}<g transform="translate(-3.5 2.6) scale(.82)">${PLAYER_SVG}</g><g transform="translate(9 6) scale(.7)">${GUN_SVG}</g>`) },
  world: { label: "World", note: () => "Map only: no players or effects", swatch: () => svg(WORLD_SVG) },
  players: { label: "Players", note: (a) => (a ? "Alpha matte" : "On green screen"), swatch: (a) => matteSvg(a, PLAYER_SVG) },
  viewmodel: { label: "Viewmodel", note: (a) => `Arms, gun and its flash · ${a ? "premultiplied alpha" : "on green"}`, swatch: (a) => matteSvg(a, GUN_SVG) },
  effects: { label: "Effects", note: (a) => `Flashes, smoke, tracers ${a ? "· premultiplied alpha" : "on black"}`,
    swatch: () => "radial-gradient(circle at 55% 50%,#fff6d0 0 9%,#ffb84a 20%,rgba(255,120,20,.35) 38%,transparent 58%),#050505" },
  depth: { label: "Depth", note: () => "16-bit · white near, black far", swatch: () => "linear-gradient(90deg,#f2f2f2,#101010)" },
  normals: { label: "Normals", note: () => "Surface direction, view space", swatch: () => "linear-gradient(135deg,#9a80ff,#7f7fff 35%,#80ffa8 70%,#ff9a80)" },
};
const LINK = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.5 9.5l3-3M7 4.5l1.3-1.3a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.3 1.3a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"/></svg>`;
const EYE = `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M1 8s2.6-4.6 7-4.6S15 8 15 8s-2.6 4.6-7 4.6S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/></svg>`;
const CODECS: [string, string][] = [["prores4444xq", "ProRes 4444 XQ"], ["prores4444", "ProRes 4444"], ["prores422hq", "ProRes 422 HQ"],
  ["prores422", "ProRes 422"], ["prores422lt", "ProRes 422 LT"]];

const CSS = `
#mvm{position:fixed;inset:0;pointer-events:none;font:12px/1.4 Segoe UI,Arial,sans-serif;color:#ddd;z-index:50;user-select:none}
#mvm.off>*:not(.mvm-toast):not(.mvm-mask):not(.prog){display:none}#mvm.rendering .mvm-mask{display:none}
#mvm .prog{display:none;position:absolute;left:50%;bottom:16px;transform:translateX(-50%);width:min(560px,90vw);padding:8px 10px;flex-direction:column;gap:6px}
#mvm.rendering .prog{display:flex}#mvm.rendering .prev{display:none!important}#mvm .prog .pbar{height:5px;border-radius:3px;background:#2a2e35;overflow:hidden}
#mvm .prog .pbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#d2321f,#f0a830)}
#mvm .prog .ptext{display:flex;gap:10px;font-variant-numeric:tabular-nums}#mvm .prog .ptext b{color:#f0a830}
#mvm .foot{flex:none;padding:8px;border-top:1px solid #333;display:flex;flex-direction:column;gap:6px}#mvm .foot:empty{display:none}
#mvm .mvm-mask{position:absolute;box-shadow:0 0 0 100vmax rgba(10,10,12,.6);outline:1px solid rgba(255,255,255,.25)}
#mvm .p{pointer-events:auto;background:rgba(18,20,24,.92);border:1px solid #333;border-radius:4px}
#mvm button,#mvm select,#mvm input{font:inherit;color:#eee;background:#2a2e35;border:1px solid #444;border-radius:3px;padding:2px 7px}
#mvm button:hover{background:#3a404a}#mvm button.on{background:#c47f12;border-color:#e09a2a;color:#111}
#mvm .top{position:absolute;left:8px;top:8px;padding:5px 9px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;max-width:calc(100% - 310px)}
#mvm>:not(.mvm-mask){zoom:var(--ui-zoom,1)}#mvm .zoom{display:flex}#mvm .zoom button{border-radius:0;min-width:24px}
#mvm .zoom button:first-child{border-radius:3px 0 0 3px}#mvm .zoom button:last-child{border-radius:0 3px 3px 0}#mvm .zoom button+button{margin-left:-1px}
#mvm .zoom [data-a="zoomReset"]{min-width:46px;font-variant-numeric:tabular-nums}
#mvm .side{position:absolute;right:8px;top:8px;width:270px;max-height:calc(100% - 120px);display:flex;flex-direction:column}
#mvm .tabs{display:flex;border-bottom:1px solid #333}#mvm .tabs button{flex:1;border:0;border-radius:0;background:none}
#mvm .tabs button.on{background:#2a2e35;color:#f0a830}
#mvm .body{padding:8px;overflow:auto;display:flex;flex-direction:column;gap:6px}#mvm .body>*{flex-shrink:0}
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
#mvm .sect{display:flex;gap:6px;align-items:center;margin-top:6px;color:#f0a830}#mvm .sect .hint{flex:1}
#mvm .sect button{padding:0 6px;font-size:11px}
#mvm .passes{display:flex;flex-direction:column;border:1px solid #30333a;border-radius:4px;overflow:hidden;background:#15171b}
#mvm .pass{display:flex;align-items:center;gap:7px;padding:5px 4px 5px 7px;cursor:pointer;border-top:1px solid #23262c}
#mvm .pass{position:relative}#mvm .pass.joined{border-top-color:transparent}#mvm .pass.joined .recdot,#mvm .pass.joined .eye{visibility:hidden}
#mvm .link{position:absolute;left:4px;top:-8px;z-index:1;width:15px;height:15px;padding:0;display:grid;place-items:center;border-radius:50%;background:#15171b;border:1px solid #30333a;color:#5c616b}
#mvm .link:hover{color:#ddd;background:#2a2e35}#mvm .link.on{color:#f0a830;border-color:#c47f12;background:#3d3220}
#mvm .pass:first-child{border-top:0}#mvm .pass:hover{background:#1f2227}#mvm .pass.rec{background:#2a2217}#mvm .pass.rec:hover{background:#33291b}
#mvm .recdot{flex:none;width:11px;height:11px;border-radius:50%;border:2px solid #4c5059;box-sizing:border-box}
#mvm .pass.rec .recdot{border-color:#ff7262;background:radial-gradient(circle at 35% 35%,#ff8a7a,#d2321f)}
#mvm .sw{flex:none;width:30px;height:20px;border-radius:3px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.12)}#mvm .sw svg{display:block}
#mvm .pass:not(.rec) .sw{opacity:.55}#mvm .pass.na{cursor:default}#mvm .pass.na>:not(.link){opacity:.4}#mvm .pass.na:hover{background:none}
#mvm .nm{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.25}
#mvm .nm b{font-weight:600;color:#9aa0a8}#mvm .pass.rec .nm b{color:#f2f2f2}

#mvm .eye{flex:none;display:flex;align-items:center;gap:3px;border:0;background:none;padding:3px 5px;color:#5c616b}
#mvm .eye:hover{background:#2f333b;color:#ccc}#mvm .eye.on{color:#f0a830;background:#3d3220}
#mvm .eye kbd{font:10px Consolas,monospace;color:inherit;opacity:.8}
#mvm .pass-opt{display:flex;align-items:center;gap:6px;padding:0 8px 6px 45px;color:#999;background:inherit}
#mvm .pass-opt input{width:60px}
#mvm .files{font:11px/1.4 Consolas,monospace;color:#9aa3ad;background:#121418;border:1px solid #2a2d33;border-radius:3px;padding:4px 6px;display:flex;flex-direction:column;gap:3px}
#mvm .files>div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc}
#mvm .files>span{display:flex;flex-wrap:wrap;gap:3px}#mvm .files>span>i{font-style:normal;background:#23262c;border-radius:2px;padding:0 4px}
#mvm .go{padding:6px;font-weight:600;background:#b8301f;border-color:#e05040;color:#fff}#mvm .go:hover{background:#d03a27}
#mvm .go[disabled]{opacity:.45;pointer-events:none}
#mvm .prev{position:absolute;left:50%;bottom:92px;transform:translateX(-50%);padding:4px 6px 4px 10px;display:flex;gap:8px;align-items:center;border-color:#c47f12}
#mvm .prev b{color:#f0a830}#mvm .prev button{padding:0 6px}
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
  private readonly pathParts = new THREE.Group();
  /** move / rotate handles on the selected node; they drive `gizmoObj`, whose pose is written back into the key */
  private readonly gizmo: TransformControls;
  private readonly gizmoObj = new THREE.Object3D();
  private gizmoDragEnd = 0;
  // a gizmo drag rebuilds the nodes every frame: one canvas texture per label, not per rebuild
  private readonly labelMats = new Map<string, THREE.SpriteMaterial>();
  /** the dolly camera's place at the playhead, with a pulsing halo */
  private readonly pathHead = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), HEAD_MAT);
  private sel = -1;
  // whole-path JSON snapshots: a campath is a handful of keys, so diffs would buy nothing
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  // a timeline node drag indexes into the keys an undo would swap out
  private keyDrag = false;
  // cached: drawBar runs at 20 Hz and the graph samples the spline once per pixel
  private speedSig = "";
  private speedPts: number[] = [];
  private speedMax = 0;
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
  /** the times of the recorded states, in order: Ctrl + arrow steps */
  private readonly ticks: number[];
  /** the demo edits as last saved: Discard goes back to them */
  private savedEdits: string;
  /** a held Ctrl + arrow: its way, when it steps next (performance.now ms), and whether it went back by rough seeks */
  private stepHold: { dir: 1 | -1; next: number; rough: boolean } | null = null;
  private uiZoom = 1;
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
  private passes: Passes | null = null;
  /** the pass the viewport shows (render tab); a render always draws the default one there */
  private preview: PassName = "default";
  private drawnTab = "";
  private readonly mouseUv = new THREE.Vector2(0.5, 0.5);
  private dofActor: string | null = null;
  private dofZ = 10;
  private dof: Dof = { ...DOF_DEFAULT };

  constructor(private readonly net: DemoNet, private readonly host: TheaterHost) {
    const demo = net.demo;
    this.outPt = demo.dur;
    this.kills = demo.recs.filter((r) => r.k === "kill").map((r) => r.t);
    this.ticks = [...new Set(demo.recs.filter((r) => r.k === "state").map((r) => r.t))];
    this.savedEdits = demoEdits(demo);
    ensureCss();
    this.root.id = "mvm";
    this.root.innerHTML = `<div class="mvm-mask"></div>
      <div class="p top"><span class="zoom" title="UI size"><button data-a="zoomOut">−</button><button data-a="zoomReset" title="Back to 100%"></button><button data-a="zoomIn">+</button></span>
        <b>${esc(demo.name)}</b><span class="hint">${esc(demo.map)} · ${fmt(demo.dur)}</span>
        <button data-a="clean">Hide HUD (G)</button><button data-a="exit">Exit</button>
        <button data-a="save" class="on" style="display:none">Save changes</button><button data-a="discard" style="display:none">Discard changes</button></div>
      <div class="p edit" style="display:none"></div>
      <div class="p prev" style="display:none"></div>
      <div class="p side"><div class="tabs">${["camera", "campath", "visuals", "render", "controls"].map((t) => `<button data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
        <div class="body"></div><div class="foot"></div></div>
      <div class="p prog"><div class="ptext"></div><div class="pbar"><i></i></div></div>
      <div class="p bar"><div class="ctl">
        <button data-a="back">⏮</button><button data-a="play"></button><button data-a="fwd">⏭</button>
        <span class="time"></span><span class="speed"></span><span class="hint mode"></span>
        <span style="flex:1"></span><span class="hint range"></span></div>
        <canvas class="tl"></canvas></div>`;
    document.getElementById("app")!.appendChild(this.root);
    this.tl = this.root.querySelector("canvas.tl")!;
    let z = 1;
    try { z = Number(localStorage.getItem(ZOOM_KEY)); } catch { /* no storage: 100% */ }
    this.setZoom(ZOOMS.includes(z) ? z : 1);
    this.wire();
    this.layoutMask();
    this.pathHead.add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), HALO_MAT));
    this.pathViz.add(this.pathParts, this.pathHead);
    this.pathViz.traverse((o) => (o.renderOrder = 999));
    this.gizmoObj.rotation.order = "YXZ"; // as applyPose
    this.gizmo = new TransformControls(host.camera, host.renderer.domElement);
    this.gizmo.size = 0.8;
    this.gizmo.setSpace("local");
    this.gizmo.addEventListener("objectChange", () => this.gizmoMoved());
    this.gizmo.addEventListener("dragging-changed", (e) => {
      if (e.value) { this.snap(); return; }
      this.gizmoDragEnd = performance.now(); this.path.unwrapAll(); this.snapEnd(); this.drawSide();
    });
    this.pathViz.add(this.gizmoObj, this.gizmo.getHelper());
    this.looks = new LookStage(host.game.scene, host.renderer);
    host.game.scene.add(this.pathViz);
    host.game.demoSource = { time: () => this.time, track: (id, t) => this.net.trackOf(id, t) };
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
    if (this.stepHold) this.stepHeld();
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
      game.poseRemotes(this.net.poses(this.time));
      return;
    }
    this.time = Math.max(0, target - WARM);
    game.snapRemotes(this.net.seek(this.time), this.time);
    this.replay(target);
    game.restrideRemotes();
  }

  /** plays on from now to `target` at the fixed step, silently: an exact seek's replay, or a tick step forward */
  private replay(target: number): void {
    const game = this.host.game;
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
    game.poseRemotes(this.net.poses(this.time));
  }

  private setMode(m: Mode, id?: string): void {
    if ((m === "free" || m === "dolly") && this.mode !== "free" && this.mode !== "dolly") this.free = this.currentPose();
    this.mode = m;
    // no gun to show outside first person, where the world's pass may now be the whole frame
    if (m !== "pov" && (this.preview === "viewmodel" || this.passOf(this.preview) === "default")) this.setPreview("default");
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
  private snap(): void {
    this.undoStack.push(JSON.stringify(this.path.keys));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  /** after it: an edit that changed nothing (a node clicked, a handle grabbed and let go) leaves no step */
  private snapEnd(): void {
    if (this.undoStack.at(-1) === JSON.stringify(this.path.keys)) this.undoStack.pop();
  }
  private edit(fn: () => void): void { this.snap(); fn(); this.snapEnd(); }

  private history(redo: boolean): void {
    if (this.gizmo.dragging || this.keyDrag) return;
    const from = redo ? this.redoStack : this.undoStack, s = from.pop();
    if (s === undefined) { this.toast(redo ? "Nothing to redo" : "Nothing to undo", 800); return; }
    (redo ? this.undoStack : this.redoStack).push(JSON.stringify(this.path.keys));
    const selT = this.path.keys[this.sel]?.t;
    this.path.keys = JSON.parse(s) as CamKey[];
    if (this.path.keys[this.sel]?.t !== selT) this.sel = -1; // an add, removal or retime shifted the indices
    if (this.mode === "dolly" && this.path.keys.length < 2) this.leaveDolly();
    this.toast(redo ? "Redo" : "Undo", 800);
    this.drawSide();
  }

  private removeKey(i: number): void {
    this.edit(() => this.path.remove(i));
    this.sel = -1;
    this.drawSide();
  }

  private addKey(): void {
    const p = this.mode === "free" ? this.free : this.currentPose();
    let at = 0;
    this.edit(() => (at = this.path.add({ t: this.time, ...p, pos: [...p.pos] as CamKey["pos"] })));
    this.sel = -1; // the insert shifts indices, and a placed node is not picked for editing
    this.toast(`Node ${at + 1} at ${fmt(this.time)}`);
    this.drawSide();
  }

  // hidden while the dolly rides it: the path would sit in front of the lens
  private drawPath3d(): void {
    const g = this.pathViz, K = this.path.keys, a = this.path.start, span = Math.max(this.path.end - a, 1e-6);
    g.visible = this.mode !== "dolly" && !this.root.classList.contains("off");
    const head = K.length > 1 && this.time >= a && this.time <= a + span ? this.path.sample(this.time) : null;
    this.pathHead.visible = !!head;
    if (head) {
      const s = (performance.now() / 900) % 1;
      this.pathHead.position.set(...head.pos);
      this.pathHead.children[0].scale.setScalar(1 + s * 1.6);
      HALO_MAT.opacity = 0.45 * (1 - s);
    }
    const aspect = this.renderOpts.w / this.renderOpts.h, sig = `${this.sel}|${aspect}|${JSON.stringify(K)}`;
    this.syncGizmo();
    if (sig === this.pathSig) return;
    this.pathSig = sig;
    const P = this.pathParts;
    for (const c of [...P.children]) { P.remove(c); disposeViz(c); }
    const add = (o: THREE.Object3D) => { o.traverse((x) => (x.renderOrder = 999)); P.add(o); };
    const colorAt = (t: number) => PATH_A.clone().lerp(PATH_B, Math.min(1, Math.max(0, (t - a) / span)));
    if (K.length > 1) {
      // samples evenly spaced in time, so the curve's own parameter is time
      const n = Math.min(400, K.length * 40), pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) { const p = this.path.sample(a + span * i / n); if (p) pts.push(new THREE.Vector3(...p.pos)); }
      const curve = new THREE.CatmullRomCurve3(pts), seg = pts.length * 2, rad = 6;
      // a locked-off shot has no length: a tube over it is all NaN
      if (curve.getLength() > 1e-4) {
        const tube = new THREE.TubeGeometry(curve, seg, 0.008, rad, false), col: number[] = [];
        for (let i = 0; i <= seg; i++) { const c = colorAt(a + span * curve.getUtoTmapping(i / seg, 0)); for (let j = 0; j <= rad; j++) col.push(c.r, c.g, c.b); }
        tube.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        add(new THREE.Mesh(tube, TINT_MAT));
      }
    }
    K.forEach((k, i) => {
      const sel = i === this.sel, c = sel ? new THREE.Color(0xffffff) : colorAt(k.t), d = sel ? 0.42 : 0.3;
      const hy = d * Math.tan(THREE.MathUtils.degToRad(k.fov) / 2), hx = hy * aspect;
      const cam = new THREE.Group();
      cam.position.set(...k.pos);
      cam.rotation.order = "YXZ"; // as applyPose
      cam.rotation.set(k.pitch, k.yaw, k.roll);
      const o = new THREE.Vector3(), [q0, q1, q2, q3] = [[-hx, hy], [hx, hy], [hx, -hy], [-hx, -hy]].map(([x, y]) => new THREE.Vector3(x, y, -d));
      cam.add(new THREE.LineSegments(paint(new THREE.BufferGeometry().setFromPoints([o, q0, o, q1, o, q2, o, q3, q0, q1, q1, q2, q2, q3, q3, q0]), c), LINE_MAT));
      cam.add(new THREE.Mesh(new THREE.PlaneGeometry(hx * 2, hy * 2).translate(0, 0, -d), FILL_MAT));
      cam.add(new THREE.Mesh(paint(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-hx * 0.3, hy * 1.12, -d),
        new THREE.Vector3(hx * 0.3, hy * 1.12, -d), new THREE.Vector3(0, hy * 1.45, -d)]), c), TINT_MAT));
      cam.add(new THREE.Mesh(paint(new THREE.SphereGeometry(sel ? 0.05 : 0.035, 12, 8), c), TINT_MAT));
      const label = nodeLabel(String(i + 1), c, this.labelMats);
      label.position.set(0, hy * 1.45 + 0.13, -d);
      cam.add(label);
      add(cam);
    });
  }


  private syncGizmo(): void {
    const k = this.path.keys[this.sel], tc = this.gizmo;
    if (!k || !this.pathViz.visible) { if (tc.object) tc.detach(); return; }
    if (!tc.dragging) { // mid-drag the handles own the pose
      this.gizmoObj.position.set(...k.pos); this.gizmoObj.rotation.set(k.pitch, k.yaw, k.roll);
    }
    if (tc.object !== this.gizmoObj) tc.attach(this.gizmoObj);
  }

  private gizmoMoved(): void {
    const k = this.path.keys[this.sel], o = this.gizmoObj;
    if (!k) return;
    k.pos = [o.position.x, o.position.y, o.position.z];
    if (this.gizmo.mode !== "rotate") return; // a move leaves the angles exactly as they were
    const e = new THREE.Euler().setFromQuaternion(o.quaternion, "YXZ");
    // past vertical YXZ returns the same turn as (pi - x, y + pi, z + pi): undo that, then stop short of vertical as the free camera does
    if (Math.abs(e.x) > 1 && Math.abs(unwrap(e.y, k.yaw) - k.yaw) > Math.PI / 2) e.set(Math.sign(e.x) * Math.PI - e.x, e.y + Math.PI, e.z + Math.PI);
    k.yaw = unwrap(e.y, k.yaw); k.pitch = THREE.MathUtils.clamp(e.x, -1.55, 1.55); k.roll = unwrap(e.z, k.roll);
    o.rotation.set(k.pitch, k.yaw, k.roll);
  }

  private nodeAt(x: number, y: number): number {
    if (!this.pathViz.visible) return -1;
    const r = this.host.renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3();
    let best = -1, bestD = 16 * 16;
    this.path.keys.forEach((k, i) => {
      v.set(...k.pos).project(this.host.camera);
      if (v.z > 1) return; // behind the camera
      const dx = (v.x + 1) / 2 * r.width + r.left - x, dy = (1 - v.y) / 2 * r.height + r.top - y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // ---- render ----
  private renderOpts = { w: window.innerWidth & ~1, h: window.innerHeight & ~1, fps: 250, codec: "prores422lt", name: "", passes: ["world"] as PassName[], joined: ["players", "effects", "viewmodel"] as PassName[], depthRange: 50 };

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
    const name = this.movieName();
    const passes = this.recorded();
    if (!passes.length) { this.toast("Pick at least one pass"); return; }
    const streams = passes.map((p) => ({ name: this.layersOf(p).join("-"), input: p === "depth" ? "gray16le" : "rgba", alpha: this.mattePass(p) && this.alphaFormat() }));
    const start = await fetch(`${DEMO_API}/render/start`, { method: "POST", body: JSON.stringify({ w, h, fps, codec: this.renderOpts.codec, name, passes: streams }) });
    if (start.status === 503) {
      window.alert("Rendering needs ffmpeg, and none was found on PATH.\n\nInstall it (for example: winget install Gyan.FFmpeg), then restart start_server.cmd.");
      return;
    }
    if (!start.ok) { this.toast(`Render failed to start: ${await start.text()}`); return; }
    const { jobs } = await start.json() as { jobs: { id: string; file: string }[] };
    const { renderer, camera } = this.host;
    const ratio = renderer.getPixelRatio(), audio = THREE.AudioContext.getContext();
    this.openEdit(null);
    this.rendering = true;
    this.pathViz.visible = false;
    this.gizmo.detach(); // its invisible pickers still take drags; the next frame() puts it back
    this.cancelRender = false;
    this.playing = false;
    this.root.classList.add("off", "rendering");
    void audio.suspend(); // sounds would play at the render's crawl
    renderer.setPixelRatio(1);
    // exactly the unmasked box of the window's view, whatever the output aspect (fov stays the window's)
    const box = this.frameBox();
    camera.setViewOffset(window.innerWidth, window.innerHeight, box.x, box.y, box.w, box.h);
    renderer.setSize(w, h, false);
    const step = 1 / fps; // game time, like IWXMVM: the playback speed is a preview setting only
    const frames = Math.round((b - a) / step);
    const bf = brightnessFactor(), passer = (this.passes ??= new Passes(renderer));
    let ok = true;
    const inflight: Promise<void>[] = [];
    // frames drawn whose pixels are still coming off the GPU
    const reading: { n: number; bytes: Promise<Uint8Array<ArrayBuffer>[]> }[] = [];
    const send = async (f: (typeof reading)[number]) => {
      const all = await f.bytes;
      all.forEach((bytes, k) => {
        // a Blob body uploads ~8x faster than the typed array itself in Chromium
        inflight.push(fetch(`${DEMO_API}/render/frame?id=${jobs[k].id}&n=${f.n}`, { method: "POST", body: new Blob([bytes]) }).then(async (r) => {
          if (!r.ok && ok) { ok = false; this.toast(`Render failed: ${(await r.json().catch(() => ({}))).error ?? r.status}`, 0); }
        }).catch((e: unknown) => { if (ok) { ok = false; this.toast(`Render failed: ${String(e)}`, 0); } }));
      });
      // ffmpeg's own pace holds the rest back
      while (inflight.length >= 2 * jobs.length) await inflight.shift();
    };
    const t0 = performance.now(), bar = this.root.querySelector<HTMLElement>(".prog .pbar i")!, text = this.root.querySelector<HTMLElement>(".prog .ptext")!;
    bar.style.width = "0";
    text.textContent = "Starting…";
    try {
      this.seek(a); // the exact seek: the in point looks as it did in the preview
      for (let i = 0; i < frames && ok && !this.cancelRender; i++) {
        if (i) this.advance(step);
        else { this.host.simulate(0); this.updateCamera(0); }
        // every pass from this one simulated frame: the files line up exactly
        // on screen: the previewed pass when it is recorded, else the first one (1 - 7 switch it while it renders)
        const shown = passes.includes(this.preview) ? this.preview : passes[0];
        reading.push({ n: i, bytes: Promise.all(passer.capture(passes, this.passFrame(), bf, () => this.drawFrame(step), shown)) });
        // the GPU draws the next frame while this one's pixels come back and upload
        if (reading.length > 2) await send(reading.shift()!);
        const fps = (i + 1) / ((performance.now() - t0) / 1000), left = Math.round((frames - i - 1) / fps);
        bar.style.width = `${((i + 1) / frames) * 100}%`;
        text.innerHTML = `<span>Frame <b>${i + 1}</b> / ${frames}</span><span>${fps.toFixed(1)} fps</span><span>${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left</span>
          <span style="flex:1"></span><span class="hint">Showing ${this.passLabel(shown)}${passes.length > 1 ? ` (${passes.map((p) => PASSES.indexOf(p === "default" ? "world" : p) + 1).join(" ")})` : ""} · Esc stops</span>`;
      }
      // a cancel keeps the frames already drawn, so every file ends on the same frame
      while (ok && reading.length) await send(reading.shift()!);
      await Promise.all(inflight);
    } catch (e) {
      if (ok) { ok = false; this.toast(`Render failed: ${String(e)}`, 0); }
    } finally {
      for (const f of reading) f.bytes.catch(() => {}); // dropped with the failed render
      // a cancel still finishes the file: every frame sent so far has been written in order (inflight awaited above)
      const ends = await Promise.all(jobs.map(async (j) => {
        const e = await fetch(`${DEMO_API}/render/${ok ? "end" : "abort"}?id=${j.id}`, { method: "POST" }).catch(() => null);
        return { ok: !!e?.ok, status: e?.status, ...(await e?.json().catch(() => ({})) as { file?: string; log?: string }) };
      }));
      const bad = ends.find((e) => !e.ok);
      this.rendering = false;
      this.root.classList.remove("off", "rendering");
      void audio.resume();
      renderer.setPixelRatio(ratio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight; // a resize meanwhile was held back (busyRendering)
      camera.clearViewOffset();
      const saved = `${ends[0].file}${ends.length > 1 ? ` + ${ends.length - 1} more pass${ends.length > 2 ? "es" : ""}` : ""}`;
      // a failed render keeps its own error on screen
      if (ok) this.toast(!bad ? `${this.cancelRender ? "Stopped early, saved" : "Saved"} ${saved}` : `ffmpeg failed: ${bad.log ?? bad.status}`, 8000);
    }
  }

  /** the passes a render records: a layer joined to the one under it goes in that one's; the viewmodel alone only in POV, the one mode that draws the gun */
  private recorded(): PassName[] {
    const o = this.renderOpts;
    return PASSES.filter((p) => o.passes.includes(p) && !o.joined.includes(p) && (p !== "viewmodel" || this.mode === "pov")).map((p) => this.passOf(p));
  }

  /** [RECRIADO] the pass p is drawn in: the world's with every layer drawn joined is the default, the frame drawn once as the game draws it */
  private passOf(p: PassName): PassName {
    const head = this.layersOf(p)[0], j = this.renderOpts.joined;
    return head === "world" && j.includes("players") && j.includes("effects") && (j.includes("viewmodel") || this.mode !== "pov") ? "default" : head;
  }

  /** the layers recorded in one pass with p, the pass's own first; [p] for default, depth, normals */
  private layersOf(p: PassName): readonly PassName[] {
    return layerPasses(this.renderOpts.joined).find((g) => (g as readonly PassName[]).includes(p)) ?? [p];
  }

  private passLabel(p: PassName): string {
    return this.layersOf(p).map((x) => PASS_INFO[x].label).join(" + ");
  }

  /** a layer pass over nothing (not the world's): its alpha is a matte */
  private mattePass(p: PassName): boolean {
    return p !== "world" && (LAYERS as readonly PassName[]).includes(p);
  }

  /** <file name or demo>_<player>_pov|third, or _cine; the server appends the first free number, then _<pass> */
  private movieName(): string {
    const who = this.net.roster().find((p) => p.id === this.host.game.observedId)?.name ?? "player";
    const tag = this.mode === "pov" || this.mode === "third" ? `_${who}_${this.mode}` : "_cine";
    return `${this.renderOpts.name || this.net.demo.name.replace(/\.pbdemo$/, "")}${tag}`.replace(/[^\w.-]/g, "_");
  }

  /** the viewport's pass; the shown one again = back to default. While rendering: recorded passes only, kept afterwards */
  private setPreview(p: PassName): void {
    p = this.passOf(p); // a joined layer shows its pass
    if ((this.rendering && !this.recorded().includes(p)) || (p === "viewmodel" && this.mode !== "pov")) return;
    this.preview = p === this.preview && !this.rendering ? "default" : p;
    this.showPreview();
  }

  private showPreview(): void {
    const el = this.root.querySelector<HTMLElement>(".prev")!;
    el.style.display = this.preview === "default" ? "none" : "flex";
    el.innerHTML = `<span class="hint">Previewing</span><b>${this.passLabel(this.preview)}</b><button data-eye="${this.preview}" title="Back to the default view">✕</button>`;
    if (this.tab === "render") this.drawSide();
  }

  /** one fixed render step: demo clock, world, camera (the passes draw it) */
  private advance(dt: number): void {
    this.time += dt;
    this.net.advance(this.time);
    this.host.game.poseRemotes(this.net.poses(this.time));
    this.host.simulate(dt);
    this.updateCamera(dt);
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
      if (this.rendering && e.code !== "Escape" && !/^Digit[1-6]$/.test(e.code)) return; // the clock and camera stay the render's
      this.held.add(e.code);
      if (!e.repeat) this.key(e);
    }, { capture: true, ...sig });
    window.addEventListener("keyup", (e) => { this.held.delete(e.code); e.stopImmediatePropagation(); }, { capture: true, ...sig });
    window.addEventListener("blur", () => { this.held.clear(); this.looking = false; }, sig);
    window.addEventListener("resize", () => this.layoutMask(), sig);
    // no browser zoom (Ctrl + wheel, pinch): it would resize the frame; the UI has its own zoom
    window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { capture: true, passive: false, ...sig });
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
    cv.addEventListener("click", (e) => {
      // the click that ends a handle drag is not a pick
      if (this.rendering || this.gizmo.dragging || performance.now() - this.gizmoDragEnd < 150) return;
      const node = this.nodeAt(e.clientX, e.clientY);
      if (node >= 0) { this.sel = node; this.drawSide(); return; }
      const id = this.actorAt(e.clientX, e.clientY);
      if (!id && this.sel >= 0) { this.sel = -1; this.drawSide(); }
      this.openEdit(id, e.clientX, e.clientY);
    }, sig);

    this.root.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a],[data-tab],[data-id],[data-key],[data-del],[data-eye],[data-join],[data-pass]");
      if (!b) return;
      if (b.dataset.eye) { this.setPreview(b.dataset.eye as PassName); return; }
      if (b.dataset.join) {
        const l = b.dataset.join as PassName, o = this.renderOpts, rec = this.recorded().includes(this.passOf(l)), split = o.joined.includes(l);
        o.joined = split ? o.joined.filter((x) => x !== l) : [...o.joined, l];
        // a recorded layer stays in a file: joined, the pass it went into records; split off, it records as its pass did
        const into = this.layersOf(l)[0];
        o.passes = PASSES.filter((x) => (x !== into ? o.passes.includes(x) : split ? rec : rec || o.passes.includes(x)));
        this.preview = this.passOf(this.preview);
        this.showPreview();
        return;
      }
      if (b.dataset.pass) {
        const p = b.dataset.pass as PassName, o = this.renderOpts;
        o.passes = PASSES.filter((x) => (x === p ? !o.passes.includes(p) : o.passes.includes(x)));
        this.drawSide();
        return;
      }
      if (b.dataset.tab) { this.tab = b.dataset.tab; this.drawSide(); return; }
      if (b.dataset.id) { this.setMode(this.mode === "third" ? "third" : "pov", b.dataset.id); return; }
      if (b.dataset.key) { const k = this.path.keys[+b.dataset.key]; this.sel = +b.dataset.key; if (k) { this.seek(k.t); this.free = { ...k, pos: [...k.pos] as CamKey["pos"] }; } this.drawSide(); return; }
      if (b.dataset.del) { this.removeKey(+b.dataset.del); return; }
      this.action(b.dataset.a!);
    }, sig);
    this.root.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement;
      const o = this.renderOpts;
      // even sizes: the 4:2:2 ProRes profiles halve the width of the colour planes
      if (t.name === "w" || t.name === "h") { const v = Math.max(16, Math.min(t.name === "w" ? 7680 : 4320, Math.round(+t.value / 2) * 2 || 2)); o[t.name] = v; t.value = String(v); this.layoutMask(); }
      else if (t.name === "fps") o.fps = +t.value;
      else if (t.name === "codec") { o.codec = t.value; this.drawSide(); } // the mattes' notes and swatches follow the alpha
      else if (t.name === "povfov") this.setPovFov(t.value === "" ? null : +t.value || null);
      else if (t.name === "name") { o.name = t.value; const el = this.root.querySelector(".files>div"); if (el) el.textContent = `${this.movieName()}#`; } // a redraw here would eat the click that blurred it
      else if (t.name === "depthrange") { o.depthRange = Math.max(1, +t.value || 50); t.value = String(o.depthRange); }
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
        this.edit(() => {
          if (t.name === "kfov") k.fov = Math.max(5, Math.min(140, +t.value || k.fov));
          else k.roll = (+t.value || 0) * Math.PI / 180;
        });
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
    const digit = /^Digit([1-6])$/.exec(e.code);
    if (digit) { this.setPreview(PASSES[+digit[1] - 1]); return; }
    switch (e.code) {
      case "Space": this.action("play"); break;
      case "ArrowUp": this.speedIdx = Math.min(SPEEDS.length - 1, this.speedIdx + 1); break;
      case "ArrowDown": this.speedIdx = Math.max(0, this.speedIdx - 1); break;
      case "ArrowLeft": if (e.ctrlKey) this.holdStep(-1); else this.skip(-1); break;
      case "ArrowRight": if (e.ctrlKey) this.holdStep(1); else this.skip(1); break;
      case "KeyB": this.action("setIn"); break;
      case "KeyN": this.action("setOut"); break;
      case "KeyF": this.setMode("free"); break;
      case "F2": this.setMode("pov"); break;
      case "F3": this.setMode("third"); break;
      case "BracketLeft": this.cycleTarget(-1); break;
      case "BracketRight": this.cycleTarget(1); break;
      case "KeyK": this.addKey(); break;
      case "KeyR": if (this.gizmo.object) { const m = this.gizmo.mode === "rotate" ? "translate" : "rotate"; this.gizmo.setMode(m); this.toast(m === "rotate" ? "Rotate node" : "Move node", 800); } break;
      case "KeyZ": if (e.ctrlKey || e.metaKey) this.history(e.shiftKey); break;
      case "KeyL": this.edit(() => this.path.clear()); this.sel = -1; this.leaveDolly(); this.toast("Campath cleared"); this.drawSide(); break;
      case "KeyJ": this.action("dolly"); break;
      case "Delete": case "Backspace":
        if (this.sel >= 0) { this.toast(`Node ${this.sel + 1} removed`, 800); this.removeKey(this.sel); }
        break;
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
      case "clear": this.edit(() => this.path.clear()); this.sel = -1; this.leaveDolly(); this.drawSide(); break;
      case "pathRange": if (this.path.keys.length > 1) { this.inPt = this.path.start; this.outPt = this.path.end; } this.drawSide(); break;
      case "setIn": this.inPt = Math.min(this.time, this.outPt); this.toast(`In ${fmt(this.inPt)}`); if (this.tab === "render") this.drawSide(); break;
      case "setOut": this.outPt = Math.max(this.time, this.inPt); this.toast(`Out ${fmt(this.outPt)}`); if (this.tab === "render") this.drawSide(); break;
      case "passesDefault": Object.assign(this.renderOpts, { passes: ["world"], joined: ["players", "effects", "viewmodel"] }); this.preview = this.passOf(this.preview); this.showPreview(); break;
      case "passesAll": this.renderOpts.passes = [...PASSES]; this.drawSide(); break;
      case "render": void this.renderMovie(); break;
      case "clean": document.body.classList.toggle("mvm-clean"); break;
      case "save": void this.save(); break;
      case "discard": if (window.confirm("Discard your unsaved demo changes?")) this.discard(); break;
      case "zoomOut": this.setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(this.uiZoom) - 1)]); break;
      case "zoomIn": this.setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(this.uiZoom) + 1)]); break;
      case "zoomReset": this.setZoom(1); break;
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
    // the cursor in the timeline's own px, by ratio: right however the UI zoom scales its box on screen
    const at = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * cv.clientWidth, y: (e.clientY - r.top) / r.height * cv.clientHeight }; };
    const tAt = (x: number) => (x / cv.clientWidth) * this.net.demo.dur;
    const keyAt = (x: number) => this.path.keys.findIndex((k) => Math.abs((k.t / this.net.demo.dur) * cv.clientWidth - x) < 6);
    cv.addEventListener("mousedown", (e) => {
      const p = at(e), i = keyAt(p.x);
      if (e.button === 2) { if (i >= 0) this.removeKey(i); return; }
      if (i >= 0 && p.y < cv.clientHeight / 2) { this.snap(); this.keyDrag = true; drag = i; this.sel = i; this.drawSide(); return; }
      drag = "seek";
      this.seek(tAt(p.x), false);
    }, sig);
    window.addEventListener("mousemove", (e) => {
      if (drag === null) return;
      const t = Math.max(0, Math.min(this.net.demo.dur, tAt(at(e).x)));
      if (drag === "seek") this.seek(t, false);
      else { drag = this.sel = this.path.retime(drag, t); }
    }, sig);
    window.addEventListener("mouseup", () => {
      if (typeof drag === "number") { this.keyDrag = false; this.snapEnd(); this.drawSide(); }
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
    if (this.path.keys.length > 1) {
      g.fillStyle = "rgba(90,160,255,.35)"; g.fillRect(X(this.path.start), 4, X(this.path.end) - X(this.path.start), 3);
      this.drawSpeed(g, w, h, X);
    }
    this.path.keys.forEach((k, i) => {
      const x = X(k.t);
      g.fillStyle = i === this.sel ? "#fff" : "#5aa0ff";
      g.beginPath(); g.moveTo(x, 2); g.lineTo(x + 5, 8); g.lineTo(x, 14); g.lineTo(x - 5, 8); g.fill();
    });
    g.fillStyle = "#f0a830"; g.fillRect(X(this.time) - 1, 0, 2, h);
  }

  private drawSpeed(g: CanvasRenderingContext2D, w: number, h: number, X: (t: number) => number): void {
    const a = this.path.start, b = this.path.end, x0 = Math.floor(X(a)), x1 = Math.ceil(X(b)), sig = `${w}|${JSON.stringify(this.path.keys)}`;
    if (sig !== this.speedSig) {
      this.speedSig = sig;
      this.speedPts = [];
      for (let x = x0; x <= x1; x++) this.speedPts.push(this.path.speed(Math.min(b, Math.max(a, (x / w) * this.net.demo.dur))));
      this.speedMax = Math.max(...this.speedPts);
    }
    if (this.speedMax <= 1e-6) return;
    const y = (v: number) => h - 2 - (v / this.speedMax) * (h - 12);
    g.beginPath(); g.moveTo(x0, h - 2);
    this.speedPts.forEach((v, i) => g.lineTo(x0 + i, y(v)));
    g.lineTo(x0 + this.speedPts.length - 1, h - 2);
    g.fillStyle = "rgba(90,160,255,.16)"; g.fill();
    g.beginPath(); this.speedPts.forEach((v, i) => (i ? g.lineTo(x0 + i, y(v)) : g.moveTo(x0, y(v))));
    g.strokeStyle = "rgba(120,180,255,.8)"; g.lineWidth = 1; g.stroke();
  }

  private drawSide(): void {
    for (const b of this.root.querySelectorAll<HTMLElement>("[data-tab]")) b.classList.toggle("on", b.dataset.tab === this.tab);
    const body = this.root.querySelector(".body")!, foot = this.root.querySelector(".foot")!;
    // a redraw of the same tab (a click in it) keeps its scroll; another tab starts at the top
    const scroll = this.drawnTab === this.tab ? body.scrollTop : 0;
    this.drawnTab = this.tab;
    foot.innerHTML = ""; // the render tab's, kept in view under its scrolling body
    const m = this.mode, o = this.renderOpts;
    const btn = (a: string, t: string, on = false) => `<button data-a="${a}" class="${on ? "on" : ""}">${t}</button>`;
    const head = (t: string) => `<div class="hint" style="color:#f0a830;margin-top:4px">${t}</div>`;
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
        <div class="hint">Drag a node on the timeline to retime it, right-click to delete it. The blue graph under the path is the camera's speed. Ctrl+Z / Ctrl+Shift+Z undo / redo.</div>`;
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
      const alpha = this.alphaFormat(), on = this.recorded(), name = this.movieName();
      const span = Math.max(0, this.outPt - this.inPt), frames = Math.round(span * o.fps);
      const pass = (p: PassName, i: number) => {
        const info = PASS_INFO[p], head = this.layersOf(p)[0], joined = head !== p, rec = on.includes(this.passOf(p)), eye = this.preview === this.passOf(p) && !joined;
        const na = head === "viewmodel" && this.mode !== "pov", below = LAYERS[LAYERS.indexOf(p as never) - 1];
        // between two layers: join this one into the pass under it, or split it off into its own file
        const link = below ? `<button class="link${joined ? " on" : ""}" data-join="${p}" title="${joined ? `In the ${this.passLabel(head)} file · click to split it off` : `Own file · click to join it into ${this.passLabel(below)}`}">${LINK}</button>` : "";
        const what = this.passOf(p) === "default" ? `Every layer in one file: ${PASS_INFO.default.note(alpha).toLowerCase()}` : this.layersOf(p).length > 1 ? `${this.passLabel(head)} in one file` : info.note(alpha);
        return `<div class="pass${rec ? " rec" : ""}${na ? " na" : ""}${joined ? " joined" : ""}" ${na ? "" : `data-pass="${head}"`} title="${na ? "First person (POV) only" : `${what} · ${rec ? "recorded, click to leave it out" : "click to record it"}`}">
            ${link}<span class="recdot"></span>${((s) => (s.startsWith("<") ? `<span class="sw">${s}</span>` : `<span class="sw" style="background:${s}"></span>`))(info.swatch(alpha))}
            <span class="nm"><b>${info.label}</b></span>
            <button class="eye${eye ? " on" : ""}" ${na || joined ? "disabled" : `data-eye="${p}"`} title="${eye && this.preview !== "default" ? "Back to the default view" : "Preview in the viewport"} (${i + 1})">${EYE}<kbd>${i + 1}</kbd></button></div>`
          + (p === "depth" && (rec || eye) ? `<div class="pass-opt${rec ? " rec" : ""}">Black at <input name="depthrange" type="number" min="1" step="1" value="${o.depthRange}"> m</div>` : "");
      };
      body.innerHTML = `${head("Output")}
        <div class="row"><label>Resolution</label><input name="w" type="number" min="16" max="7680" step="2" value="${o.w}" style="flex:1;min-width:0"> ×
          <input name="h" type="number" min="16" max="4320" step="2" value="${o.h}" style="flex:1;min-width:0"></div>
        <div class="row"><label>FPS</label><select name="fps">${FRAMERATES.map((f) => `<option ${f === o.fps ? "selected" : ""}>${f}</option>`).join("")}</select></div>
        <div class="row"><label>Format</label><select name="codec" style="flex:1;min-width:0">${CODECS.map(([v, l]) => `<option value="${v}" ${v === o.codec ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="row"><label>File</label><input name="name" placeholder="${esc(this.net.demo.name.replace(/\.pbdemo$/, ""))}" value="${esc(o.name)}" style="flex:1;min-width:0"></div>
        <div class="sect" title="Every pass comes from the same frames, so the files line up exactly">Passes<span class="hint">${on.length} recorded</span>${btn("passesDefault", "Default only")}${btn("passesAll", "All")}</div>
        <div class="passes">${PASSES.map(pass).join("")}</div>
        <div class="hint">Click a pass to record it. The eye or 1 – ${PASSES.length} shows it.</div>`;
      foot.innerHTML = `<div class="sect" style="margin-top:0">Range<span class="hint">${fmt(this.inPt)} – ${fmt(this.outPt)} · ${frames} frames</span></div>
        <div class="row">${btn("setIn", "Set in (B)")}${btn("setOut", "Set out (N)")}${btn("pathRange", "Campath")}</div>
        ${on.length ? `<div class="files" title="Saved to point-blank-webport/mvm/movies; # is the first free number"><div>${esc(name)}#</div><span>${on.map((p) => `<i>${p === "default" ? "" : `_${this.layersOf(p).join("-")}`}.mov</i>`).join("")}</span></div>` : ""}
        <button data-a="render" class="go" title="Game time, not real time: 1 s of demo is 1 s of video at any speed" ${on.length && frames ? "" : "disabled"}>${on.length ? `● Render ${on.length} pass${on.length > 1 ? "es" : ""}` : "Pick a pass to render"}</button>`;
    } else {
      const rows: [string, string][] = [["Space", "Play / pause"], ["↑ / ↓", "Faster / slower"], ["← / →", `Skip ${SKIP} s back / forward, stopping at deaths, dolly nodes and in / out points`], ["Ctrl + ← / →", "Pause and step one demo tick (hold to keep stepping)"], ["B / N", "Set in / out point"],
        ["F", "Free camera"], ["F2 / F3", "First / third person"], ["[ / ]", "Previous / next player"], ["W A S D", "Move (free camera)"], ["Q / E", "Down / up"],
        ["Shift / Ctrl", "Faster / slower move"], ["Right mouse", "Look (free camera)"], ["Wheel", "FOV (free, third)"], ["Alt + wheel", "Roll"], ["Middle mouse", "Reset angle / FOV"],
        ["K", "Add dolly node"], ["L", "Clear nodes"], ["J", "Play dolly path"], ["Delete / Backspace", "Remove selected node"], ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo campath edits"],
        ["Click node", "Select it; drag its handles to edit"], ["R", "Move / rotate handles"],
        ["1 – 7", "Preview a render pass (again: back to the default view)"], ["G", "Hide game HUD"], ["H", "Hide this UI"], ["Esc", "Cancel render"]];
      body.innerHTML = `<table class="keys">${rows.map(([k, t]) => `<tr><td>${k}</td><td>${t}</td></tr>`).join("")}</table>`;
    }
    body.scrollTop = scroll;
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
    const z = this.uiZoom; // its left / top are zoomed with it
    el.style.left = `${Math.min(x + 8, window.innerWidth - 250 * z) / z}px`;
    el.style.top = `${Math.min(y + 8, window.innerHeight - 160 * z) / z}px`;
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
    const p = this.rendering ? "default" : this.preview;
    if (p === "default") { this.drawFrame(dt); return; }
    (this.passes ??= new Passes(this.host.renderer)).show(p, this.passFrame(), () => this.drawFrame(dt));
    renderOnTop(this.host.renderer, [this.pathViz].filter((o) => o.visible), this.host.camera); // the campath stays editable over the preview
  }

  /** the default pass: the frame, through the depth of field when it is on (which also moves the focus) */
  private drawFrame(dt: number): void {
    const d = this.dof;
    if (!d.mode) { this.host.render(); return; }
    this.post ??= new Post(this.host.renderer);
    if (d.mode === 3) this.dofZ = this.actorDepth(this.dofTarget()) ?? this.dofZ; // held while the player is gone
    this.post.render(this.host.game.scene, this.host.camera, this.dofParams(dt), [...this.host.camera.children, this.pathViz]);
  }

  private dofParams(dt: number): DofParams {
    const d = this.dof;
    return {
      focus: d.mode === 1 ? d.focus : this.dofZ, focusUv: d.mode === 2 ? this.mouseUv : null, focusLerp: 1 - Math.exp(-d.speed * dt),
      aperture: d.aperture / 100, maxBlur: d.maxBlur / 100, near: d.near, far: d.far,
    };
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

  /** held steps are rough (an exact seek costs ~75 ms); endHold lands the last one exactly, as a timeline drag */
  private step(dir: 1 | -1, exact = true): void {
    this.playing = false;
    const t = this.time, eps = 1e-6;
    let to = dir > 0 ? this.net.demo.dur : 0;
    for (const x of this.ticks) {
      if (dir > 0 && x > t + eps) { to = x; break; }
      if (dir < 0) { if (x < t - eps) to = x; else break; }
    }
    if (to === t) return;
    if (exact) this.seek(to);
    else if (to > t && to - t <= WARM) this.replay(to); // playing on keeps the arms' clips running while held
    else this.seek(to, false);
  }

  /** a Ctrl + arrow press: one step now, more from frame() at STEP_RATE while it is held */
  private holdStep(dir: 1 | -1): void {
    this.endHold();
    this.step(dir);
    this.stepHold = { dir, next: performance.now() + STEP_DELAY, rough: false };
  }

  private endHold(): void {
    if (this.stepHold?.rough) this.seek(this.time);
    this.stepHold = null;
  }

  private stepHeld(): void {
    const s = this.stepHold!, h = this.held;
    if (!h.has(s.dir > 0 ? "ArrowRight" : "ArrowLeft") || !(h.has("ControlLeft") || h.has("ControlRight"))) { this.endHold(); return; }
    const now = performance.now();
    s.next = Math.max(s.next, now - 100); // a stalled frame does not owe a burst of steps
    for (; s.next <= now; s.next += 1000 / STEP_RATE) {
      this.step(s.dir, false);
      s.rough = true;
    }
  }

  /** this frame, split for the passes */
  private passFrame(): PassFrame {
    const cam = this.host.camera;
    const dof: PassFrame["dof"] = this.dof.mode ? (color, depth, target, matte) => this.post?.blur(color, depth, cam, this.dofParams(0), target, matte) : null;
    // the edit outline writes depth: it would show in the depth and normals
    return { scene: this.host.game.scene, camera: cam, players: this.players(), viewmodel: cam.children, editor: [this.pathViz, ...this.outline], depthRange: this.renderOpts.depthRange, alpha: this.alphaFormat(), joined: this.renderOpts.joined, dof };
  }

  /** the ProRes 4444 profiles carry an alpha plane */
  private alphaFormat(): boolean {
    return this.renderOpts.codec.startsWith("prores4444");
  }

  /** the player models in the scene (alive or ragdolled) */
  private players(): THREE.Object3D[] {
    return [...this.host.game.actors()].flatMap((a) => (a.visualRoot?.parent ? [a.visualRoot] : []));
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
    for (const a of ["save", "discard"]) this.root.querySelector<HTMLElement>(`[data-a="${a}"]`)!.style.display = v ? "" : "none";
  }

  /** back to the edits last saved: each one set back through DemoNet, then the seek replays the bodies with them */
  private discard(): void {
    const s = JSON.parse(this.savedEdits) as Pick<Demo, "deaths" | "charas" | "hats">, d = this.net.demo;
    const keys = (a?: object, b?: object) => new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const k of keys(d.deaths, s.deaths)) this.net.setDeathClip(k, s.deaths?.[k] ?? null);
    for (const id of keys(d.charas, s.charas)) this.net.setChara(id, s.charas?.[id] ?? null);
    for (const id of keys(d.hats, s.hats)) this.net.setHat(id, s.hats?.[id] ?? null);
    this.setDirty(false);
    this.seek(this.time);
    this.toast("Changes discarded");
  }

  private setZoom(z: number): void {
    this.uiZoom = z;
    this.root.style.setProperty("--ui-zoom", String(z));
    this.root.querySelector('[data-a="zoomReset"]')!.textContent = `${Math.round(z * 100)}%`;
    try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* private mode: this session only */ }
  }

  private async save(): Promise<void> {
    try {
      const edits = demoEdits(this.net.demo); // what this save writes, not an edit made while it runs
      await saveDemo(this.net.demo);
      this.savedEdits = edits;
      this.setDirty(demoEdits(this.net.demo) !== edits);
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
    this.passes?.dispose();
    this.cancelRender = true;
    this.ac.abort();
    this.root.remove();
    this.pathViz.removeFromParent();
    // r169 TransformControls.dispose() calls this.traverse, which a Controls lacks: unhook it and free the helper here
    this.gizmo.disconnect();
    this.gizmo.getHelper().removeFromParent();
    this.gizmo.getHelper().traverse((o) => { (o as THREE.Mesh).geometry?.dispose(); ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose(); });
    disposeViz(this.pathViz);
    for (const m of this.labelMats.values()) { m.map?.dispose(); m.dispose(); }
    document.body.classList.remove("mvm-clean");
  }
}

/** demo browser: resolves with the picked demo, or null on close */
export function pickDemo(): Promise<string | null> {
  return new Promise((done) => {
    ensureCss();
    const root = document.createElement("div");
    root.id = "mvm";
    root.innerHTML = `<div class="p" style="position:absolute;left:50%;top:8%;transform:translateX(-50%);width:min(720px,94vw);max-height:84%;display:flex;flex-direction:column">
      <div class="row" style="padding:10px 12px;border-bottom:1px solid #333"><b style="flex:1;font-size:14px">Theater · demos</b><button data-a="close">Close</button></div>
      <div class="row" style="padding:8px 12px 0"><input class="search" placeholder="Search by name, map or player" style="flex:1"></div>
      <div class="body list"><div class="hint">Loading…</div></div>
      <div class="hint" style="padding:0 12px 8px">Right-click a demo to rename or delete it.</div></div>
      <div class="p menu" style="position:fixed;display:none;flex-direction:column;padding:3px;min-width:110px">
        <button data-a="rename" style="border:0;text-align:left">Rename</button><button data-a="delete" style="border:0;text-align:left">Delete</button></div>`;
    document.body.appendChild(root);
    const list = root.querySelector(".body")!, search = root.querySelector<HTMLInputElement>(".search")!, menu = root.querySelector<HTMLElement>(".menu")!;
    let demos: DemoListing[] = [], target = "";
    const infos = new Map<string, DemoInfo | null>();
    const finish = (v: string | null) => { root.remove(); done(v); };
    const mapLabel = (id: string) => mapIndexEntry(id)?.name ?? id;
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = demos.filter((d) => {
        const i = infos.get(d.name);
        return [d.name, i && mapLabel(i.map), i?.map, ...(i?.players.map((p) => p.name) ?? [])].some((s) => s?.toLowerCase().includes(q));
      });
      list.innerHTML = shown.length
        ? shown.map((d) => demoRow(d, infos.get(d.name), mapLabel)).join("")
        : `<div class="hint">${demos.length ? "No demo matches." : "No demos yet. Every match you play is recorded to point-blank-webport/mvm/demos."}</div>`;
    };
    // the rows show at once; each fills in as the dev server reads its file, a few at a time
    const fill = async (names: string[]) => {
      const next = async (): Promise<void> => {
        const n = names.shift();
        if (n === undefined || !root.isConnected) return;
        infos.set(n, await demoInfo(n).catch(() => null));
        // only the arriving row: rebuilding the list between a press and its release swallows the click
        const row = list.querySelector(`[data-demo="${window.CSS.escape(n)}"]`);
        if (search.value.trim()) draw();
        else if (row) row.outerHTML = demoRow(demos.find((d) => d.name === n)!, infos.get(n), mapLabel);
        return next();
      };
      await Promise.all([next(), next(), next()]);
    };
    const load = () => listDemos().then((ds) => {
      demos = ds;
      draw();
      void fill(ds.map((d) => d.name).filter((n) => !infos.has(n)));
    }).catch((e) => { list.innerHTML = `<div class="hint">Could not list demos: ${esc(String(e))}</div>`; });
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

function demoRow(d: DemoListing, i: DemoInfo | null | undefined, mapLabel: (id: string) => string): string {
  const shape = i ? STAGE_SHAPE[i.map.toLowerCase()] : undefined;
  let thumb = "";
  if (shape !== undefined) {
    const { tex, u, v } = mapShapeCell(shape);
    thumb = `<div style="width:${MAP_SHAPE.w}px;height:${MAP_SHAPE.h}px;transform:scale(.6);transform-origin:0 0;background:url(${assetUrl(`/assets/ui/cross/atlas/${MAP_SHAPE.atlas(tex)}.png`)}) -${u}px -${v}px"></div>`;
  }
  const players = i ? i.players.map((p) => `<span style="color:${p.team ? "#6a9cf0" : "#e06a5c"};${p.id === i.pov ? "font-weight:bold;text-decoration:underline" : ""}">${esc(p.name)}</span>`).join(", ") : "";
  const meta = i ? `${esc(mapLabel(i.map))} · ${esc(i.mode)} · ${fmt(i.dur).replace(/\.\d+$/, "")} · ${new Date(i.date).toLocaleString()}` : i === null ? "Could not read this demo" : "Reading…";
  return `<div class="item" data-demo="${esc(d.name)}" style="align-items:flex-start;gap:10px;padding:6px 8px">
    <div style="flex:none;width:${Math.round(MAP_SHAPE.w * 0.6)}px;height:${Math.round(MAP_SHAPE.h * 0.6)}px;overflow:hidden;border-radius:3px;background:#1a1c20">${thumb}</div>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
      <div style="display:flex;gap:8px"><b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name.replace(/\.pbdemo$/, ""))}</b><span class="hint">${(d.size / 1e6).toFixed(1)} MB</span></div>
      <div class="hint">${meta}</div>
      <div style="font-size:11px;line-height:1.35">${players}</div></div></div>`;
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
