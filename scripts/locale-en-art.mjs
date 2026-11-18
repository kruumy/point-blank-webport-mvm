#!/usr/bin/env node
// [RECRIADO] English copies of the Cross UI sheets whose labels are painted into the texture (the client ships PT-BR only).
// Each label box is refilled row by row with a linear blend of its left/right edge pixels (the button's own gradient), then the
// English text is drawn in the original text colour (sampled from the pixels that stand out from that fill).
// Reads public/assets (pbx export), writes public/assets/ui/cross/atlas-en and public/assets/ui/cross-hud/hud-en.
// The lobby (i3Gui) and the HUD stack these over the originals, so a missing file falls back to the PT-BR art.
// Needs sharp from pb-extract-tools (PB_TOOLS, default ../pb-extract-tools).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.resolve(process.env.PB_TOOLS ?? path.join(WEB, '../pb-extract-tools'));
const sharp = createRequire(path.join(TOOLS, 'package.json'))('sharp');
const UI = path.join(WEB, 'public/assets/ui');

// [x, y, w, h] of the label box (inside the button frame), text; rows repeat one label over its button states
const L = (x, y, w, h, text, o = {}) => ({ x, y, w, h, text, ...o });
const rows = (ys, f) => ys.flatMap(f);
const SHEETS = {
  'cross/atlas/main_ui_source01.png': [
    ...rows([176, 218, 260], (y) => [L(312, y + 5, 59, 31, 'Start\nGame'), L(380, y + 5, 59, 31, 'Invite'), L(448, y + 5, 59, 31, 'Exit')]),
    ...[308, 376, 444].map((x) => L(x + 25, 308, 38, 25, 'Help')),
    ...rows([344, 386, 428], (y) => [L(312, y + 6, 74, 29, 'Quick Start'), L(400, y + 6, 74, 29, 'Special Mode')]),
  ],
  'cross/atlas/main_ui_source02.png': [
    ...rows([107, 136], (y) => [L(156, y + 4, 111, 20, 'Contact List'), L(278, y + 4, 111, 20, 'Messages')]),
    ...rows([235, 265], (y) => [L(156, y + 4, 111, 20, 'Personal Mission'), L(278, y + 4, 111, 20, 'Emblem')]),
    L(465, 2, 38, 13, 'Equipped', { size: 8 }), L(465, 20, 38, 13, 'Unused', { size: 8 }), L(465, 38, 38, 13, 'Used', { size: 8 }),
    ...rows([381, 425, 469], (y) => [L(377, y + 5, 59, 31, 'Cancel\nStart'), L(447, y + 5, 59, 31, 'Cancel\nReady')]),
  ],
  'cross/atlas/main_ui_source03.png': [
    L(339, 211, 54, 35, 'Buy\nCash'), L(417, 211, 54, 35, 'Buy\nCash'), L(417, 253, 54, 35, 'Buy\nCash'),
    L(380, 318, 59, 33, 'Cancel\nMatch'), L(448, 318, 59, 33, 'Cancel\nMatch'), L(380, 360, 59, 33, 'Cancel\nMatch'),
    L(380, 400, 59, 33, 'Ready'), L(448, 400, 59, 33, 'Ready'), L(380, 442, 59, 33, 'Ready'),
    ...rows([422, 452], (y) => [L(6, y + 4, 110, 20, 'Weapons'), L(127, y + 4, 110, 20, 'Character')]),
    L(159, 382, 39, 13, 'READY', { size: 8 }), L(203, 382, 39, 13, 'PLAY', { size: 8 }),
  ],
  'cross/atlas/main_ui_source04.png': [
    ...rows([[110, 109], [140, 140], [170, 170], [200, 200], [230, 229], [259, 259]], ([ya, yb], i) => {
      const t = ['Clan Info', 'Clan Battle', 'Search Clan', 'Clan Management', 'Clan List', 'User List'][[110, 140, 170, 200, 230, 259].indexOf(ya)];
      return [L(7, ya + 4, 106, 19, t), L(128, yb + 4, 106, 19, t)];
    }),
    ...rows([289, 319, 349], (y) => {
      const t = { 289: 'Scoreboard', 319: 'Armory', 349: 'Title' }[y];
      return [L(5, y + 4, 92, 19, t), L(112, y + 3, 92, 19, t)];
    }),
    ...rows([110, 152, 194], (y) => [L(251, y + 5, 59, 31, 'Change\nOwner'), L(320, y + 5, 59, 31, 'Change\nTeam')]),
  ],
  'cross/atlas/interface_ui_source_mapmode.png': [
    ...[[10, 'Destruction'], [73, 'Suppression'], [200, 'Sabotage'], [263, 'Challenge'], [328, 'Special']].map(([x, t]) =>
      L(x + 1, 26, 58, 18, t, { badge: true, size: 10 })),
    L(40, 214, 60, 15, 'Chaos', { align: 'end', size: 10 }),
  ],
  'cross-hud/hud/Hud.png': [L(521, 152, 152, 19, 'Mission Alert', { size: 11, badge: true })],
};

const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function sheet(rel, labels) {
  const src = path.join(UI, rel);
  if (!fs.existsSync(src)) { console.warn(`skip ${rel}: not exported`); return; }
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  const svg = [];
  for (const b of labels) {
    // text colour: mean of the pixels furthest from the edge blend (the strokes), taken before the box is refilled
    const diffs = [];
    const fill = [];
    for (let y = b.y; y < b.y + b.h; y++) {
      // buttons: the row's median (vertical gradient, thin strokes never reach half the row); badges: blend of the edge pixels
      const row = [];
      for (let x = b.x; x < b.x + b.w; x++) row.push(px(x, y));
      const med = [0, 1, 2, 3].map((k) => row.map((p) => p[k]).sort((p, q) => p - q)[row.length >> 1]);
      const a = px(b.x - 1, y), c = px(b.x + b.w, y);
      for (let x = b.x; x < b.x + b.w; x++) {
        const t = (x - b.x + 1) / (b.w + 1), bg = b.badge ? a.map((v, k) => Math.round(v + (c[k] - v) * t)) : med;
        const p = px(x, y);
        // labels are lighter than their button (the dark drop shadow is not the colour); badge text is the most saturated light pixel
        const sat = Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
        diffs.push([b.badge ? (lum(p) > 60 ? sat : -1) : lum(p) - lum(bg), p]);
        fill.push([x, y, bg]);
      }
    }
    diffs.sort((p, q) => q[0] - p[0]);
    const top = diffs.slice(0, Math.max(4, diffs.length * 0.06 | 0)).map((d) => d[1]);
    const col = [0, 1, 2].map((k) => Math.round(top.reduce((s, p) => s + p[k], 0) / top.length));
    for (const [x, y, bg] of fill) { const i = (y * W + x) * 4; data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2]; data[i + 3] = bg[3]; }
    const lines = b.text.split('\n');
    let size = b.size ?? 11;
    // rough Arial bold advance (0.6 em) to fit the widest line in the box
    while (size > 7 && Math.max(...lines.map((s) => s.length)) * size * 0.6 > b.w - 2) size -= 0.5;
    const lh = size * 1.1, y0 = b.y + b.h / 2 - (lh * (lines.length - 1)) / 2;
    const anchor = b.align ?? 'middle', tx = anchor === 'end' ? b.x + b.w - 2 : b.x + b.w / 2;
    const dark = lum(col) > 110;
    const stroke = b.badge ? `stroke="#000" stroke-width="2" paint-order="stroke"` : '';
    lines.forEach((s, i) => {
      const y = (y0 + i * lh).toFixed(1);
      if (!b.badge && dark) svg.push(`<text x="${tx + 1}" y="${(+y + 1).toFixed(1)}" fill="#000" fill-opacity=".55" ${attrs(size, anchor)}>${esc(s)}</text>`);
      svg.push(`<text x="${tx}" y="${y}" fill="rgb(${col})" ${stroke} ${attrs(size, anchor)}>${esc(s)}</text>`);
    });
  }
  const out = path.join(UI, rel.replace(/\/(atlas|hud)\//, '/$1-en/'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${info.height}">${svg.join('')}</svg>`);
  await sharp(data, { raw: info }).composite([{ input: overlay }]).png().toFile(out);
  console.log(`${path.relative(WEB, out)}: ${labels.length} labels`);
}
function attrs(size, anchor) {
  return `font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${size}" text-anchor="${anchor}" dominant-baseline="central"`;
}

for (const [rel, labels] of Object.entries(SHEETS)) await sheet(rel, labels);
