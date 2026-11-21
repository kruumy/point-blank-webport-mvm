import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlayerState } from "../../game/netAdapter.ts";

(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ weapons: [] }) });
const { packState, stateBits, encodeHitPart, decodeHitPart } = await import("../battle.ts");
const { makeHitIndex } = await import("../matchUdp.ts");

const base: PlayerState = {
  id: "slot1", name: "a", team: 0, pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, crouch: false, alive: true, hp: 100,
  weapon: "K-2", weaponSlot: 2, firing: false, airborne: true, t: 0,
};

test("packState round-trips helmetOff and ladder next to the other action bits", () => {
  for (const helmetOff of [false, true]) for (const ladder of [false, true]) for (const bot of [false, true]) {
    const act = packState({ ...base, helmetOff, ladder }, 0, bot).actionState!.action;
    assert.deepEqual(stateBits(act, true), { helmetOff, ladder });
    assert.equal((act >> 2) & 7, 2, "weapon slot untouched");
    assert.equal((act & 0x20) !== 0, bot, "bot flag untouched");
    assert.equal((act & 0x100) !== 0, true, "airborne untouched");
  }
  // a dead record carries neither (its value is the kill mark)
  assert.deepEqual(stateBits(packState({ ...base, helmetOff: true, ladder: true }, 0, false).actionState!.action, false), { helmetOff: false, ladder: false });
  // an older sender: no bits
  assert.deepEqual(stateBits(packState(base, 0, false).actionState!.action, true), { helmetOff: false, ladder: false });
});

test("a helmet block rides HitIndex bits 17-19 as HelmetProtection (3), the part stays the zone", () => {
  const { part, hitEnum } = encodeHitPart("head", true, true);
  const idx = makeHitIndex(4, 120, part, 2, hitEnum);
  assert.equal((idx >>> 17) & 7, 3); // matchCore hitHelmet -> HitType.HelmetProtection
  assert.equal((idx >>> 11) & 63, 14); // CharaHitPart.HEAD
  assert.equal(idx >>> 21, 120);
  assert.deepEqual(decodeHitPart((idx >>> 11) & 63, (idx >>> 17) & 7), { zone: "head", helmetBlocked: true });
  const plain = encodeHitPart("torso", false, false);
  assert.equal((makeHitIndex(4, 30, plain.part, 2, plain.hitEnum) >>> 17) & 7, 0);
  // the helmet popped but the hit went through: not HelmetProtection, still a pop for the peers
  const through = encodeHitPart("head", true, false);
  assert.equal(through.hitEnum, 0);
  assert.deepEqual(decodeHitPart(through.part, through.hitEnum), { zone: "head", helmetBlocked: true });
});
