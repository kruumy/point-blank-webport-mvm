// Clan menu rules: who may run which action, the text of each failure, and the display of
// dates / presence. Pure functions only: the page (pages/clan.ts) asks here before it sends, the server checks again.
import { ClanErr, CLAN_STATE, type ClanStatus } from "../../net/clanClient.ts";

/** clanAccess of the account (server: 1 leader = system_clan.owner_id, 2 staff, 3 normal, 0 outside the clan) */
export const CLAN_ACCESS = { OUTSIDE: 0, LEADER: 1, STAFF: 2, NORMAL: 3 } as const;

/** staff() of the server: leader or staff (kick, accept / deny requests, notice and intro) */
export const canManage = (access: number): boolean => access === CLAN_ACCESS.LEADER || access === CLAN_ACCESS.STAFF;
export const isLeader = (access: number): boolean => access === CLAN_ACCESS.LEADER;

/** member-list actions (clanHandlers.ts 830 / 836 / 839 / 833): who may run each, and the access the target must have */
export type MemberAction = "deport" | "staff" | "regular" | "master";
export interface MemberActionDef { id: MemberAction; key: [string, string]; can: (access: number) => boolean; target: number }
export const MEMBER_ACTIONS: MemberActionDef[] = [
  { id: "deport", key: ["STBL_IDX_CLAN_CAPTION_DISMISSAL_MEMBER", "Expulsar membro"], can: canManage, target: CLAN_ACCESS.NORMAL },
  { id: "staff", key: ["STBL_IDX_CLAN_CAPTION_APPOINT_MEMBER", "Promover Membro"], can: isLeader, target: CLAN_ACCESS.NORMAL },
  { id: "regular", key: ["STBL_IDX_CLAN_CAPTION_DEMOTE_MEMBER", "Rebaixar membro"], can: canManage, target: CLAN_ACCESS.STAFF },
  { id: "master", key: ["STBL_IDX_CLAN_CAPTION_COMMISSION_MASTER", "Change leader"], can: isLeader, target: CLAN_ACCESS.STAFF },
];

/** failure caption of each action (strings.json keys; the exe's CAPTION_*_FAIL) */
export type ClanOp = "create" | "join" | "cancelJoin" | "secede" | "close" | "accept" | "deny" | "deport" | "staff" | "regular" | "master" | "notice" | "intro";
const FAIL_CAPTION: Record<ClanOp, [string, string]> = {
  create: ["STBL_IDX_CLAN_CAPTION_FAIL_CREATING", "Clan creation failed"],
  join: ["STBL_IDX_CLAN_CAPTION_SUBSCRIPTION_FAIL", "Could not register in the clan"],
  cancelJoin: ["STBL_IDX_CLAN_CAPTION_CANCEL_REQUEST_FAIL", "Failed to cancel the application"],
  secede: ["STBL_IDX_CLAN_CAPTION_SECESSION_FAIL", "Failed to leave the clan."],
  close: ["STBL_IDX_CLAN_CAPTION_DISSOLUTION_FAIL", "Failed to delete the clan."],
  accept: ["STBL_IDX_CLAN_CAPTION_SUBSCRIPTION_FAIL", "Could not register in the clan"],
  deny: ["STBL_IDX_CLAN_CAPTION_REJECTION_FAIL", "Failed to reject application."],
  deport: ["STBL_IDX_CLAN_CAPTION_DISMISSAL_FAIL", "Failed to kick"],
  staff: ["STBL_IDX_CLAN_CAPTION_COMMISION_STAFF_FAIL", "Failed to make member Staff."],
  regular: ["STBL_IDX_CLAN_CAPTION_COMMISION_REGULAR_FAIL", "Failed to demote to Regular."],
  master: ["STBL_IDX_CLAN_CAPTION_COMMISION_MASTER_FAIL", "Failed to change the clan owner."],
  notice: ["STBL_IDX_CLAN_CAPTION_MODIFY_FAIL", "Failed to save changes."],
  intro: ["STBL_IDX_CLAN_CAPTION_MODIFY_FAIL", "Failed to save changes."],
};
/** the specific server errors that have their own text; any other error gets the action's caption */
const SPECIFIC: Record<number, [string, string]> = {
  [ClanErr.CREATE_CONDITION]: ["STBL_IDX_CLAN_NEED_HIGH_RANK", "Level too low to create a clan."],
  [ClanErr.NAME_IN_USE]: ["STBL_IDX_CLAN_MESSAGE_FAIL_CREATING_OVERLAPPING", "\nClan creation failed.\nA clan with the same name \nor web address already exists."],
  [ClanErr.ALREADY_IN_CLAN]: ["STBL_IDX_CLAN_MESSAGE_ALREADY_SUBSCRIPTION", "An application already exists."],
  [ClanErr.OWNER_CANNOT_SECEDE]: ["STBL_IDX_CLAN_MESSAGE_SECESSION_MASTER_FAIL", "The clan owner cannot leave."],
  [ClanErr.MASTER_RANK]: ["STBL_IDX_CLAN_CAPTION_COMMISION_MASTER_FAIL_RANK", "The clan owner cannot give permissions to this member."],
  [ClanErr.RANK_LIMIT]: ["STBL_IDX_CLAN_MESSAGE_CANNOT_SUBSCRIPTION_RANK", "Cannot register: level below the clan's limit."],
};

/** text of a failed clan request: the server's special case, else the action's caption */
export function failText(op: ClanOp, err: number): [string, string] {
  return SPECIFIC[err] ?? FAIL_CAPTION[op];
}

/** clan dates (create / join / request: server fmtDate "yyyyMMdd", e.g. 20261012) as STBL_IDX_CLAN_DECLARE_DATE: "%04d/%02d/%02d".
 * A 10-digit "yyMMddHHmm" value (item expiry format) is read too. */
export function clanDate(v: number): string {
  if (!v) return "-";
  const [y, m, d] = v >= 1e9
    ? [2000 + (Math.floor(v / 1e8) % 100), Math.floor(v / 1e6) % 100, Math.floor(v / 1e4) % 100]
    : [Math.floor(v / 1e4), Math.floor(v / 100) % 100, v % 100];
  return `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`;
}

/** presence of a member row: the key and fallback of the state text (CLAN_STATE codes of clanClient.ts) */
export function presence(status: ClanStatus): [string, string] {
  switch (status.state) {
    case CLAN_STATE.ONLINE: return ["STBL_IDX_CLAN_ONLINE", "Online"];
    case CLAN_STATE.ROOM: return ["STBL_IDX_CLAN_DECLARE_ROOM", "Channel %d Room %d"];
    case CLAN_STATE.LOBBY: return ["STBL_IDX_CLAN_ONLINE", "Online"];
    default: return ["STBL_IDX_CLAN_OFFLINE", "Offline"];
  }
}
