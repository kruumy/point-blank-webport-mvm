import type { HeadEquip } from "../game/actorEquip";
import type { HitEvent, KillEvent, PlayerState, ThrowEvent } from "../game/netAdapter";

/** [RECRIADO] Point Blank has no demo format: a demo here is what a guest of the match receives (net/battle.ts), the
 * PlayerState of every actor and the reliable events, stamped with the match clock. One gzip'd JSON line per record
 * (first line = header), written while the match runs so the browser only holds the compressed bytes. */
export type DemoEvent =
  | { k: "state"; s: PlayerState }
  | { k: "kill"; e: KillEvent }
  | { k: "hit"; e: HitEvent }
  | { k: "throw"; e: ThrowEvent }
  | { k: "prop"; i: number }
  | { k: "leave"; id: string }
  /** the actor's head items from its 5138 (actorEquip.ts); absent in older demos = bare heads */
  | { k: "equip"; id: string; eq: HeadEquip };
/** t = seconds since the first record */
export type DemoRecord = DemoEvent & { t: number };

export interface DemoHeader {
  v: 1; map: string; mode: string; date: string; pov: string;
  /** [RECRIADO] theater edits: death clip by "<actor id>@<time the death starts>" (demoNet.ts deathKey) */
  deaths?: Record<string, string>;
  /** [RECRIADO] theater edits: character itemId by actor id, over the recorded one */
  charas?: Record<string, number>;
  /** [RECRIADO] theater edits: head / beret item by actor id over the recorded ones (0 = no item: the character's default helmet) */
  hats?: Record<string, { head: number; beret: number }>;
  /** [RECRIADO] theater edits: display name by actor id, over the recorded one (kill feed, HUD, name tags) */
  names?: Record<string, string>;
}
export interface Demo extends DemoHeader { name: string; dur: number; recs: DemoRecord[] }

export const DEMO_API = "/__mvm";

// mm / mrad precision: a demo of a full room stays a few MB
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const v3 = (v: [number, number, number]): [number, number, number] => [r3(v[0]), r3(v[1]), r3(v[2])];

export class DemoRecorder {
  private readonly cs = new CompressionStream("gzip");
  private readonly writer = this.cs.writable.getWriter();
  private readonly out = new Response(this.cs.readable).blob();
  private readonly enc = new TextEncoder();
  private buf = "";
  private t0 = -1;
  private last = 0;
  private count = 0;
  private closed = false;

  private readonly head: Omit<DemoHeader, "v" | "date">;

  // a plain field, not a parameter property: node's type stripping (src/net/test) cannot run those
  constructor(head: Omit<DemoHeader, "v" | "date">) {
    this.head = head;
    this.line({ v: 1, date: new Date().toISOString(), ...head });
  }

  add(time: number, ev: DemoEvent): void {
    if (this.closed) return;
    if (this.t0 < 0) this.t0 = time;
    this.last = r3(time - this.t0);
    const rec = ev.k === "state"
      ? { k: "state", s: { ...ev.s, pos: v3(ev.s.pos), vel: v3(ev.s.vel), yaw: r3(ev.s.yaw), pitch: r3(ev.s.pitch) } }
      : ev;
    this.line({ t: this.last, ...rec });
    this.count++;
  }

  private line(o: object): void {
    this.buf += JSON.stringify(o) + "\n";
    if (this.buf.length > 1 << 16) this.flush();
  }

  private flush(): void {
    if (!this.buf) return;
    void this.writer.write(this.enc.encode(this.buf));
    this.buf = "";
  }

  /** closes the stream and stores it through the dev server (scripts/mvm-server.ts); a match too short to watch is dropped */
  async save(): Promise<string | null> {
    if (this.closed) return null;
    this.closed = true;
    this.flush();
    await this.writer.close();
    const blob = await this.out;
    if (this.last < 5 || this.count < 20) return null;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name = `${stamp}_${this.head.map}.pbdemo`;
    const r = await fetch(`${DEMO_API}/demos/${encodeURIComponent(name)}`, { method: "PUT", body: blob });
    if (!r.ok) throw new Error(`demo save ${r.status}`);
    console.info(`[mvm] demo saved: ${name} (${this.count} records, ${this.last.toFixed(0)} s, ${(blob.size / 1e6).toFixed(1)} MB)`);
    return name;
  }
}

export interface DemoListing { name: string; size: number; mtime: number }

// read from the .pbdemo itself (scripts/mvm-server.ts demoInfo): demos carry no side files
export interface DemoInfo { map: string; mode: string; date: string; pov: string; dur: number; players: { id: string; name: string; team: number }[] }

export async function demoInfo(name: string): Promise<DemoInfo> {
  const r = await fetch(`${DEMO_API}/demos/${encodeURIComponent(name)}?info`);
  if (!r.ok) throw new Error(`demo info ${r.status}`);
  return r.json() as Promise<DemoInfo>;
}

export async function listDemos(): Promise<DemoListing[]> {
  const r = await fetch(`${DEMO_API}/demos`);
  if (!r.ok) throw new Error(`demo list ${r.status}`);
  return r.json() as Promise<DemoListing[]>;
}

/** null = done, else the server's reason */
export async function renameDemo(name: string, to: string): Promise<string | null> {
  const r = await fetch(`${DEMO_API}/demos/${encodeURIComponent(name)}?to=${encodeURIComponent(to)}`, { method: "POST" });
  return r.ok ? null : ((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
}

export async function deleteDemo(name: string): Promise<boolean> {
  return (await fetch(`${DEMO_API}/demos/${encodeURIComponent(name)}`, { method: "DELETE" })).ok;
}

/** writes the demo back over its file: the header with its edits, then the records */
export async function saveDemo(d: Demo): Promise<void> {
  const { name: _n, dur: _d, recs, ...head } = d;
  // deathPick is derived on load (demoNet.ts), not recorded
  const line = (o: object) => JSON.stringify(o, (k, v) => (k === "deathPick" ? undefined : v)) + "\n";
  const parts = [line(head)];
  for (const r of recs) parts.push(line(r));
  const gz = new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"));
  const r = await fetch(`${DEMO_API}/demos/${encodeURIComponent(d.name)}`, { method: "PUT", body: await new Response(gz).blob() });
  if (!r.ok) throw new Error(`demo save ${r.status}`);
}

export async function loadDemo(name: string): Promise<Demo> {
  const r = await fetch(`${DEMO_API}/demos/${encodeURIComponent(name)}`);
  if (!r.ok || !r.body) throw new Error(`demo load ${r.status}`);
  const text = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
  const lines = text.split("\n").filter(Boolean);
  if (!lines.length) throw new Error("empty demo");
  const head = JSON.parse(lines[0]) as DemoHeader;
  if (head.v !== 1) throw new Error(`demo version ${head.v}`);
  const recs = lines.slice(1).map((l) => JSON.parse(l) as DemoRecord);
  // demos recorded before PlayerState.silencer became ext
  for (const r of recs) if (r.k === "state" && "silencer" in r.s) r.s.ext = (r.s as { silencer?: boolean }).silencer;
  return { ...head, name, dur: recs.length ? recs[recs.length - 1].t : 0, recs };
}
