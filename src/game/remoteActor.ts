import * as THREE from "three";
import { DIR8 } from "./charAnim";
import { PB_CHARA } from "../gameplay/pbConfig";
import { bindWeaponAnim } from "./charAnimLib";
import { actorHasHelmet, actorHeadgearOn, noteBotEquip } from "./charEquip";
import { charaMaxHp } from "../gameplay/charaHp";
import { createCharVisual, preloadChara, spawnBlinkAlpha, type CharVisual } from "./charModel";
import type { PlayerState } from "./netAdapter";
import type { Actor, ObsState, Team } from "./types";
import type { DeathHit } from "./ragdoll";
import { createLaserBeam } from "../weapons/laser";
import { weaponFxInfo } from "../weapons/sights";
import { norm } from "../weapons/worldModel";
import { jsonOnce } from "../jsonOnce";

/** the sender's own grounded flag; vel.y (a position difference) reads a stair climb / descent as a jump / fall */
const groundedOf = (vel: THREE.Vector3, airborne: boolean | undefined) => (airborne === undefined ? Math.abs(vel.y) < 1.5 : !airborne);

/** the replicated movement bits as the animator's lower-body input */
function lowerInput(vel: THREE.Vector3, airborne: boolean | undefined, moving: boolean, running: boolean, moveDir: number) {
  return {
    grounded: groundedOf(vel, airborne),
    moving,
    walking: moving ? !running : undefined,
    dir8: moving ? DIR8[moveDir] : undefined,
  };
}

/** [RECRIADO] theater seek: a body's recorded states up to `clock` as apply() and update() feed them, each held until the next */
function* strideSteps(track: { t: number[]; s: PlayerState[] }, clock: number) {
  const vel = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i < track.t.length && track.t[i] <= clock; i++) {
    const s = track.s[i];
    if (s.vel) i ? vel.lerp(v.set(s.vel[0], s.vel[1], s.vel[2]), 0.4) : vel.set(s.vel[0], s.vel[1], s.vel[2]);
    const input = { vel, yaw: s.yaw, crouch: s.crouch, alive: s.alive, ...lowerInput(vel, s.ladder ? false : s.airborne, s.moving ?? false, s.running ?? false, s.moveDir ?? 0) };
    yield [Math.min(track.t[i + 1] ?? clock, clock) - track.t[i], input] as const;
  }
}

/**
 * weapons.json name -> id, resolved locally (not through weapon-own-anim's worldModel cache) so remoteActor.ts
 * stays a self-contained consumer of the shared file.: the laser
 * BEAM is drawn on every other player's current weapon at all times (exe 0x64c778) whenever its class carries a
 * laser (WeaponDotLaser / *WithLaser) - unlike the red DOT, it is not gated by the owner's toggle (key B) or any
 * replicated state, so PlayerState needs no laser field for this.
 */
let laserIdMapP: Promise<Map<string, number>> | null = null;
function laserWeaponIdMap(): Promise<Map<string, number>> {
  laserIdMapP ??= jsonOnce<{ weapons?: { id: number; name: string }[] }>("/assets/cross/weapons/weapons.json")
    .then((j) => {
      const m = new Map<string, number>();
      for (const w of j?.weapons ?? []) m.set(norm(w.name), w.id);
      return m;
    })
    .catch(() => new Map<string, number>());
  return laserIdMapP;
}
async function hasLaser(weapon: string | number): Promise<boolean> {
  const id = typeof weapon === "number" ? weapon : (await laserWeaponIdMap()).get(norm(weapon));
  return !!id && !!weaponFxInfo(id)?.laser;
}

/** Network player driven by PlayerState snapshots (interpolated). Hit-testable like bots. */
/** state packets come every 50 ms: this long without one and the replicated "firing" flag is stale */
const REMOTE_FIRE_STALE = 0.4;
/** [INFERIDO] WeaponSystem.startReload's lead-in, the 3PV opening runs over it as the 1PV readyPhase does */
const RELOAD_LEAD = 0.3;

export class RemoteActor implements Actor {
  readonly kind = "remote" as const;
  name: string;
  team: Team;
  hp = PB_CHARA.hp;
  maxHp = PB_CHARA.hp;
  armor = 100;
  /** popped off by HELMET PROTECTION this life (reset on respawn) */
  helmetLost = false;
  /** wears a helmet: a head item is equipped (charEquip.ts actorHasHelmet) and it has not popped off this life */
  get helmet(): boolean { return !this.helmetLost && actorHasHelmet(this.id); }
  set helmet(on: boolean) { this.helmetLost = !on; }
  alive = true;
  invulnUntil = 0;
  weaponName = "";
  /** item id in hand (net WeaponSync, PlayerState.weaponId); 0 = only the name is known */
  weaponId = 0;
  /** equip slot in hand (PlayerState.weaponSlot); undefined = not sent */
  weaponSlot: number | undefined;
  /** what the 3PV model was built for: the item id when known (skins), else the name */
  private weaponKey: string | number = "";
  private visual: CharVisual;
  private pos = new THREE.Vector3();
  private target = new THREE.Vector3();
  private yawV = 0;
  private targetYaw = 0;
  private crouch = false;
  private pitchV = 0;
  private targetPitch = 0;
  private vel = new THREE.Vector3();
  private _v = new THREE.Vector3();
  private airborne: boolean | undefined;
  private firing = false;
  /** seconds between shots of the held weapon (game.ts sets it from the weapon def); 0 = unknown, no dedupe */
  fireGap = 0;
  /** the held weapon repeats while "firing" (auto / burst); unknown weapon = true, the old behaviour */
  fireHeld = true;
  boltTime: number | undefined;
  // the remote's own reload scale is not networked: [INFERIDO] 1
  reloadTime: number | undefined;
  reloadPerShell = false;
  private reloadAge = 0;
  private shells = 0;
  private clock = 0;
  private lastFireAt = -999;
  /** seconds since the last apply() */
  private sinceState = 0;
  /** ADS: last torsoAction "zoom" seen for a weapon.pef _ZoomType 2|3 (net/battle.ts torsoAction + zoomType); kept
   *  across "fire"/"reload"/"change" (transient torsoActions carry no zoom info of their own) */
  aiming = false;
  private fireAnimCd = 0;
  lastFire = -999;
  /** last torsoAction applied (edge-triggers reload/change/fire one-shots) */
  private torsoAction: NonNullable<PlayerState["torsoAction"]> = "idle";
  private moving = false;
  private running = false;
  private moveDir = 0;
  /** equipped character itemId (RESPAWN 5138) the visual was built for; also Actor.chara (radio voice lookup) */
  chara: number | undefined;
  private charaTok = 0;
  /** the visual was rebuilt for another character (game.ts re-registers the bone hitboxes) */
  onVisualChanged: (() => void) | null = null;
  /** game.ts hook: positional weapon-fire sound (WeaponSystem.playRemoteFire), fired alongside the muzzle flash. */
  onFire: ((heavy: boolean) => void) | null = null;
  /** RMB extension switched on / off by the remote player (silencer sound, game.ts) */
  onExt: ((on: boolean) => void) | null = null;
  /** plant / defuse hold started (kind) or ended (null): game.ts plays the hold sound at the holder */
  onBombHold: ((kind: "plant" | "defuse" | null) => void) | null = null;
  extOn = false;
  private extSeen = false;
  /** current weapon's class carries a laser (WeaponDotLaser); resolved async off weapons.json + weaponfx.json */
  /** spawn protection length (s), set by game.ts from the match config; remaining time of the current one */
  protectTime = 0;
  private protectLeft = 0;
  private laserOn = false;
  private laserTok = 0;
  private changeTok = 0;
  private beam: THREE.Mesh | null = null;

  // timing before the first apply: its fire / reload edge plays at once
  constructor(readonly id: string, s: PlayerState, private scene: THREE.Scene, timing?: Partial<Pick<RemoteActor, "fireGap" | "fireHeld" | "boltTime" | "reloadTime" | "reloadPerShell">>) {
    Object.assign(this, timing);
    if (s.bot) noteBotEquip(id); // an AI seat: no 5138 reaches us, so no head item from the player who held the seat before
    this.name = s.name;
    this.team = s.team;
    this.chara = s.chara;
    this.maxHp = charaMaxHp(s.chara);
    this.visual = createCharVisual(s.team, { itemId: s.chara, equipActor: id });
    scene.add(this.visual.root);
    if (s.chara) this.loadChara(s.chara);
    this.apply(s, true);
  }

  /** Loads the equipped character and swaps the model in once it is ready (same pose / weapon). */
  private loadChara(itemId: number): void {
    const tok = ++this.charaTok;
    void preloadChara(itemId, this.team).then((name) => {
      console.info(`[remote] ${this.id} chara ${itemId} team ${this.team}: model ${name ?? "none"}, now ${this.visual.charaName ?? "none"}${tok !== this.charaTok ? " (stale)" : ""}`);
      if (tok !== this.charaTok || !name || name === this.visual.charaName) return;
      const old = this.visual, was = old.anim;
      this.visual = createCharVisual(this.team, { itemId, equipActor: this.id });
      this.scene.add(this.visual.root);
      // [RECRIADO] theater: the new model goes on in the old one's clock and step
      if (this.demo) this.visual.resetAnim(was?.time ?? this.demo.time(), was?.stride ?? 0);
      old.dispose();
      if (this.weaponKey) {
        this.visual.setWeapon(this.weaponKey);
        const anim = this.visual.anim;
        // no old body to follow: where a seek puts it, after the bind (its Low_* tables, not the model's stand-ins)
        void bindWeaponAnim(anim, this.weaponKey, undefined, this.visual.animSkel).then(() => {
          if (!was && anim === this.visual.anim) this.restride();
        });
      }
      if (!this.alive) this.visual.die(undefined, this.crouch);
      this.onVisualChanged?.();
    });
  }

  apply(s: PlayerState, snap = false): void {
    this.name = s.name;
    if (snap) this.changeTok++; // [RECRIADO] a seek is no swap: no draw still waiting for its clips (the seek's own state queued one)
    if (s.chara !== undefined && s.chara !== this.chara) {
      this.chara = s.chara;
      this.maxHp = charaMaxHp(s.chara);
      this.loadChara(s.chara);
    }
    this.hp = s.hp;
    if (s.alive && !this.alive) {
      this.helmetLost = false; // respawned: the equipped helmet is back
      this.protectLeft = this.protectTime; // spawn protection starts (Character.pef InvincibleTime)
    }
    // only "off" is taken live: the states sent before the victim took the hit (and an older peer's) still say false. A snap
    // (theater seek) takes either; a respawn puts the helmet back above
    if (s.alive && (s.helmetOff || (snap && s.helmetOff === false))) this.helmetLost = !!s.helmetOff;
    // firing drops the protection (same rule as the local player, game.ts)
    if (s.firing && s.alive) this.protectLeft = 0;
    if (!s.alive && this.alive && s.deathPick !== undefined) this.setDeathPick(s.deathPick);
    this.alive = s.alive;
    this.crouch = s.crouch;
    let weaponChanged = false;
    // the replicated item id (WeaponSync) picks the exact model / skin; the name is the fallback (bots, older senders)
    const key: string | number = s.weaponId || s.weapon;
    if (key && key !== this.weaponKey) {
      weaponChanged = true;
      this.visual.setWeapon(key);
      // the weapon's own PB upper-body AI (reload/change/attack clips); Change plays once its clips are bound
      // [RECRIADO] a late bind starts the draw as far in as the swap is old; a new chara model's animator has another clock
      const first = !this.weaponKey, anim = this.visual.anim, at = anim?.time ?? 0, tok = this.changeTok;
      void bindWeaponAnim(anim, key, undefined, this.visual.animSkel).then((ai) => {
        if (!first && ai && tok === this.changeTok) this.visual.change(this.visual.anim === anim ? (anim?.time ?? 0) - at : 0);
      });
      this.weaponKey = key;
    }
    this.weaponName = s.weapon;
    this.weaponId = s.weaponId ?? 0;
    this.weaponSlot = s.weaponSlot;
    if (weaponChanged) {
      const tok = ++this.laserTok;
      this.laserOn = false;
      void hasLaser(key).then((v) => { if (tok === this.laserTok) this.laserOn = v; });
    }
    this.target.set(s.pos[0], s.pos[1], s.pos[2]);
    this.targetYaw = s.yaw;
    this.targetPitch = s.pitch ?? 0;
    // a climber is off the ground but not falling: no jump / fall pose (Cross has no climb clip)
    this.airborne = s.ladder ? false : s.airborne;
    // the receiver's vel is a position difference over packet arrival times: jittery, it drove the stride rate
    if (s.vel) {
      if (snap) this.vel.set(s.vel[0], s.vel[1], s.vel[2]);
      else this.vel.lerp(this._v.set(s.vel[0], s.vel[1], s.vel[2]), 0.4);
    }
    this.firing = !!s.firing;
    this.sinceState = 0;

    // torsoAction (net/battle.ts action bits 10-13): edge-triggered one-shots for reload/change/fire, and the
    // persistent ADS flag (ahead of / behind a transient torsoAction, "zoom" is the only state that carries it).
    const torso = s.torsoAction ?? (s.firing ? "fire" : "idle");
    if (torso === "zoom" || torso === "idle") this.aiming = torso === "zoom" && (s.zoomType === 2 || s.zoomType === 3);
    if (torso !== this.torsoAction) {
      const was = this.torsoAction;
      this.torsoAction = torso;
      if (torso === "plant") this.visual.plant(true);
      else if (was === "plant") this.visual.plant(false);
      if (torso === "plant" || torso === "defuse") this.onBombHold?.(torso);
      else if (was === "plant" || was === "defuse") this.onBombHold?.(null);
      if (torso === "plant") { /* the Install clip holds until the plant ends */ }
      else if (torso === "reload") this.playReload();
      else if (torso === "change" && !weaponChanged) this.visual.change();
      else if (torso === "fire") this.playFire(!!s.heavy);
      else if (torso === "ready") this.visual.throwReady();
    }
    // RMB extension: the ExtensionActivate / Deactivate clip of the weapon model plays on the edge (not on a weapon change)
    const ext = !!s.ext;
    if (ext !== this.extOn) {
      this.extOn = ext;
      this.visual.setExt(ext, !weaponChanged && this.extSeen);
      if (!weaponChanged && this.extSeen) this.onExt?.(ext);
    } else if (weaponChanged) this.visual.setExt(ext, false);
    this.extSeen = true;
    this.moving = s.moving ?? false;
    this.running = s.running ?? false;
    this.moveDir = s.moveDir ?? 0;

    if (snap) {
      this.pos.copy(this.target);
      this.yawV = s.yaw;
      this.pitchV = this.targetPitch;
    }
  }

  /** [RECRIADO] theater seek: a fresh living body, before the replay that leads up to the seek time */
  resetAnim(clock: number): void {
    this.alive = true;
    this.torsoAction = "idle";
    this.fireAnimCd = 0;
    this.lastFireAt = -999;
    this.visual.resetAnim(clock);
  }

  /** [RECRIADO] theater: the demo clock and the actor's states since it joined (game.ts sets it on every remote) */
  demo?: { time(): number; track(id: string, t: number): { t: number[]; s: PlayerState[] } | undefined };
  /** [RECRIADO] theater: the legs where the recorded states put them now, so a seek and a model mount agree */
  restride(): void {
    const anim = this.visual.anim, t = this.demo?.time(), track = t === undefined ? undefined : this.demo!.track(this.id, t);
    if (anim && track) anim.stride = anim.stridePhase(strideSteps(track, t!));
  }

  /** [RECRIADO] demo playback: the clip pick of the coming death (the kill event or the dead state, whichever arrives first) */
  setDeathPick(pick: number | string): void {
    this.visual.deathPick = pick;
  }

  /** [RECRIADO] theater demo editor: the body to click on and its animator */
  get charVisual(): CharVisual {
    return this.visual;
  }

  /** [RECRIADO] demo playback: the pose interpolated between the two recorded ticks around now, with no smoothing lag */
  setPose(pos: [number, number, number], yaw: number, pitch: number): void {
    this.pos.set(pos[0], pos[1], pos[2]);
    this.target.copy(this.pos);
    this.yawV = this.targetYaw = yaw;
    this.pitchV = this.targetPitch = pitch;
  }

  update(dt: number): void {
    this.protectLeft = Math.max(0, this.protectLeft - dt);
    this.visual.setAlpha(this.alive ? spawnBlinkAlpha(this.protectLeft) : 1);
    const k = Math.min(1, dt * 15);
    this.pos.lerp(this.target, k);
    let d = this.targetYaw - this.yawV;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yawV += d * k;
    this.pitchV += (this.targetPitch - this.pitchV) * k;
    // replicated "firing" flag -> upper-body attack clip at ~10 Hz (exact shots come via playFire())
    this.fireAnimCd -= dt;
    // the sender stopped (match over / link closed) with "firing" in its last packet: no new state, no more shots
    this.clock += dt;
    this.sinceState += dt;
    if (this.sinceState > REMOTE_FIRE_STALE) this.firing = false;
    // held repeat only for auto / burst: a semi-auto shot keeps "fire" set ~150 ms, which would read as a second shot
    if (this.firing && this.fireHeld && this.alive && this.fireAnimCd <= 0 && this.torsoAction !== "plant") this.playFire();
    // shell-by-shell: one LoadMagazine per ReloadTime after the 0.3 s lead-in (WeaponSystem.startReload) while "reload" holds
    if (this.torsoAction === "reload" && this.reloadPerShell && this.reloadTime) {
      this.reloadAge += dt;
      while (this.alive && this.reloadAge >= RELOAD_LEAD + this.shells * this.reloadTime) {
        this.shells++;
        this.visual.reloadShell(this.reloadTime);
      }
    }
    const dummy = this.alive ? this.visual.laserDummy : null;
    if (this.laserOn && dummy) {
      if (this.beam?.parent !== dummy) {
        this.beam?.removeFromParent();
        this.beam = createLaserBeam();
        dummy.add(this.beam);
      }
    } else if (this.beam) {
      this.beam.removeFromParent();
      this.beam = null;
    }
    this.visual.setHelmet(actorHeadgearOn(this.id, this.helmetLost));
    this.visual.update(dt, {
      pos: this.pos,
      yaw: this.yawV,
      pitch: this.pitchV,
      vel: this.vel,
      crouch: this.crouch,
      alive: this.alive,
      zoom: this.aiming,
      ...lowerInput(this.vel, this.airborne, this.moving, this.running, this.moveDir),
    });
  }

  /** Visual hooks for net events (game.ts): shot / reload / hurt / kill direction. */
  playFire(heavy = false): void {
    // one shot arrives twice (torsoAction "fire" edge + the held "firing" flag of the same packet / the next one):
    // nothing fires again before 80% of the weapon's FireDelay
    if (this.clock - this.lastFireAt < this.fireGap * 0.8) return;
    this.lastFireAt = this.clock;
    this.fireSeq++;
    this.lastHeavy = heavy;
    this.fireAnimCd = this.fireGap || 0.1;
    this.visual.fire(heavy);
    // [INFERIDO] Fire is 1 frame, LoadBullet follows at once (as observeFire); no ammo count, so the last round chambers too
    if (this.boltTime !== undefined && !heavy) this.visual.loadBullet(this.boltTime);
    this.onFire?.(heavy);
  }
  /** seconds = the weapon's weapon.pef ReloadTime: the whole Up_Reload clip is stretched over it */
  playReload(seconds = this.reloadTime): void {
    this.reloadSeq++;
    this.reloadSecs = seconds ?? 2;
    this.reloadAge = 0;
    this.shells = 0;
    if (this.reloadPerShell && seconds) this.visual.reloadOpen(RELOAD_LEAD);
    else this.visual.reload(seconds);
  }
  /**
   * Flinch on a bullet hit. The shooter's own client drives it: the victim is client-authoritative (game.ts
   * applyHit only sends the hit), so nobody else would ever play it. DamageFrontLeftA / DamageBackA come from the
   * victim's *current weapon's* AI bundle, so it has to be the one asking (this.weaponKey is what was bound).
   */
  noteHit(h: DeathHit): void {
    this.visual.noteHit(h);
  }
  playHurt(shotDir?: THREE.Vector3): void {
    this.visual.hurt(shotDir);
  }
  playDeath(shotDir?: THREE.Vector3): void {
    this.visual.die(shotDir, this.crouch);
  }
  /** Muzzle position of the 3rd-person weapon (tracers/flash for remote shots). */
  muzzle(out = new THREE.Vector3()): THREE.Vector3 {
    return this.visual.muzzleWorld(out);
  }
  /** Muzzle(s) of the last shot: both guns for a DualSMG / crossed HK45 Dual */
  muzzles(): THREE.Vector3[] {
    return this.visual.muzzles();
  }
  /** muzzles() of the pose update() just set (the render has not refreshed the world matrices yet) */
  muzzlesNow(): THREE.Vector3[] {
    this.visual.root.updateWorldMatrix(true, false); // getWorldPosition updates the muzzle's own chain below it
    return this.visual.muzzles();
  }
  /** Character model root (for charModel.getBoneHitboxes). */
  /** the helmet on the head (world transform + model to copy) for the HELMET PROTECTION drop */
  helmetSource() {
    return this.visual.helmetSource();
  }
  private fireSeq = 0;
  private lastHeavy = false;
  private reloadSeq = 0;
  private reloadSecs = 2;
  obsState(): ObsState {
    return { speed: Math.hypot(this.vel.x, this.vel.z), grounded: groundedOf(this.vel, this.airborne), aiming: this.aiming, fireSeq: this.fireSeq, reloadSeq: this.reloadSeq, reloadSecs: this.reloadSecs, firing: this.firing, planting: this.torsoAction === "plant", heavy: this.lastHeavy, reloading: this.torsoAction === "reload", ready: this.torsoAction === "ready", ext: this.extOn, walking: this.moving && !this.running };
  }
  get visualRoot(): THREE.Object3D {
    return this.visual.root;
  }

  feet(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos);
  }
  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos).setY(this.pos.y + (this.crouch ? 1.0 : 1.7));
  }
  yaw(): number {
    return this.yawV;
  }
  /** replicated aim direction (net yaw / pitch, same convention as bots.ts) */
  aimDir(out = new THREE.Vector3()): THREE.Vector3 {
    const cp = Math.cos(this.pitchV);
    return out.set(-Math.sin(this.yawV) * cp, Math.sin(this.pitchV), -Math.cos(this.yawV) * cp);
  }
  /** the last replicated angles, unsmoothed: the observer's FPS view (his camera recoil is in his pitch) */
  viewDir(out = new THREE.Vector3()): THREE.Vector3 {
    const cp = Math.cos(this.targetPitch);
    return out.set(-Math.sin(this.targetYaw) * cp, Math.sin(this.targetPitch), -Math.cos(this.targetYaw) * cp);
  }
  isCrouching(): boolean {
    return this.crouch;
  }

  dispose(): void {
    this.beam?.removeFromParent();
    this.visual.dispose();
  }
}
