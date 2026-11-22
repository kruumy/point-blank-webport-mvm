export interface CamPose { pos: [number, number, number]; yaw: number; pitch: number; roll: number; fov: number }
export interface CamKey extends CamPose { t: number }

const CH = 7; // x y z yaw pitch roll fov
const flat = (k: CamPose): number[] => [k.pos[0], k.pos[1], k.pos[2], k.yaw, k.pitch, k.roll, k.fov];

/** [RECRIADO] Dolly campath: camera keyframes on the demo clock, sampled with a Hermite spline whose tangents come from the
 * neighbours over their real time gaps (uneven key spacing keeps an even speed through each key). */
export class Campath {
  keys: CamKey[] = [];

  /** adds a key (replaces one at the same time) */
  add(k: CamKey): number {
    this.keys = this.keys.filter((o) => Math.abs(o.t - k.t) > 1e-3);
    const i = this.keys.findIndex((o) => o.t > k.t);
    const at = i < 0 ? this.keys.length : i;
    this.keys.splice(at, 0, { ...k, pos: [...k.pos] as CamKey["pos"] });
    this.unwrapAll();
    return at;
  }

  remove(i: number): void { this.keys.splice(i, 1); this.unwrapAll(); }

  /** every key's yaw / roll within pi of the key before it: an insert, move or removal can leave two neighbours further apart,
   * and the camera would turn the long way between them */
  unwrapAll(): void {
    for (let i = 1; i < this.keys.length; i++) {
      const k = this.keys[i], p = this.keys[i - 1];
      k.yaw = unwrap(k.yaw, p.yaw);
      k.roll = unwrap(k.roll, p.roll);
    }
  }
  clear(): void { this.keys = []; }

  /** moves key `i` to time `t`, keeping the list sorted; returns its new index */
  retime(i: number, t: number): number {
    const [k] = this.keys.splice(i, 1);
    return this.add({ ...k, t });
  }

  get start(): number { return this.keys[0]?.t ?? 0; }
  get end(): number { return this.keys[this.keys.length - 1]?.t ?? 0; }

  sample(t: number): CamPose | null {
    const K = this.keys, n = K.length;
    if (!n) return null;
    if (n === 1 || t <= K[0].t) return copy(K[0]);
    if (t >= K[n - 1].t) return copy(K[n - 1]);
    let i = 0;
    while (K[i + 1].t < t) i++;
    const k0 = K[i], k1 = K[i + 1], h = k1.t - k0.t, s = (t - k0.t) / h;
    const p0 = flat(k0), p1 = flat(k1), m0 = this.tangent(i), m1 = this.tangent(i + 1);
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const v = Array.from({ length: CH }, (_, c) => h00 * p0[c] + h10 * h * m0[c] + h01 * p1[c] + h11 * h * m1[c]);
    return { pos: [v[0], v[1], v[2]], yaw: v[3], pitch: v[4], roll: v[5], fov: v[6] };
  }

  speed(t: number): number {
    const K = this.keys;
    if (K.length < 2 || t < K[0].t || t > K[K.length - 1].t) return 0;
    const d = 1e-3, t0 = Math.max(K[0].t, t - d), t1 = Math.min(K[K.length - 1].t, t + d), a = this.sample(t0)!, b = this.sample(t1)!;
    return t1 > t0 ? Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]) / (t1 - t0) : 0;
  }

  /** per-second slope at key i: central difference inside, one-sided at the ends */
  private tangent(i: number): number[] {
    const K = this.keys, a = K[Math.max(0, i - 1)], b = K[Math.min(K.length - 1, i + 1)];
    const pa = flat(a), pb = flat(b), dt = b.t - a.t || 1;
    return pa.map((v, c) => (pb[c] - v) / dt);
  }
}

export function unwrap(a: number, ref: number): number {
  while (a - ref > Math.PI) a -= Math.PI * 2;
  while (a - ref < -Math.PI) a += Math.PI * 2;
  return a;
}

const copy = (k: CamKey): CamPose => ({ pos: [...k.pos] as CamKey["pos"], yaw: k.yaw, pitch: k.pitch, roll: k.roll, fov: k.fov });
