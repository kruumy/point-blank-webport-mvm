import { test } from "node:test";
import assert from "node:assert/strict";
import type { Demo, DemoRecord } from "../../mvm/demo.ts";

const files = new Map<string, Uint8Array<ArrayBuffer>>();
(globalThis as any).fetch = async (url: string, init?: { method?: string; body?: Blob }) => {
  const name = decodeURIComponent(url.split("/").pop()!.split("?")[0]);
  if (init?.method === "PUT") { files.set(name, new Uint8Array(await init.body!.arrayBuffer())); return { ok: true }; }
  const b = files.get(name);
  return b ? { ok: true, body: new Blob([b]).stream() } : { ok: false, status: 404 };
};
const { saveDemo, loadDemo } = await import("../../mvm/demo.ts");
const { DemoNet } = await import("../../mvm/demoNet.ts");
const { actorEquip } = await import("../../game/actorEquip.ts");

const state = (t: number, extra: object): DemoRecord => ({
  t, k: "state", s: { id: "slot2", name: "b", team: 1, pos: [1, 2, 3], vel: [0, 0, 0], yaw: 0, pitch: 0, crouch: false, alive: true, hp: 100, weapon: "K-2", firing: false, t: 0, ...extra },
});

test("save / load keeps helmetOff, ladder, helmetBlocked and the equip record; seek restores them", async () => {
  const recs: DemoRecord[] = [
    { t: 0, k: "equip", id: "slot2", eq: { head: 701002, face: 0, beret: 0 } },
    state(0, { helmetOff: false, ladder: true }),
    { t: 1, k: "hit", e: { attackerId: "slot1", victimId: "slot2", weapon: "K-2", zone: "head", baseDamage: 0, preScaled: true, helmetPenetrate: 0, falloff: 1, point: [1, 3, 3], t: 0, helmetBlocked: true } },
    state(1.1, { helmetOff: true, ladder: false }),
  ];
  const demo: Demo = { v: 1, map: "marinewave", mode: "DM", date: "2026-11-19", pov: "slot1", name: "new.pbdemo", dur: 1.1, recs };
  await saveDemo(demo);
  const back = await loadDemo("new.pbdemo");
  assert.deepEqual(back.recs, recs);
  const net = new DemoNet(back);
  assert.equal(net.seek(0.5)[0].ladder, true);
  assert.equal(net.seek(2)[0].helmetOff, true);
  assert.equal(actorEquip("slot2")?.head, 701002);
});

test("an old demo (no helmetOff / ladder / helmetBlocked / equip) still loads: the fields read as absent", async () => {
  const lines = [{ v: 1, map: "luxville", mode: "DM", date: "2026-10-01", pov: "slot1" }, state(0, {}), state(1, { silencer: true })]
    .map((o) => JSON.stringify(o) + "\n");
  const gz = new Blob(lines).stream().pipeThrough(new CompressionStream("gzip"));
  files.set("old.pbdemo", new Uint8Array(await new Response(gz).arrayBuffer()));
  const old = await loadDemo("old.pbdemo");
  assert.equal(old.v, 1);
  const s = old.recs[1].k === "state" ? old.recs[1].s : null;
  assert.ok(s && !s.helmetOff && !s.ladder && s.ext === true);
  assert.equal(new DemoNet(old).seek(5).length, 1);
});
