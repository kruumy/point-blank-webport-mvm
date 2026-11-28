import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { lockPointer } from "./lockPointer.ts";
import { Game, type GameDeps } from "./game/game";
import { Input } from "./game/input";
import { buildTestLevel } from "./testLevel";
import { buildRealLevel } from "./realLevel";
import { setCompressedTextureSupport } from "./render/compressedTex";
import { assetExists } from "./assetProbe";
import { PB_KEYS } from "./game/keymap";
import { AssetPaths, CurrentMap, MAP_LABELS, setCurrentMap, type MapId } from "./config";
import type { LevelBuildResult } from "./testLevel";
import { setBattleProgress } from "./game/battleLoading";
import { clearPbPointLights, configurePbRenderer, pbLighting } from "./render/pbLighting";
import { acquireRenderer, memSnap, releaseMatch, rendererStats } from "./render/sharedRenderer";
import { levelCacheStats } from "./levelCache";
import { brightnessFactor, getSettings, onSettings, pixelRatioFor, setSettingsOverride, type GameSettings } from "./gameplay/settings";
import { preloadMatch, type MatchSet } from "./game/matchPreload";
import { warmScene } from "./render/warmup";
import { renderWithViewmodel } from "./render/onTop";
import { disposePbShadows, renderPbShadows } from "./render/pbShadow";
import { TEST_EQUIPPED } from "./game/testLoadout";
import { BOT_WEAPON } from "./game/weaponAdapter";
import { DemoRecorder } from "./mvm/demo";
import type { DemoNet } from "./mvm/demoNet";
import { THEATER_GRAPHICS, Theater } from "./mvm/theater";
import { FX_LAYER } from "./render/layers";

export interface StartGameOptions extends Pick<GameDeps, "net" | "localTeam" | "localName" | "localRank" | "match" | "onMatchEnd" | "respawnInventory" | "firstLoadout" | "localChara" | "itemEffects" | "botCount" | "botSkill" | "botAllies" | "missions" | "missionPanel" | "clanMatch" | "stageType" | "room"> {
  /** Client map to load (default: ?map= / nstation). */
  map?: MapId;
  /** Net mode: "Sair da partida" button on the pause overlay. */
  onLeave?: (reason?: "away") => void;
  /** [RECRIADO] movie theater: play this demo instead of a match (onLeave = the theater's Exit) */
  theater?: DemoNet;
}

export interface GameHandle {
  game: Game;
  /** Stops the loop and removes the canvas/HUD/listeners (the NetAdapter is left to its owner). */
  stop(): void;
}

/** NOT ORIGINAL: Vídeo > "Escala de renderização" (settings.ts pixelRatioFor), clamped to the GL's max renderbuffer */
const renderRatio = (r: THREE.WebGLRenderer, s: GameSettings): number => {
  const gl = r.getContext();
  return pixelRatioFor(s, window.devicePixelRatio, Math.max(window.innerWidth, window.innerHeight), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
};

/** [RECRIADO] Resolução dinâmica: fractions of the chosen render ratio (the last = the ceiling) and the refresh rates (Hz, ascending) the period is snapped to */
const DYN_STEPS = [0.7, 0.8, 0.9, 1];
const DYN_REFRESH = [30, 48, 60, 75, 90, 120, 144, 165, 240];

/** Boots renderer + physics + level + Game. Local (bots) when `net` is omitted. */
/** perf probe (open the game with ?perf): every 2 s logs the mean ms of game.update / world.step / renderer.render (CPU submit) and the bots loop inside update */
const PERF = typeof location !== "undefined" && new URLSearchParams(location.search).has("perf");
let perfN = 0, perfU = 0, perfS = 0, perfR = 0, perfAt = 0;
function perfTick(u: number, s: number, r: number): void {
  if (!PERF) return;
  perfN++; perfU += u; perfS += s; perfR += r;
  const now = performance.now();
  if (now - perfAt < 2000) return;
  const b = (globalThis as { __pbPerfBots?: Record<string, number> }).__pbPerfBots;
  const f = (x: number) => (x / perfN).toFixed(2);
  const parts = b ? Object.entries(b).map(([k, v]) => `${k} ${f(v)}`).join(" ") : "-";
  console.info(`[perf] ${perfN} frames: update ${f(perfU)} [${parts}] · step ${f(perfS)} · render ${f(perfR)} ms`);
  if (b) for (const k of Object.keys(b)) b[k] = 0;
  perfN = perfU = perfS = perfR = 0;
  perfAt = now;
}

/** Everything of a match that does not need the net: renderer, physics world, level, the match assets and the warm-up. */
interface Prepared {
  map: MapId;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: RAPIER.World;
  level: LevelBuildResult;
  levelName: string;
  debugGroup: THREE.Group;
}

/** the room battle's prepare (prepareGame), taken by its startGame */
let pending: { map: MapId; p: Promise<Prepared> } | null = null;

/**
 * Room battle, between LOADING_START and PRESTARTBATTLE (ui/roomScreen.ts -> game/battlePrep.ts -> boot.ts): builds the
 * map, the renderer and the match set's assets now, behind the loading curtain. The startGame after STARTBATTLE +
 * RESPAWN takes it and only wires the net, the Game and the loop: the match no longer runs on the server while the
 * client downloads it.
 */
export function prepareGame(map: MapId, set: MatchSet, bots = false): Promise<void> {
  discardPrepared();
  const p = prepare(map, bots ? { ...set, weapons: [...set.weapons, BOT_WEAPON.id] } : set);
  pending = { map, p };
  return p.then(() => undefined);
}

/** The battle did not start after a prepareGame: free what its scene put on the GPU (the renderer is shared, render/sharedRenderer.ts) and its physics world. */
export function discardPrepared(): void {
  const p = pending;
  pending = null;
  void p?.p.then((x) => {
    releaseMatch(x.renderer, [x.scene, x.camera], "discarded prepare");
    x.world.free();
  }, () => {});
}

/** Match set of a startGame without a room prepare (offline ?play / Treino com bots): the local loadout, the bots' K-2, the local character. */
function localMatchSet(opts: StartGameOptions): MatchSet {
  const e: Partial<Record<keyof typeof TEST_EQUIPPED, number>> = opts.firstLoadout ?? opts.respawnInventory?.equipped ?? TEST_EQUIPPED;
  const team = opts.localTeam ?? (new URLSearchParams(location.search).get("team")?.toLowerCase().startsWith("b") ? 1 : 0); // as Game's constructor
  const weapons = [e.primary, e.secondary, e.melee, e.grenade, e.special].filter((id): id is number => !!id && id > 0);
  return { weapons: [...weapons, BOT_WEAPON.id], charas: [{ itemId: opts.localChara, team }], local: { chara: opts.localChara, team, weapons }, bomb: opts.match?.mode === "BOMB" };
}

async function prepare(map: MapId | undefined, set: MatchSet): Promise<Prepared> {
  if (map) setCurrentMap(map);
  await RAPIER.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111318); // [NÃO CONFIRMADO] DX clear colour; behind the sky (realLevel loadSky), and all there is on indoor maps

  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.05,
    500
  );
  camera.layers.enable(FX_LAYER);

  const renderer = acquireRenderer(); // one renderer / GL context for the session: the level's GPU data survives the rematch
  // NOT ORIGINAL: default DPR cap 1.5; Vídeo > "Escala de renderização" 70%..200% (settings.ts pixelRatioFor), clamped to the GL's max renderbuffer
  renderer.setPixelRatio(renderRatio(renderer, getSettings()));
  setCompressedTextureSupport(renderer);
  renderer.setSize(window.innerWidth, window.innerHeight);
  // DX9 pipeline: no tone mapping, gamma-space maths. The PB ShaderMaterials (src/render/pbLighting.ts) read their
  // textures raw and write raw values, so the sRGB output setting only affects the three.js materials left unported.
  // PB's shadow map (EnvSet Shadow_Quality_Type) is the port's own pass (render/pbShadow.ts), not three.js shadows.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const gravity = { x: 0.0, y: -9.81, z: 0.0 };
  const world = new RAPIER.World(gravity);

  setBattleProgress(0.05); // real milestones of the load drive the loading screen's bar (game/battleLoading.ts)
  const [hasVisual, hasCollision] = await Promise.all([
    assetExists(AssetPaths.visualGlb),
    assetExists(AssetPaths.collisionGlb),
  ]);

  let level: LevelBuildResult;
  let levelName: string;

  if (hasCollision) {
    try {
      level = await buildRealLevel(world, RAPIER, hasVisual);
      levelName = `${MAP_LABELS[CurrentMap]} (${hasVisual ? "real assets" : "collision only"})`;
    } catch (err) {
      console.error("Failed to load real level, falling back to test level", err);
      level = buildTestLevel(world, RAPIER);
      levelName = "Test level (fallback, load error)";
    }
  } else {
    level = buildTestLevel(world, RAPIER);
    levelName = "Test level (placeholder)";
  }

  setBattleProgress(0.6); // the map is the bulk of the download
  level.visualGroup.matrixAutoUpdate = false; // static: nothing moves/rotates/scales the group (children keep their own updates)
  level.visualGroup.updateMatrix();
  scene.add(level.visualGroup);
  configurePbRenderer(renderer, scene); // fog of the i3World (lighting.json), after buildRealLevel loaded it
  const camFar = pbLighting()?.camFar;
  if (camFar) {
    camera.far = camFar; // Stage.pef CamFar
    camera.updateProjectionMatrix();
  }

  const debugGroup = new THREE.Group();
  debugGroup.visible = false;
  for (const mesh of level.colliderMeshes) {
    debugGroup.add(mesh);
  }
  scene.add(debugGroup);

  // the match set's sounds / models / textures, then every program the map and the set need, before the first frame
  const warm = await preloadMatch(set).catch((e) => { console.warn("[preload]", e); return null; });
  setBattleProgress(0.85); // match assets (models, sounds) in
  await warmScene(renderer, scene, camera, warm?.objects).catch((e) => console.warn("[warmup]", e));
  warm?.dispose();
  setBattleProgress(0.9); // shaders compiled; the room handshake (roomScreen) takes it on
  return { map: CurrentMap, renderer, scene, camera, world, level, levelName, debugGroup };
}

export async function startGame(opts: StartGameOptions = {}): Promise<GameHandle> {
  if (opts.theater) setSettingsOverride(THEATER_GRAPHICS); // before prepare's renderer: its antialias is read at creation
  // a room battle takes its prepareGame (same map); anything else prepares here
  let prepP: Promise<Prepared>;
  if (opts.net && pending && pending.map === (opts.map ?? CurrentMap)) {
    prepP = pending.p;
    pending = null;
  } else {
    discardPrepared();
    prepP = prepare(opts.map, localMatchSet(opts));
  }
  const { map, renderer, scene, camera, world, level, levelName, debugGroup } = await prepP;
  const ac = new AbortController();
  const signal = ac.signal;

  const app = document.getElementById("app")!;
  const blocker = document.getElementById("blocker")!;

  app.appendChild(renderer.domElement);
  // the window may have changed since the prepare
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // lobby Configuração "Brilho" (gameplay/settings.ts, 50 = unchanged)
  // [RECRIADO] Resolução dinâmica: dynLevel indexes DYN_STEPS (1 = the chosen renderScale, the ceiling); see dynTick
  let dynLevel = DYN_STEPS.length - 1;
  const applyRes = (s: GameSettings) => {
    if (!s.dynamicRes) dynLevel = DYN_STEPS.length - 1;
    renderer.setPixelRatio(renderRatio(renderer, s) * DYN_STEPS[dynLevel]);
    renderer.setSize(app.clientWidth, app.clientHeight); // the window, or the theater's viewport
  };
  let dynN = 0, dynSum = 0, dynCpuSum = 0, dynGood = 0, dynHold = 5, dynLastUp = 0, dynFloorMs = Infinity;
  /** every ~1 s: mean frame time vs the monitor's refresh period (estimated from the best window seen, snapped to common rates);
   *  over by 15% = one step down, under by 5% for dynHold windows = one step up (hold doubles when a step up is undone within 10 s).
   *  No step down when CPU-bound: JS (update + world.step + render submit) >= 70% of the frame means a lower resolution won't gain FPS */
  const dynTick = (raw: number, cpu: number): void => {
    const s = getSettings();
    if (!s.dynamicRes || document.hidden || raw > 0.25) { dynN = dynSum = dynCpuSum = 0; return; } // hitch (tab switch, load): not a measure
    dynN++; dynSum += raw * 1000; dynCpuSum += cpu;
    if (dynSum < 1000) return;
    const avg = dynSum / dynN;
    const cpuAvg = dynCpuSum / dynN;
    dynN = dynSum = dynCpuSum = 0;
    dynFloorMs = Math.min(dynFloorMs, avg);
    const target = 1000 / (DYN_REFRESH.find((hz) => 1000 / hz <= dynFloorMs * 1.05) ?? 240);
    if (avg > target * 1.15) {
      dynGood = 0;
      if (dynLevel > 0 && cpuAvg < avg * 0.7) {
        // GPU-bound: only then a lower scale helps
        if (performance.now() - dynLastUp < 10000) dynHold = Math.min(dynHold * 2, 60);
        dynLevel--; applyRes(s);
      }
    } else if (avg < target * 1.05 && dynLevel < DYN_STEPS.length - 1 && ++dynGood >= dynHold) {
      dynGood = 0; dynLevel++; dynLastUp = performance.now(); applyRes(s);
    }
  };
  const unsubRes = onSettings(applyRes);
  const unsubBrightness = onSettings((s) => { renderer.domElement.style.filter = s.brightness === 50 ? "" : `brightness(${brightnessFactor(s)})`; });

  // declared before the listener: a resize while the match loads must not hit it uninitialised
  let theater: Theater | null = null;
  window.addEventListener("resize", () => {
    if (theater) return; // it fits the canvas to its viewport (theater.ts layout)
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }, { signal });

  const row = (k: string, t: string) => `<div class="ov-row"><span class="ov-key">${k}</span><span>${t}</span></div>`;
  const kn = (a: keyof typeof PB_KEYS) => PB_KEYS[a][0].replace(/^(Key|Digit)/, "").replace(/(Left|Right)$/, "").replace("Control", "Ctrl");
  blocker.innerHTML =
    `<div class="ov-panel"><div class="ov-logo"><img src="/assets/ui/cross/brand/logo.png" alt="Project Blackout" draggable="false"></div>` +
    `<div class="ov-meta"><span>${MAP_LABELS[map]}</span><span class="ov-sep">·</span><span>${opts.match?.mode === "BOMB" ? "Bomb Mission" : "Deathmatch"}</span></div>` +
    `<button class="ov-play" type="button">Click to play</button><div class="ov-controls">` +
    `<div class="ov-group"><h3>Movement</h3>${row("WASD", "Move")}${row(kn("walk"), "Walk (silent)")}${row(kn("crouch"), "Crouch")}${row(kn("jump"), "Jump")}</div>` +
    `<div class="ov-group"><h3>Combat</h3>${row("L. mouse", "Fire")}${row("R. mouse", "Aim")}${row(kn("reload"), "Reload")}${row(kn("drop"), "Drop weapon")}</div>` +
    `<div class="ov-group"><h3>Weapons</h3>${row("1-5", "Select")}${row("Wheel", "Switch")}${row(kn("lastWeapon"), "Last weapon")}${row(kn("extension"), "Extension (laser)")}</div>` +
    `<div class="ov-group"><h3>Interface</h3>${row("Tab", "Scoreboard")}${row("Esc", "Menu")}${row("Enter", "Chat")}${row(PB_KEYS.radio.map((c) => c.slice(3)).join(" "), "Radio")}</div></div>` +
    (opts.onLeave ? `<button id="pbleave" class="ov-leave" type="button">Leave match</button>` : "") + `</div>`;
  blocker.classList.toggle("hidden", !!opts.theater);

  // [RECRIADO] every match is recorded for the theater (dev server only: it stores the file, scripts/mvm-server.ts)
  const recorder = import.meta.env.DEV && !opts.theater ? new DemoRecorder({ map, mode: opts.match?.mode ?? "DM", pov: opts.net?.localId ?? "local" }) : undefined;
  const input = new Input(document.body);
  const game = await Game.create({
    scene,
    camera,
    world,
    R: RAPIER,
    input,
    levelName,
    levelSpawn: level.spawn,
    collisionJsonUrl: AssetPaths.collisionJson,
    net: opts.theater ?? opts.net,
    recorder,
    theater: !!opts.theater,
    localTeam: opts.localTeam,
    localName: opts.localName,
    localRank: opts.localRank,
    // the theater's clock is the demo's: no kill / time limit ends it
    match: opts.theater ? { killLimit: 0, timeLimit: 1e9, endScreen: Infinity } : opts.match,
    onMatchEnd: opts.onMatchEnd,
    onLeave: opts.onLeave,
    respawnInventory: opts.respawnInventory,
    firstLoadout: opts.firstLoadout,
    localChara: opts.localChara,
    itemEffects: opts.itemEffects,
    botCount: opts.botCount,
    botSkill: opts.botSkill,
    botAllies: opts.botAllies,
    missions: opts.missions,
    missionPanel: opts.missionPanel,
    stageType: opts.stageType,
    room: opts.room,
    clanMatch: opts.clanMatch,
  });
  // what Game.create added (viewmodel, bots, shadow, drops) mounts from the preloaded caches within a task: compile it now too
  // (its programs are mostly cached by the prepare) and upload its new textures before the first frame instead of in it
  await new Promise((r) => setTimeout(r, 0));
  await warmScene(renderer, scene, camera).catch((e) => console.warn("[warmup]", e));

  let debugVisible = false;
  window.addEventListener("keydown", (e) => {
    if (e.code === "F4") { // collision debug (was F2: F2 opens the test menu, game/devMenu.ts)
      e.preventDefault();
      debugVisible = !debugVisible;
      debugGroup.visible = debugVisible;
    }
  }, { signal });

  document.body.addEventListener("click", (e) => {
    if ((e.target as HTMLElement | null)?.id === "pbleave") {
      opts.onLeave?.();
      return;
    }
    if (game.finalOn || opts.theater) return; // end-of-match screen: the mouse stays free for the leave button; the theater never locks
    if (document.pointerLockElement !== document.body) void lockPointer();
  }, { signal });

  // Game's own constructor already registers a pointerlockchange listener (game.ts) that hides the blocker on
  // lock AND on the ESC menu opening (it needs escMenu/respawnMenu state this scope doesn't have) — a second,
  // simpler one here that only checked the lock raced it and clobbered the blocker back to visible every time.

  const clock = new THREE.Clock();

  let raf = 0;
  let lastStep = performance.now(); // last simulated frame (rAF or the hidden-tab timer below)
  let lastCpu = 0; // ms of JS this frame (update + step + render submit), read by dynTick on the next frame
  theater = opts.theater ? new Theater(opts.theater, {
    game, renderer, camera,
    simulate(dt) {
      world.timestep = dt;
      game.update(dt, dt);
      if (dt > 0) world.step(); // paused: ragdolls hold their pose
    },
    render: () => renderWithViewmodel(renderer, scene, camera),
    exit: () => opts.onLeave?.(),
  }) : null;

  function animate() {
    raf = requestAnimationFrame(animate);
    lastStep = performance.now();
    const raw = clock.getDelta();
    if (theater) { theater.frame(raw); return; }
    const dt = Math.min(raw, 0.05);
    dynTick(raw, lastCpu);

    world.timestep = dt;
    const t0 = performance.now();
    game.update(dt, raw);
    const t1 = performance.now();
    world.step();
    const t2 = performance.now();
    renderPbShadows(renderer, scene, camera);
    renderWithViewmodel(renderer, scene, camera);
    const t3 = performance.now();
    lastCpu = t3 - t0;
    perfTick(t1 - t0, t2 - t1, t3 - t2);
  }

  (window as unknown as { __pb?: Game }).__pb = game; // debug/test handle
  (window as unknown as { __pbR?: THREE.WebGLRenderer }).__pbR = renderer; // perf: __pbR.info.render.calls / .memory / .programs
  animate();
  // A hidden tab gets no requestAnimationFrame: keep simulating (no render) on a timer so this player's state keeps
  // reaching the others (the browser clamps it to ~1 Hz, enough to show the player is still in the match).
  const stepOnly = () => {
    const raw = clock.getDelta();
    const dt = Math.min(raw, 0.05);
    world.timestep = dt;
    game.update(dt, raw);
    world.step();
  };
  const bg = setInterval(() => { if (!theater && document.hidden && performance.now() - lastStep > 400) { lastStep = performance.now(); stepOnly(); } }, 250);

  let stopped = false;
  let successor: GameHandle | null = null; // set by __pbRestart: the caller's (boot.ts) handle then stops the new match too
  const w = window as unknown as { __pb?: Game; __pbRestart?: (map?: MapId) => Promise<unknown>; __pbMem?: () => unknown };
  const handle: GameHandle = {
    game,
    stop() {
      if (stopped) { successor?.stop(); return; }
      stopped = true;
      cancelAnimationFrame(raf);
      theater?.dispose();
      recorder?.save().catch((e) => console.warn("[mvm] demo not saved", e));
      clearInterval(bg);
      unsubRes();
      unsubBrightness();
      ac.abort();
      if (document.pointerLockElement) document.exitPointerLock();
      // the renderer stays for the next match (render/sharedRenderer.ts): the match's own GPU resources go now, the level cache's stay.
      // Before game.dispose, which detaches the actors from the scene
      releaseMatch(renderer, [scene, camera]);
      disposePbShadows();
      clearPbPointLights();
      if (opts.theater) setSettingsOverride(null);
      game.dispose();
      world.free();
      blocker.classList.add("hidden");
      if (w.__pb === game) delete w.__pb;
      if (w.__pbRestart === restart) delete w.__pbRestart;
    },
  };
  // dev / ?perf: closes this local match and opens another one the way a rematch does (stop -> startGame, same renderer, level from
  // the cache). Resolves with the renderer memory before / after: after a rematch on the same map geometries / textures / programs
  // must be equal. Optional `map` = a map switch (frees the previous map's cache).
  const restart = async (map?: MapId) => {
    if (opts.net) throw new Error("__pbRestart: local match only");
    const t0 = performance.now();
    const before = memSnap(renderer);
    handle.stop();
    const next = await startGame({ ...opts, map: map ?? opts.map ?? CurrentMap });
    successor = next;
    const nr = (window as unknown as { __pbR: THREE.WebGLRenderer }).__pbR;
    return { ms: Math.round(performance.now() - t0), sameRenderer: nr === renderer, before, after: memSnap(nr), level: { ...levelCacheStats }, renderer: { ...rendererStats } };
  };
  if (PERF || import.meta.env.DEV) {
    w.__pbRestart = restart;
    w.__pbMem = () => ({ ...memSnap(renderer), level: { ...levelCacheStats }, renderer: { ...rendererStats } });
  }
  return handle;
}
