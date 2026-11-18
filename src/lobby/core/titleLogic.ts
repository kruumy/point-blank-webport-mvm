// Perfil / Títulos phase (UIPhaseProfile, PointBlankRe_MyInfomation + _Designation): title rules and texts, no DOM.
// Rules mirror server profileHandlers.ts handleTitleChange / handleTitleEquip / handleTitleRelease (the C#
// PROTOCOL_BASE_USER_TITLE_*_REQ), so the client greys out exactly what the server would refuse. Texts are the
// client's own STR_TBL_DESIGNATION_* / STR_HEADER_* (pt-BR.json); Lua flow of the scene: PointBlankRe_MyInfomation_Designation.lua.
import { tOr } from "../ui/i18n.ts";
import { cleanLabel } from "../screens/strings.ts";
import { AUTHORITY_EFFECTS, EFFECTS, TITLES, type TitleDef } from "./titleData.ts";

export const TITLE_COUNT = TITLES.length;
/** equip slots of the profile (i3UIButtonMySlot1..3); `slots` of the account says how many are unlocked */
export const TITLE_SLOTS = 3;
export const titleDef = (id: number): TitleDef | undefined => (id >= 1 && id <= TITLE_COUNT ? TITLES[id - 1] : undefined);

export interface TitleState {
  /** bit `id` set = title owned (server PlayerTitles.Flags, `1 << id`) */
  flags: bigint;
  equiped: [number, number, number];
  slots: number;
  /** badges consumed by getting titles (2363): Broche / Insígnia / Medalha / Ordem Azul */
  ribbon: number; ensign: number; medal: number; master: number;
  /** false until the first 2383 of the session arrived */
  known: boolean;
}
export const emptyTitleState = (): TitleState => ({ flags: 0n, equiped: [0, 0, 0], slots: 1, ribbon: 0, ensign: 0, medal: 0, master: 0, known: false });

export const hasTitle = (s: TitleState, id: number): boolean => id > 0 && (s.flags & (1n << BigInt(id))) !== 0n;
export const titleSlotOf = (s: TitleState, id: number): number => s.equiped.indexOf(id);

/** why handleTitleChange would refuse `def` (null = it would accept) */
export type GetBlock = "owned" | "rank" | "badges" | "required";
export function getBlock(s: TitleState, rank: number, d: TitleDef): GetBlock | null {
  if (hasTitle(s, d.id)) return "owned";
  if (rank < d.rank) return "rank";
  if (s.ribbon < d.ribbon || s.ensign < d.ensign || s.medal < d.medal || s.master < d.master) return "badges";
  if ((d.req1 && !hasTitle(s, d.req1)) || (d.req2 && !hasTitle(s, d.req2))) return "required";
  return null;
}

/** why handleTitleEquip would refuse `id` in `slot` (null = it would accept); slot >= slots is locked (client rule: the Lock icon) */
export type EquipBlock = "locked" | "notOwned" | "already" | "sameClass";
export function equipBlock(s: TitleState, id: number, slot: number): EquipBlock | null {
  const d = titleDef(id);
  if (slot < 0 || slot >= TITLE_SLOTS || slot >= s.slots) return "locked";
  if (!d || !hasTitle(s, id)) return "notOwned";
  if (s.equiped.includes(id)) return "already";
  if (s.equiped.some((e, i) => i !== slot && e && titleDef(e)?.classId === d.classId)) return "sameClass";
  return null;
}

// ------------------------------------------------------------------------------------------------ texts

/** STR_TBL_DESIGNATION_NAME_NO<set-1> (the table indexes DesignationSet, not the wire id) */
export const titleName = (d: TitleDef): string => cleanLabel(tOr(`STR_TBL_DESIGNATION_NAME_NO${d.set - 1}`, `#${d.id}`));
/** STR_TBL_DESIGNATION_EXPLAIN_NO<set-1>; some titles have none */
export const titleExplain = (d: TitleDef): string => cleanLabel(tOr(`STR_TBL_DESIGNATION_EXPLAIN_NO${d.set - 1}`, ""));
export const rankName = (rank: number): string => cleanLabel(tOr(`STBL_IDX_RANK_${rank}`, `${rank}`));

/** text of one effect id ("" = none): STR_HEADER_<key> of the exe's id table (CDesignationValueSet 0x4d29d0 -> _setUserTitleEffectText
 * 0x4d01f0). Authority ids (weapon unlocks) have no text of their own, see `effectRows`. */
export function effectText(id: number): string {
  const e = EFFECTS[id];
  return e && e[0] ? cleanLabel(tOr(`STR_HEADER_${e[0]}`, "")) : "";
}

/** AuthWeaponClass / Number -> item id (Dragunov G = class 5, number 6 = 105006, which is also its server award) */
export const weaponItemId = (cls: number, num: number): number => 100000 + cls * 1000 + num;
export function weaponText(cls: number, num: number, nameOf: (itemId: number) => string): string {
  const name = nameOf(weaponItemId(cls, num));
  return name ? cleanLabel(tOr("STR_HEADER_AUTHORITY_WEAPON", "%s").replace("%s", name)) : "";
}

const NONE = (n: 1 | 2 | 3): string => cleanLabel(tOr(`STR_TBL_DESIGNATION_NONE_WITH_COLOR${n}`, "Unavailable"));
const joined = (xs: string[], none: string): string => (xs.length ? xs.join("\n") : none);
/** Efeito + / Efeito - / Efeito extra rows of a title (i3UIEffectPlus / Minus / Add), UITabProfileDesignation::__UpdateDetailInfoBox
 * 0x950eb0: two slots per row, empty = "Indisponível" (NONE_WITH_COLOR1 / 2 / 3). Extra row, per slot: id 0 or an authority id ->
 * "Permissão de compra de <arma>" for the n-th weapon of the title (none -> nothing); other ids -> their effect text. */
export function effectRows(d: TitleDef, nameOf: (itemId: number) => string): { plus: string; minus: string; add: string } {
  const add: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = d.add[i] ?? 0;
    const t = !id || AUTHORITY_EFFECTS.includes(id)
      ? (d.weapon[i] ? weaponText(d.weapon[i][0], d.weapon[i][1], nameOf) : "")
      : effectText(id);
    if (t) add.push(t);
  }
  return { plus: joined(d.plus.map(effectText).filter(Boolean), NONE(1)), minus: joined(d.minus.map(effectText).filter(Boolean), NONE(2)), add: joined(add, NONE(3)) };
}

/** second line of the title name box (SetDesignTitle: "{blue}NAME_NO{/col}
{gray}NAME2_NO{/col}"; NAME2 is the title's English name) */
export const titleName2 = (d: TitleDef): string => cleanLabel(tOr(`STR_TBL_DESIGNATION_NAME2_NO${d.set - 1}`, ""));

/** count lines of the badge rows: "Possui %d und." (owned) / "Precisa de %d und." (needed) */
export const ownedText = (n: number): string => cleanLabel(tOr("STR_TBL_DESIGNATION_APPENDIX_BADGECOUNT_TEXT", "Possui %d und.")).replace("%d", String(n));
export const neededText = (n: number): string => cleanLabel(tOr("STR_TBL_DESIGNATION_NEEDED_BADGECOUNT_TEXT", "Needs %d pcs.")).replace("%d", String(n));

export const TS = {
  get select() { return cleanLabel(tOr("STR_TBL_DESIGNATION_GET_SELECT", "Choose the title")); },
  get none() { return cleanLabel(tOr("STR_TBL_DESIGNATION_NONE_WITH_COLOR3", "Unavailable")); },
  get getText() { return cleanLabel(tOr("STR_TBL_DESIGNATION_GET_TEXT", "Get Title")); },
  get useText() { return cleanLabel(tOr("STR_TBL_DESIGNATION_USE_TEXT", "Use Title")); },
  get releaseText() { return cleanLabel(tOr("STR_TBL_DESIGNATION_RELEASE_TEXT", "Cancel Title")); },
  get getAsk() { return cleanLabel(tOr("STR_TBL_DESIGNATION_GET_ANSWER_MESSAGE", "Get the chosen title?")); },
  get equipAsk() { return cleanLabel(tOr("STR_TBL_DESIGNATION_EQUIP_ANSWER_MESSAGE", "Equip the chosen title?")); },
  get releaseAsk() { return cleanLabel(tOr("STR_TBL_DESIGNATION_RELEASE_ANSWER_MESSAGE", "Cancel the chosen title?")); },
  get noSlot() { return cleanLabel(tOr("STR_TBL_DESIGNATION_NO_SELECTED_SLOT_MESSAGE", "No slot chosen.")); },
  get sameClass() { return cleanLabel(tOr("STR_TBL_DESIGNATION_FAIL_ANOTHER_USED", "You are already using a title of the same type.")); },
  get dupSlot() { return cleanLabel(tOr("STR_TBL_NETWORK_DUPLICATED_DESIGNATION_TYPE", "The title is already used in another slot.")); },
  get notMatch() { return cleanLabel(tOr("STR_TBL_NETWORK_NOT_MATCH_BUY_DESIGNATION", "Purchase conditions not met.")); },
  get noEquipYet() { return cleanLabel(tOr("STR_TBL_GUI_BASE_NO_EQUIP_PRE_DESIGNATION", "Cannot equip before earning the title.")); },
  get gotIt() { return cleanLabel(tOr("STR_TBL_NETWORK_SUCESS_GET_DESIGNATION", "Title obtained successfully.")); },
  get gotPrize() { return cleanLabel(tOr("STR_TBL_NETWORK_SUCESS_GET_DESIGNATION_WITH_PRIZE", "You received a reward for earning the title.")); },
  get registered() { return cleanLabel(tOr("STR_TBL_NETWORK_REGISTER_DESIGNATION", "The chosen title was registered successfully.")); },
  get releaseFail() { return cleanLabel(tOr("STR_TBL_NETWORK_FAIL_RELEASE_DESIGNATION", "Failed to cancel the title.")); },
  get already() { return cleanLabel(tOr("STR_TBL_NETWORK_ALREADY_GET_DESIGNATION", "You already have this title.")); },
  get slotHint() { return cleanLabel(tOr("STR_TBL_DESIGNATION_GET_EXPLAIN_MESSAGE", "Choose the slot to equip the title and confirm.")).split("\n")[0]; },
};
