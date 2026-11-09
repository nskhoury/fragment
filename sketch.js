/* ------------------------------------------------------------------
   SKETCH 01 — FRAGMENT   (p5.js 2.x)
     drag an image file onto the canvas → use your own image
     space: reshuffle;   s: save PNG (8 × 8 in, 300 ppi, transparent)

   HOW IT'S ORGANISED (and why it's fast)
     1. LOAD     – an image is decoded ONCE and turned into three copies:
                     analysis  ≤ 600 px   pixel data for working out the grid
                     preview   ≤ 1600 px  drawn on screen
                     print     ≤ 2400 px  drawn into the saved file
                   The original (which can be 50+ megapixels) is then thrown away.
     2. LAYOUT   – the grid and each cell's treatment are worked out from the
                   analysis copy. Only redone when seed / depth / smear /
                   void / bg cut change — not for labels or words.
     3. RENDER   – draws the layout into a square at any size. Same code
                   for the preview and the 2400 px export.
------------------------------------------------------------------- */

const IMAGE_FILE = '';             // e.g. 'photo.jpg' after uploading it to the project

// ---- output: the artwork is fitted inside this square
const BOX_IN = 8;                  // inches
const PPI    = 300;                // pixels per inch
const BOX_PX = BOX_IN * PPI;       // 2400 px — the print copy never needs to be bigger

// ---- working copy sizes (long side, in px)
const ANALYSIS_MAX = 600;          // enough detail to find edges; small = fast
const PREVIEW_MAX  = 1600;         // sharp on a retina screen

const PANEL_H = 52;                // height of the control bar under the canvas

// ---- interface typeface (the artwork's labels stay monospace)
const UI_FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';

// ---- colour of the stand-in image (used when IMAGE_FILE is empty)
const DEFAULT_COLOR = '#ff6a13';

// ---- how-to text shown in the top-left corner
const INSTRUCTIONS = [
  'Drag in an image',
  'Space to shuffle',
  'S to save',
];

// ---- words used for the cell labels (edit this list to change them)
const WORDS = ['fragment', 'signal', 'trace', 'surface', 'layer', 'drift',
               'index', 'residue', 'sharp-focus', 'vivid-color'];

let IMG = null;      // { analysis:{w,h,data,bg}, preview:canvas, print:canvas, aspect }
let layout = [];     // cells: { x,y,w,h (0–1 of the image), mode, line, dir }
let layoutKey = '';  // remembers which settings the layout was made with
let seed = 1;
let ui = {};
const P = {};
let previewBuf = null;
let renderQueued = false;


/* ================================================================
   SETUP
   ================================================================ */
async function setup() {
  const c = createCanvas(windowWidth, windowHeight - PANEL_H);
  pixelDensity(2);
  noLoop();
  buildPanel();

  if (IMAGE_FILE) {
    const img = await loadImage(IMAGE_FILE);
    prepareImage(img.canvas || img.elt);
  } else {
    const g = makeDefaultImage();
    prepareImage(g.elt);
    g.remove();
  }
  requestRender();

  // drag & drop — decode straight from the file (no giant base64 string)
  c.drop(async file => {
    if (file.type !== 'image') return;
    let source;
    try { source = await createImageBitmap(file.file); }
    catch (e) { const img = await loadImage(file.data); source = img.canvas || img.elt; }
    prepareImage(source);
    if (source.close) source.close();        // free the full-size decode right away
    seed = Math.floor(Math.random() * 1e6);   // Math.random: p5's random() is seeded
    requestRender();
  });
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight - PANEL_H);
  requestRender();
}


/* ================================================================
   1. LOAD — make the three working copies
   ================================================================ */
function prepareImage(source) {
  const w = source.width, h = source.height;

  // analysis copy: we only ever READ its pixels, so grab them once
  const a = downscale(source, ANALYSIS_MAX);
  const data = a.getContext('2d', { willReadFrequently: true })
                .getImageData(0, 0, a.width, a.height).data;
  const analysis = { w: a.width, h: a.height, data };
  analysis.bg = pixelAt(analysis, 1, 1);     // background colour = top-left pixel

  IMG = {
    analysis,
    preview: downscale(source, PREVIEW_MAX),
    print:   downscale(source, BOX_PX),
    aspect:  w / h,
    srcW: w, srcH: h,
  };
  layoutKey = '';                            // force a new layout
}

// High-quality shrink: halve repeatedly, then a final resize.
// (One big jump from 8000 px → 600 px looks grainy; halving keeps it smooth.)
function downscale(source, maxSide) {
  const k = Math.min(1, maxSide / Math.max(source.width, source.height));
  const tw = Math.max(1, Math.round(source.width * k));
  const th = Math.max(1, Math.round(source.height * k));
  let cur = source, cw = source.width, ch = source.height;
  while (cw / 2 >= tw && ch / 2 >= th) {
    cw = Math.round(cw / 2); ch = Math.round(ch / 2);
    cur = drawTo(cur, cw, ch);
  }
  return (cur === source || cw !== tw || ch !== th) ? drawTo(cur, tw, th) : cur;
}

function drawTo(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return c;
}

function pixelAt(A, x, y) {
  x = Math.min(A.w - 1, Math.max(0, x | 0));
  y = Math.min(A.h - 1, Math.max(0, y | 0));
  const i = 4 * (y * A.w + x), d = A.data;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}


/* ================================================================
   2. LAYOUT — cut the image into cells and decide each one's treatment
   All positions are fractions (0–1) of the image, so the same layout
   can be drawn at any size.
   ================================================================ */
function makeLayout() {
  randomSeed(seed);
  const A = IMG.analysis;
  const minSide = Math.max(A.w, A.h) / 120;   // smallest allowed cell (relative)
  const cells = [];

  // recursive cut (named "partition" because p5 already has split())
  function partition(x, y, w, h, d) {
    const content = contentRatio(A, x, y, w, h);
    if (content < 0.04) return;                       // pure background → drop it

    // edge cells keep splitting; solid interior cells may stop early
    const isEdge = content < 0.9;
    const stop = d >= P.depth || w < minSide || h < minSide ||
                 (d > 2 && !isEdge && random() < 0.35);
    if (stop) { cells.push({ x, y, w, h }); return; }

    const t = random(0.3, 0.7);                       // off-centre cut
    if (w > h * random(0.7, 1.4)) {
      partition(x, y, w * t, h, d + 1);
      partition(x + w * t, y, w * (1 - t), h, d + 1);
    } else {
      partition(x, y, w, h * t, d + 1);
      partition(x, y + h * t, w, h * (1 - t), d + 1);
    }
  }
  partition(0, 0, A.w, A.h, 0);

  // decide each cell's treatment now, so rendering has no randomness
  return cells.map(c => {
    const cell = { x: c.x / A.w, y: c.y / A.h, w: c.w / A.w, h: c.h / A.h, mode: 'keep', dir: '' };
    const r = random();
    if (r < P.void) cell.mode = 'void';
    else if (r < P.void + P.smear) {
      cell.mode = random() < 0.6 ? 'smearX' : 'smearY';
      cell.line = random();                           // which row/column to stretch
      cell.dir  = cell.mode === 'smearX' ? '→' : '↓';   // → ↓
    }
    return cell;
  });
}

// fraction of 25 sample points in a rect that differ from the background
function contentRatio(A, x, y, w, h) {
  const bg = A.bg, cut = P.thresh * 3;
  let hit = 0;
  for (let i = 0.1; i < 1; i += 0.2) {
    for (let j = 0.1; j < 1; j += 0.2) {
      const p = pixelAt(A, x + w * i, y + h * j);
      const d = Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
      if (d > cut && p[3] > 20) hit++;
    }
  }
  return hit / 25;
}

function ensureLayout() {
  const settings = [seed, P.depth, P.smear, P.void, P.thresh].join('|');
  if (settings !== layoutKey) { layout = makeLayout(); layoutKey = settings; }
}


/* ================================================================
   3. RENDER — draw the layout into a square of size `side`
   ctx    : a canvas 2D context (preview buffer or export buffer)
   source : the image copy to draw from (preview or print)
   ================================================================ */
function renderArt(ctx, side, source) {
  const u = side / 800;                        // proportions stay identical at any size

  // fit the image inside the square, centred
  const pad = 2 * u;
  const artW = IMG.aspect >= 1 ? side - pad * 2 : (side - pad * 2) * IMG.aspect;
  const artH = IMG.aspect >= 1 ? (side - pad * 2) / IMG.aspect : side - pad * 2;
  const ox = (side - artW) / 2, oy = (side - artH) / 2;
  const SW = source.width, SH = source.height;

  ctx.save();
  ctx.imageSmoothingQuality = 'high';

  if (P.ghost) {
    ctx.globalAlpha = 0.15;
    ctx.drawImage(source, ox, oy, artW, artH);
    ctx.globalAlpha = 1;
  }

  // ---- image content
  for (const c of layout) {
    const x = ox + c.x * artW, y = oy + c.y * artH, w = c.w * artW, h = c.h * artH;
    const sx = c.x * SW, sy = c.y * SH, sw = c.w * SW, sh = c.h * SH;

    if (c.mode === 'keep') {
      ctx.drawImage(source, sx, sy, sw, sh, x, y, w, h);
    } else if (c.mode === 'smearX') {          // one column stretched sideways
      const col = Math.min(SW - 1, Math.floor(sx + c.line * sw));
      ctx.drawImage(source, col, sy, 1, sh, x, y, w, h);
    } else if (c.mode === 'smearY') {          // one row stretched down
      const row = Math.min(SH - 1, Math.floor(sy + c.line * sh));
      ctx.drawImage(source, sx, row, sw, 1, x, y, w, h);
    }
  }

  // ---- grid outlines: all in ONE path, one stroke call
  if (P.grid) {
    ctx.beginPath();
    for (const c of layout) ctx.rect(ox + c.x * artW, oy + c.y * artH, c.w * artW, c.h * artH);
    ctx.strokeStyle = 'rgb(150,150,145)';
    ctx.lineWidth = 0.6 * u;
    ctx.stroke();
  }

  // ---- labels
  if (P.labels) {
    const fs = 7 * u;
    ctx.fillStyle = 'rgb(20,20,20)';
    ctx.textBaseline = 'top';
    layout.forEach((c, i) => {
      const x = ox + c.x * artW, y = oy + c.y * artH, w = c.w * artW, h = c.h * artH;
      if (w <= 30 * u || h <= 24 * u) return;
      ctx.font = `bold ${fs}px monospace`;
      let word = WORDS[i % WORDS.length].toUpperCase();
      while (word.length > 1 && ctx.measureText(word).width > w - 8 * u) word = word.slice(0, -1);
      ctx.fillText(word, x + 4 * u, y + 4 * u);
      ctx.font = `${fs}px monospace`;
      ctx.fillText((i + 1) + c.dir, x + 4 * u, y + 13 * u);
    });
  }
  ctx.restore();
}

function clearCtx(ctx) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}


/* ================================================================
   SCREEN — preview buffer is made once and reused
   ================================================================ */
// Sliders fire many events per second; this collapses them into
// at most one redraw per screen frame.
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; redraw(); });
}

function draw() {
  background(243, 243, 241);
  if (!IMG) return;
  readPanel();
  ensureLayout();

  // leave room on the left for the instructions so they never overlap the square
  textFont(UI_FONT); textSize(11);
  const insW = Math.max(...INSTRUCTIONS.map(t => textWidth(t))) + 40;
  const side = Math.floor(Math.max(100, Math.min(width - insW * 2, height - 60)));
  if (!previewBuf || previewBuf.width !== side) {
    if (previewBuf) previewBuf.remove();
    previewBuf = createGraphics(side, side);
    previewBuf.pixelDensity(2);
  }
  const ctx = previewBuf.drawingContext;
  clearCtx(ctx);
  renderArt(ctx, side, IMG.preview);

  const bx = (width - side) / 2, by = (height - side) / 2;
  noFill(); stroke(205); strokeWeight(1);
  rect(bx, by, side, side);                  // the 8 × 8 bounding box
  image(previewBuf, bx, by, side, side);

  noStroke(); fill(140); textFont(UI_FONT); textSize(11); textAlign(LEFT, TOP); textLeading(17);
  text(`${BOX_IN} × ${BOX_IN} in · ${PPI} ppi · ${BOX_PX} × ${BOX_PX} px · ` +
       `${layout.length} cells · image ${IMG.srcW} × ${IMG.srcH}`, bx, by + side + 6);

  // instructions, top-left corner (screen only — never in the saved file)
  text(INSTRUCTIONS.join('\n'), 20, 20);
}


/* ================================================================
   SAVE — 8 × 8 in at 300 ppi, transparent
   Rendered straight at 2400 × 2400 from the print copy (not an
   enlarged screenshot). Same layout as on screen.
   ================================================================ */
async function savePNG() {
  readPanel();
  ensureLayout();
  const c = document.createElement('canvas');
  c.width = c.height = BOX_PX;
  renderArt(c.getContext('2d'), BOX_PX, IMG.print);

  const blob = await new Promise(res => c.toBlob(res, 'image/png'));
  const png = setPNGppi(new Uint8Array(await blob.arrayBuffer()), PPI);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  a.download = `fragment-${seed}-${BOX_IN}x${BOX_IN}in-${PPI}ppi.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  console.log(`saved ${BOX_PX} × ${BOX_PX} px = ${BOX_IN} × ${BOX_IN} in at ${PPI} ppi`);
  if (Math.max(IMG.srcW, IMG.srcH) < BOX_PX)
    console.log(`note: your image is ${IMG.srcW} × ${IMG.srcH} px — use one at least ` +
                `${BOX_PX} px on its long side for full sharpness`);
}

// write "300 ppi" into the PNG (a pHYs chunk right after the header)
function setPNGppi(bytes, ppi) {
  const ppm = Math.round(ppi / 0.0254);            // pixels per metre
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);                               // data length
  chunk.set([112, 72, 89, 115], 4);                 // "pHYs"
  dv.setUint32(8, ppm); dv.setUint32(12, ppm);
  chunk[16] = 1;                                    // unit = metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33;                                    // 8-byte signature + 25-byte IHDR
  const out = new Uint8Array(bytes.length + 21);
  out.set(bytes.subarray(0, at)); out.set(chunk, at); out.set(bytes.subarray(at), at + 21);
  return out;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}


/* ================================================================
   STAND-IN IMAGE so the sketch runs before you load one
   ================================================================ */
function makeDefaultImage() {
  const g = createGraphics(700, 820);
  g.pixelDensity(1);
  g.background(255);                     // white background (the grid ignores it)
  g.noStroke();
  g.fill(DEFAULT_COLOR);                 // one flat colour, no shading
  noiseSeed(7);
  // the same organic silhouette as before, built from 9 overlapping blobs
  for (let k = 0; k < 9; k++) {
    const cx = 350 + (k % 3 - 1) * 90, cy = 260 + floor(k / 3) * 150;
    const r = 150 - k * 6;
    g.beginShape();
    for (let a = 0; a < TWO_PI; a += 0.06) {
      const nr = r * (0.75 + 0.5 * noise(k * 3 + cos(a), sin(a), r * 0.004));
      g.vertex(cx + cos(a) * nr, cy + sin(a) * nr * 1.15);
    }
    g.endShape(CLOSE);
  }
  return g;
}


/* ================================================================
   CONTROLS
   ================================================================ */
function buildPanel() {
  // styles for the control bar: one row, sans-serif, evenly spaced
  createElement('style', `
    body, button, label, span, input { font-family: ${UI_FONT}; font-size: 12px; }
    #bar { position: fixed; left: 0; right: 0; bottom: 0; height: ${PANEL_H}px;
           display: flex; align-items: center; gap: 22px; padding: 0 20px;
           box-sizing: border-box; white-space: nowrap; overflow-x: auto; }
    #bar .group { display: flex; align-items: center; gap: 8px; }
    #bar input[type=range] { width: 100px; margin: 0; }
    #bar label { display: flex; align-items: center; gap: 4px; }
    #bar .spacer { flex: 1; }
    #bar button { background: #0a6cff; color: #fff; border: none; border-radius: 6px;
                  padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
    #bar button:hover  { background: #0057d9; }
    #bar button:active { background: #0047b3; }
  `).parent(document.head);

  const bar = createDiv().id('bar');

  ui.depth  = makeSlider(bar, 'depth',  1, 12, 8);
  ui.smear  = makeSlider(bar, 'smear',  0, 100, 55);
  ui.void   = makeSlider(bar, 'void',   0, 100, 12);
  ui.thresh = makeSlider(bar, 'bg cut', 0, 120, 28);

  ui.grid   = createCheckbox('grid', true).parent(bar).changed(requestRender);
  ui.labels = createCheckbox('labels', true).parent(bar).changed(requestRender);
  ui.ghost  = createCheckbox('ghost', false).parent(bar).changed(requestRender);

  createDiv().addClass('spacer').parent(bar);      // pushes the buttons to the right
  createButton('reseed').parent(bar).mousePressed(reseed);
  createButton('save png').parent(bar).mousePressed(savePNG);
}

// a slider with its name in front of it, added to the bar
function makeSlider(bar, name, lo, hi, val) {
  const group = createDiv().addClass('group').parent(bar);
  createSpan(name).parent(group);
  return createSlider(lo, hi, val, 1).parent(group).input(requestRender);
}

function readPanel() {
  P.depth  = ui.depth.value();
  P.smear  = ui.smear.value() / 100;
  P.void   = ui.void.value() / 100;
  P.thresh = ui.thresh.value();
  P.grid   = ui.grid.checked();
  P.labels = ui.labels.checked();
  P.ghost  = ui.ghost.checked();
}

function reseed() {
  seed = Math.floor(Math.random() * 1e6);   // Math.random: p5's random() is seeded
  requestRender();
}

function keyPressed() {
  if (key === ' ') { reseed(); return false; }
  if (key === 's') savePNG();
}