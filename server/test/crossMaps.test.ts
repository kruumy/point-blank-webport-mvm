import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pool } from "../src/db.ts";
import { getMapLimit, loadMaps } from "../src/game/roomModel.ts";

type Row = Record<string, string | number>;
const SQL = fs.readFileSync(new URL("../../db/init/001_init.sql", import.meta.url), "utf8").replace(/\r/g, "");
function copyRows(table: string): Row[] {
  const head = SQL.match(new RegExp(`^COPY public\\.${table} \\(([^)]*)\\) FROM stdin;\\n`, "m"))!;
  const cols = head[1].split(", ");
  const body = SQL.slice(head.index! + head[0].length, SQL.indexOf("\n\\.\n", head.index));
  return body.split("\n").map((l) => Object.fromEntries(l.split("\t").map((v, i) => [cols[i], /^-?\d+$/.test(v) ? Number(v) : v])));
}
const RULES = copyRows("system_map_rules");
const ALL = copyRows("system_map_matches");
const OLD = ALL.filter((r) => Number(r.seq) < 136);

/** pool over an in-memory system_map_matches (loadMaps' SELECTs) */
function usePool(matches: Row[]): void {
  Object.assign(pool, {
    query: async (sql: string) => {
      if (sql.includes("system_map_matches")) return { rows: [...matches].sort((a, b) => Number(a.seq) - Number(b.seq)) };
      if (sql.includes("system_map_rules")) return { rows: RULES };
      return { rows: [] };
    },
  });
}

test("getMapLimit prefers the row of the room's mode", async () => {
  usePool(ALL.map((r) => ({ ...r })));
  await loadMaps();
  assert.equal(getMapLimit(57, 0, 4)?.limit, 2, "Tutorial in a Deathmatch room: its Deathmatch row");
  assert.equal(getMapLimit(57, 0, 40)?.limit, 1, "Tutorial room: the Tutorial row");
  assert.equal(getMapLimit(57, 0)?.limit, 1, "no roomType: the first row of the rule, as before");
  assert.equal(getMapLimit(9, 0, 4)?.limit, 8, "Crack Down keeps its Deathmatch limit, not the AI.D row");
  assert.equal(getMapLimit(49, 128, 8)?.limit, 8, "Hardrock Bomb");
  assert.equal(getMapLimit(150, 32, 4)?.limit, 16, "Angkor Ruins HeadHunter");
  assert.equal(getMapLimit(154, 80, 4)?.limit, 16, "Giran 2 Chaos");
  assert.equal(getMapLimit(38, 128, 8), null, "Cargo Port has no bomb sites");
});

test("every room on the old rows gets the same map row as before", async () => {
  usePool(OLD.map((r) => ({ ...r })));
  await loadMaps();
  const conds = [...new Set(RULES.map((r) => Number(r.conditions)))];
  for (const map of new Set(OLD.map((r) => Number(r.map_id)))) {
    for (const rule of new Set(RULES.map((r) => Number(r.rule)))) {
      const before = getMapLimit(map, rule);
      for (const c of conds) assert.equal(getMapLimit(map, rule, c)?.limit, before?.limit, `map ${map} rule ${rule} roomType ${c}`);
    }
  }
});
