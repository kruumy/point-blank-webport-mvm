import type { HitEvent, KillEvent, NetAdapter, PlayerState, ThrowEvent } from "../game/netAdapter";
import type { Demo } from "./demo";
import { noteActorEquip, type HeadEquip } from "../game/actorEquip.ts";

type Cb<T> = (e: T) => void;
interface Death { id: string; t: number; end: number; key: string; pick: number; carriers: { deathPick?: number | string }[] }

/** [RECRIADO] Plays a demo into Game as if its actors were the other players of a net match: the guest code path
 * (RemoteActor, remote fire tracers / sounds, kill feed, grenades) draws them, the local player only watches. */
export class DemoNet implements NetAdapter {
  readonly mode = "net" as const;
  readonly localId = "mvm-viewer";
  private readonly state: Cb<PlayerState>[] = [];
  private readonly hit: Cb<HitEvent>[] = [];
  private readonly kill: Cb<KillEvent>[] = [];
  private readonly leave: Cb<string>[] = [];
  private readonly thrown: Cb<ThrowEvent>[] = [];
  private readonly prop: Cb<number>[] = [];
  /** next record to play */
  private cursor = 0;
  /** every actor's states in time order: the pose between two ticks (poses) */
  private readonly tracks = new Map<string, { t: number[]; s: PlayerState[] }>();
  /** every death in the demo: its first and last dead state and the records that carry its pick */
  private readonly deaths: Death[] = [];

  readonly demo: Demo;

  // a plain field, not a parameter property: node's type stripping (src/net/test) cannot run those
  constructor(demo: Demo) {
    this.demo = demo;
    const dead = new Map<string, Death>(); // actor -> the death in progress
    for (const r of demo.recs) {
      if (r.k === "leave") this.leaves.set(r.id, [...(this.leaves.get(r.id) ?? []), r.t]);
      if (r.k !== "state") continue;
      let tr = this.tracks.get(r.s.id);
      if (!tr) this.tracks.set(r.s.id, tr = { t: [], s: [] });
      tr.t.push(r.t);
      tr.s.push(r.s);
      // one pick per death, from where it starts: a replay or a seek into it shows the same clip
      if (r.s.alive) dead.delete(r.s.id);
      else {
        let d = dead.get(r.s.id);
        if (!d) {
          d = { id: r.s.id, t: r.t, end: r.t, key: `${r.s.id}@${r.t}`, pick: hash01(`${r.s.id}@${r.t}`), carriers: [] };
          dead.set(r.s.id, d);
          this.deaths.push(d);
        }
        d.end = r.t;
        d.carriers.push(r.s);
      }
    }
    // the kill is recorded a tick before the victim's first dead state and kills it first on playback: it carries the same pick
    for (const r of demo.recs) {
      if (r.k !== "kill") continue;
      const d = this.deaths.find((x) => x.id === r.e.victimId && x.t >= r.t - 0.25 && x.t <= r.t + 1); // a victim with no dead state after it: no pick
      if (d) d.carriers.push(r.e);
    }
    this.applyDeaths();
  }

  /** the recorded pick, or the clip a theater edit chose */
  private applyDeaths(): void {
    for (const d of this.deaths) {
      const pick = this.demo.deaths?.[d.key] ?? d.pick;
      for (const c of d.carriers) c.deathPick = pick;
    }
  }

  /** [RECRIADO] demo editor: the death `id` is in at `t` (its key and the clip an edit chose), or null while it lives */
  deathAt(id: string, t: number): { key: string; clip: string | null } | null {
    const d = this.deaths.find((x) => x.id === id && x.t - 0.25 <= t && t <= x.end + 0.5);
    return d ? { key: d.key, clip: this.demo.deaths?.[d.key] ?? null } : null;
  }

  /** [RECRIADO] demo editor: plays `clip` for that death from now on; null = back to the recorded pick */
  setDeathClip(key: string, clip: string | null): void {
    const edits = (this.demo.deaths ??= {});
    if (clip) edits[key] = clip;
    else delete edits[key];
    if (!Object.keys(edits).length) delete this.demo.deaths;
    this.applyDeaths();
  }

  /** a state with the character an edit chose; a copy, so the record keeps what was recorded (saveDemo writes the records) */
  private withChara(s: PlayerState): PlayerState {
    // no recorded character = the team default; an actor that had an edit needs it said (0) or its model would never change back
    const c = this.demo.charas?.[s.id] ?? (s.chara === undefined && this.charaTouched.has(s.id) ? 0 : undefined);
    return c === undefined ? s : { ...s, chara: c };
  }
  private readonly charaTouched = new Set<string>();

  /** [RECRIADO] demo editor: the character the actor shows (an edit's, else the recorded one) and whether it is an edit */
  charaOf(id: string): { chara: number | undefined; edited: boolean } {
    const c = this.demo.charas?.[id];
    if (c !== undefined) return { chara: c, edited: true };
    const tr = this.tracks.get(id);
    return { chara: tr?.s[tr.s.length - 1].chara, edited: false };
  }

  /** [RECRIADO] demo editor: that actor shows `chara` for the whole demo; null = back to the recorded one */
  setChara(id: string, chara: number | null): void {
    const edits = (this.demo.charas ??= {});
    this.charaTouched.add(id);
    if (chara) edits[id] = chara;
    else delete edits[id];
    if (!Object.keys(edits).length) delete this.demo.charas;
  }

  /** the head items each actor's last played equip record gave it (before the hat edits) */
  private readonly recEquip = new Map<string, HeadEquip>();
  private noteEquip(id: string, eq: HeadEquip): void {
    this.recEquip.set(id, eq);
    const hat = this.demo.hats?.[id];
    noteActorEquip(id, hat ? { ...eq, ...hat } : eq);
  }

  /** [RECRIADO] demo editor: the hat edit of that actor (undefined = the recorded head items) */
  hatOf(id: string): { head: number; beret: number } | undefined {
    return this.demo.hats?.[id];
  }

  /** [RECRIADO] demo editor: that actor wears `hat` for the whole demo; null = back to the recorded head items */
  setHat(id: string, hat: { head: number; beret: number } | null): void {
    const edits = (this.demo.hats ??= {});
    if (hat) edits[id] = hat;
    else delete edits[id];
    if (!Object.keys(edits).length) delete this.demo.hats;
    this.noteEquip(id, this.recEquip.get(id) ?? {});
  }

  /** each actor's pose at `t`, interpolated between the recorded ticks around it (not across a respawn or a gap) */
  poses(t: number): { id: string; pos: [number, number, number]; yaw: number; pitch: number }[] {
    const out = [];
    for (const [id, tr] of this.tracks) {
      let lo = 0, hi = tr.t.length - 1;
      if (tr.t[0] > t) continue;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tr.t[m] <= t) lo = m; else hi = m - 1; }
      const a = tr.s[lo], b = tr.s[lo + 1];
      if (!b || b.alive !== a.alive || tr.t[lo + 1] - tr.t[lo] > 0.5) { out.push({ id, pos: a.pos, yaw: a.yaw, pitch: a.pitch }); continue; }
      const k = (t - tr.t[lo]) / (tr.t[lo + 1] - tr.t[lo] || 1);
      let dy = b.yaw - a.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      out.push({
        id,
        pos: [a.pos[0] + (b.pos[0] - a.pos[0]) * k, a.pos[1] + (b.pos[1] - a.pos[1]) * k, a.pos[2] + (b.pos[2] - a.pos[2]) * k] as [number, number, number],
        yaw: a.yaw + dy * k,
        pitch: a.pitch + (b.pitch - a.pitch) * k,
      });
    }
    return out;
  }

  /** plays every record up to demo time `t` */
  advance(t: number): void {
    const recs = this.demo.recs;
    while (this.cursor < recs.length && recs[this.cursor].t <= t) {
      const r = recs[this.cursor++];
      switch (r.k) {
        case "state": { const s = this.withChara(r.s); for (const f of this.state) f(s); break; }
        case "hit": for (const f of this.hit) f(r.e); break;
        case "kill": for (const f of this.kill) f(r.e); break;
        case "throw": for (const f of this.thrown) f(r.e); break;
        case "prop": for (const f of this.prop) f(r.i); break;
        case "leave": for (const f of this.leave) f(r.id); break;
        case "equip": this.noteEquip(r.id, r.eq); break;
      }
    }
  }

  /** [RECRIADO] theater seek: that actor's states since it last joined before `t` (a rejoin is a new body, its stride from 0) */
  trackOf(id: string, t: number): { t: number[]; s: PlayerState[] } | undefined {
    const tr = this.tracks.get(id), left = Math.max(-Infinity, ...(this.leaves.get(id) ?? []).filter((x) => x <= t));
    const from = tr?.t.findIndex((x) => x > left) ?? -1;
    return from < 0 ? undefined : from === 0 ? tr : { t: tr!.t.slice(from), s: tr!.s.slice(from) };
  }
  private readonly leaves = new Map<string, number[]>();

  /** jumps to `t` without the events in between: plays each actor's last state (the caller snaps the bodies to it) */
  seek(t: number): PlayerState[] {
    const recs = this.demo.recs, last = new Map<string, PlayerState>(), equip = new Map<string, HeadEquip>();
    let i = 0;
    for (; i < recs.length && recs[i].t <= t; i++) {
      const r = recs[i];
      if (r.k === "state") last.set(r.s.id, r.s);
      else if (r.k === "leave") last.delete(r.id);
      else if (r.k === "equip") equip.set(r.id, r.eq);
    }
    this.cursor = i;
    for (const [id, eq] of equip) this.noteEquip(id, eq);
    // an actor with a hat edit and no equip record before `t` (older demos have none)
    for (const id of Object.keys(this.demo.hats ?? {})) if (!equip.has(id)) this.noteEquip(id, {});
    const states = [...last.values()].map((s) => this.withChara(s));
    for (const s of states) for (const f of this.state) f(s);
    return states;
  }

  /** actors the demo knows (first state of each id); built once, the theater asks every UI tick */
  roster(): { id: string; name: string; team: number }[] {
    if (this.rosterList) return this.rosterList;
    const seen = new Map<string, { id: string; name: string; team: number }>();
    for (const r of this.demo.recs) if (r.k === "state" && !seen.has(r.s.id)) seen.set(r.s.id, { id: r.s.id, name: r.s.name, team: r.s.team });
    return (this.rosterList = [...seen.values()]);
  }
  private rosterList: { id: string; name: string; team: number }[] | null = null;

  sendState(): void {}
  sendHit(): void {}
  sendKill(): void {}
  onRemoteState(cb: Cb<PlayerState>) { return sub(this.state, cb); }
  onRemoteHit(cb: Cb<HitEvent>) { return sub(this.hit, cb); }
  onRemoteKill(cb: Cb<KillEvent>) { return sub(this.kill, cb); }
  onRemoteLeave(cb: Cb<string>) { return sub(this.leave, cb); }
  onRemoteThrow(cb: Cb<ThrowEvent>) { return sub(this.thrown, cb); }
  onRemotePropBreak(cb: Cb<number>) { return sub(this.prop, cb); }
  dispose(): void {}
}

function sub<T>(list: Cb<T>[], cb: Cb<T>): () => void {
  list.push(cb);
  return () => { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); };
}

/** string -> [0, 1) (FNV-1a) */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) / 2 ** 32;
}
