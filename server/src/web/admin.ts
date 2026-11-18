import type http from "node:http";
import { readFileSync } from "node:fs";
import { pool } from "../db.ts";
import { isValidRank } from "../shared/rank.ts";
import { getIdStatics, getItemCategory, ItemCategory, ItemEquipType } from "../shared/items.ts";
import { nowNum } from "../shared/time.ts";
import { AccountApiError } from "./accounts/accounts.ts";
import { hashPassword } from "./accounts/password.ts";
import { credentialsSchema, isReservedNick } from "./accounts/validation.ts";
import { readJsonBody, sendJson } from "./webServer.ts";

const PAGE = readFileSync(new URL("./admin.html", import.meta.url));
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// the web front listens on 0.0.0.0 for LAN play: only this machine, and only the page it serves itself (Host and
// Origin checks shut out other sites calling localhost and DNS rebinding)
function isLocal(req: http.IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  let name: string;
  try { name = new URL(`http://${host}`).hostname; } catch { return false; }
  const origin = req.headers.origin;
  return LOOPBACK.has(req.socket.remoteAddress ?? "") && LOCAL_HOSTS.has(name) && (!origin || origin === `http://${host}`);
}

const INT_MAX = 2147483647; // the columns are 32-bit int
const isInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= INT_MAX;
const range = (what: string) => `${what} must be a whole number from 0 to ${INT_MAX}`;

/** editable column -> check of the new value (string = error) */
const FIELDS: Record<string, (v: unknown) => Promise<string | null>> = {
  nickname: async (v) => {
    if (typeof v !== "string" || !v.trim() || v.length > 16) return "nickname must be 1-16 characters";
    if (isReservedNick(v)) return "nickname not allowed";
    return null;
  },
  rank: async (v) => (Number.isInteger(v) && isValidRank(v as number) ? null : "invalid rank"),
  experience: async (v) => (isInt(v) ? null : range("experience")),
  gold: async (v) => (isInt(v) ? null : range("gold")),
  cash: async (v) => (isInt(v) ? null : range("cash")),
  tags: async (v) => (isInt(v) ? null : range("tags")),
  access_level: async (v) =>
    Number.isInteger(v) && (await pool.query(`SELECT 1 FROM system_access_levels WHERE key=$1`, [v])).rowCount ? null : "unknown access level",
};

// offline accounts only: the game server holds an online player's copy in memory and writes it back over the row
/** 404 when the account is gone, else 409 (the only other reason an `AND NOT online` statement touches nothing) */
async function missingOrOnline(id: string): Promise<never> {
  const r = await pool.query(`SELECT 1 FROM accounts WHERE player_id=$1`, [id]);
  throw new AccountApiError(r.rowCount ? 409 : 404, r.rowCount ? "player is online: edit after they log out" : "account not found");
}

async function listAccounts(q: string): Promise<unknown> {
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const r = await pool.query(
    `SELECT player_id, username, nickname, rank, experience, gold, cash, tags, access_level, online, clan_id, created_at
     FROM accounts WHERE nickname ILIKE $1 OR username ILIKE $1 OR player_id::text = $2 ORDER BY player_id LIMIT 500`, [like, q]);
  const levels = await pool.query(`SELECT key, name FROM system_access_levels ORDER BY key`);
  return { accounts: r.rows, levels: levels.rows };
}

async function editAccount(id: string, raw: unknown): Promise<void> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AccountApiError(400, "expected a JSON object");
  const body = raw as Record<string, unknown>;
  const cols = Object.keys(body).filter((k) => k in FIELDS);
  if (!cols.length) throw new AccountApiError(400, "nothing to change");
  for (const c of cols) {
    const err = await FIELDS[c](body[c]);
    if (err) throw new AccountApiError(400, err);
  }
  if (cols.includes("nickname") && (await pool.query(`SELECT 1 FROM accounts WHERE nickname=$1 AND player_id<>$2`, [body.nickname, id])).rowCount)
    throw new AccountApiError(409, "nickname already taken");
  const r = await pool.query(
    `UPDATE accounts SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(", ")} WHERE player_id=$1 AND NOT online`,
    [id, ...cols.map((c) => body[c])]);
  if (!r.rowCount) await missingOrOnline(id);
}

async function setPassword(id: string, password: unknown): Promise<void> {
  const ok = credentialsSchema.shape.password.safeParse(password);
  if (!ok.success) throw new AccountApiError(400, ok.error.issues[0].message);
  const hash = await hashPassword(ok.data);
  // the token from the last login goes too: the old password's session must not outlive the reset
  const r = await pool.query(
    `WITH a AS (UPDATE accounts SET token='' WHERE player_id=$1 AND NOT online RETURNING username)
     UPDATE account_api_credentials c SET password_hash=$2, updated_at=now() FROM a WHERE c.username=a.username`, [id, hash]);
  if (!r.rowCount) {
    if ((await pool.query(`SELECT 1 FROM accounts WHERE player_id=$1 AND NOT online`, [id])).rowCount)
      throw new AccountApiError(404, "this account has no web login to reset");
    await missingOrOnline(id);
  }
}

/** every visible shop item as permanent (coupons are consumables, not unlocks), plus a character row for each character */
async function unlockAll(id: string): Promise<{ items: number; madePermanent: number; characters: number }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const acc = (await c.query(`SELECT online FROM accounts WHERE player_id=$1 FOR UPDATE`, [id])).rows[0];
    if (!acc) throw new AccountApiError(404, "account not found");
    if (acc.online) throw new AccountApiError(409, "player is online: unlock after they log out");
    const shop = ((await c.query(`SELECT DISTINCT ON (item_id) item_id, item_name FROM system_shop WHERE item_visible ORDER BY item_id`)).rows as
      { item_id: number; item_name: string }[]).filter((x) => getItemCategory(x.item_id) !== ItemCategory.Coupon);
    const ids = shop.map((x) => x.item_id);
    const owned = new Set((await c.query(`SELECT id FROM player_items WHERE owner_id=$1`, [id])).rows.map((x) => x.id as number));
    const fresh = shop.filter((x) => !owned.has(x.item_id));
    // same row as the :gift command's item (equip Permanent, count 1)
    await c.query(
      `INSERT INTO player_items(owner_id, id, name, count, equip) SELECT $1, i, n, 1, $4 FROM unnest($2::int[], $3::text[]) AS u(i, n)`,
      [id, fresh.map((x) => x.item_id), fresh.map((x) => x.item_name), ItemEquipType.Permanent]);
    // owned with an expiry or a use count: now permanent too
    const upgraded = await c.query(`UPDATE player_items SET equip=$3, count=1 WHERE owner_id=$1 AND id = ANY($2::int[]) AND equip <> $3`,
      [id, ids.filter((x) => owned.has(x)), ItemEquipType.Permanent]);
    const charas = (await c.query(`SELECT id, slot FROM player_characters WHERE owner_id=$1`, [id])).rows;
    const has = new Set(charas.map((x) => x.id as number)), used = new Set(charas.map((x) => x.slot as number));
    const newChars = shop.filter((x) => getIdStatics(x.item_id, 1) === 6 && !has.has(x.item_id));
    let slot = 0;
    const slots = newChars.map(() => { while (used.has(slot)) slot++; used.add(slot); return slot; }); // first free slots, like nextCharaSlot
    await c.query(
      `INSERT INTO player_characters(owner_id, id, slot, name, create_date, playtime) SELECT $1, i, s, n, $5, 0 FROM unnest($2::int[], $3::int[], $4::text[]) AS u(i, s, n)`,
      [id, newChars.map((x) => x.item_id), slots, newChars.map((x) => x.item_name), nowNum("yyMMddHHmm")]);
    // login sends at most 600 + inventory_plus items (limitationIndex): room for all of them
    await c.query(`UPDATE accounts SET inventory_plus = GREATEST(inventory_plus, (SELECT count(*) FROM player_items WHERE owner_id=$1) - 600) WHERE player_id=$1`, [id]);
    await c.query("COMMIT");
    return { items: fresh.length, madePermanent: upgraded.rowCount ?? 0, characters: newChars.length };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/** the account row and every row keyed to it; returns rows removed per table */
async function deleteAccount(id: string): Promise<Record<string, number>> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // the row lock makes a login in the meantime wait for the outcome
    const acc = (await c.query(`SELECT username, online FROM accounts WHERE player_id=$1 FOR UPDATE`, [id])).rows[0];
    if (!acc) throw new AccountApiError(404, "account not found");
    if (acc.online) throw new AccountApiError(409, "player is online: delete after they log out");
    const clan = (await c.query(`SELECT name FROM system_clan WHERE owner_id=$1`, [id])).rows[0];
    if (clan) throw new AccountApiError(409, `leads clan "${clan.name}": hand it over or disband it in game first`);
    // every player table is keyed by owner_id or player_id (system_* are game data; system_clan.owner_id is handled above)
    const keyed = (await c.query(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
       WHERE c.table_schema='public' AND c.column_name IN ('owner_id', 'player_id') AND c.table_name NOT LIKE 'system\\_%'
         AND c.table_name <> 'accounts' ORDER BY 1, 2`)).rows as { table_name: string; column_name: string }[];
    const removed: Record<string, number> = {};
    const del = async (label: string, sql: string, args: unknown[]) => {
      const n = (await c.query(sql, args)).rowCount ?? 0;
      if (n) removed[label] = (removed[label] ?? 0) + n;
    };
    for (const k of keyed) await del(k.table_name, `DELETE FROM "${k.table_name}" WHERE "${k.column_name}"=$1`, [id]);
    await del("player_friends", `DELETE FROM player_friends WHERE id=$1`, [id]); // the entry in other players' lists
    await del("system_clan_invites", `DELETE FROM system_clan_invites WHERE player_id=$1`, [id]);
    await del("account_api_credentials", `DELETE FROM account_api_credentials WHERE username=$1`, [acc.username]);
    await del("accounts", `DELETE FROM accounts WHERE player_id=$1`, [id]);
    await c.query("COMMIT");
    return removed;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/** [RECRIADO] local admin panel: GET /admin (page), /admin/api/accounts. True when the request was an /admin one (answered here) */
export function handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) return false;
  if (!isLocal(req)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("admin panel: only from this machine (http://localhost)\n");
    return true;
  }
  if (url.pathname === "/admin" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return true;
  }
  void (async () => {
    try {
      const m = /^\/admin\/api\/accounts(?:\/(\d{1,18})(\/password|\/unlock-all)?)?$/.exec(url.pathname);
      const id = m?.[1];
      if (m && !id && req.method === "GET") return sendJson(res, 200, await listAccounts(url.searchParams.get("q")?.trim() ?? ""));
      if (id && !m[2] && req.method === "PATCH") { await editAccount(id, await readJsonBody(req)); return sendJson(res, 200, { ok: true }); }
      if (id && m[2] === "/unlock-all" && req.method === "POST") return sendJson(res, 200, await unlockAll(id));
      if (id && m[2] === "/password" && req.method === "POST") { await setPassword(id, ((await readJsonBody(req)) as { password?: unknown }).password); return sendJson(res, 200, { ok: true }); }
      if (id && !m[2] && req.method === "DELETE") return sendJson(res, 200, { removed: await deleteAccount(id) });
      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof AccountApiError) return sendJson(res, e.status, { error: e.message });
      console.error(e);
      sendJson(res, 500, { error: e instanceof Error ? e.message : "internal error" });
    }
  })();
  return true;
}
