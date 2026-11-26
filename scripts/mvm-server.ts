import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { join, resolve } from "node:path";
import type { DemoInfo } from "../src/mvm/demo.ts";

const ROOT = resolve("mvm");
const DIRS = { demos: join(ROOT, "demos"), looks: join(ROOT, "looks"), movies: join(ROOT, "movies") };
// stored files by kind: theater looks (src/mvm/looks.ts) are kept like the demos
const STORES: Record<string, string> = { demos: ".pbdemo", looks: ".json" };
const MAPS = resolve("public/assets/maps");
// names come from the page: one plain file name, never a path
const SAFE = /^[\w][\w.-]{0,150}$/;

// IWXMVM's video codecs (CaptureManager.cpp): the ProRes profiles at q 1
const prores = (profile: number, pix: string) => ({ ext: "mov", args: ["-c:v", "prores", "-profile:v", String(profile), "-q:v", "1", "-pix_fmt", pix] });
const CODECS: Record<string, { ext: string; args: string[] }> = {
  prores4444xq: prores(5, "yuv444p10le"),
  prores4444: prores(4, "yuv444p10le"),
  prores422hq: prores(3, "yuv422p10le"),
  prores422: prores(2, "yuv422p10le"),
  prores422lt: prores(1, "yuv422p10le"),
};

interface Job {
  proc: ChildProcessWithoutNullStreams; file: string; log: string; done: Promise<number>;
  /** the page keeps a few uploads in flight, so frames can arrive out of order: written strictly by index */
  next: number; pending: Map<number, { data: Buffer; written: () => void }>; writing: boolean;
  idle?: ReturnType<typeof setTimeout>;
}
// a page that went away mid-render (reload, closed tab) sends no end: its ffmpeg is finished with the frames it got
const IDLE_MS = 120_000;
function keepAlive(jid: string, job: Job): void {
  clearTimeout(job.idle);
  job.idle = setTimeout(() => { jobs.delete(jid); job.proc.stdin.end(); }, IDLE_MS);
}
const jobs = new Map<string, Job>();

// the demo browser asks for every listed demo: each file is read once per change, not on every open
const infoCache = new Map<string, { mtime: number; size: number; info: DemoInfo }>();
const gunzipAsync = promisify(gunzip);
// async: a long match's demo would otherwise hold up every other dev request while it unpacks
async function demoInfo(file: string): Promise<DemoInfo> {
  const st = statSync(file), hit = infoCache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.info;
  const lines = (await gunzipAsync(await readFile(file))).toString("utf8").split("\n").filter(Boolean);
  const head = JSON.parse(lines[0]) as { map: string; mode: string; date: string; pov: string };
  const players = new Map<string, DemoInfo["players"][number]>();
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.includes('"k":"state"')) continue;
    // only a new actor's line is parsed: a match is hundreds of thousands of state lines
    const id = /"id":"((?:[^"\\]|\\.)*)"/.exec(l)?.[1];
    if (id === undefined || players.has(JSON.parse(`"${id}"`))) continue;
    const s = (JSON.parse(l) as { s: { id: string; name: string; team: number } }).s;
    players.set(s.id, { id: s.id, name: s.name, team: s.team });
  }
  const dur = lines.length > 1 ? (JSON.parse(lines[lines.length - 1]) as { t: number }).t : 0;
  const info = { map: head.map, mode: head.mode, date: head.date, pov: head.pov, dur, players: [...players.values()] };
  infoCache.set(file, { mtime: st.mtimeMs, size: st.size, info });
  return info;
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => ok(Buffer.concat(parts)));
    req.on("error", fail);
  });
}

function send(res: ServerResponse, code: number, data?: unknown): void {
  res.statusCode = code;
  if (data === undefined) { res.end(); return; }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");
  const [kind, name] = url.pathname.replace(/^\/__mvm\/?/, "").split("/").map(decodeURIComponent);
  const m = req.method ?? "GET";

  if (kind === "skies" && m === "GET") { // maps with an exported sky (realLevel loadSky)
    const maps = existsSync(MAPS) ? readdirSync(MAPS).filter((d) => existsSync(join(MAPS, d, "sky", "sky.glb"))) : [];
    return send(res, 200, maps);
  }

  if (kind === "demos" || kind === "looks") {
    const dir = DIRS[kind], ext = STORES[kind];
    mkdirSync(dir, { recursive: true });
    if (!name) {
      const list = readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => {
        const st = statSync(join(dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
      return send(res, 200, list);
    }
    if (!SAFE.test(name) || !name.endsWith(ext)) return send(res, 400, { error: "bad name" });
    const file = join(dir, name);
    if (m === "GET") {
      if (!existsSync(file)) return send(res, 404);
      if (kind === "demos" && url.searchParams.has("info")) {
        try { return send(res, 200, await demoInfo(file)); } catch (e) { return send(res, 422, { error: String(e) }); }
      }
      res.setHeader("Content-Type", "application/octet-stream");
      createReadStream(file).pipe(res);
      return;
    }
    if (m === "PUT") {
      writeFileSync(file, await body(req));
      return send(res, 200, { name });
    }
    if (m === "DELETE") {
      if (!existsSync(file)) return send(res, 404);
      rmSync(file);
      infoCache.delete(file);
      return send(res, 200);
    }
    if (m === "POST") { // rename: ?to=<new name>.pbdemo, never onto another demo
      const to = url.searchParams.get("to") ?? "";
      if (!SAFE.test(to) || !to.endsWith(ext)) return send(res, 400, { error: "bad name" });
      if (!existsSync(file)) return send(res, 404);
      if (existsSync(join(dir, to))) return send(res, 409, { error: "a demo with that name already exists" });
      renameSync(file, join(dir, to));
      infoCache.delete(file);
      return send(res, 200, { name: to });
    }
    return send(res, 405);
  }

  if (kind === "render" && m === "POST") {
    const id = url.searchParams.get("id") ?? "";
    if (name === "start") {
      // passes: the theater's render passes (src/mvm/passes.ts), one ffmpeg each, fed the same frame numbers
      type Pass = { name: string; input: string; alpha: boolean };
      const o = JSON.parse((await body(req)).toString("utf8")) as { w: number; h: number; fps: number; codec: string; name: string; passes: Pass[] };
      const codec = CODECS[o.codec];
      const ok = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
      const passOk = (p: Pass) => /^[a-z]+(-[a-z]+){0,3}$/.test(p.name) && p.name.length <= 40 && (p.input === "rgba" || p.input === "gray16le") && typeof p.alpha === "boolean";
      if (!codec || !ok(o.w, 16, 7680) || !ok(o.h, 16, 4320) || o.w % 2 || o.h % 2 || !ok(o.fps, 1, 1000) || !SAFE.test(o.name)
        || !Array.isArray(o.passes) || !ok(o.passes.length, 1, 8) || !o.passes.every(passOk) || new Set(o.passes.map((p) => p.name)).size !== o.passes.length) return send(res, 400, { error: "bad render settings" });
      if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error) return send(res, 503, { error: "ffmpeg not found" });
      mkdirSync(DIRS.movies, { recursive: true });
      // name + the first number free for every pass: a render never overwrites an earlier one
      const fileOf = (n: number, p: Pass) => join(DIRS.movies, `${o.name}${n}${p.name === "default" ? "" : `_${p.name}`}.${codec.ext}`);
      let n = 1;
      while (o.passes.some((p) => existsSync(fileOf(n, p)))) n++;
      const started = o.passes.map((p) => {
        const file = fileOf(n, p);
        // a matte survives only in the 4444 profiles' alpha plane
        const args = p.alpha && codec.args.includes("yuv444p10le") ? codec.args.map((a) => (a === "yuv444p10le" ? "yuva444p10le" : a)) : codec.args;
        const proc = spawn("ffmpeg", ["-y", "-f", "rawvideo", "-pix_fmt", p.input, "-s", `${o.w}x${o.h}`, "-r", String(o.fps), "-i", "-",
          "-vf", "vflip", ...args, "-r", String(o.fps), file]);
        const job: Job = { proc, file, log: "", done: new Promise((ok) => { proc.on("close", (c) => ok(c ?? -1)); proc.on("error", () => ok(-1)); }), next: 0, pending: new Map(), writing: false };
        proc.on("error", (e) => { job.log += `\n${String(e)}`; }); // a failed spawn: unhandled, it would take the dev server down
        proc.stderr.on("data", (d: Buffer) => { job.log = (job.log + d.toString()).slice(-4000); });
        proc.stdin.on("error", () => {}); // ffmpeg died: the next frame / end reports it
        const jid = Math.random().toString(36).slice(2);
        jobs.set(jid, job);
        keepAlive(jid, job);
        return { id: jid, file };
      });
      return send(res, 200, { jobs: started });
    }
    const job = jobs.get(id);
    if (!job) return send(res, 404, { error: "no such render" });
    if (name === "frame") {
      const n = Number(url.searchParams.get("n"));
      if (!Number.isInteger(n) || n < job.next || job.pending.has(n) || job.pending.size > 64) return send(res, 400, { error: "bad frame index" });
      keepAlive(id, job);
      const data = await body(req);
      if (job.proc.exitCode !== null) return send(res, 500, { error: job.log });
      await new Promise<void>((written) => { job.pending.set(n, { data, written }); void drainFrames(job); });
      return job.proc.exitCode === null ? send(res, 200) : send(res, 500, { error: job.log });
    }
    if (name === "end" || name === "abort") {
      jobs.delete(id);
      clearTimeout(job.idle);
      if (name === "abort") job.proc.kill();
      else job.proc.stdin.end();
      const code = await job.done;
      // frames still held for an earlier index never get written: answer them
      for (const f of job.pending.values()) f.written();
      job.pending.clear();
      if (name === "abort") rmSync(job.file, { force: true }); // a killed ffmpeg leaves a .mov without its index
      return send(res, code === 0 || name === "abort" ? 200 : 500, { file: job.file, code, log: code === 0 ? "" : job.log });
    }
  }
  send(res, 404);
}

async function drainFrames(job: Job): Promise<void> {
  if (job.writing) return;
  job.writing = true;
  for (let f = job.pending.get(job.next); f; f = job.pending.get(job.next)) {
    job.pending.delete(job.next++);
    // ffmpeg gone: no drain will ever come
    if (!job.proc.stdin.write(f.data)) await Promise.race([new Promise((ok) => job.proc.stdin.once("drain", ok)), job.done]);
    f.written();
  }
  job.writing = false;
}

/** [RECRIADO] Dev-server half of the movie maker (src/mvm): demos on disk under mvm/, and the offline render piped into the
 * user's own ffmpeg (on PATH). Local only (Vite dev server); nothing here runs in a production build. */
export function mvmServer(): Plugin {
  return {
    name: "pb-mvm",
    apply: "serve",
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__mvm/")) return next();
        // the dev server listens on every interface (vite.config host 0.0.0.0): disk writes and ffmpeg stay this machine's
        // Host and Origin too (as server/src/web/admin.ts isLocal): another site open in the browser calls from 127.0.0.1 as well
        const ip = req.socket.remoteAddress ?? "", host = req.headers.host ?? "", origin = req.headers.origin;
        let hostName = "";
        try { hostName = new URL(`http://${host}`).hostname; } catch { /* bad Host: refused below */ }
        if (!(ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.")) || !["localhost", "127.0.0.1", "[::1]"].includes(hostName)
          || (origin && origin !== `http://${host}`)) return send(res, 403);
        handle(req, res).catch((e: unknown) => send(res, 500, { error: String(e) }));
      });
    },
  };
}
