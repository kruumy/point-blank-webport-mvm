// Stronger 3rd-person pistol recoil, a personal change (not how Cross looks).
//
// Cross gives the Colt45, Colt Python, Desert Eagle, K5, MK23, P99 and Taurus one shared shot clip,
// handgun/Common/Up_Attack, which barely moves the arms (~10 degrees in 0.17 s). This script replaces it in the
// exported assets with the Black Pearl's shot (black-pearl/Black-Pearl/Up_Attack_A: the wrist flicks up ~24 degrees
// over 0.53 s), moved onto the normal handgun hold. Each frame, IK moves the left arm so the left hand stays on the
// grip and rises with the right hand.
//
// Usage, from the repo root, after the assets are exported (public/assets/chars/<skel>/anim3pv/ exists):
//   node scripts/bake-handgun-kick.mjs                # swat_male and swat_female
//   node scripts/bake-handgun-kick.mjs swat_male      # one skeleton
// Then reload the page. It rewrites public/assets/chars/<skel>/anim3pv/handgun_Common.glb in place:
// - The first run keeps the exported file as handgun_Common.glb.orig and every run bakes from it, so re-runs are safe.
//   To undo, copy the .orig back over handgun_Common.glb.
// - Any pbx export that rewrites the 3rd-person animations brings the original clip back; run this again afterwards.
// - public/assets is not in git, so other players need your baked file or must run this themselves.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const CHARS = fileURLToPath(new URL("../public/assets/chars/", import.meta.url));
const N = { SCALAR: 1, VEC3: 3, VEC4: 4 };

function readGlb(fn) {
  const b = fs.readFileSync(fn), jl = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jl).toString());
  const bs = 20 + jl, bl = b.readUInt32LE(bs);
  return { j, bin: Buffer.from(b.subarray(bs + 8, bs + 8 + bl)) };
}
function acc(g, i) {
  const a = g.j.accessors[i], bv = g.j.bufferViews[a.bufferView], n = N[a.type];
  if (a.componentType !== 5126) throw new Error("not float");
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0), st = bv.byteStride || 4 * n, out = [];
  for (let k = 0; k < a.count; k++) { const v = []; for (let c = 0; c < n; c++) v.push(g.bin.readFloatLE(off + k * st + c * 4)); out.push(v); }
  return out;
}
function clip(g, name) {
  const an = g.j.animations.find((a) => a.name === name);
  if (!an) throw new Error(`no ${name}`);
  const out = {};
  for (const ch of an.channels) {
    const s = an.samplers[ch.sampler];
    if ((s.interpolation ?? "LINEAR") !== "LINEAR") throw new Error("not linear");
    const bone = g.j.nodes[ch.target.node].name;
    (out[bone] ??= {})[ch.target.path] = { t: acc(g, s.input).map((x) => x[0]), v: acc(g, s.output) };
  }
  return out;
}
function sample(tr, time) {
  const { t, v } = tr;
  if (time <= t[0]) return v[0].slice();
  if (time >= t[t.length - 1]) return v[v.length - 1].slice();
  let i = 0;
  while (t[i + 1] < time) i++;
  const a = (time - t[i]) / (t[i + 1] - t[i]);
  if (v[i].length === 4) return new THREE.Quaternion().fromArray(v[i]).slerp(new THREE.Quaternion().fromArray(v[i + 1]), a).toArray();
  return v[i].map((x, k) => x + (v[i + 1][k] - x) * a);
}
const first = (c, bone, p) => c[bone]?.[p]?.v[0];

// [RECRIADO] personal change, not Cross: the shared handgun Up_Attack becomes the Black Pearl kick on the handgun hold; a pbx re-export undoes it
for (const skel of process.argv.slice(2).length ? process.argv.slice(2) : ["swat_male", "swat_female"]) bake(`${CHARS}${skel}`);

function bake(dir) {
  const outFile = `${dir}/anim3pv/handgun_Common.glb`, orig = `${outFile}.orig`;
  if (!fs.existsSync(orig)) fs.copyFileSync(outFile, orig);
  const model = readGlb(`${dir}/model.glb`);
  const hg = readGlb(orig);
  const bpC = readGlb(`${dir}/anim3pv/black-pearl_Common.glb`);
  const bpW = readGlb(`${dir}/anim3pv/black-pearl_Black-Pearl.glb`);
  const onto = clip(hg, "handgun/Common/Up_AttackIdle");
  const from = clip(bpC, "black-pearl/Common/Up_AttackIdle");
  const shot = clip(bpW, "black-pearl/Black-Pearl/Up_Attack_A");

  // skeleton: rest TRS + parent by name
  const nodes = model.j.nodes, parent = {}, rest = {};
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[nodes[c].name] = n.name)));
  for (const n of nodes) rest[n.name] = { translation: n.translation ?? [0, 0, 0], rotation: n.rotation ?? [0, 0, 0, 1], scale: n.scale ?? [1, 1, 1] };
  const order = [];
  const seen = new Set();
  const visit = (name) => { if (seen.has(name)) return; if (parent[name]) visit(parent[name]); seen.add(name); order.push(name); };
  nodes.forEach((n) => visit(n.name));

  // shot keyed at the union of its times
  const times = [...new Set(Object.values(shot).flatMap((b) => Object.values(b).flatMap((tr) => tr.t)))].sort((a, b) => a - b);

  /** the rebased kick at `time`: rest <- handgun idle frame 0 <- shot as offsets from the Black Pearl idle */
  function pose(time) {
    const P = {};
    for (const b of order) {
      P[b] = {};
      for (const p of ["translation", "rotation", "scale"]) P[b][p] = (first(onto, b, p) ?? rest[b][p]).slice();
    }
    for (const [b, tr] of Object.entries(shot)) for (const [p, track] of Object.entries(tr)) {
      if (!P[b]) continue;
      const v = sample(track, time), a = first(from, b, p), o = first(onto, b, p);
      if (!a || !o) { P[b][p] = v; continue; }
      if (p === "rotation") P[b][p] = new THREE.Quaternion().fromArray(o).multiply(new THREE.Quaternion().fromArray(a).invert().multiply(new THREE.Quaternion().fromArray(v))).toArray();
      else P[b][p] = v.map((x, k) => x + o[k] - a[k]);
    }
    return P;
  }
  function world(P) {
    const W = {};
    for (const b of order) {
      const m = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(P[b].translation), new THREE.Quaternion().fromArray(P[b].rotation), new THREE.Vector3().fromArray(P[b].scale));
      W[b] = parent[b] ? W[parent[b]].clone().multiply(m) : m;
    }
    return W;
  }
  const dec = (m) => { const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); m.decompose(p, q, s); return { p, q }; };

  const LH = "L Hand", LF = "L Forearm", LU = "L UpperArm", LT = "L Twist1", RH = "R Hand";
  for (const b of [LH, LF, LU, LT, RH]) if (!rest[b]) throw new Error(`no bone ${b}`);
  if (parent[LT] !== LU || parent[LF] !== LU) throw new Error("twist / forearm not siblings");

  const P0 = pose(times[0]), W0 = world(P0);
  const rel = W0[RH].clone().invert().multiply(W0[LH]);
  const out = {};
  let maxErr = 0, maxMove = 0;
  for (const time of times) {
    const P = pose(time);
    const foreOld = new THREE.Quaternion().fromArray(P[LF].rotation);
    let W = world(P);
    const target = dec(W[RH].clone().multiply(rel));
    maxMove = Math.max(maxMove, dec(W[LH]).p.distanceTo(target.p));
    for (let it = 0; it < 60; it++) {
      for (const b of [LF, LU]) {
        W = world(P);
        const bw = dec(W[b]), eff = dec(W[LH]).p;
        const v1 = eff.clone().sub(bw.p).normalize(), v2 = target.p.clone().sub(bw.p).normalize();
        const qW = new THREE.Quaternion().setFromUnitVectors(v1, v2);
        const pq = dec(W[parent[b]]).q;
        P[b].rotation = pq.clone().invert().multiply(qW.multiply(bw.q)).toArray();
      }
    }
    W = world(P);
    P[LH].rotation = dec(W[LF]).q.invert().multiply(target.q).toArray();
    const D = new THREE.Quaternion().fromArray(P[LF].rotation).multiply(foreOld.clone().invert());
    P[LT].rotation = D.multiply(new THREE.Quaternion().fromArray(P[LT].rotation)).toArray();
    W = world(P);
    maxErr = Math.max(maxErr, dec(W[LH]).p.distanceTo(target.p));
    const bones = new Set([...Object.keys(shot), LH, LF, LU, LT]);
    for (const b of bones) {
      if (!P[b]) continue;
      const ps = new Set(["rotation", ...Object.keys(shot[b] ?? {})]);
      for (const p of ps) ((out[b] ??= {})[p] ??= []).push(P[b][p]);
    }
  }
  console.log(`frames ${times.length} dur ${times.at(-1).toFixed(3)} | left hand off its grip without IK ${(maxMove * 100).toFixed(1)} cm, after IK ${(maxErr * 1000).toFixed(2)} mm`);

  // the original Up_Attack's accessors stay unreferenced in the buffer (~20 KB)
  const j = hg.j, chunks = [hg.bin];
  let len = hg.bin.length;
  const push = (arr, type, minmax) => {
    const n = N[type], buf = Buffer.alloc(arr.length * n * 4);
    arr.forEach((v, k) => v.forEach((x, c) => buf.writeFloatLE(x, (k * n + c) * 4)));
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); len += pad; }
    j.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: buf.length });
    chunks.push(buf); len += buf.length;
    const a = { bufferView: j.bufferViews.length - 1, componentType: 5126, count: arr.length, type };
    if (minmax) Object.assign(a, { min: [Math.min(...arr.map((v) => v[0]))], max: [Math.max(...arr.map((v) => v[0]))] });
    j.accessors.push(a);
    return j.accessors.length - 1;
  };
  const input = push(times.map((t) => [t - times[0]]), "SCALAR", true);
  const nodeIx = Object.fromEntries(j.nodes.map((n, i) => [n.name, i]));
  const samplers = [], channels = [];
  for (const [b, props] of Object.entries(out)) {
    if (nodeIx[b] === undefined) { console.warn("skip bone not in bundle", b); continue; }
    for (const [p, vals] of Object.entries(props)) {
      samplers.push({ input, output: push(vals, vals[0].length === 4 ? "VEC4" : "VEC3"), interpolation: "LINEAR" });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeIx[b], path: p } });
    }
  }
  const ai = j.animations.findIndex((a) => a.name === "handgun/Common/Up_Attack");
  if (ai < 0) throw new Error(`${orig} has no handgun/Common/Up_Attack`);
  j.animations[ai] = { name: "handgun/Common/Up_Attack", samplers, channels };
  const bin = Buffer.concat(chunks), binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  j.buffers[0].byteLength = binPad.length;
  let js = Buffer.from(JSON.stringify(j));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + binPad.length, 8);
  jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(binPad.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(outFile, Buffer.concat([head, jh, js, bh, binPad]));
  console.log("wrote", outFile, channels.length, "channels");
}
