import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { Game } from "../game/game";
import type { KillEvent } from "../game/netAdapter";
import { Campath, unwrap, type CamKey, type CamPose } from "./campath";
import { DEMO_API, demoInfo, deleteDemo, listDemos, renameDemo, saveDemo, type Demo, type DemoInfo, type DemoListing } from "./demo";
import { MAP_SHAPE, STAGE_SHAPE, mapShapeCell } from "../lobby/screensCross/crossMap";
import { assetUrl } from "../assetMap";
import { mapIndexEntry } from "../config";
import type { DemoNet } from "./demoNet";
import { Post, type DofParams } from "./post";
import { LAYERS, PASSES, Passes, hudKey, layerPasses, type PassFrame, type PassName } from "./passes";
import { CROSSHAIR, CROSSHAIR_COLORS } from "../game/pbHud/layout";
import { HudCapture } from "./hudCapture";
import { renderOnTop } from "../render/onTop";
import { renderPbShadows } from "../render/pbShadow";
import { charaChoices } from "../game/charModel";
import { actorEquip, hatChoices } from "../game/charEquip";
import { WeaponDb } from "../weapons/data";
import { loadWeaponModelIndex } from "../weapons/worldModel";
import { isItemShown, loadWeaponSupport } from "../lobby/state/weaponSupport";
import { brightnessFactor, crosshairIndex, type GameSettings } from "../gameplay/settings";
import { aoOn } from "./lookFx";
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
// the timeline: ruler height, kill marker height, px between ruler labels (px); the closest zoom (s)
const TL_RULER = 18, TL_MARK = 12, TL_LABEL = 64, MIN_VIEW = 0.5;
const RULER_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
/** red, blue, no team (the world) */
const TEAM_CSS = ["#e0503f", "#4a8ef0", "#9a9a9a"];
const STEP_DELAY = 300, STEP_RATE = 30; // a held Ctrl + arrow: ms before it repeats, then ticks per second
const ZOOMS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const ZOOM_KEY = "mvm.uiZoom";
const demoEdits = (d: Demo) => JSON.stringify({ deaths: d.deaths, charas: d.charas, hats: d.hats, names: d.names, weapons: d.weapons });

type WeaponChoices = { list: { itemId: number; label: string; group: string }[]; names: Map<number, string> };
let weaponChoicesP: Promise<WeaponChoices> | null = null;
/** every weapon the client shows, primary first, for the actor editor's weapon swap; loaded once */
function weaponChoices(): Promise<WeaponChoices> {
  return (weaponChoicesP ??= loadWeaponChoices().catch((e) => { console.warn("[theater] weapon list", e); throw e; }));
}
async function loadWeaponChoices(): Promise<WeaponChoices> {
  const db = new WeaponDb();
  const [models] = await Promise.all([loadWeaponModelIndex(), db.load("/assets/cross/weapons/weapons.json"), loadWeaponSupport()]);
  const looks = new Map<string, Set<string>>(), out: { itemId: number; label: string; group: string; model: string }[] = [];
  for (const w of db.all().filter((w) => isItemShown(w.id)).sort((a, b) => a.slot - b.slot || a.name.localeCompare(b.name) || a.id - b.id)) {
    const model = models.find((m) => m.itemIds?.includes(w.id))?.id ?? "", seen = looks.get(w.name) ?? new Set<string>();
    looks.set(w.name, seen);
    if (seen.has(model)) continue; // a timed / event copy of the same gun: same model, clips and sounds
    seen.add(model);
    out.push({ itemId: w.id, label: w.name, group: w.slotName, model });
  }
  // a name left with several looks (KrissSuperV, its _EV and _D) says which model each is
  const list = out.map((o) => (looks.get(o.label)!.size > 1 && o.model ? { ...o, label: `${o.label} (${o.model})` } : o));
  return { list, names: new Map(db.all().map((w) => [w.id, w.name])) };
}

const ICON = {
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  focus: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  camera: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10.5l6-3.5v10l-6-3.5z"/>',
  campath: '<circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="6" r="2.2"/><path d="M7.2 18C14 18 10 6 16.8 6"/>',
  visuals: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  render: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
  controls: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  back: '<path d="M19 5v14L9 12z" fill="currentColor"/><path d="M5 5v14"/>',
  fwd: '<path d="M5 5v14l10-7z" fill="currentColor"/><path d="M19 5v14"/>',
  loop: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
};
const TABS = { camera: "Camera", campath: "Campath", visuals: "Visuals", render: "Render", controls: "Controls" };
const MODES: [Mode, string, string][] = [["pov", "POV", "First person (F2)"], ["third", "Third", "Third person (F3)"], ["free", "Free", "Free camera (F)"], ["dolly", "Dolly", "Ride the campath (J)"]];
// common output sizes; the viewport takes the picked one's shape
const icon = (k: keyof typeof ICON, size = 14) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
const TEAM = [{ name: "Red", color: "#d33a2c" }, { name: "Blue", color: "#2c6fd3" }];
/** [RECRIADO] best graphics while the theater is open (never saved); Rim Light and antialias off by user choice */
export const THEATER_GRAPHICS: Partial<GameSettings> = {
  shadowQuality: 3, dynamicLight: true, normalMap: true, specularMap: true, reflection: true, rimLight: false, ibl: true, anisotropic: true,
  antialias: false, dynamicRes: false,
};

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
const HUD_SVG = `<path d="M15 6.5v3m0 4v3m-5-5h3m4 0h3" stroke="#5cf03c" stroke-width="1.1"/><rect x="1" y="1" width="7" height="7" rx=".6" fill="#26303a" stroke="#9aa3ad" stroke-width=".5"/>
  <circle cx="4.5" cy="4.5" r=".9" fill="#5cf03c"/><rect x="20" y="14" width="9" height="5" rx=".6" fill="#2b2f36" stroke="#9aa3ad" stroke-width=".5"/><path d="M21.5 16.5h3" stroke="#8eb740" stroke-width="1.4"/>`;
const CHECK_SVG = Array.from({ length: 24 }, (_, i) => `<rect x="${(i % 6) * 5}" y="${Math.floor(i / 6) * 5}" width="5" height="5" fill="${(i % 6 + Math.floor(i / 6)) % 2 ? "#2e3036" : "#4a4d55"}"/>`).join("");
const svg = (inner: string) => `<svg viewBox="0 0 30 20" width="30" height="20">${inner}</svg>`;
const matteSvg = (alpha: boolean, inner: string, key = "#14b814") => svg((alpha ? CHECK_SVG : `<rect width="30" height="20" fill="${key}"/>`) + inner);
/** the HUD's screen colour (passes.ts hudKey) by the crosshair colour set in the options, as PbHud draws it */
const hudKeyNow = () => { const i = crosshairIndex(); return hudKey(i === null ? CROSSHAIR.color : CROSSHAIR_COLORS[i] ?? CROSSHAIR.color); };
const KEY_NAMES: Record<string, string> = { "1,0,1": "magenta", "0,0,1": "blue" };
/** swatch: an svg, or a CSS background */
const PASS_INFO: Record<PassName, { label: string; note: (alpha: boolean) => string; swatch: (alpha: boolean) => string }> = {
  default: { label: "Default", note: () => "The frame as you see it",
    swatch: () => svg(`${WORLD_SVG}<g transform="translate(-3.5 2.6) scale(.82)">${PLAYER_SVG}</g><g transform="translate(9 6) scale(.7)">${GUN_SVG}</g>`) },
  world: { label: "World", note: () => "Map only: no players or effects", swatch: () => svg(WORLD_SVG) },
  players: { label: "Players", note: (a) => (a ? "Alpha matte" : "On green screen"), swatch: (a) => matteSvg(a, PLAYER_SVG) },
  viewmodel: { label: "Viewmodel", note: (a) => `Arms, gun and its flash · ${a ? "premultiplied alpha" : "on green"}`, swatch: (a) => matteSvg(a, GUN_SVG) },
  hud: { label: "HUD", note: (a) => `The player's own HUD: crosshair, radar, kill feed · ${a ? "alpha matte" : `on ${KEY_NAMES[hudKeyNow().join()]} (its own green rules out green)`}`, swatch: (a) => matteSvg(a, HUD_SVG, `rgb(${hudKeyNow().map((v) => v * 255).join()})`) },
  effects: { label: "Effects", note: (a) => `Flashes, smoke, tracers ${a ? "· premultiplied alpha" : "on black"}`,
    swatch: () => "radial-gradient(circle at 55% 50%,#fff6d0 0 9%,#ffb84a 20%,rgba(255,120,20,.35) 38%,transparent 58%),#050505" },
  depth: { label: "Depth", note: () => "16-bit · white near, black far", swatch: () => "linear-gradient(90deg,#f2f2f2,#101010)" },
  normals: { label: "Normals", note: () => "Surface direction, view space", swatch: () => "linear-gradient(135deg,#9a80ff,#7f7fff 35%,#80ffa8 70%,#ff9a80)" },
};
/** layers only first person draws: his gun and his HUD */
const povOnly = (p: PassName) => p === "viewmodel" || p === "hud";
const LINK = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.5 9.5l3-3M7 4.5l1.3-1.3a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.3 1.3a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"/></svg>`;
const EYE = `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M1 8s2.6-4.6 7-4.6S15 8 15 8s-2.6 4.6-7 4.6S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/></svg>`;
const CODECS: [string, string][] = [["prores4444xq", "ProRes 4444 XQ"], ["prores4444", "ProRes 4444"], ["prores422hq", "ProRes 422 HQ"],
  ["prores422", "ProRes 422"], ["prores422lt", "ProRes 422 LT"]];

const CSS = `
#mvm{--bg1:#171a1e;--bg2:#1f2328;--bg3:#2a2f35;--ln:#2b3036;--tx:#d6dae0;--mu:#878f99;--am:#f2a93b;--amd:#3b2f1b;--rec:#e2452f;
  position:fixed;inset:0;pointer-events:none;font:12.5px/1.45 Bahnschrift,"Segoe UI",system-ui,sans-serif;color:var(--tx);z-index:50;user-select:none;font-variant-numeric:tabular-nums}
body.mvm-on{background:#0d0f12}body.mvm-on #app{overflow:hidden}
#mvm.off>:not(.mvm-toast):not(.prog){display:none}#mvm.rendering .prev{display:none!important}
#mvm>.shell,#mvm>.edit{zoom:var(--ui-zoom,1)}
#mvm .p{pointer-events:auto;background:var(--bg1);border:1px solid var(--ln);border-radius:6px}
#mvm button,#mvm select,#mvm input{font:inherit;color:var(--tx);background:var(--bg2);border:1px solid var(--ln);border-radius:4px;padding:3px 8px;outline:none}
#mvm button:hover{background:var(--bg3)}#mvm button.on{background:var(--am);border-color:var(--am);color:#1a1408}
#mvm :is(button,select,input):focus-visible{box-shadow:0 0 0 2px rgba(242,169,59,.55)}
#mvm input[type=range]{accent-color:var(--am);padding:0;border:0;background:none}#mvm input[type=color]{padding:1px 2px;width:32px;height:24px}
#mvm .hint{color:var(--mu)}#mvm .grow{flex:1}
#mvm .shell{position:absolute;inset:0;display:grid;grid-template:"bar bar bar" 38px "stage side rail" minmax(0,1fr) "dock dock dock" auto/minmax(0,1fr) 300px 54px}
#mvm .shell>.p{border:0;border-radius:0}
#mvm .shell>.mbar{grid-area:bar;display:flex;align-items:center;gap:12px;padding:0 10px 0 14px;border-bottom:1px solid var(--ln)}
#mvm .brand{font-weight:600;color:var(--am)}#mvm .dname{font-weight:600;max-width:46ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mvm .zoom{display:flex}#mvm .zoom button{border-radius:0;min-width:26px}
#mvm .zoom button:first-child{border-radius:4px 0 0 4px}#mvm .zoom button:last-child{border-radius:0 4px 4px 0}#mvm .zoom button+button{margin-left:-1px}
#mvm .zoom [data-a="zoomReset"]{min-width:48px}
#mvm .stage{grid-area:stage;display:flex;flex-direction:column;min-width:0;min-height:0}
#mvm .slate{pointer-events:auto;display:flex;align-items:center;gap:8px;padding:10px 16px 0;min-width:0}
#mvm .seg{display:flex}#mvm .seg button{border-radius:0;margin-left:-1px;min-width:52px}
#mvm .seg button:first-child{border-radius:4px 0 0 4px;margin-left:0}#mvm .seg button:last-child{border-radius:0 4px 4px 0}
#mvm .slate select{max-width:180px}
#mvm .spec{display:flex;gap:12px;color:var(--mu);white-space:nowrap}
#mvm .view{flex:1;min-height:0;margin:12px 16px 16px}
#mvm .frame{position:fixed;pointer-events:none;outline:1px solid rgba(255,255,255,.07)}
#mvm .frame i{position:absolute;width:16px;height:16px;border:0 solid var(--am)}
#mvm .frame i:nth-child(1){left:-7px;top:-7px;border-width:2px 0 0 2px}#mvm .frame i:nth-child(2){right:-7px;top:-7px;border-width:2px 2px 0 0}
#mvm .frame i:nth-child(3){right:-7px;bottom:-7px;border-width:0 2px 2px 0}#mvm .frame i:nth-child(4){left:-7px;bottom:-7px;border-width:0 0 2px 2px}
#mvm .frame.pv i{border-color:#7fb3ff}
#mvm .prev{display:flex;gap:8px;align-items:center;padding:2px 3px 2px 10px;border:1px solid #4a74b0;border-radius:4px;background:#1a2433;white-space:nowrap}
#mvm .prev b{color:#9cc4ff;font-weight:600}#mvm .prev button{padding:0 6px;background:none;border:0}
#mvm .shell>.side{grid-area:side;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--ln)}
#mvm .ttl{margin:0;padding:13px 14px 9px;font-size:15px;font-weight:600}
#mvm .body{padding:4px 14px 14px;overflow:auto;display:flex;flex-direction:column;gap:7px;min-height:0}#mvm .body>*{flex-shrink:0}
#mvm .foot{flex:none;padding:10px 14px 14px;border-top:1px solid var(--ln);display:flex;flex-direction:column;gap:7px}#mvm .foot:empty{display:none}
#mvm .shell>.rail{grid-area:rail;display:flex;flex-direction:column;gap:2px;padding:8px 5px;border-left:1px solid var(--ln);background:#14171a}
#mvm .rail button{display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 0 5px;border:0;border-radius:5px;background:none;color:var(--mu);font-size:10.5px}
#mvm .rail button:hover{background:var(--bg2);color:var(--tx)}#mvm .rail button.on{background:var(--amd);color:var(--am)}
#mvm .shell>.dock{grid-area:dock;border-top:1px solid var(--ln);padding:7px 14px 12px;display:flex;flex-direction:column;gap:7px}
#mvm .ctl{display:flex;align-items:center;gap:5px}
#mvm .tp{width:30px;height:28px;padding:0;display:grid;place-items:center}#mvm .tp.play{width:40px}
#mvm .tc{font-size:20px;font-weight:600;margin-left:10px;min-width:84px}
#mvm .spd{position:relative;margin-left:10px}#mvm .speed{width:54px;padding:1px 0;text-align:center;border-radius:9px;background:none;color:var(--mu)}#mvm .speed.on{color:var(--am);border-color:var(--am);background:none}
#mvm .spop{position:absolute;bottom:calc(100% + 10px);left:50%;transform:translateX(-50%);width:250px;padding:10px 12px 9px;display:flex;flex-direction:column;gap:6px;z-index:2;box-shadow:0 10px 28px rgba(0,0,0,.5)}
#mvm .spop[hidden]{display:none}#mvm .spop b{font-size:18px;font-weight:600}#mvm .spop input{width:100%;margin:2px 0}
#mvm .sticks{position:relative;height:16px;margin:0 8px;font-size:11px}#mvm .sticks button{position:absolute;transform:translateX(-50%);padding:0 3px;border:0;background:none;color:var(--mu)}
#mvm .sticks button:hover{color:var(--tx)}
#mvm .range{display:flex;gap:14px;color:var(--mu)}#mvm .range b{color:var(--tx);font-weight:400}
#mvm .tracks{display:grid;grid-template-columns:96px minmax(0,1fr)}
#mvm .lanes{display:grid;grid-template-rows:18px 1fr 1fr;color:var(--mu);font-size:11.5px}
#mvm .lanes span{display:flex;align-items:center;gap:6px;border-top:1px solid var(--ln)}#mvm .lanes span:first-child{border:0}
#mvm .lanes i{font-style:normal;color:#5d646d}
#mvm .tlwrap{position:relative;min-width:0}
#mvm canvas.tl{width:100%;height:84px;cursor:pointer;display:block;border-radius:3px;background:#121417}
#mvm .tltip{position:absolute;bottom:calc(100% + 4px);display:none;padding:4px 8px;background:var(--bg1);border:1px solid var(--ln);border-radius:4px;white-space:nowrap;pointer-events:none;font-size:11.5px}
#mvm .row{display:flex;gap:6px;align-items:center}#mvm .row>label{flex:0 0 74px;color:var(--mu)}
#mvm .hd{font-weight:600;margin-top:6px;padding-top:9px;border-top:1px solid var(--ln)}
#mvm .list{display:flex;flex-direction:column;gap:1px}
#mvm .item{display:flex;gap:7px;padding:3px 6px;border-radius:4px;cursor:pointer;align-items:center}
#mvm .item:hover{background:var(--bg2)}#mvm .item.on{background:var(--amd)}
#mvm .dot{width:8px;height:8px;border-radius:50%;flex:none}
#mvm .keys{border-collapse:collapse}#mvm .keys td{padding:3px 6px;vertical-align:top;border-top:1px solid #22262b}
#mvm .keys td:first-child{color:var(--am);font-weight:600;white-space:nowrap}
#mvm .mvm-toast{position:fixed;left:var(--vx,50%);top:var(--vy,40%);transform:translateX(-50%);padding:8px 16px;font-size:14px;background:rgba(23,26,30,.94)}
#mvm .prog{display:none;position:absolute;left:50%;bottom:16px;transform:translateX(-50%);width:min(560px,90vw);padding:9px 12px;flex-direction:column;gap:7px}
#mvm.rendering .prog{display:flex}#mvm .prog .pbar{height:5px;border-radius:3px;background:var(--bg3);overflow:hidden}
#mvm .prog .pbar i{display:block;height:100%;width:0;background:var(--rec)}
#mvm .prog .ptext{display:flex;gap:12px}#mvm .prog .ptext b{color:var(--am)}
#mvm .edit{position:absolute;width:264px;flex-direction:column;overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,.55)}
#mvm .edit select,#mvm .edit input{width:100%;min-width:0;box-sizing:border-box}
#mvm .ed-head{display:flex;align-items:center;gap:2px;padding:8px 6px 8px 10px;border-left:3px solid var(--team);cursor:move;user-select:none;background:linear-gradient(90deg,color-mix(in srgb,var(--team) 24%,transparent),transparent 75%)}
#mvm .ed-id{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.25}
#mvm .ed-id b{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#mvm .ed-id span{font-size:11px;color:var(--mu)}
#mvm .ed-id i{font-style:normal;color:var(--am)}
#mvm .ic{flex:none;width:26px;height:26px;padding:0;display:grid;place-items:center;background:none;border-color:transparent;color:#9aa0a8}
#mvm .ic:hover{color:#fff}#mvm .ic.on{color:var(--am);background:var(--amd);border-color:#c47f12}
#mvm .ed-sec{padding:7px 10px 9px;border-top:1px solid var(--ln);display:flex;flex-direction:column;gap:5px}
#mvm .ed-sec h6{margin:0;font-size:11.5px;font-weight:600;color:var(--mu)}
#mvm .fld{display:grid;grid-template-columns:78px minmax(0,1fr);align-items:center;gap:6px}
#mvm .fld>span{color:#9aa0a8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mvm .fld.ed>span{color:var(--am)}#mvm .fld.ed>span::before{content:"";display:inline-block;width:5px;height:5px;margin-right:4px;border-radius:50%;background:var(--am);vertical-align:middle}
#mvm .fld.ed select,#mvm .fld.ed input{border-color:#8a5c12}
#mvm .ed-foot{padding:5px 6px 5px 10px;border-top:1px solid var(--ln);display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mu)}
#mvm .ed-foot span{flex:1}#mvm .ed-foot button{display:flex;align-items:center;gap:4px;padding:2px 8px}
#mvm .item .who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mvm .item .wr{flex:none;width:22px;height:20px;padding:0;display:grid;place-items:center;background:none;border-color:transparent;color:#6c717a;opacity:.55}
#mvm .item:hover .wr{opacity:1}#mvm .item .wr:hover{color:#fff;background:var(--bg3)}
#mvm .item .wr.has{color:var(--am);opacity:1}#mvm .item.editing .wr{color:#111;background:#c47f12;opacity:1}
#mvm .sect{display:flex;gap:6px;align-items:center;margin-top:6px;font-weight:600}#mvm .sect .hint{flex:1;font-weight:400}
#mvm .sect button{padding:0 7px;font-size:11px;font-weight:400}
#mvm .passes{display:flex;flex-direction:column;border:1px solid var(--ln);border-radius:5px;overflow:hidden;background:#15181b}
#mvm .pass{display:flex;align-items:center;gap:7px;padding:5px 4px 5px 7px;cursor:pointer;border-top:1px solid #23262c}
#mvm .pass{position:relative}#mvm .pass.joined{border-top-color:transparent}#mvm .pass.joined .recdot,#mvm .pass.joined .eye{visibility:hidden}
#mvm .link{position:absolute;left:4px;top:-8px;z-index:1;width:15px;height:15px;padding:0;display:grid;place-items:center;border-radius:50%;background:#15181b;border:1px solid var(--ln);color:#5c616b}
#mvm .link:hover{color:#ddd;background:var(--bg3)}#mvm .link.on{color:var(--am);border-color:#c47f12;background:var(--amd)}
#mvm .pass:first-child{border-top:0}#mvm .pass:hover{background:#1f2227}#mvm .pass.rec{background:#2a2217}#mvm .pass.rec:hover{background:#33291b}
#mvm .recdot{flex:none;width:11px;height:11px;border-radius:50%;border:2px solid #4c5059;box-sizing:border-box}
#mvm .pass.rec .recdot{border-color:#ff7262;background:radial-gradient(circle at 35% 35%,#ff8a7a,#d2321f)}
#mvm .sw{flex:none;width:30px;height:20px;border-radius:3px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.12)}#mvm .sw svg{display:block}
#mvm .pass:not(.rec) .sw{opacity:.55}#mvm .pass.na{cursor:default}#mvm .pass.na>:not(.link){opacity:.4}#mvm .pass.na:hover{background:none}
#mvm .nm{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.25}
#mvm .nm b{font-weight:600;color:#9aa0a8}#mvm .pass.rec .nm b{color:#f2f2f2}
#mvm .eye{flex:none;display:flex;align-items:center;gap:3px;border:0;background:none;padding:3px 5px;color:#5c616b}
#mvm .eye:hover{background:#2f333b;color:#ccc}#mvm .eye.on{color:#9cc4ff;background:#1a2433}
#mvm .eye kbd{font:inherit;font-size:10.5px;color:inherit;opacity:.8}
#mvm .pass-opt{display:flex;align-items:center;gap:6px;padding:0 8px 6px 45px;color:var(--mu);background:inherit}
#mvm .pass-opt input{width:60px}
#mvm .files{font-size:11.5px;color:#9aa3ad;background:#121418;border:1px solid var(--ln);border-radius:4px;padding:5px 7px;display:flex;flex-direction:column;gap:3px}
#mvm .files>div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc}
#mvm .files>span{display:flex;flex-wrap:wrap;gap:3px}#mvm .files>span>i{font-style:normal;background:#23262c;border-radius:2px;padding:0 4px}
#mvm .go{padding:7px;font-weight:600;background:var(--rec);border-color:#f06a55;color:#fff;display:flex;align-items:center;justify-content:center;gap:7px}#mvm .go:hover{background:#f0553d}
#mvm .go[disabled]{opacity:.45;pointer-events:none}
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
  /** the game's own stage (canvas, HUD), framed into the viewport slot at the output's shape */
  private readonly app = document.getElementById("app")!;
  private readonly slot: HTMLElement;
  private appStyle: string | null = null;
  private readonly slotSeen = new ResizeObserver(() => this.layout());
  private tab = "camera";
  private kills: number[];
  private readonly killRecs: { t: number; e: KillEvent }[];
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
  private weaponList: { itemId: number; label: string; group: string }[] = [];
  private weaponNames = new Map<number, string>();
  private dirty = false;
  private readonly looks: LookStage;
  /** saved looks / maps with a sky; null = not fetched yet */
  private lookNames: string[] | null = null;
  private skyNames: string[] = [];
  private lookName = "";
  /** depth of field: made on first use; the cursor over the canvas (0..1, origin bottom left) and the player in focus */
  private post: Post | null = null;
  private passes: Passes | null = null;
  private readonly hudCap = new HudCapture();
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
    this.killRecs = demo.recs.flatMap((r) => (r.k === "kill" ? [{ t: r.t, e: r.e }] : []));
    this.kills = this.killRecs.map((r) => r.t);
    this.ticks = [...new Set(demo.recs.filter((r) => r.k === "state").map((r) => r.t))];
    this.savedEdits = demoEdits(demo);
    ensureCss();
    this.root.id = "mvm";
    this.root.innerHTML = `<div class="shell">
      <header class="p mbar"><span class="brand">Theater</span><span class="dname" title="${esc(demo.name)}">${esc(demo.name.replace(/\.pbdemo$/, ""))}</span>
        <span class="hint">${esc(mapIndexEntry(demo.map)?.name ?? demo.map)}</span><span class="hint">${fmt(demo.dur)}</span><span class="grow"></span>
        <button data-a="save" class="on" style="display:none">Save changes</button><button data-a="discard" style="display:none">Discard</button>
        <span class="zoom" title="UI size"><button data-a="zoomOut">−</button><button data-a="zoomReset" title="Back to 100%"></button><button data-a="zoomIn">+</button></span>
        <button data-a="exit">Exit</button></header>
      <section class="stage"><div class="slate">
        <span class="seg">${MODES.map(([m, t, tip]) => `<button data-a="${m}" title="${tip}">${t}</button>`).join("")}</span>
        <select name="watch" title="Player to watch ([ / ])"></select><span class="grow"></span>
        <div class="prev" style="display:none"></div><span class="spec" title="Output size (Render tab)"></span></div>
        <div class="view"></div></section>
      <aside class="p side"><h2 class="ttl"></h2><div class="body"></div><div class="foot"></div></aside>
      <nav class="p rail">${Object.entries(TABS).map(([t, l]) => `<button data-tab="${t}" title="${l}">${icon(t as keyof typeof ICON, 18)}${l === "Controls" ? "Keys" : l}</button>`).join("")}</nav>
      <footer class="p dock"><div class="ctl">
        <button class="tp" data-a="back" title="Skip back (←)">${icon("back", 14)}</button><button class="tp play" data-a="play" title="Play / pause (Space)"></button>
        <button class="tp" data-a="fwd" title="Skip forward (→)">${icon("fwd", 14)}</button><button class="tp" data-a="loop" title="Loop the in / out range (O)">${icon("loop", 15)}</button>
        <span class="tc"></span><span class="hint">/ ${fmt(demo.dur)}</span><span class="spd"><button class="speed" data-a="speed" title="Playback speed (↑ / ↓)"></button>
          <div class="p spop" hidden><div><b class="sval"></b> <span class="hint">playback speed</span></div>
            <input type="range" name="speed" min="0" max="${SPEEDS.length - 1}" step="1" aria-label="Playback speed">
            <div class="sticks">${[0.1, 0.5, 1, 2, 8].map((v) => `<button data-speed="${SPEEDS.indexOf(v)}" style="left:${(SPEEDS.indexOf(v) / (SPEEDS.length - 1)) * 100}%">${v}×</button>`).join("")}</div>
            <span class="hint">Preview only: a render always runs at game time.</span></div></span>
        <span class="grow"></span><span class="range" title="In / out points (B / N)"></span></div>
        <div class="tracks"><div class="lanes"><span></span><span>Campath <i class="nk"></i></span><span>Kills <i>${this.kills.length}</i></span></div>
          <div class="tlwrap"><canvas class="tl"></canvas><div class="tltip"></div></div></div></footer></div>
      <div class="frame"><i></i><i></i><i></i><i></i></div>
      <div class="p edit" style="display:none"></div>
      <div class="p prog"><div class="ptext"></div><div class="pbar"><i></i></div></div>`;
    document.body.appendChild(this.root);
    document.body.classList.add("mvm-on");
    this.appStyle = this.app.getAttribute("style");
    this.tl = this.root.querySelector("canvas.tl")!;
    this.slot = this.root.querySelector(".view")!;
    let z = 1;
    try { z = Number(localStorage.getItem(ZOOM_KEY)); } catch { /* no storage: 100% */ }
    this.setZoom(ZOOMS.includes(z) ? z : 1);
    this.wire();
    this.layout();
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
    host.game.onHudFocus = () => host.game.hudRewind(this.killRecs, this.time);
    this.seek(0);
    this.setMode("pov", demo.pov);
    this.drawSide();
  }

  // ---- frame ----
  /** one rAF frame (main.ts animate); during a render the render loop steps the world itself */
  frame(raw: number): void {
    if (this.rendering) return;
    if (this.stepHold) this.stepHeld();
    const dt = Math.min(raw, 0.05);
    let sim = 0;
    if (this.playing) {
      sim = dt * SPEEDS[this.speedIdx];
      // looping: past the out point (crossed while playing) back to the in point
      if (this.loop && this.outPt > this.inPt && this.time < this.outPt && this.time + sim >= this.outPt) { this.seek(this.inPt); sim = 0; }
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
      game.hudRewind(this.killRecs, this.time);
      game.poseRemotes(this.net.poses(this.time));
      return;
    }
    this.time = Math.max(0, target - WARM);
    game.snapRemotes(this.net.seek(this.time), this.time);
    game.hudRewind(this.killRecs, this.time); // the replay brings the rest
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
      this.net.advance(target); // the steps' float sum can stop short of a record at the target itself
      this.host.simulate(0); // ...and the game takes in what that record brought (a shot exactly at the target: a kill marker)
    });
    this.time = target;
    game.poseRemotes(this.net.poses(this.time));
  }

  private setMode(m: Mode, id?: string): void {
    if ((m === "free" || m === "dolly") && this.mode !== "free" && this.mode !== "dolly") this.free = this.currentPose();
    this.mode = m;
    // no gun to show outside first person, where the world's pass may now be the whole frame
    if (m !== "pov" && povOnly(this.preview)) this.setPreview("default");
    this.host.game.observe(m === "pov" ? "fps" : m === "third" ? "third" : "fly", id);
    // arms mounted now start cold (no shot or reload under way): the exact seek's replay brings them up to this moment
    if (m === "pov") this.seek(this.time);
    this.drawSide();
    this.drawSlate();
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
  private renderOpts = { w: 1920, h: 1080, fps: 250, codec: "prores422lt", name: "", passes: ["world"] as PassName[], joined: ["players", "effects", "viewmodel"] as PassName[], depthRange: 50, hudScale: 100 };

  /** [RECRIADO] the game's stage at the output's shape in the viewport slot (the window with the UI hidden): the preview is the render's frame */
  private layout(): void {
    const o = this.renderOpts, r = this.root.classList.contains("off") ? new DOMRect(0, 0, innerWidth, innerHeight) : this.slot.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const k = Math.min(r.width / o.w, r.height / o.h), w = Math.max(2, Math.floor(o.w * k)), h = Math.max(2, Math.floor(o.h * k));
    const box = { position: "fixed", left: `${Math.round(r.left + (r.width - w) / 2)}px`, top: `${Math.round(r.top + (r.height - h) / 2)}px`, width: `${w}px`, height: `${h}px` };
    Object.assign(this.app.style, box);
    Object.assign(this.root.querySelector<HTMLElement>(".frame")!.style, box);
    this.root.style.setProperty("--vx", `${Math.round(r.left + r.width / 2)}px`);
    this.root.style.setProperty("--vy", `${Math.round(r.top + (r.height - h) / 2) + 16}px`);
    // [RECRIADO] the HUD laid out as the game would for output / scale (the exe uses fixed px), shrunk to the frame; capped at 8K wide
    const hud = document.getElementById("pbhud"), hw = Math.min(7680, Math.round(o.w * 100 / o.hudScale)), hh = Math.round(hw * o.h / o.w);
    if (hud) Object.assign(hud.style, { inset: "0 auto auto 0", width: `${hw}px`, height: `${hh}px`, transformOrigin: "0 0", transform: `scale(${w / hw})` });
    const { renderer, camera } = this.host, cv = renderer.domElement;
    if (this.rendering) { cv.style.width = `${w}px`; cv.style.height = `${h}px`; return; } // the drawing buffer stays the output's
    renderer.setSize(w, h);
    camera.aspect = o.w / o.h;
    camera.updateProjectionMatrix();
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
    // the viewport already has the output's shape: only the drawing buffer grows to it
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    this.layout();
    const hudRoot = passes.some((p) => (p === "default" ? this.layersOf("world") : this.layersOf(p)).includes("hud")) ? document.getElementById("pbhud") : null;
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
        // a Blob body uploads ~8x faster than the typed array itself in Chromium; but the blob store (~2 GB here, freed only
        // by a GC the tiny Blob objects never prompt) runs out on long renders: that frame goes again as the bytes themselves
        const post = (body: BodyInit) => fetch(`${DEMO_API}/render/frame?id=${jobs[k].id}&n=${f.n}`, { method: "POST", body });
        inflight.push(post(new Blob([bytes])).catch(() => post(bytes)).then(async (r) => {
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
        const want = this.passOf(this.preview), shown = passes.includes(want) ? want : passes[0];
        const hud = hudRoot ? await this.hudCap.capture(hudRoot, w, h) : null;
        renderPbShadows(this.host.renderer, this.host.game.scene, this.host.camera);
        reading.push({ n: i, bytes: Promise.all(passer.capture(passes, this.passFrame(hud), bf, () => this.drawFrame(step), shown)) });
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
      this.layout();
      const saved = `${ends[0].file}${ends.length > 1 ? ` + ${ends.length - 1} more pass${ends.length > 2 ? "es" : ""}` : ""}`;
      // a failed render keeps its own error on screen
      if (ok) this.toast(!bad ? `${this.cancelRender ? "Stopped early, saved" : "Saved"} ${saved}` : `ffmpeg failed: ${bad.log ?? bad.status}`, 8000);
    }
  }

  /** the passes a render records: a layer joined to the one under it goes in that one's; the viewmodel and HUD alone only in POV, the one mode that draws the gun and his HUD */
  private recorded(): PassName[] {
    const o = this.renderOpts;
    return PASSES.filter((p) => o.passes.includes(p) && !o.joined.includes(p) && (!povOnly(p) || this.mode === "pov")).map((p) => this.passOf(p));
  }

  /** [RECRIADO] the pass p is drawn in: the world's with every layer drawn joined is the default, the frame drawn once as the game draws it */
  /** p is the first layer of its file (its eye shows the whole file) */
  private heads(p: PassName): boolean {
    return this.layersOf(p)[0] === p;
  }

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

  /** the viewport shows that layer alone (joined or not); the shown one again = back to default. While rendering: the recorded passes only, kept afterwards */
  private setPreview(p: PassName): void {
    if (this.rendering) p = this.passOf(p); // the render's own files
    if ((this.rendering && !this.recorded().includes(p)) || (povOnly(p) && this.mode !== "pov")) return;
    this.preview = p === this.preview && !this.rendering ? "default" : p;
    this.showPreview();
  }

  private showPreview(): void {
    this.previewLabel();
    if (this.tab === "render") this.drawSide();
  }

  /** the "Previewing" tag: its file's layers follow every link / unlink (drawSide) */
  private previewLabel(): void {
    const el = this.root.querySelector<HTMLElement>(".prev")!;
    el.style.display = this.preview === "default" ? "none" : "flex";
    this.root.querySelector(".frame")!.classList.toggle("pv", this.preview !== "default");
    el.innerHTML = `<span class="hint">Previewing</span><b>${this.rendering || this.heads(this.preview) ? this.passLabel(this.preview) : PASS_INFO[this.preview].label}</b><button data-eye="${this.preview}" title="Back to the default view">✕</button>`;
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
      if (this.rendering && e.code !== "Escape" && !/^Digit[1-7]$/.test(e.code)) return; // the clock and camera stay the render's
      this.held.add(e.code);
      if (!e.repeat) this.key(e);
    }, { capture: true, ...sig });
    window.addEventListener("keyup", (e) => { this.held.delete(e.code); e.stopImmediatePropagation(); }, { capture: true, ...sig });
    window.addEventListener("blur", () => { this.held.clear(); this.looking = false; }, sig);
    window.addEventListener("resize", () => this.layout(), sig); // the slot's observer misses it with the UI hidden
    this.slotSeen.observe(this.slot);
    // no browser zoom (Ctrl + wheel, pinch): it would resize the frame; the UI has its own zoom
    window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { capture: true, passive: false, ...sig });
    const cv = this.host.renderer.domElement;
    cv.addEventListener("mousedown", (e) => {
      if (this.rendering) return;
      if (e.button === 2) this.looking = true;
      if (e.button === 1 && this.mode !== "free" && this.mode !== "dolly") { e.preventDefault(); this.setPovFov(null); }
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
      this.openEdit(id, e.clientX + 8, e.clientY + 8);
    }, sig);

    this.root.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement, el = t.closest<HTMLElement>(".edit");
      if (!el || !t.closest(".ed-head") || t.closest("button")) return;
      const z = this.uiZoom, dx = e.clientX - el.offsetLeft * z, dy = e.clientY - el.offsetTop * z;
      const move = (m: PointerEvent) => this.placeEdit(m.clientX - dx, m.clientY - dy);
      el.setPointerCapture(e.pointerId);
      el.addEventListener("pointermove", move, sig);
      el.addEventListener("lostpointercapture", () => el.removeEventListener("pointermove", move), { once: true, ...sig });
    }, sig);
    this.root.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a],[data-tab],[data-edit],[data-id],[data-key],[data-del],[data-eye],[data-join],[data-pass],[data-speed]");
      if (!b) return;
      if (b.dataset.speed) { this.speedIdx = +b.dataset.speed; this.drawBar(); return; }
      if (b.dataset.eye) { this.setPreview(b.dataset.eye as PassName); return; }
      if (b.dataset.join) {
        const l = b.dataset.join as PassName, o = this.renderOpts, rec = this.recorded().includes(this.passOf(l)), split = o.joined.includes(l);
        o.joined = split ? o.joined.filter((x) => x !== l) : [...o.joined, l];
        // a recorded layer stays in a file: joined, the pass it went into records; split off, it records as its pass did
        const into = this.layersOf(l)[0];
        o.passes = PASSES.filter((x) => (x !== into ? o.passes.includes(x) : split ? rec : rec || o.passes.includes(x)));
        this.drawSide();
        return;
      }
      if (b.dataset.pass) {
        const p = b.dataset.pass as PassName, o = this.renderOpts;
        o.passes = PASSES.filter((x) => (x === p ? !o.passes.includes(p) : o.passes.includes(x)));
        this.drawSide();
        return;
      }
      if (b.dataset.tab) { this.tab = b.dataset.tab; this.drawSide(); return; }
      if (b.dataset.edit) {
        // beside the side panel, level with its row
        const side = this.root.querySelector(".side")!.getBoundingClientRect(), row = b.getBoundingClientRect();
        this.openEdit(this.editId === b.dataset.edit ? null : b.dataset.edit, side.left - 8 - 264 * this.uiZoom, row.top - 8);
        return;
      }
      if (b.dataset.id) { this.setMode(this.mode === "third" ? "third" : "pov", b.dataset.id); return; }
      if (b.dataset.key) { const k = this.path.keys[+b.dataset.key]; this.sel = +b.dataset.key; if (k) { this.seek(k.t); this.free = { ...k, pos: [...k.pos] as CamKey["pos"] }; } this.drawSide(); return; }
      if (b.dataset.del) { this.removeKey(+b.dataset.del); return; }
      this.action(b.dataset.a!);
    }, sig);
    this.root.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement;
      const o = this.renderOpts;
      // even sizes: the 4:2:2 ProRes profiles halve the width of the colour planes
      if (t.name === "w" || t.name === "h") { const v = Math.max(16, Math.min(t.name === "w" ? 7680 : 4320, Math.round(+t.value / 2) * 2 || 2)); o[t.name] = v; t.value = String(v); this.layout(); }
      else if (t.name === "watch") { t.blur(); this.setMode(this.mode === "third" ? "third" : "pov", t.value); } // focus kept would swallow the theater's keys
      else if (t.name === "speed") t.blur(); // the drag's end; on input it would cut the drag short
      else if (t.name === "fps") o.fps = +t.value;
      else if (t.name === "codec") { o.codec = t.value; this.drawSide(); } // the mattes' notes and swatches follow the alpha
      else if (t.name === "povfov") this.setPovFov(t.value === "" ? null : +t.value || null);
      else if (t.name === "name") { o.name = t.value; const el = this.root.querySelector(".files>div"); if (el) el.textContent = `${this.movieName()}#`; } // a redraw here would eat the click that blurred it
      else if (t.name === "depthrange") { o.depthRange = Math.max(1, +t.value || 50); t.value = String(o.depthRange); }
      else if (t.name === "hudscale") { o.hudScale = Math.max(25, Math.min(400, +t.value || 100)); t.value = String(o.hudScale); this.layout(); }
      else if (t.name === "lookname") this.lookName = t.value;
      else if (t.name === "dofactor") this.dofActor = t.value || null;
      else if (t.name === "chara" && this.editId) {
        this.net.setChara(this.editId, +t.value || null);
        this.setDirty(true);
        this.seek(this.time); // the seek replays each actor's last state, now with the new character
      }
      else if (t.name === "pname" && this.editId) {
        this.net.setName(this.editId, t.value.trim() || null);
        this.setDirty(true);
        this.seek(this.time); // the bodies take the name from their states, the kill feed is rebuilt with it
        this.drawSide();
      }
      else if (t.name === "hat" && this.editId) {
        // "" = recorded, "0" = bare head, else "<slot>:<itemId>"
        const [slot, id] = t.value.split(":");
        this.net.setHat(this.editId, t.value === "" ? null : { head: slot === "head" ? +id : 0, beret: slot === "beret" ? +id : 0 });
        this.setDirty(true);
      }
      else if (t.name === "weapon" && this.editId && t.dataset.from) {
        this.net.setWeapon(this.editId, t.dataset.from, +t.value || null);
        this.setDirty(true);
        this.seek(this.time); // the seek replays each actor's last state, now holding the new weapon
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
    // the speed slider closes on a click anywhere else, the viewport included
    window.addEventListener("pointerdown", (e) => { if (!(e.target as Element).closest?.(".spd")) this.root.querySelector<HTMLElement>(".spop")!.hidden = true; }, sig);
    this.root.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement, k = t.dataset.look as keyof Look | undefined, d = t.dataset.dof as keyof Dof | undefined;
      if (t.name === "speed") { this.speedIdx = +t.value; this.drawBar(); return; }
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
    const digit = /^Digit([1-7])$/.exec(e.code);
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
      case "KeyO": this.action("loop"); break;
      case "Delete": case "Backspace":
        if (this.sel >= 0) { this.toast(`Node ${this.sel + 1} removed`, 800); this.removeKey(this.sel); }
        break;
      case "KeyH": this.root.classList.toggle("off"); this.layout(); break;
      case "Escape": this.cancelRender = true; break;
    }
  }

  private action(a: string): void {
    switch (a) {
      case "play": if (this.time >= this.net.demo.dur) this.seek(0); this.playing = !this.playing; break;
      case "back": this.skip(-1); break;
      case "loop": this.loop = !this.loop; this.toast(this.loop ? `Loop ${fmt(this.inPt)} – ${fmt(this.outPt)}` : "Loop off", 1000); this.drawBar(); break;
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
      case "passesDefault": Object.assign(this.renderOpts, { passes: ["world"], joined: ["players", "effects", "viewmodel"] }); this.drawSide(); break;
      case "passesAll": this.renderOpts.passes = [...PASSES]; this.drawSide(); break;
      case "render": void this.renderMovie(); break;
      case "speed": { const pop = this.root.querySelector<HTMLElement>(".spop")!; pop.hidden = !pop.hidden; this.drawBar(); break; }
      case "save": void this.save(); break;
      case "discard": if (window.confirm("Discard your unsaved demo changes?")) this.discard(); break;
      case "zoomOut": this.setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(this.uiZoom) - 1)]); break;
      case "zoomIn": this.setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(this.uiZoom) + 1)]); break;
      case "zoomReset": this.setZoom(1); break;
      case "closeEdit": this.openEdit(null); break;
      case "resetActor": {
        const id = this.editId, d = this.net.demo;
        if (!id) break;
        if (d.names?.[id] !== undefined) this.net.setName(id, null);
        if (d.charas?.[id] !== undefined) this.net.setChara(id, null);
        if (d.hats?.[id] !== undefined) this.net.setHat(id, null);
        for (const k of Object.keys(d.weapons?.[id] ?? {})) this.net.setWeapon(id, k, null);
        for (const k of Object.keys(d.deaths ?? {})) if (k.startsWith(`${id}@`)) this.net.setDeathClip(k, null);
        this.setDirty(true);
        this.seek(this.time);
        break;
      }
      case "focusActor":
        if (this.dofActor === this.editId && this.dof.mode === 3) this.dof.mode = 0;
        else { this.dofActor = this.editId; this.dof.mode = 3; }
        this.drawSide();
        break;
      case "lookLoad": void this.loadLook(); break;
      case "lookSave": void this.saveLook(); break;
      case "lookDel": void this.deleteLook(); break;
      case "lookReset": this.looks.set(this.looks.base); this.lookName = ""; this.drawSide(); break;
      case "exit": if (!this.dirty || window.confirm("Exit without saving your demo changes?")) this.host.exit(); break;
    }
  }

  // ---- timeline ----
  /** the shown span of the demo (s): the wheel zooms around the cursor, the middle button or Shift + wheel pans */
  private view = { a: 0, b: 0 };
  private hoverX: number | null = null;
  /** the playhead at the last timeline draw */
  private barT = 0;
  private loop = false;

  private tlX(t: number, w: number): number { return ((t - this.view.a) / (this.view.b - this.view.a)) * w; }
  private tlT(x: number, w: number): number { return this.view.a + (x / w) * (this.view.b - this.view.a); }

  /** a span `s` long with time `at` kept `k` of the way across, inside the demo */
  private setView(s: number, at: number, k: number): void {
    const dur = this.net.demo.dur;
    s = Math.max(Math.min(MIN_VIEW, dur), Math.min(dur, s));
    const a = Math.max(0, Math.min(dur - s, at - k * s));
    this.view = { a, b: a + s };
    this.drawBar();
  }

  /** what sits under timeline x: a dolly node, the in / out handle, kills */
  private tlHit(x: number, y: number, w: number, h: number) {
    const near = (t: number) => Math.abs(this.tlX(t, w) - x) < 5;
    const key = y >= TL_RULER && y < TL_RULER + (h - TL_RULER) / 2 ? this.path.keys.findIndex((k) => near(k.t)) : -1;
    // the ruler only moves the playhead
    // both handles at one x: the cursor's side picks, or the range could never open to the right
    const edge = y < TL_RULER ? null : near(this.outPt) && (!near(this.inPt) || x > this.tlX(this.inPt, w)) ? "out" as const : near(this.inPt) ? "in" as const : null;
    const kills = y >= TL_RULER + (h - TL_RULER) / 2 ? this.killRecs.filter((k) => near(k.t)) : [];
    return { key, edge, kills };
  }

  private wireTimeline(): void {
    const cv = this.tl, sig = { signal: this.ac.signal };
    this.view = { a: 0, b: this.net.demo.dur };
    let drag: { kind: "seek" | "pan" | "in" | "out" | "range"; from: number; view: { a: number; b: number } } | number | null = null;
    // the cursor in the timeline's own px, by ratio: right however the UI zoom scales its box on screen
    const at = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * cv.clientWidth, y: (e.clientY - r.top) / r.height * cv.clientHeight }; };
    const tAt = (x: number) => Math.max(0, Math.min(this.net.demo.dur, this.tlT(x, cv.clientWidth)));
    cv.addEventListener("mousedown", (e) => {
      const p = at(e), hit = this.tlHit(p.x, p.y, cv.clientWidth, cv.clientHeight);
      if (e.button === 1) { e.preventDefault(); drag = { kind: "pan", from: p.x, view: { ...this.view } }; return; }
      if (e.button === 2) { if (hit.key >= 0) this.removeKey(hit.key); return; }
      if (e.button !== 0) return;
      if (hit.key >= 0) { this.snap(); this.keyDrag = true; drag = hit.key; this.sel = hit.key; this.drawSide(); return; }
      if (e.shiftKey && p.y >= TL_RULER) { const t = tAt(p.x); drag = { kind: "range", from: t, view: this.view }; this.inPt = this.outPt = t; this.drawBar(); return; }
      if (hit.edge) { drag = { kind: hit.edge, from: p.x, view: this.view }; return; }
      if (hit.kills.length) { this.seek(hit.kills[0].t); this.drawBar(); return; } // a kill marker: jump to it
      drag = { kind: "seek", from: p.x, view: this.view };
      this.seek(tAt(p.x), false);
    }, sig);
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = at(e), w = cv.clientWidth, s = this.view.b - this.view.a;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { this.setView(s, this.view.a + ((e.shiftKey ? e.deltaY : e.deltaX) / w) * s, 0); return; }
      this.setView(s * Math.exp(e.deltaY * 0.0015), this.tlT(p.x, w), p.x / w);
    }, { passive: false, ...sig });
    cv.addEventListener("mousemove", (e) => { this.hoverX = at(e).x; this.drawTip(at(e)); }, sig);
    cv.addEventListener("mouseleave", () => { this.hoverX = null; this.drawTip(null); }, sig);
    window.addEventListener("mousemove", (e) => {
      if (drag === null) return;
      const p = at(e), t = tAt(p.x);
      if (typeof drag === "number") { drag = this.sel = this.path.retime(drag, t); return; }
      if (drag.kind === "seek") this.seek(t, false);
      else if (drag.kind === "pan") { const s = drag.view.b - drag.view.a; this.setView(s, drag.view.a - ((p.x - drag.from) / cv.clientWidth) * s, 0); }
      else if (drag.kind === "in") this.inPt = Math.min(t, this.outPt);
      else if (drag.kind === "out") this.outPt = Math.max(t, this.inPt);
      else { this.inPt = Math.min(drag.from, t); this.outPt = Math.max(drag.from, t); }
      this.drawBar();
    }, sig);
    window.addEventListener("mouseup", () => {
      if (typeof drag === "number") { this.keyDrag = false; this.snapEnd(); this.drawSide(); }
      else if (drag?.kind === "seek") this.seek(this.time);
      else if (drag && drag.kind !== "pan" && this.tab === "render") this.drawSide(); // its range line
      drag = null;
    }, sig);
  }

  /** the tooltip over the timeline: the time under the cursor and what is there */
  private drawTip(p: { x: number; y: number } | null): void {
    const tip = this.root.querySelector<HTMLElement>(".tltip")!;
    if (!p) { tip.style.display = "none"; return; }
    const w = this.tl.clientWidth, hit = this.tlHit(p.x, p.y, w, this.tl.clientHeight), t = Math.max(0, Math.min(this.net.demo.dur, this.tlT(p.x, w)));
    const team = this.teamOf(), name = (id: string | null) => (id ? `<b style="color:${TEAM_CSS[team.get(id) ?? 2]}">${esc(this.nameOf(id))}</b>` : "<b>World</b>");
    const lines = [fmt(t)];
    if (hit.key >= 0) { const k = this.path.keys[hit.key]; lines.push(`Node ${hit.key + 1} · ${fmt(k.t)} · ${k.fov.toFixed(0)}°`); }
    else if (hit.edge) lines.push(`${hit.edge === "in" ? "In" : "Out"} point · drag to move it`);
    for (const k of hit.kills.slice(0, 3)) lines.push(`${fmt(k.t)} ${name(k.e.killerId)} ▸ ${name(k.e.victimId)} · ${esc(k.e.weapon)}${k.e.headshot ? " · Headshot" : ""}`);
    tip.innerHTML = lines.join("<br>");
    tip.style.display = "block";
    tip.style.left = `${Math.max(0, Math.min(w - tip.offsetWidth, p.x - tip.offsetWidth / 2)) + this.tl.offsetLeft}px`;
  }

  /** each actor's team (0 red, 1 blue) */
  private teamOf(): Map<string, number> { return new Map(this.net.roster().map((a) => [a.id, a.team])); }
  private nameOf(id: string): string { return this.net.roster().find((a) => a.id === id)?.name ?? id; }

  // ---- UI ----
  private drawBar(): void {
    const q = (s: string) => this.root.querySelector<HTMLElement>(s)!;
    const play = q('[data-a="play"]'), ic = this.playing ? "pause" : "play";
    if (play.dataset.ic !== ic) { play.dataset.ic = ic; play.innerHTML = icon(ic, 16); }
    q('[data-a="loop"]').classList.toggle("on", this.loop);
    q(".tc").textContent = fmt(this.time);
    const speed = `${SPEEDS[this.speedIdx]}×`, pop = q(".spop"), slider = q('[name="speed"]') as HTMLInputElement;
    q(".speed").textContent = q(".sval").textContent = speed;
    q(".speed").classList.toggle("on", !pop.hidden);
    if (+slider.value !== this.speedIdx) slider.value = String(this.speedIdx);
    const range = `<span>In <b>${fmt(this.inPt)}</b></span><span>Out <b>${fmt(this.outPt)}</b></span>`, rEl = q(".range");
    if (rEl.dataset.v !== range) { rEl.dataset.v = range; rEl.innerHTML = range; }
    q(".nk").textContent = String(this.path.keys.length);
    this.drawSlate();
    const cv = this.tl, w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1, dur = this.net.demo.dur;
    // the playhead playing across the right edge of a zoomed view: its next page (a view panned elsewhere stays)
    const span = this.view.b - this.view.a, crossed = this.playing && span < dur && this.barT <= this.view.b && this.time > this.view.b;
    this.barT = this.time;
    if (crossed) { this.setView(span, this.time, 0.05); return; }
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    // the campath lane over the kills lane
    const g = cv.getContext("2d")!, X = (t: number) => this.tlX(t, w), R = TL_RULER, mid = R + (h - R) / 2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    this.drawRuler(g, w);
    g.fillStyle = "rgba(255,255,255,.025)"; g.fillRect(0, mid, w, h - mid);
    g.fillStyle = "#2b3036"; g.fillRect(0, mid, w, 1);
    // outside the in / out range dimmed: the whole demo in range shows plain
    g.fillStyle = "rgba(0,0,0,.4)"; g.fillRect(0, R, X(this.inPt), h - R); g.fillRect(X(this.outPt), R, w - X(this.outPt), h - R);
    for (const [t, d] of [[this.inPt, 1], [this.outPt, -1]] as const) { // bracket handles
      const x = Math.round(X(t)) + 0.5;
      g.strokeStyle = "#f0a830"; g.lineWidth = 2; g.beginPath(); g.moveTo(x + 4 * d, R + 1); g.lineTo(x, R + 1); g.lineTo(x, h - 1); g.lineTo(x + 4 * d, h - 1); g.stroke();
    }
    // the recorded ticks, once they are far enough apart to see
    const tick = this.ticks[1] - this.ticks[0];
    if (tick > 0 && (tick / span) * w >= 4) {
      g.fillStyle = "rgba(255,255,255,.28)";
      for (let i = lowerBound(this.ticks, this.view.a); i < this.ticks.length && this.ticks[i] <= this.view.b; i++) g.fillRect(Math.round(X(this.ticks[i])), mid - 2, 1, 4);
    }
    // kills: the killer's team colour, taller for the watched player's, a dot for a headshot, a mark over his deaths
    const team = this.teamOf(), me = this.host.game.observedId;
    for (const k of this.killRecs) {
      if (k.t < this.view.a - 1 || k.t > this.view.b + 1) continue;
      const x = X(k.t), mine = !!me && k.e.killerId === me, tall = mine ? TL_MARK + 4 : TL_MARK;
      g.fillStyle = k.e.killerId ? TEAM_CSS[team.get(k.e.killerId) ?? 2] : TEAM_CSS[2];
      g.globalAlpha = me && !mine && k.e.victimId !== me ? 0.6 : 1;
      g.fillRect(x - 1, h - 2 - tall, 2, tall);
      if (k.e.headshot) { g.fillStyle = "#ffd75a"; g.beginPath(); g.arc(x, h - 4 - tall, 1.8, 0, Math.PI * 2); g.fill(); }
      if (me && k.e.victimId === me) { g.fillStyle = "#fff"; g.beginPath(); g.moveTo(x - 3.5, h - 6 - tall); g.lineTo(x + 3.5, h - 6 - tall); g.lineTo(x, h - 1 - tall); g.fill(); }
      g.globalAlpha = 1;
    }
    if (this.path.keys.length > 1) {
      g.fillStyle = "rgba(90,160,255,.35)"; g.fillRect(X(this.path.start), R + 3, X(this.path.end) - X(this.path.start), 3);
      this.drawSpeed(g, w, h, X);
    }
    this.path.keys.forEach((k, i) => {
      const x = X(k.t), y = (R + mid) / 2;
      g.fillStyle = i === this.sel ? "#fff" : "#5aa0ff";
      g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 5, y); g.lineTo(x, y + 6); g.lineTo(x - 5, y); g.fill();
    });
    if (this.hoverX !== null) { g.fillStyle = "rgba(255,255,255,.35)"; g.fillRect(Math.round(this.hoverX), R, 1, h - R); }
    const px = X(this.time);
    g.fillStyle = "#f0a830"; g.fillRect(px - 1, 0, 2, h);
    g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 6); g.fill(); // the playhead's head, in the ruler
  }

  /** labelled time marks at least TL_LABEL px apart; the strip under them = where the zoomed view sits in the demo */
  private drawRuler(g: CanvasRenderingContext2D, w: number): void {
    const { a, b } = this.view, pps = w / (b - a), dur = this.net.demo.dur;
    const step = RULER_STEPS.find((s) => s * pps >= TL_LABEL) ?? RULER_STEPS[RULER_STEPS.length - 1];
    const minor = step / (step * pps >= 5 * 8 ? 5 : 2);
    g.fillStyle = "#14171a"; g.fillRect(0, 0, w, TL_RULER);
    if (b - a < dur) { g.fillStyle = "rgba(240,168,48,.5)"; g.fillRect((a / dur) * w, TL_RULER - 2, Math.max(2, ((b - a) / dur) * w), 2); }
    g.font = "10px Bahnschrift,Segoe UI,sans-serif"; g.textBaseline = "top";
    for (let i = Math.ceil(a / minor - 1e-9); i * minor <= b + 1e-9; i++) {
      const t = i * minor, x = Math.round((t - a) * pps) + 0.5, major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      g.fillStyle = "#4a5058"; g.fillRect(x, major ? 2 : TL_RULER - 6, 1, major ? TL_RULER - 4 : 3);
      if (major) { g.fillStyle = "#8a929c"; g.fillText(rulerLabel(t, step), x + 4, 4); }
    }
  }

  private drawSpeed(g: CanvasRenderingContext2D, w: number, h: number, X: (t: number) => number): void {
    const a = Math.max(this.path.start, this.view.a), b = Math.min(this.path.end, this.view.b);
    if (b <= a) return;
    const x0 = Math.floor(X(a)), x1 = Math.ceil(X(b)), sig = `${w}|${this.view.a}|${this.view.b}|${JSON.stringify(this.path.keys)}`;
    if (sig !== this.speedSig) {
      this.speedSig = sig;
      this.speedPts = [];
      for (let x = x0; x <= x1; x++) this.speedPts.push(this.path.speed(Math.min(b, Math.max(a, this.tlT(x, w)))));
      this.speedMax = Math.max(...this.speedPts);
    }
    if (this.speedMax <= 1e-6) return;
    const top = TL_RULER + 8, bot = TL_RULER + (h - TL_RULER) / 2 - 1, y = (v: number) => bot - (v / this.speedMax) * (bot - top);
    g.beginPath(); g.moveTo(x0, bot);
    this.speedPts.forEach((v, i) => g.lineTo(x0 + i, y(v)));
    g.lineTo(x0 + this.speedPts.length - 1, bot);
    g.fillStyle = "rgba(90,160,255,.16)"; g.fill();
    g.beginPath(); this.speedPts.forEach((v, i) => (i ? g.lineTo(x0 + i, y(v)) : g.moveTo(x0, y(v))));
    g.strokeStyle = "rgba(120,180,255,.8)"; g.lineWidth = 1; g.stroke();
  }

  private drawSide(): void {
    this.previewLabel();
    for (const b of this.root.querySelectorAll<HTMLElement>("[data-tab]")) b.classList.toggle("on", b.dataset.tab === this.tab);
    this.root.querySelector(".ttl")!.textContent = TABS[this.tab as keyof typeof TABS];
    const body = this.root.querySelector(".body")!, foot = this.root.querySelector(".foot")!;
    // a redraw of the same tab (a click in it) keeps its scroll; another tab starts at the top
    const scroll = this.drawnTab === this.tab ? body.scrollTop : 0;
    this.drawnTab = this.tab;
    foot.innerHTML = ""; // the render tab's, kept in view under its scrolling body
    const o = this.renderOpts;
    const btn = (a: string, t: string, on = false) => `<button data-a="${a}" class="${on ? "on" : ""}">${t}</button>`;
    const head = (t: string) => `<div class="hd">${t}</div>`;
    if (this.tab === "camera") {
      const cur = this.host.game.observedId;
      body.innerHTML = `<div class="row"><label>POV FOV</label><input name="povfov" type="number" min="5" max="140" step="1" placeholder="game" value="${this.povFov ?? ""}" style="width:60px"></div>
        <div class="hint">Players (click to watch, [ / ] to cycle)</div>
        <div class="list">${this.net.roster().map((a) => { const n = this.editsOf(a.id); return `<div class="item ${a.id === cur ? "on" : ""} ${a.id === this.editId ? "editing" : ""}" data-id="${esc(a.id)}"><span class="dot" style="background:${TEAM[a.team ? 1 : 0].color}"></span><span class="who">${esc(a.name)}</span><button class="wr ${n ? "has" : ""}" data-edit="${esc(a.id)}" title="Edit ${esc(a.name)}${n ? ` (${n} change${n > 1 ? "s" : ""})` : ""}">${icon("wrench", 13)}</button></div>`; }).join("")}</div>
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
        ${head("Effects")}${row("Occlusion", slider("aoStrength", 0, 1, 0.05))}
        ${row("AO radius", slider("aoRadius", 0.1, 3, 0.05))}
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
        const info = PASS_INFO[p], head = this.layersOf(p)[0], joined = head !== p, rec = on.includes(this.passOf(p)), eye = this.preview === p;
        const na = povOnly(head) && this.mode !== "pov", below = LAYERS[LAYERS.indexOf(p as never) - 1];
        // between two layers: join this one into the pass under it, or split it off into its own file
        const link = below ? `<button class="link${joined ? " on" : ""}" data-join="${p}" title="${joined ? `In the ${this.passLabel(head)} file · click to split it off` : `Own file · click to join it into ${this.passLabel(below)}`}">${LINK}</button>` : "";
        const what = this.passOf(p) === "default" ? `Every layer in one file: ${PASS_INFO.default.note(alpha).toLowerCase()}` : this.layersOf(p).length > 1 ? `${this.passLabel(head)} in one file` : info.note(alpha);
        return `<div class="pass${rec ? " rec" : ""}${na ? " na" : ""}${joined ? " joined" : ""}" ${na ? "" : `data-pass="${head}"`} title="${na ? "First person (POV) only" : `${what} · ${rec ? "recorded, click to leave it out" : "click to record it"}`}">
            ${link}<span class="recdot"></span>${((s) => (s.startsWith("<") ? `<span class="sw">${s}</span>` : `<span class="sw" style="background:${s}"></span>`))(info.swatch(alpha))}
            <span class="nm"><b>${info.label}</b></span>
            <button class="eye${eye ? " on" : ""}" ${na ? "disabled" : `data-eye="${p}"`} title="${eye ? "Back to the default view" : `Preview ${info.label} alone in the viewport`} (${i + 1})">${EYE}<kbd>${i + 1}</kbd></button></div>`
          + (p === "depth" && (rec || eye) ? `<div class="pass-opt${rec ? " rec" : ""}">Black at <input name="depthrange" type="number" min="1" step="1" value="${o.depthRange}"> m</div>` : "")
          + (p === "hud" && (rec || eye) ? `<div class="pass-opt${rec ? " rec" : ""}" title="100% draws it as the game would at this resolution">Scale <input name="hudscale" type="number" min="25" max="400" step="5" value="${o.hudScale}"> %</div>` : "");
      };
      body.innerHTML = `<div class="row"><label>Resolution</label><input name="w" type="number" min="16" max="7680" step="2" value="${o.w}" style="flex:1;min-width:0"> ×
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
        <button data-a="render" class="go" title="Game time, not real time: 1 s of demo is 1 s of video at any speed" ${on.length && frames ? "" : "disabled"}>${on.length ? `${icon("render", 14)}Render ${on.length} pass${on.length > 1 ? "es" : ""}` : "Pick a pass to render"}</button>`;
    } else {
      const rows: [string, string][] = [["Space", "Play / pause"], ["↑ / ↓", "Faster / slower"], ["← / →", `Skip ${SKIP} s back / forward, stopping at deaths, dolly nodes and in / out points`], ["Ctrl + ← / →", "Pause and step one demo tick (hold to keep stepping)"], ["B / N", "Set in / out point"], ["O", "Loop the in / out range"],
        ["F", "Free camera"], ["F2 / F3", "First / third person"], ["[ / ]", "Previous / next player"], ["W A S D", "Move (free camera)"], ["Q / E", "Down / up"],
        ["Shift / Ctrl", "Faster / slower move"], ["Right mouse", "Look (free camera)"], ["Wheel", "FOV (free, third)"], ["Alt + wheel", "Roll"], ["Middle mouse", "Reset angle / FOV"],
        ["K", "Add dolly node"], ["L", "Clear nodes"], ["J", "Play dolly path"], ["Delete / Backspace", "Remove selected node"], ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo campath edits"],
        ["Click node", "Select it; drag its handles to edit"], ["R", "Move / rotate handles"],
        ["Timeline wheel", "Zoom (Shift: pan; middle drag pans)"], ["Timeline Shift + drag", "Set the in / out range (or drag its brackets)"],
        ["Kill marker", "Click to jump to it; hover for who and how"],
        [`1 – ${PASSES.length}`, "Preview a render pass (again: back to the default view)"], ["H", "Hide this UI"], ["Esc", "Cancel render"]];
      body.innerHTML = `<table class="keys">${rows.map(([k, t]) => `<tr><td>${k}</td><td>${t}</td></tr>`).join("")}</table>`;
    }
    body.scrollTop = scroll;
  }

  /** the bar over the viewport: camera mode, the watched player, the output size it frames */
  private drawSlate(): void {
    for (const b of this.root.querySelectorAll<HTMLElement>(".seg [data-a]")) b.classList.toggle("on", b.dataset.a === this.mode);
    const sel = this.root.querySelector<HTMLSelectElement>('[name="watch"]')!, roster = this.net.roster(), cur = this.host.game.observedId ?? "";
    const names = roster.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
    // rebuilt only when a name changes: a rebuild would close it open
    if (sel.dataset.v !== names) { sel.dataset.v = names; sel.innerHTML = names; }
    if (sel.value !== cur && roster.some((a) => a.id === cur)) sel.value = cur;
    const o = this.renderOpts, spec = `<span>${o.w} × ${o.h}</span><span>${o.fps} fps</span>`, el = this.root.querySelector<HTMLElement>(".spec")!;
    if (el.dataset.v !== spec) { el.dataset.v = spec; el.innerHTML = spec; }
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
    if (this.tab === "camera") this.drawSide(); // the list marks whose editor is open
    if (!id) return;
    this.drawEdit();
    this.placeEdit(x, y);
  }

  /** the editor's top-left at screen x, y, kept inside the window (its left / top are zoomed with it) */
  private placeEdit(x: number, y: number): void {
    const el = this.root.querySelector<HTMLElement>(".edit")!, z = this.uiZoom;
    el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth * z)) / z}px`;
    el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight * z)) / z}px`;
  }

  /** theater edits on that actor: name, model, hat, each weapon swap and each death clip */
  private editsOf(id: string): number {
    const d = this.net.demo;
    return [d.names, d.charas, d.hats].filter((m) => m?.[id] !== undefined).length + Object.keys(d.weapons?.[id] ?? {}).length
      + Object.keys(d.deaths ?? {}).filter((k) => k.startsWith(`${id}@`)).length;
  }

  private drawEdit(): void {
    const id = this.editId, el = this.root.querySelector<HTMLElement>(".edit")!;
    if (!id) return;
    const a = this.host.game.remotes.get(id), anim = a?.charVisual.anim;
    const nm = this.net.nameOf(id), name = nm.name;
    const death = this.net.deathAt(id, this.time), ch = this.net.charaOf(id);
    if ((a?.charVisual.root ?? null) !== this.outlineRoot) this.setOutline(id); // the model was swapped in
    // redrawn only when what it shows changes: a rebuild would close an open dropdown
    const hat = this.net.hatOf(id), worn = actorEquip(id), wEd = this.net.demo.weapons?.[id];
    const sig = `${death?.key}|${death?.clip}|${a?.alive}|${anim?.deathClip}|${ch.chara}|${ch.edited}|${this.charas.length}|${hat?.head}/${hat?.beret}|${this.hats.length}|${worn?.head}/${worn?.beret}|${name}|${JSON.stringify(wEd ?? {})}|${this.weaponList.length}|${this.dofActor === id && this.dof.mode === 3}`;
    if (sig === this.editSig) return;
    this.editSig = sig;
    if (!this.charas.length) void charaChoices().then((c) => { this.charas = c; });
    if (!this.hats.length) void hatChoices().then((h) => { this.hats = h; });
    if (!this.weaponList.length) void weaponChoices().then((w) => { this.weaponList = w.list; this.weaponNames = w.names; }).catch(() => {});
    const rec = ch.edited ? undefined : ch.chara;
    const fld = (label: string, edited: boolean, control: string) => `<label class="fld ${edited ? "ed" : ""}"><span title="${esc(label)}">${esc(label)}</span>${control}</label>`;
    const model = `<select name="chara"><option value="">Recorded${rec ? ` (${esc(this.charas.find((c) => c.itemId === rec)?.label ?? String(rec))})` : ""}</option>
      ${this.charas.map((c) => `<option value="${c.itemId}" ${ch.edited && c.itemId === ch.chara ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select>`;
    const recHat = hat ? undefined : this.hats.find((h) => h.itemId === (worn?.head || worn?.beret));
    const pickedHat = hat && (hat.head || hat.beret);
    const hats = `<select name="hat"><option value="">Recorded${recHat ? ` (${esc(recHat.label)})` : ""}</option>
      <option value="0" ${hat && !pickedHat ? "selected" : ""}>No item (default helmet)</option>
      ${this.hats.map((h) => `<option value="${h.slot}:${h.itemId}" ${pickedHat === h.itemId ? "selected" : ""}>${esc(h.label)}</option>`).join("")}</select>`;
    const groups = [...new Set(this.weaponList.map((w) => w.group))];
    // [RECRIADO] a dirty swap: the new gun plays the recorded fire / reload timing, and the kill feed keeps the recorded gun
    const guns = this.net.weaponsOf(id).map((h) => {
      const to = wEd?.[h.key], listed = to === undefined || this.weaponList.some((w) => w.itemId === to);
      // a saved pick the list folded into its twin still shows, so "Recorded" can undo it
      const kept = listed ? "" : `<option value="${to}" selected>${esc(this.weaponNames.get(to!) ?? String(to))}</option>`;
      return fld(/^\d+$/.test(h.key) ? this.weaponNames.get(+h.key) ?? h.name : h.name, to !== undefined, `<select name="weapon" data-from="${esc(h.key)}"><option value="">Recorded</option>${kept}
      ${groups.map((g) => `<optgroup label="${esc(g)}">${this.weaponList.filter((w) => w.group === g).map((w) => `<option value="${w.itemId}" ${wEd?.[h.key] === w.itemId ? "selected" : ""}>${esc(w.label)}</option>`).join("")}</optgroup>`).join("")}</select>`);
    }).join("");
    let dies: string;
    if (!death || !a || a.alive || !anim) dies = `<div class="hint">Pause on one of this player's deaths to pick its animation.</div>`;
    else {
      const clips = anim.deathClips(), now = anim.deathClip;
      dies = fld(now ? `Playing ${now}` : "Clip", !!death.clip, `<select name="deathclip" data-key="${esc(death.key)}"><option value="">Recorded</option>
        ${clips.map((c) => `<option value="${esc(c)}" ${c === death.clip ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>`);
    }
    const rename = `<input name="pname" maxlength="32" placeholder="${esc(nm.recorded)}" value="${name === nm.recorded ? "" : esc(name)}" title="Shown in the kill feed, HUD and name tags; empty = the recorded name">`;
    const team = TEAM[this.net.roster().find((r) => r.id === id)?.team ? 1 : 0], n = this.editsOf(id);
    const sec = (title: string, html: string) => `<div class="ed-sec"><h6>${title}</h6>${html}</div>`;
    el.style.setProperty("--team", team.color);
    el.innerHTML = `<div class="ed-head" title="Drag to move">
        <div class="ed-id"><b>${esc(name)}</b><span>${team.name} team · ${a?.alive === false ? "dead" : "alive"}${n ? ` · <i>${n} change${n > 1 ? "s" : ""}</i>` : ""}</span></div>
        <button class="ic ${this.dofActor === id && this.dof.mode === 3 ? "on" : ""}" data-a="focusActor" title="Depth of field: keep this player in focus">${icon("focus")}</button>
        <button class="ic" data-a="closeEdit" title="Close">${icon("close")}</button></div>
      ${sec("Identity", fld("Name", name !== nm.recorded, rename))}
      ${sec("Look", fld("Model", ch.edited, model) + fld("Hat", !!hat, hats))}
      ${guns ? sec("Loadout", guns) : ""}
      ${sec("Death", dies)}
      ${n ? `<div class="ed-foot"><span>Changes apply to the whole demo.</span><button data-a="resetActor" title="Back to everything as recorded">${icon("reset", 12)}Reset</button></div>` : ""}`;
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
    renderPbShadows(this.host.renderer, this.host.game.scene, this.host.camera);
    const p = this.rendering ? "default" : this.preview;
    // a pass shows its file (the layers joined into it), the whole frame for the default one; a joined layer, itself alone
    const frame = p === "default" || (this.heads(p) && this.passOf(p) === "default");
    // the page's HUD always in the plain view; in a previewed file only where it holds the HUD. The passes composite their own (previewHud)
    const hudEl = document.getElementById("pbhud");
    if (hudEl && !this.rendering) hudEl.style.opacity = p === "default" || (frame && this.layersOf(p).includes("hud")) ? "" : "0";
    if (frame) { this.drawFrame(dt); return; }
    const f = this.passFrame();
    (this.passes ??= new Passes(this.host.renderer)).show(p, this.heads(p) ? f : { ...f, joined: [] }, () => this.drawFrame(dt));
    renderOnTop(this.host.renderer, [this.pathViz].filter((o) => o.visible), this.host.camera); // the campath stays editable over the preview
  }

  /** the default pass: the frame, through the depth of field when it is on (which also moves the focus) */
  private drawFrame(dt: number): void {
    const d = this.dof, l = this.looks.current, fx = aoOn(l);
    if (!d.mode && !fx) { this.host.render(); return; }
    this.post ??= new Post(this.host.renderer);
    if (d.mode === 3) this.dofZ = this.actorDepth(this.dofTarget()) ?? this.dofZ; // held while the player is gone
    this.post.render(this.host.game.scene, this.host.camera, d.mode ? this.dofParams(dt) : null, [...this.host.camera.children, this.pathViz], fx ? l : null);
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
  /** `hud`: this frame's HUD capture; none given = the last one for the preview, when it shows the HUD */
  private passFrame(hud: THREE.Texture | null = this.previewHud()): PassFrame {
    const cam = this.host.camera;
    const dof: PassFrame["dof"] = this.dof.mode ? (color, depth, target, matte) => this.post?.blur(color, depth, cam, this.dofParams(0), target, matte) : null;
    // the edit outline writes depth: it would show in the depth and normals
    return { scene: this.host.game.scene, camera: cam, players: this.players(), viewmodel: cam.children, editor: [this.pathViz, ...this.outline], depthRange: this.renderOpts.depthRange, alpha: this.alphaFormat(), joined: this.renderOpts.joined, dof, hud: this.mode === "pov" ? hud : null, hudKey: hudKeyNow() };
  }

  private previewHud(): THREE.Texture | null {
    const root = document.getElementById("pbhud");
    if (!root || this.mode !== "pov" || !(this.heads(this.preview) ? this.layersOf(this.preview) : [this.preview]).includes("hud")) return null;
    const size = this.host.renderer.getDrawingBufferSize(new THREE.Vector2());
    return this.hudCap.latest(root, size.x, size.y);
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
    if (this.tab === "camera") this.drawSide(); // the list's edit markers
  }

  /** back to the edits last saved: each one set back through DemoNet, then the seek replays the bodies with them */
  private discard(): void {
    const s = JSON.parse(this.savedEdits) as Pick<Demo, "deaths" | "charas" | "hats" | "names" | "weapons">, d = this.net.demo;
    const keys = (a?: object, b?: object) => new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const k of keys(d.deaths, s.deaths)) this.net.setDeathClip(k, s.deaths?.[k] ?? null);
    for (const id of keys(d.charas, s.charas)) this.net.setChara(id, s.charas?.[id] ?? null);
    for (const id of keys(d.hats, s.hats)) this.net.setHat(id, s.hats?.[id] ?? null);
    for (const id of keys(d.names, s.names)) this.net.setName(id, s.names?.[id] ?? null);
    d.weapons = s.weapons; // DemoNet reads the edits live
    this.setDirty(false);
    this.seek(this.time);
    this.drawSide(); // the player list's names
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
    this.hudCap.dispose();
    for (const k of ["opacity", "inset", "width", "height", "transform-origin", "transform"]) document.getElementById("pbhud")?.style.removeProperty(k);
    this.cancelRender = true;
    this.ac.abort();
    this.slotSeen.disconnect();
    this.root.remove();
    document.body.classList.remove("mvm-on");
    if (this.appStyle === null) this.app.removeAttribute("style"); else this.app.setAttribute("style", this.appStyle);
    this.pathViz.removeFromParent();
    // r169 TransformControls.dispose() calls this.traverse, which a Controls lacks: unhook it and free the helper here
    this.gizmo.disconnect();
    this.gizmo.getHelper().removeFromParent();
    this.gizmo.getHelper().traverse((o) => { (o as THREE.Mesh).geometry?.dispose(); ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose(); });
    disposeViz(this.pathViz);
    for (const m of this.labelMats.values()) { m.map?.dispose(); m.dispose(); }
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

/** a ruler label: m:ss, with the fraction a step under a second needs */
function rulerLabel(t: number, step: number): string {
  const m = Math.floor(t / 60 + 1e-9), sec = t - m * 60, d = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return `${m}:${sec.toFixed(d).padStart(d ? 3 + d : 2, "0")}`;
}

/** the first index whose value is >= v */
function lowerBound(list: readonly number[], v: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < v) lo = m + 1; else hi = m; }
  return lo;
}
