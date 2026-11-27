import * as THREE from "three";
import { disposeTree, loadSky } from "../realLevel";
import { configurePbRenderer, pbUniforms as U } from "../render/pbLighting";
import { DEMO_API } from "./demo";
import { LOOK_FX_DEFAULT, type LookFxParams } from "./lookFx";

/** colours "#rrggbb" in the engine's gamma space, strengths multiply them, angles in degrees */
export interface Look extends LookFxParams {
  sunAzimuth: number; sunElevation: number; sunColor: string; sunStrength: number;
  ambientColor: string; ambientStrength: number;
  /** baked light: lit (mostly sun) / shaded parts of the lightmap */
  worldLitColor: string; worldLit: number; worldShadeColor: string; worldShade: number;
  /** D3DFOGMODE: 0 off, 1 EXP, 2 EXP2, 3 LINEAR */
  fogMode: number; fogColor: string; fogNear: number; fogFar: number; fogDensity: number;
  /** "" = the map's own, "none", or another map's id */
  sky: string; skyColor: string; skyStrength: number;
  background: string;
}

type V3 = [number, number, number];
const HEX = /^#[0-9a-f]{6}$/i;
const round = (v: number, k = 1000) => Math.round(v * k) / k;
const hex = (v: V3) => "#" + v.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("");
const rgb = (h: string): V3 => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as V3;
/** engine colours go past 1: shown as a colour and a strength */
function split(v: V3): [string, number] {
  const s = Math.max(...v);
  return s > 0 ? [hex(v.map((x) => x / s) as V3), round(s)] : ["#ffffff", 0];
}
const scaled = (h: string, s: number): V3 => rgb(h).map((x) => x * s) as V3;

/** [RECRIADO] theater look over the map's engine lighting, sky and clear colour; dispose puts the map's own values back */
export class LookStage {
  readonly base: Look;
  private look: Look;
  private readonly ownSky: THREE.Object3D | null;
  private readonly skies = new Map<string, Promise<THREE.Object3D | null>>();
  private readonly loaded: THREE.Object3D[] = [];
  private shown: THREE.Object3D | null;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, private readonly renderer: THREE.WebGLRenderer) {
    this.ownSky = this.shown = scene.getObjectByName("pbSky") ?? null;
    const d = U.pbLightDir.value.clone().normalize(), l = U.pbLightDiffuse.value, a = U.pbAmbient.value;
    const f = U.pbFogParams.value, fc = U.pbFogColor.value;
    const [sunColor, sunStrength] = split([l.x, l.y, l.z]), [ambientColor, ambientStrength] = split([a.x, a.y, a.z]);
    const li = U.pbLuxLit.value, sh = U.pbLuxShade.value;
    const [worldLitColor, worldLit] = split([li.x, li.y, li.z]), [worldShadeColor, worldShade] = split([sh.x, sh.y, sh.z]);
    const bg = scene.background instanceof THREE.Color ? "#" + scene.background.getHexString() : "#000000";
    this.base = {
      sunAzimuth: round(THREE.MathUtils.radToDeg(Math.atan2(d.x, d.z)), 10), sunElevation: round(THREE.MathUtils.radToDeg(Math.asin(d.y)), 10),
      sunColor, sunStrength, ambientColor, ambientStrength, worldLitColor, worldLit, worldShadeColor, worldShade,
      fogMode: U.pbFogMode.value, fogColor: hex([fc.x, fc.y, fc.z]), fogNear: f.x, fogFar: f.y, fogDensity: f.z,
      sky: "", skyColor: "#ffffff", skyStrength: 1, background: bg, ...LOOK_FX_DEFAULT,
    };
    this.look = { ...this.base };
  }

  get current(): Look { return { ...this.look }; }

  set(change: Partial<Look>): void {
    const k = this.look = { ...this.look, ...change };
    const az = THREE.MathUtils.degToRad(k.sunAzimuth), el = THREE.MathUtils.degToRad(k.sunElevation);
    U.pbLightDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    const w = U.pbLightDiffuse.value.w; // alpha of the world / chara output, not a colour
    U.pbLightDiffuse.value.set(...scaled(k.sunColor, k.sunStrength), w);
    U.pbAmbient.value.set(...scaled(k.ambientColor, k.ambientStrength));
    U.pbLuxLit.value.set(...scaled(k.worldLitColor, k.worldLit));
    U.pbLuxShade.value.set(...scaled(k.worldShadeColor, k.worldShade));
    U.pbFogMode.value = k.fogMode;
    U.pbFogColor.value.set(...rgb(k.fogColor));
    U.pbFogParams.value.set(k.fogNear, k.fogFar, k.fogDensity);
    configurePbRenderer(this.renderer, this.scene);
    if (this.scene.background instanceof THREE.Color) this.scene.background.set(k.background);
    void this.showSky(k.sky);
  }

  private async showSky(id: string): Promise<void> {
    let sky = id === "none" ? null : this.ownSky;
    if (id && id !== "none") {
      if (!this.skies.has(id)) this.skies.set(id, loadSky(`/assets/maps/${id}/sky/sky.glb`).then((s) => this.adopt(s)));
      sky = await this.skies.get(id)!;
      if (this.look.sky !== id || this.disposed) return; // another pick meanwhile
    }
    for (const s of [this.ownSky, ...this.loaded]) if (s) s.visible = s === sky;
    this.shown = sky;
    sky?.traverse((o) => { if (o instanceof THREE.Mesh) (o.material as THREE.MeshBasicMaterial).color.set(this.look.skyColor).multiplyScalar(this.look.skyStrength); });
  }

  /** another map's sky, moved so its centre sits on this map's sky ([INFERIDO] each sky box is exported around its own map) */
  private adopt(s: THREE.Object3D | null): THREE.Object3D | null {
    if (!s) return null;
    if (this.disposed) { disposeTree(s); return null; }
    if (this.ownSky) {
      const box = new THREE.Box3();
      s.position.add(box.setFromObject(this.ownSky).getCenter(new THREE.Vector3()).sub(box.setFromObject(s).getCenter(new THREE.Vector3())));
    }
    s.visible = false;
    (this.ownSky?.parent ?? this.scene).add(s);
    this.loaded.push(s);
    return s;
  }

  /** the map's own values back; the other maps' skies freed */
  dispose(): void {
    this.set(this.base);
    this.disposed = true;
    for (const s of this.loaded) { s.removeFromParent(); disposeTree(s); }
  }
}

export async function listLooks(): Promise<string[]> {
  const r = await fetch(`${DEMO_API}/looks`);
  if (!r.ok) throw new Error(`look list ${r.status}`);
  return ((await r.json()) as { name: string }[]).map((x) => x.name.replace(/\.json$/, ""));
}

export async function listSkies(): Promise<string[]> {
  const r = await fetch(`${DEMO_API}/skies`);
  return r.ok ? (r.json() as Promise<string[]>) : [];
}

const lookUrl = (name: string) => `${DEMO_API}/looks/${encodeURIComponent(name)}.json`;

/** a file from disk: only the keys this version knows, with the right type; the rest keeps `base` */
export async function readLook(name: string, base: Look): Promise<Look> {
  const r = await fetch(lookUrl(name));
  if (!r.ok) throw new Error(`look load ${r.status}`);
  const j = (await r.json()) as Record<string, unknown>, out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(base)) {
    const x = j?.[k];
    const ok = typeof x === "number" ? Number.isFinite(x) : typeof x === "string" && (k === "sky" ? /^[\w-]*$/.test(x) : HEX.test(x));
    if (ok && typeof x === typeof v) out[k] = x;
  }
  return out as unknown as Look;
}

export async function writeLook(name: string, l: Look): Promise<void> {
  const r = await fetch(lookUrl(name), { method: "PUT", body: JSON.stringify(l, null, 1) });
  if (!r.ok) throw new Error(`look save ${r.status}`);
}

export async function deleteLook(name: string): Promise<boolean> {
  return (await fetch(lookUrl(name), { method: "DELETE" })).ok;
}
