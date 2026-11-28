import type { PlayerState } from "./netAdapter";

/** the ADS flag a state says: "zoom" is the only torso state that carries it, "idle" clears it, the one-shots in between say nothing */
function zoomOf(s: PlayerState): boolean | undefined {
  const torso = s.torsoAction ?? (s.firing ? "fire" : "idle");
  return torso === "zoom" || torso === "idle" ? torso === "zoom" && (s.zoomType === 2 || s.zoomType === 3) : undefined;
}

const keyOf = (s: PlayerState) => s.weaponId || s.weapon;

/** a remote's zoom after state `s`; a seek passes his recorded `track` up to `now` */
export function replicatedZoom(aiming: boolean, s: PlayerState, weaponChanged: boolean, track?: { t: number[]; s: PlayerState[] }, now = Infinity): boolean {
  if (track) {
    let i = track.t.length - 1;
    while (i >= 0 && track.t[i] > now) i--;
    // the raw recorded states, not `s`: a theater weapon edit renames the seek's state only
    for (let j = i; j >= 0 && keyOf(track.s[j]) === keyOf(track.s[i]); j--) {
      const z = zoomOf(track.s[j]);
      if (z !== undefined) return z;
    }
    return false;
  }
  // a swap drops the zoom (the sender's setZoom(false) while switching): his switch state still says the old gun's zoom, and "change" kept it
  return weaponChanged ? false : zoomOf(s) ?? aiming;
}
