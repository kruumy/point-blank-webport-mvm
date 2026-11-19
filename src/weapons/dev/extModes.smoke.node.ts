// Node smoke: RMB extensions DirectMelee (M1887 106005), DualMag (AK-47 DualMag 103002), CrossFire (HK45 Dual 214007) and
// GrenadeLauncher (K201 103011) on the real WeaponSystem.
//   npx esbuild src/weapons/dev/extModes.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/em.mjs && node <tmp>/em.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem } from "../WeaponSystem";
import { setFxTextureLoader } from "../effects";
import { setWeaponFx } from "../sights";

const any: any = new Proxy(function () {}, { get: () => any, apply: () => any, construct: () => any });
const g = globalThis as any;
g.document = any;
g.window = any;
g.AudioContext = any;
const PUB = path.resolve("public");
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(PUB, rel), "utf8"));
g.fetch = async (req: string | { url: string }) => {
  const url = (typeof req === "string" ? req : req.url).replace(/^http:\/\/local/, "");
  const p = path.join(PUB, decodeURIComponent(url.replace(/^\//, "")));
  if (!fs.existsSync(p)) return { ok: false, status: 404, headers: { get: () => "" }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  const buf = fs.readFileSync(p);
  return { ok: true, status: 200, headers: { get: () => (p.endsWith(".json") ? "application/json" : "") },
    json: async () => JSON.parse(buf.toString("utf8")), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
};

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

(async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(60, 0.1, 60).setTranslation(0, -0.1, 0));
  world.step();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  camera.position.set(0, 1.6, 0);
  scene.add(camera);
  camera.updateMatrixWorld();
  setFxTextureLoader(() => new THREE.Texture());
  setWeaponFx(readJson("assets/weapons/fx/weaponfx.json"), "/assets/weapons/fx");
  const ws = new WeaponSystem({
    scene, camera, world, RAPIER, viewmodel: false, audioListener: any, loadout: {}, resolveTarget: () => null,
    applyLook: () => {},
  });
  await ws.ready;
  const W = ws as any;
  const dt = 1 / 60;
  const frame = (inp: Record<string, unknown> = {}) => { camera.updateMatrixWorld(); ws.update(dt, { fire: false, aim: false, ...inp } as any); };
  const idle = (n: number) => { for (let i = 0; i < n; i++) frame(); };
  const hold = (secs: number) => idle(Math.round(secs / dt));
  const slot = () => W.slots[W.cur];
  W.audio.playAt = () => {};
  W.audio.play = () => {};
  W.audio.fire = () => {};
  for (const k of ["hitAt", "knifeHit", "zoom", "playReload", "silencerAt", "breath"]) W.audio[k] = () => {};
  const equip = (primary: number, secondary = 202022) => {
    ws.setLoadout({ primary, secondary, melee: 301001, grenade: 407001 });
    ws.refill();
    frame({ slot: primary === secondary ? 1 : 0 });
    hold(1.5);
  };

  // ---- DirectMelee: M1887 stock blow ------------------------------------------------------------------
  {
    const def = ws.db.def(106005)!;
    check("M1887 ext data: DirectMelee 126 dmg, 0.3666 s, 1.5 m",
      def.params.ext?.type === "DirectMelee" && def.params.ext.meleeDamage === 126 && def.params.ext.meleeTime === 0.3666 && def.params.ext.range === 1.5);
    equip(106005);
    const blows: { t: number; blow: unknown }[] = [];
    const orig = W.meleeHit.bind(W);
    W.meleeHit = (d: unknown, heavy: boolean, second: boolean, blow: unknown) => { blows.push({ t: W.time, blow }); return orig(d, heavy, second, blow); };
    const t0 = W.time;
    frame({ aim: true });
    hold(0.3);
    check("no hit before ExtensionAttackTime", blows.length === 0);
    hold(0.2);
    const b = blows[0] as { t: number; blow: { damage: number; range: number } } | undefined;
    check("one blow at ~0.367 s with 126 dmg, 1.5 m", blows.length === 1 && Math.abs(b!.t - t0 - 0.3666) < 0.05 && b!.blow.damage === 126 && b!.blow.range === 1.5,
      b ? `t=${(b.t - t0).toFixed(3)} ${JSON.stringify(b.blow)}` : "none");
    const ammo = slot().ammo;
    frame({ fire: true }); frame();
    check("cannot fire during the blow", slot().ammo === ammo);
    hold(1);
    frame({ fire: true }); frame();
    check("fires again after the blow", slot().ammo === ammo - 1, `${ammo} -> ${slot().ammo}`);
    check("zoom stays off (RMB is the blow)", !W.zoomOn);
    W.meleeHit = orig;
  }

  // ---- DualMag: AK-47 DualMag flip / full reload -----------------------------------------------------
  {
    equip(103002);
    const s = slot();
    check("AK-47 DualMag spawns with two full magazines", s.ammo === 30 && s.mag2 === 30 && !s.magR, `${s.ammo}/${s.mag2}`);
    s.ammo = 5;
    const r0 = s.reserve;
    frame({ reload: true }); frame();
    hold(1.1);
    check("flip not done before ReloadTimeDual (1.2 s)", s.ammo === 5);
    hold(0.2);
    check("flip: taped magazine in (30), old one taped (5), no reserve used", s.ammo === 30 && s.mag2 === 5 && s.magR && s.reserve === r0,
      `${s.ammo}/${s.mag2} r${s.reserve}`);
    s.ammo = 10;
    frame({ reload: true }); frame();
    check("second R = full reload (normal reload state)", W.reloading);
    hold(2.7);
    check("full reload refills both magazines from the reserve", s.ammo === 30 && s.mag2 === 30 && !s.magR && s.reserve === r0 - 20 - 25,
      `${s.ammo}/${s.mag2} r${s.reserve} (want ${r0 - 45})`);
    s.ammo = 1;
    frame({ fire: true }); hold(0.2); frame({ fire: true }); frame();
    check("empty magazine + loaded taped one: the dry pull flips", !!s.magR, `${s.ammo}/${s.mag2}`);
    hold(1.5);
    // a flip cut by a weapon swap never swapped: the first magazine stays in, and zoom is ignored meanwhile
    frame({ reload: true }); frame();
    s.ammo = 4; s.mag2 = 20; s.magR = false;
    frame({ reload: true }); frame();
    frame({ aim: true }); frame();
    check("no zoom during the flip", !W.zoomOn);
    frame({ slot: 1 }); hold(1.5);
    check("swap mid-flip: no swap, first magazine still in", s.ammo === 4 && s.mag2 === 20 && !s.magR, `${s.ammo}/${s.mag2} magR ${s.magR}`);
    frame({ slot: 0 }); hold(1.5);
    // drop / pickup carries the taped magazine as the drop's extra rounds
    const d = ws.dropCurrent(true)!;
    check("drop carries the taped magazine (extra)", d.extra === 20, `extra ${d.extra}`);
    ws.pickUp(d.def.id, d.ammo, d.reserve, d.extra);
    const p = W.slots[0];
    check("pickup restores both magazines", p.ammo === 4 && p.mag2 === 20 && !p.magR, `${p.ammo}/${p.mag2}`);
    // dropped after its flip (taped magazine in): no flip left, the other magazine's rounds ride in the reserve
    p.ammo = 12; p.mag2 = 7; p.magR = true;
    const r1 = p.reserve;
    const d2 = ws.dropCurrent(true)!;
    check("flipped DualMag drop: extra 0, the used magazine goes to the reserve", d2.extra === 0 && d2.reserve === r1 + 7, `extra ${d2.extra} reserve ${r1}->${d2.reserve}`);
    ws.pickUp(d2.def.id, d2.ammo, d2.reserve, d2.extra);
    check("picked up: R is the full reload, not a flip", !W.canFlip(W.slots[0]) && W.canReload(W.slots[0]));
  }

  // ---- Silencer: MK23 keeps its silencer across a weapon swap ------------------------------------------------
  {
    equip(103004, 202002);
    frame({ slot: 1 }); hold(1.5);
    frame({ aim: true }); frame(); hold(2.5);
    check("RMB puts the MK23 silencer on", !!slot().ext);
    frame({ slot: 0 }); hold(1.5);
    frame({ slot: 1 }); hold(1.5);
    check("the silencer stays on through a swap", !!slot().ext);
  }

  // ---- CrossFire: HK45 Dual -------------------------------------------------------------------------------
  {
    const def = ws.db.def(214007)!;
    check("HK45 Dual ext data: CrossFire 41 dmg, 0.65 s", def.params.ext?.type === "CrossFire" && def.params.ext.damage === 41 && def.params.ext.fireDelay === 0.65);
    equip(214007, 214007);
    const s = slot();
    const bases: number[] = [];
    const tb = W.traceBullet.bind(W);
    W.traceBullet = (d: unknown, o: unknown, dir: unknown, base: number) => { bases.push(base); return tb(d, o, dir, base); };
    const clicks = (secs: number) => { const a = s.ammo; for (let i = 0; i < Math.round(secs / dt); i++) frame({ fire: i % 2 === 0 }); return a - s.ammo; };
    const normal = clicks(2);
    frame({ aim: true });
    check("RMB crosses the arms (ext on), no zoom", !!s.ext && !W.zoomOn);
    hold(2.1);
    bases.length = 0;
    const crossed = clicks(2);
    check("crossed: Ext_FireDelay 0.65 s, 2 rounds a pull", crossed >= 6 && crossed <= 8 && normal >= 6, `normal ${normal}, crossed ${crossed} rounds`);
    check("crossed shots use Ext_Damage 41", bases.length > 0 && bases.every((b) => b === 41), bases.join(","));
    const a0 = s.ammo;
    bases.length = 0;
    hold(1);
    frame({ fire: true }); frame();
    check("a crossed pull fires both guns: 2 bullets, 2 rounds (0x644ee0)", bases.length === 2 && a0 - s.ammo === 2, `${bases.length} bullets, ${a0 - s.ammo} rounds`);
    hold(1);
    s.ammo = 1; bases.length = 0;
    frame({ fire: true }); frame();
    check("1 round left: only the left gun fires", bases.length === 1 && s.ammo === 0, `${bases.length} bullets`);
    s.ammo = 10; // part-empty: the reload below is allowed
    hold(1);
    frame({ reload: true }); frame();
    check("reload keeps the crossed arms (CrossIdle LoadMagazine = Ext_Reload)", !!s.ext && W.reloading);
    hold(3.5);
    W.traceBullet = tb;
  }

  // ---- GrenadeLauncher: K201 ---------------------------------------------------------------------------------
  {
    equip(103011);
    const s = slot();
    check("K201 spawns with 1 shell", s.shells === 1, `${s.shells}`);
    frame({ aim: true });
    check("RMB raises the launcher", !!s.ext);
    hold(2.1);
    const ammo = s.ammo;
    frame({ fire: true }); frame();
    const live = W.grenades.live as { weapon: { id: number }; sticky: boolean }[];
    check("LMB launches the K201 shell (411015), not a bullet", s.shells === 0 && s.ammo === ammo && live.some((x) => x.weapon.id === 411015 && x.sticky),
      `shells ${s.shells} ammo ${ammo}->${s.ammo} live ${live.map((x) => x.weapon.id)}`);
    let gone = false;
    for (let i = 0; i < 240 && !gone; i++) { frame(); gone = !live.some((x) => x.weapon.id === 411015); }
    check("the shell goes off on contact", gone);
    hold(0.6);
    frame({ fire: true }); frame();
    check("no shell left: LMB lowers the launcher", !s.ext);
    hold(2.1);
    frame({ fire: true }); frame();
    check("rifle fires again", s.ammo === ammo - 1, `${ammo} -> ${s.ammo}`);
    const d = ws.dropCurrent(true)!;
    ws.pickUp(d.def.id, d.ammo, d.reserve, d.extra);
    check("a spent launcher stays spent through drop / pickup", d.extra === 0 && W.slots[0].shells === 0, `extra ${d.extra} shells ${W.slots[0].shells}`);
  }

  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
