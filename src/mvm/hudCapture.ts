import * as THREE from "three";

// the serializer writes an attribute's quotes as &quot;
const URL_RE = /url\((&quot;|["']?)(.+?)\1\)/g;
const SVG_NS = "http://www.w3.org/2000/svg";

/** [RECRIADO] the page's own HUD through an SVG foreignObject: the browser lays out its art and text exactly as on screen */
export class HudCapture {
  private readonly cv = document.createElement("canvas");
  private readonly g = this.cv.getContext("2d")!;
  readonly texture = new THREE.CanvasTexture(this.cv);
  private readonly inlined = new Map<string, Promise<string>>();
  private css: Promise<string> | null = null;
  /** each layer's last raster, by its markup: most layers change a few times a second */
  private readonly rasters = new WeakMap<Element, { key: string; img: HTMLImageElement }>();
  private readonly sheets = new Map<string, Promise<HTMLImageElement>>();
  private busy = false;

  constructor() {
    this.texture.premultiplyAlpha = true;
    this.texture.colorSpace = THREE.NoColorSpace; // the page's bytes as they are
  }

  /** the preview: the last finished capture, a new one started when none is running */
  latest(root: HTMLElement, w: number, h: number): THREE.Texture {
    if (!this.busy) {
      this.busy = true;
      void this.capture(root, w, h).finally(() => { this.busy = false; });
    }
    return this.texture;
  }

  /** the HUD as it stands now, w x h px */
  async capture(root: HTMLElement, w: number, h: number): Promise<THREE.Texture> {
    const rr = root.getBoundingClientRect(), css = await (this.css ??= this.pageCss());
    const draws: (() => void)[] = [];
    if (!rr.width || !rr.height) root = document.createElement("div"); // HUD off: an empty frame
    const place = (el: Element, src: CanvasImageSource) => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) draws.push(() => this.g.drawImage(src, (r.left - rr.left) / rr.width * w, (r.top - rr.top) / rr.height * h, r.width / rr.width * w, r.height / rr.height * h));
    };
    for (const el of root.children) {
      if (el.classList.contains("pbhud-dbg") || getComputedStyle(el).display === "none") continue; // the port's debug lines are not the game's
      if (el instanceof HTMLCanvasElement) { place(el, el); continue; }
      // laid out at the HUD's own size (the theater shrinks it with a transform), drawn at w x h
      const { img, sprites } = await this.raster(el, css, root.offsetWidth, root.offsetHeight, w, h);
      for (const sp of sprites) {
        const sheet = await this.sheet(sp.url), r = sp.el.getBoundingClientRect(), kx = sp.bw / sheet.naturalWidth, ky = sp.bh / sheet.naturalHeight;
        if (r.width && r.height) draws.push(() => {
          this.g.globalAlpha = sp.alpha;
          this.g.drawImage(sheet, -sp.bx / kx, -sp.by / ky, sp.w / kx, sp.h / ky, (r.left - rr.left) / rr.width * w, (r.top - rr.top) / rr.height * h, r.width / rr.width * w, r.height / rr.height * h);
          this.g.globalAlpha = 1;
        });
      }
      if (img) draws.push(() => this.g.drawImage(img, 0, 0, w, h));
      for (const c of el.querySelectorAll("canvas")) if (c.getClientRects().length) place(c, c);
    }
    // a new size needs new GPU storage (three allocates it once per texture)
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; this.texture.dispose(); }
    this.g.clearRect(0, 0, w, h);
    for (const d of draws) d();
    this.texture.needsUpdate = true;
    return this.texture;
  }

  // plain sprites come out to their sheet so a moving one never re-rasters; shortcut: they go under the layer's text (none over it in PbHud)
  private async raster(el: Element, css: string, W: number, H: number, w: number, h: number): Promise<{ img: HTMLImageElement | null; sprites: Sprite[] }> {
    // without what draws nothing (the hidden result window alone is ~1000 nodes)
    const clone = el.cloneNode(true) as Element, src = el.querySelectorAll("*"), dst = clone.querySelectorAll("*"), sprites: Sprite[] = [];
    let hidden: Element | null = null;
    for (let i = 0; i < src.length; i++) {
      const e = src[i];
      if (hidden?.contains(e)) continue;
      const cs = getComputedStyle(e);
      if (cs.display === "none") { hidden = e; dst[i].remove(); continue; }
      const sp = e instanceof HTMLCanvasElement ? null : plainSprite(e as HTMLElement, cs, el);
      if (sp) sprites.push(sp);
      if (sp || e instanceof HTMLCanvasElement) dst[i].remove();
    }
    const html = new XMLSerializer().serializeToString(clone);
    const key = `${W}x${H}>${w}x${h}|${html}`, old = this.rasters.get(el);
    if (old?.key === key) return { img: old.img, sprites };
    if (!clone.querySelector("*") && !clone.textContent?.trim()) return { img: null, sprites }; // sprites only
    // each sheet once, as a custom property: a panel names the same sheet in every sprite
    const vars = new Map<string, string>();
    const body = (await this.inline(html, (data) => {
      let v = vars.get(data);
      if (!v) vars.set(data, (v = `--hudu${vars.size}`));
      return `var(${v})`;
    }));
    const decl = [...vars].map(([data, v]) => `${v}:url(${data})`).join(";");
    const svg = `<svg xmlns="${SVG_NS}" width="${w}" height="${h}"><foreignObject width="100%" height="100%">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" id="pbhud" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0;transform:scale(${w / W},${h / H});${decl}"><style>${css}</style>${body}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    this.rasters.set(el, { key, img });
    return { img, sprites };
  }

  private sheet(url: string): Promise<HTMLImageElement> {
    let p = this.sheets.get(url);
    if (!p) {
      const img = new Image();
      img.src = url;
      this.sheets.set(url, (p = img.decode().then(() => img)));
    }
    return p;
  }

  /** the HUD's own rules and the fonts: an SVG image reaches nothing outside itself */
  private async pageCss(): Promise<string> {
    const rules: string[] = [];
    for (const sheet of document.styleSheets) {
      let list: CSSRuleList;
      try { list = sheet.cssRules; } catch { continue; } // another origin's sheet
      for (const r of list) if (r instanceof CSSFontFaceRule || r.cssText.includes("pbhud")) rules.push(r.cssText);
    }
    return this.inline(rules.join("\n"));
  }

  /** every url(...) and src="..." as a data: url; `ref` writes a url(...) in its place */
  private async inline(text: string, ref?: (data: string) => string): Promise<string> {
    const urls = new Set<string>();
    for (const m of text.matchAll(URL_RE)) urls.add(m[2]);
    for (const m of text.matchAll(/\bsrc="([^"]+)"/g)) urls.add(m[1]);
    const data = new Map<string, string>();
    await Promise.all([...urls].filter((u) => !u.startsWith("data:")).map(async (u) => data.set(u, await this.dataUrl(u.replace(/&amp;/g, "&")))));
    return text.replace(URL_RE, (all, q: string, u: string) => (!data.has(u) ? all : ref ? ref(data.get(u)!) : `url(${q}${data.get(u)}${q})`))
      .replace(/\bsrc="([^"]+)"/g, (all, u: string) => (data.has(u) ? `src="${data.get(u)}"` : all));
  }

  private dataUrl(url: string): Promise<string> {
    let p = this.inlined.get(url);
    if (!p) {
      p = fetch(url).then((r) => r.blob()).then((b) => new Promise<string>((ok) => {
        const fr = new FileReader();
        fr.onload = () => ok(String(fr.result));
        fr.readAsDataURL(b);
      })).catch(() => url);
      this.inlined.set(url, p);
    }
    return p;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

interface Sprite { el: HTMLElement; url: string; alpha: number; w: number; h: number; bw: number; bh: number; bx: number; by: number }

const PX2 = /^(-?[\d.]+)px (-?[\d.]+)px$/;

/** an empty box showing one cell of a sheet (PbHud's spr): nothing but its background, in px, and its opacity */
function plainSprite(e: HTMLElement, cs: CSSStyleDeclaration, layer: Element): Sprite | null {
  if (e.childNodes.length || cs.position !== "absolute" || cs.visibility !== "visible" || cs.backgroundColor !== "rgba(0, 0, 0, 0)"
    || cs.borderTopStyle !== "none" || cs.borderLeftStyle !== "none" || cs.borderRightStyle !== "none" || cs.borderBottomStyle !== "none"
    || cs.boxShadow !== "none" || cs.filter !== "none" || cs.clipPath !== "none" || cs.mixBlendMode !== "normal" || !/^(no-)?repeat$/.test(cs.backgroundRepeat)) return null;
  const url = /^url\("(.+)"\)$/.exec(cs.backgroundImage)?.[1], size = PX2.exec(cs.backgroundSize), pos = PX2.exec(cs.backgroundPosition);
  if (!url || !size || !pos) return null;
  let alpha = Number(cs.opacity);
  for (let a = e.parentElement; a && a !== layer.parentElement; a = a.parentElement) {
    const as = getComputedStyle(a);
    if (as.overflow !== "visible") return null; // a clip (bars): the sheet draw would ignore it
    alpha *= Number(as.opacity);
  }
  return { el: e, url, alpha, w: e.offsetWidth, h: e.offsetHeight, bw: +size[1], bh: +size[2], bx: +pos[1], by: +pos[2] };
}
