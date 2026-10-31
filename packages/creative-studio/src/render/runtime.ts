// Scene runtime. ONE implementation runs in two places:
//   * headless Chromium on the server (stills, preview and final renders);
//   * the sandboxed live-preview iframe in the studio surface.
// It is shipped as a plain JavaScript string so both hosts execute exactly the
// same bytes. Keep it self-contained: no imports, no template literals.
//
// Scene module contract (ES module, default export):
//   canvas2d: { setup?(ctx, info) => state, draw(ctx, f, state) }
//   svg:      { setup?(info) => state, draw(f, state) => "<svg…>" or inner SVG markup }
//   three:    { setup?({ THREE, scene, camera, renderer, width, height, palette }) => state,
//               draw(f, state, three) }   — the runtime renders three.scene/three.camera
// `f` is the frame: time, beat/bar phase, loudness and band curves, section,
// lyric line, palette and deterministic random — see the skill reference.

import { CURVE_RATE, type AudioAnalysis } from "../audio/analysis.ts";
import type { RendererKind, StudioScene, StudioState, TransitionKind } from "../index.ts";

export interface RuntimeScene {
  id: string;
  title: string;
  description: string;
  start: number;
  end: number;
  renderer: RendererKind;
  transition?: { kind: TransitionKind; duration: number };
  code?: string;
}

export interface RuntimeAnalysis {
  duration: number;
  bpm: number;
  beats: number[];
  downbeats: number[];
  sections: Array<{ start: number; end: number; kind: string; group: string; energy: number }>;
  accents: number[];
  curve: { rate: number; rms: number[]; low: number[]; mid: number[]; high: number[]; onset: number[] };
  lyrics: Array<{ start: number; end: number; text: string }>;
}

export interface RuntimeInput {
  width: number;
  height: number;
  duration: number;
  scenes: RuntimeScene[];
  analysis: RuntimeAnalysis | null;
  palette: string[];
  background: string;
  typography: string;
  lyricsOverlay: boolean;
  /** three.core.js + three.module.js sources; only when a scene needs Three.js. */
  three?: { core: string; module: string } | null;
}

export function runtimeAnalysis(analysis: AudioAnalysis | null | undefined): RuntimeAnalysis | null {
  if (!analysis) return null;
  return {
    duration: analysis.durationSec,
    bpm: analysis.bpm,
    beats: analysis.beats,
    downbeats: analysis.downbeats,
    sections: analysis.sections,
    accents: analysis.accents,
    curve: { ...analysis.curve, rate: analysis.curve.rate || CURVE_RATE },
    lyrics: analysis.lyrics?.lines ?? [],
  };
}

export function runtimeInput(input: {
  state: StudioState;
  analysis: AudioAnalysis | null;
  codes: Record<string, string | undefined>;
  width: number;
  height: number;
  three?: RuntimeInput["three"];
  scenes?: readonly StudioScene[];
}): RuntimeInput {
  const guide = input.state.styleGuide;
  const palette = guide?.palette.length ? guide.palette : ["#101018", "#f2f2f7", "#7c6cff", "#ff6b8b", "#ffd166"];
  const scenes = (input.scenes ?? input.state.scenes).map((scene): RuntimeScene => ({
    id: scene.id,
    title: scene.title,
    description: scene.description,
    start: scene.start,
    end: scene.end,
    renderer: scene.renderer,
    ...(scene.transition ? { transition: scene.transition } : {}),
    ...(input.codes[scene.id] ? { code: input.codes[scene.id] } : {}),
  }));
  return {
    width: input.width,
    height: input.height,
    duration: input.analysis?.durationSec ?? input.state.format.durationSec,
    scenes,
    analysis: runtimeAnalysis(input.analysis),
    palette,
    background: guide?.background ?? palette[0]!,
    typography: guide?.typography ?? "",
    lyricsOverlay: Boolean(input.state.format.lyricsOverlay),
    three: input.three ?? null,
  };
}

export const needsThree = (scenes: readonly Pick<StudioScene, "renderer">[]) =>
  scenes.some((scene) => scene.renderer === "three");

export const STUDIO_RUNTIME_SOURCE = String.raw`
(function () {
  "use strict";
  var S = { ready: false, errors: [], version: 1 };
  globalThis.__studio = S;
  var W = 0, H = 0, out = null, octx = null, input = null, scenes = [], A = null;
  var threeLib = null, threeRenderer = null, threeCanvas = null, statsCanvas = null, lastStats = null;
  var errorKeys = {};

  function msg(e) { return e && e.message ? String(e.message) : String(e); }
  function record(sceneId, e, t) {
    var text = msg(e).slice(0, 300);
    var key = sceneId + "|" + text;
    if (errorKeys[key]) return;
    errorKeys[key] = true;
    S.errors.push({ sceneId: sceneId, message: text, t: t });
  }
  function canvas(w, h) { var c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function ease(k) { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function lastAtOrBefore(arr, t) { var lo = 0, hi = arr.length - 1, f = -1; while (lo <= hi) { var m = (lo + hi) >> 1; if (arr[m] <= t) { f = m; lo = m + 1; } else hi = m - 1; } return f; }
  function curveAt(values, rate, t) {
    if (!values || !values.length) return 0;
    var p = Math.max(0, t * rate), i = Math.floor(p);
    if (i >= values.length - 1) return values[values.length - 1];
    var k = p - i; return values[i] * (1 - k) + values[i + 1] * k;
  }

  async function loadThree(src) {
    var coreUrl = URL.createObjectURL(new Blob([src.core], { type: "text/javascript" }));
    var text = src.module.split("'./three.core.js'").join(JSON.stringify(coreUrl)).split('"./three.core.js"').join(JSON.stringify(coreUrl));
    var modUrl = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    return await import(modUrl);
  }

  async function loadModule(code) {
    var url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    try { var m = await import(url); return m.default || m; } finally { URL.revokeObjectURL(url); }
  }

  S.init = async function (value) {
    input = value; W = value.width; H = value.height; A = value.analysis;
    S.errors = []; errorKeys = {}; lastStats = null;
    out = value.canvas || document.getElementById("studio-out") || canvas(W, H);
    out.width = W; out.height = H;
    octx = out.getContext("2d");
    var wantsThree = value.scenes.some(function (s) { return s.renderer === "three" && s.code; });
    if (wantsThree && !threeLib) {
      if (!value.three) record("runtime", new Error("Three.js is not available on this host"), 0);
      else {
        try {
          threeLib = await loadThree(value.three);
        } catch (e) { record("runtime", e, 0); }
      }
    }
    if (threeLib && !threeRenderer) {
      threeCanvas = canvas(W, H);
      try {
        threeRenderer = new threeLib.WebGLRenderer({ canvas: threeCanvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
        threeRenderer.setPixelRatio(1);
      } catch (e) { record("runtime", e, 0); }
    }
    if (threeRenderer) threeRenderer.setSize(W, H, false);
    scenes = [];
    for (var i = 0; i < value.scenes.length; i++) {
      var def = value.scenes[i];
      var entry = { def: def, mod: null, state: undefined, ready: false, layer: canvas(W, H), three: null, failed: false };
      if (def.code) {
        try { entry.mod = await loadModule(def.code); }
        catch (e) { entry.failed = true; record(def.id, e, def.start); }
      }
      scenes.push(entry);
    }
    S.ready = true;
    return { errors: S.errors.slice() };
  };

  function sceneAt(t) {
    for (var i = 0; i < scenes.length; i++) {
      var d = scenes[i].def;
      if (t >= d.start && t < d.end) return i;
    }
    return scenes.length ? (t < scenes[0].def.start ? 0 : scenes.length - 1) : -1;
  }

  function frame(entry, t, index) {
    var d = entry.def, dur = Math.max(0.001, d.end - d.start), local = t - d.start;
    var f = {
      t: t, time: t, local: local, duration: dur, progress: clamp(local / dur, 0, 1),
      width: W, height: H, palette: input.palette, background: input.background, typography: input.typography,
      bpm: A ? A.bpm : 120, beatIndex: -1, beatPhase: 0, sinceBeat: 0, isDownbeat: false, bar: -1, barPhase: 0, pulse: 0,
      energy: 0, low: 0, mid: 0, high: 0, onset: 0, accent: 0,
      section: { kind: "verse", group: "A", index: 0, progress: 0, energy: 0 },
      lyric: null, scene: { id: d.id, title: d.title, index: index },
      random: mulberry(hash(d.id) + Math.floor(t * 1000)),
      seeded: function (n) { return mulberry(hash(d.id) + (n | 0)); },
      util: { clamp: clamp, lerp: lerp, ease: ease }
    };
    if (A) {
      var bi = lastAtOrBefore(A.beats, t);
      var period = 60 / (A.bpm || 120);
      var b0 = bi >= 0 ? A.beats[bi] : 0, b1 = bi >= 0 && bi + 1 < A.beats.length ? A.beats[bi + 1] : b0 + period;
      f.beatIndex = bi; f.sinceBeat = bi >= 0 ? t - b0 : t; f.beatPhase = bi >= 0 ? clamp((t - b0) / Math.max(0.05, b1 - b0), 0, 1) : 0;
      f.pulse = Math.exp(-f.sinceBeat * 7);
      var di = lastAtOrBefore(A.downbeats, t);
      f.bar = di; f.isDownbeat = di >= 0 && Math.abs(A.downbeats[di] - b0) < 0.02;
      if (di >= 0) { var d0 = A.downbeats[di], d1 = A.downbeats[di + 1] || d0 + period * 4; f.barPhase = clamp((t - d0) / Math.max(0.1, d1 - d0), 0, 1); }
      var rate = A.curve.rate;
      f.energy = curveAt(A.curve.rms, rate, t); f.low = curveAt(A.curve.low, rate, t); f.mid = curveAt(A.curve.mid, rate, t);
      f.high = curveAt(A.curve.high, rate, t); f.onset = curveAt(A.curve.onset, rate, t);
      var ai = lastAtOrBefore(A.accents, t); f.accent = ai >= 0 ? Math.exp(-(t - A.accents[ai]) * 6) : 0;
      for (var s = 0; s < A.sections.length; s++) {
        var sec = A.sections[s];
        if (t >= sec.start && (t < sec.end || s === A.sections.length - 1)) {
          f.section = { kind: sec.kind, group: sec.group, index: s, energy: sec.energy, progress: clamp((t - sec.start) / Math.max(0.1, sec.end - sec.start), 0, 1) };
          break;
        }
      }
      var li = -1;
      for (var l = 0; l < A.lyrics.length; l++) { if (A.lyrics[l].start <= t) li = l; else break; }
      if (li >= 0 && t < A.lyrics[li].end) { var ln = A.lyrics[li]; f.lyric = { text: ln.text, index: li, progress: clamp((t - ln.start) / Math.max(0.1, ln.end - ln.start), 0, 1) }; }
    }
    return f;
  }

  function wrap(text, ctx, maxWidth) {
    var words = String(text || "").split(/\s+/), lines = [], line = "";
    for (var i = 0; i < words.length; i++) {
      var probe = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(probe).width > maxWidth && line) { lines.push(line); line = words[i]; } else line = probe;
      if (lines.length >= 4) break;
    }
    if (line && lines.length < 5) lines.push(line);
    return lines;
  }

  // Animatic card for a scene that has no code yet: the storyboard, timed to music.
  function placeholder(entry, f, ctx, error) {
    var p = input.palette;
    ctx.fillStyle = error ? "#1a0b10" : (p[0] || "#111");
    ctx.fillRect(0, 0, W, H);
    var k = 0.5 + 0.5 * f.pulse;
    ctx.fillStyle = p[2] || "#7c6cff";
    ctx.globalAlpha = 0.12 + 0.18 * f.energy;
    ctx.beginPath(); ctx.arc(W * 0.5, H * 0.5, Math.min(W, H) * (0.18 + 0.08 * k), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = error ? "#ff6b8b" : (p[1] || "#eee");
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "600 " + Math.round(H * 0.06) + "px system-ui, sans-serif";
    ctx.fillText(error ? "Scene error: " + entry.def.id : entry.def.title, W / 2, H * 0.4);
    ctx.font = Math.round(H * 0.035) + "px system-ui, sans-serif";
    ctx.globalAlpha = 0.85;
    var lines = wrap(error || entry.def.description, ctx, W * 0.75);
    for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], W / 2, H * 0.52 + i * H * 0.05);
    ctx.globalAlpha = 1;
    ctx.fillStyle = p[3] || "#ff6b8b";
    ctx.fillRect(0, H - H * 0.012, W * f.progress, H * 0.012);
  }

  async function drawScene(index, t) {
    var entry = scenes[index], d = entry.def, ctx = entry.layer.getContext("2d");
    var f = frame(entry, t, index);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    if (!entry.mod || entry.failed) { placeholder(entry, f, ctx, entry.failed ? (S.errors.find(function (e) { return e.sceneId === d.id; }) || {}).message : null); return; }
    try {
      var m = entry.mod;
      if (d.renderer === "three") {
        if (!threeLib || !threeRenderer) throw new Error("Three.js renderer unavailable");
        if (!entry.ready) {
          var camera = new threeLib.PerspectiveCamera(50, W / H, 0.1, 1000); camera.position.set(0, 0, 6);
          entry.three = { THREE: threeLib, scene: new threeLib.Scene(), camera: camera, renderer: threeRenderer, width: W, height: H, palette: input.palette };
          entry.three.scene.background = new threeLib.Color(input.background);
          entry.state = m.setup ? await m.setup(entry.three) : undefined; entry.ready = true;
        }
        await m.draw(f, entry.state, entry.three);
        threeRenderer.render(entry.three.scene, entry.three.camera);
        ctx.drawImage(threeCanvas, 0, 0, W, H);
      } else if (d.renderer === "svg") {
        if (!entry.ready) { entry.state = m.setup ? await m.setup({ width: W, height: H, palette: input.palette }) : undefined; entry.ready = true; }
        var markup = String(await m.draw(f, entry.state) || "");
        if (markup.indexOf("<svg") === -1) markup = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '">' + markup + "</svg>";
        else if (markup.indexOf("xmlns=") === -1) markup = markup.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
        var img = new Image();
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
        await img.decode();
        ctx.drawImage(img, 0, 0, W, H);
      } else {
        if (!entry.ready) { entry.state = m.setup ? await m.setup(ctx, { width: W, height: H, palette: input.palette }) : undefined; entry.ready = true; }
        ctx.save(); await m.draw(ctx, f, entry.state); ctx.restore();
      }
    } catch (e) {
      record(d.id, e, t);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
      placeholder(entry, f, ctx, msg(e));
    }
  }

  function drawLyrics(t) {
    if (!input.lyricsOverlay || !A || !A.lyrics.length) return;
    var f = frame(scenes[0] || { def: { id: "lyrics", start: 0, end: 1, title: "" } }, t, 0);
    if (!f.lyric) return;
    var k = f.lyric.progress, alpha = Math.min(1, Math.min(k, 1 - k) * 8);
    octx.save();
    octx.globalAlpha = clamp(alpha, 0, 1);
    octx.font = "600 " + Math.round(H * 0.05) + "px " + (input.typography || "system-ui, sans-serif");
    octx.textAlign = "center"; octx.textBaseline = "alphabetic";
    octx.shadowColor = "rgba(0,0,0,0.65)"; octx.shadowBlur = H * 0.02;
    octx.fillStyle = "#ffffff";
    var lines = wrap(f.lyric.text, octx, W * 0.84).slice(0, 2);
    for (var i = 0; i < lines.length; i++) octx.fillText(lines[i], W / 2, H * 0.9 - (lines.length - 1 - i) * H * 0.06);
    octx.restore();
  }

  S.renderFrame = async function (t) {
    if (!S.ready) throw new Error("runtime not initialised");
    octx.setTransform(1, 0, 0, 1, 0, 0); octx.globalAlpha = 1;
    octx.fillStyle = input.background || "#000"; octx.fillRect(0, 0, W, H);
    var i = sceneAt(t);
    if (i < 0) { drawLyrics(t); return; }
    var cur = scenes[i], tr = cur.def.transition, into = t - cur.def.start;
    if (i > 0 && tr && tr.kind !== "cut" && tr.duration > 0 && into >= 0 && into < tr.duration) {
      var k = ease(into / tr.duration);
      await drawScene(i - 1, t);
      await drawScene(i, t);
      var prev = scenes[i - 1].layer;
      if (tr.kind === "fade") { octx.drawImage(prev, 0, 0); octx.globalAlpha = k; octx.drawImage(cur.layer, 0, 0); octx.globalAlpha = 1; }
      else if (tr.kind === "wipe") { octx.drawImage(prev, 0, 0); octx.save(); octx.beginPath(); octx.rect(0, 0, W * k, H); octx.clip(); octx.drawImage(cur.layer, 0, 0); octx.restore(); }
      else { octx.drawImage(k < 0.5 ? prev : cur.layer, 0, 0); octx.fillStyle = "#ffffff"; octx.globalAlpha = 1 - Math.abs(2 * k - 1); octx.fillRect(0, 0, W, H); octx.globalAlpha = 1; }
    } else {
      await drawScene(i, t);
      octx.drawImage(cur.layer, 0, 0);
    }
    drawLyrics(t);
  };

  S.capture = function (type, quality) { return out.toDataURL(type || "image/jpeg", quality || 0.9); };

  // Cheap visual statistics on a 64×36 thumbnail for automatic QA.
  S.stats = function () {
    if (!statsCanvas) statsCanvas = canvas(64, 36);
    var sctx = statsCanvas.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(out, 0, 0, 64, 36);
    var data = sctx.getImageData(0, 0, 64, 36).data, n = 64 * 36, sum = 0, sq = 0, lum = new Float32Array(n);
    for (var i = 0; i < n; i++) { var y = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255; lum[i] = y; sum += y; sq += y * y; }
    var mean = sum / n, std = Math.sqrt(Math.max(0, sq / n - mean * mean)), diff = null;
    if (lastStats) { var dsum = 0; for (var j = 0; j < n; j++) dsum += Math.abs(lum[j] - lastStats[j]); diff = dsum / n; }
    lastStats = lum;
    return { mean: mean, std: std, diff: diff };
  };
  S.resetStats = function () { lastStats = null; };

  // Contact sheet of labelled thumbnails (data URLs) → JPEG data URL.
  S.contactSheet = async function (items, columns) {
    var cols = Math.max(1, columns || 4), rows = Math.ceil(items.length / cols);
    var tw = 320, th = Math.round(tw * H / W), pad = 8, label = 26;
    var sheet = canvas(cols * (tw + pad) + pad, rows * (th + label + pad) + pad), c = sheet.getContext("2d");
    c.fillStyle = "#111"; c.fillRect(0, 0, sheet.width, sheet.height);
    for (var i = 0; i < items.length; i++) {
      var x = pad + (i % cols) * (tw + pad), y = pad + Math.floor(i / cols) * (th + label + pad);
      var img = new Image(); img.src = items[i].src; await img.decode();
      c.drawImage(img, x, y, tw, th);
      c.fillStyle = "#ddd"; c.font = "14px system-ui, sans-serif"; c.textBaseline = "top";
      c.fillText(String(items[i].label).slice(0, 40), x + 2, y + th + 5);
    }
    return sheet.toDataURL("image/jpeg", 0.86);
  };
})();
`;

/** HTML page for the headless renderer. */
export function rendererPage(): string {
  return "<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{margin:0;background:#000}</style></head>"
    + "<body><canvas id=\"studio-out\"></canvas><script>" + STUDIO_RUNTIME_SOURCE + "</script></body></html>";
}
