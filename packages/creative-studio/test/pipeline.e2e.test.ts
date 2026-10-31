// End-to-end: real FFmpeg + headless Chromium. Skips (with a reason) on hosts
// without them; set POLYTH_REQUIRE_CHROMIUM=1 to make that a failure.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { findChromiumExecutable } from "@polyth/browser/chromium";
import { applyStudioPatch, stageCriteria, studioPaths } from "../src/index.ts";
import { StudioStore } from "../src/server/store.ts";
import { createStudioService } from "../src/server/service.ts";
import { createStudioTools } from "../src/server/tools.ts";
import { verifyVideo } from "../src/render/renderer.ts";

const STUDIO = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const chromium = await findChromiumExecutable().catch(() => null);
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !chromium || !hasFfmpeg ? `needs Chromium and FFmpeg (chromium=${Boolean(chromium)}, ffmpeg=${hasFfmpeg})` : false;

const cwd = await mkdtemp(path.join(tmpdir(), "creative-studio-"));
after(() => rm(cwd, { recursive: true, force: true }));

/** 8 s, 120 BPM: kick on beats, louder second half. */
function wav(seconds: number): Buffer {
  const rate = 22050;
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const s = t % 0.5;
    const kick = Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-s * 30)) * s) * Math.exp(-s * 9);
    const pad = Math.sin(2 * Math.PI * 220 * t) * 0.1;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, (kick + pad) * (t < 4 ? 0.4 : 0.9))) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const CANVAS = `export default {
  setup(ctx, info) { return { r: Math.min(info.width, info.height) * 0.2 }; },
  draw(ctx, f, s) {
    ctx.fillStyle = f.palette[0]; ctx.fillRect(0, 0, f.width, f.height);
    ctx.fillStyle = f.palette[2];
    ctx.beginPath(); ctx.arc(f.width * (0.2 + 0.6 * f.progress), f.height / 2, s.r * (0.6 + 0.6 * f.pulse), 0, Math.PI * 2); ctx.fill();
  }
};`;
const SVG = `export default {
  draw(f) {
    const w = f.width, h = f.height, x = w * (0.1 + 0.8 * f.progress);
    return '<rect width="' + w + '" height="' + h + '" fill="' + f.palette[1] + '"/>' +
      '<circle cx="' + x + '" cy="' + h / 2 + '" r="' + (h * 0.15 * (1 + f.energy)) + '" fill="' + f.palette[3] + '"/>';
  }
};`;
const THREE = `export default {
  setup({ THREE, scene }) {
    const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1.2, 0.35, 96, 12), new THREE.MeshStandardMaterial({ color: 0xff6b8b }));
    scene.add(mesh, new THREE.AmbientLight(0xffffff, 0.5));
    const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(3, 4, 5); scene.add(light);
    return { mesh };
  },
  draw(f, s) { s.mesh.rotation.y = f.local * 1.5; s.mesh.rotation.x = f.beatPhase; s.mesh.scale.setScalar(1 + 0.2 * f.pulse); }
};`;
const BROKEN = `export default { draw(ctx, f) { if (f.local > 0) throw new Error("boom " + f.scene.id); } };`;
const BLANK = `export default { draw(ctx, f) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, f.width, f.height); } };`;

test("song → analysis → scenes → stills/QA → preview video", { skip, timeout: 240_000 }, async () => {
  const store = new StudioStore();
  const service = createStudioService({ store, renderer: { chromiumPath: async () => chromium } });
  const tools = Object.fromEntries(createStudioTools(service).map((tool) => [tool.descriptor.kind === "tool" ? tool.descriptor.name : "", tool.execute!]));
  const ctx = { sessionId: STUDIO, projectId: "p", cwd };
  const call = async (name: string, input: Record<string, unknown>) => JSON.parse((await tools[name]!(input as never, ctx)).output);
  try {
    const paths = studioPaths(STUDIO);
    await writeFile(path.join(cwd, "song.wav"), wav(8));
    const init = await call("creative_studio_init", { idea: "A glowing orb follows the kick drum through three worlds", durationSec: 8, effort: "sketch", audioPath: "song.wav" });
    assert.equal(init.created, true);

    const analysis = await call("creative_audio_analyze", { lyricsText: "first line here\nsecond line here" });
    assert.ok(Math.abs(analysis.bpm - 120) < 3, `bpm ${analysis.bpm}`);
    assert.equal(analysis.lyrics.source, "text");

    await call("creative_studio_update", {
      role: "planner",
      patch: {
        styleGuide: { palette: ["#0b0b14", "#f4f1ea", "#7c6cff", "#ff6b8b"], background: "#0b0b14" },
        scenes: [
          { id: "orb", title: "Orb", start: 0, end: 2, renderer: "canvas2d", description: "An orb pulses on the kick" },
          { id: "vector", title: "Vector", start: 2, end: 4, renderer: "svg", description: "Vector circle grows with energy", transition: { kind: "fade", duration: 0.4 } },
          { id: "knot", title: "Knot", start: 4, end: 6, renderer: "three", description: "A 3D knot spins on the beat", transition: { kind: "flash", duration: 0.3 } },
          { id: "broken", title: "Broken", start: 6, end: 7, renderer: "canvas2d", description: "Throws to prove error reporting" },
          { id: "blank", title: "Blank", start: 7, end: 8, renderer: "canvas2d", description: "Draws nothing visible on purpose" },
        ],
        stages: { brief: { status: "done" }, concept: { status: "active" } },
      },
    });
    // A stage cannot be closed before its criteria hold.
    await assert.rejects(call("creative_studio_update", { patch: { stages: { production: { status: "done" } } } }), /not ready: code/);

    const written = await call("creative_scene_write", { sceneId: "orb", code: CANVAS });
    assert.equal(written.ok, true, JSON.stringify(written));
    await assert.rejects(call("creative_scene_write", { sceneId: "orb", code: "import x from 'y'; export default {}" }), /must not import/);
    for (const [id, code] of [["vector", SVG], ["knot", THREE], ["broken", BROKEN], ["blank", BLANK]] as const) {
      await call("creative_scene_write", { sceneId: id, code, renderStill: false });
    }

    const stills = await call("creative_render", { kind: "stills" });
    assert.equal(stills.scenes.length, 5);
    assert.ok(stills.contactSheet);
    for (const scene of stills.scenes) assert.ok((await stat(path.join(cwd, scene.still))).size > 1000);
    assert.ok(stills.errors.some((error: { sceneId: string; message: string }) => error.sceneId === "broken" && /boom broken/.test(error.message)));
    assert.ok(!stills.errors.some((error: { sceneId: string }) => ["orb", "vector", "knot", "runtime"].includes(error.sceneId)), JSON.stringify(stills.errors));
    assert.ok(stills.findings.some((finding: { sceneId?: string; severity: string }) => finding.sceneId === "blank" && finding.severity === "error"));
    // The Three.js still actually shows the pink knot, not the background.
    const knotStats = stills.scenes.find((scene: { sceneId: string }) => scene.sceneId === "knot").stats;
    assert.ok(knotStats.every((stats: { std: number }) => stats.std > 0.03), JSON.stringify(knotStats));

    let state = (await store.read({ cwd, studioId: STUDIO }))!;
    assert.equal(state.scenes.find((scene) => scene.id === "broken")!.status, "needs-fix");
    assert.ok(!stageCriteria(state, "production").find((criterion) => criterion.id === "errors")!.met);

    // Fix the broken scene; its still re-renders and the error clears.
    const fixed = await call("creative_scene_write", { sceneId: "broken", code: CANVAS });
    assert.equal(fixed.ok, true);
    state = (await store.read({ cwd, studioId: STUDIO }))!;
    assert.equal(state.scenes.find((scene) => scene.id === "broken")!.lastError, undefined);

    const started = await call("creative_render", { kind: "preview" });
    assert.equal(started.job.status, "running");
    const finished = await call("creative_render_wait", { jobId: started.job.id, timeoutSec: 200 });
    assert.equal(finished.job.status, "done", JSON.stringify(finished.job));
    const video = path.join(cwd, paths.render("preview"));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", video], { encoding: "utf8" }));
    const types = probe.streams.map((stream: { codec_type: string }) => stream.codec_type).sort();
    assert.deepEqual(types, ["audio", "video"]);
    assert.ok(Math.abs(Number(probe.format.duration) - 8) < 0.3, `duration ${probe.format.duration}`);
    assert.ok((await readFile(path.join(cwd, paths.liveFrame))).length > 1000, "live frame written during render");

    state = (await store.read({ cwd, studioId: STUDIO }))!;
    assert.ok(stageCriteria(state, "assembly").every((criterion) => criterion.met), JSON.stringify(stageCriteria(state, "assembly")));
    // Rewriting a scene makes the preview stale again.
    await call("creative_scene_write", { sceneId: "orb", code: CANVAS, renderStill: false });
    state = (await store.read({ cwd, studioId: STUDIO }))!;
    assert.ok(!stageCriteria(state, "assembly").find((criterion) => criterion.id === "preview")!.met);
    assert.ok(state.activity.some((entry) => /Preview render finished/.test(entry.message)));
  } finally {
    await service.dispose();
  }
});

test("a render can be cancelled and leaves no partial output", { skip, timeout: 120_000 }, async () => {
  const studio = "7a1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  const store = new StudioStore();
  const service = createStudioService({ store, renderer: { chromiumPath: async () => chromium } });
  const ref = { cwd, studioId: studio };
  try {
    await store.init(ref, { idea: "cancel test video idea", durationSec: 30, effort: "balanced" });
    await store.update(ref, (state) => applyStudioPatch(state, {
      scenes: [{ id: "one", title: "One", start: 0, end: 30, renderer: "canvas2d", description: "Plain animated canvas" }],
    }));
    await store.writeScene(ref, "one", CANVAS);
    const job = await service.startRender(ref, "final");
    await assert.rejects(service.startRender(ref, "preview"), /already running/);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(await service.cancelRender(ref), true);
    const state = (await store.read(ref))!;
    const stored = state.renders.find((candidate) => candidate.id === job.id)!;
    assert.equal(stored.status, "cancelled");
    await assert.rejects(stat(path.join(cwd, studioPaths(studio).render("final"))));
  } finally {
    await service.dispose();
  }
});

test("autonomous delivery: verified final copied to the delivery path, report closes export", { skip, timeout: 240_000 }, async () => {
  const studio = "8b1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  const store = new StudioStore();
  const service = createStudioService({ store, renderer: { chromiumPath: async () => chromium } });
  const tools = Object.fromEntries(createStudioTools(service).map((tool) => [tool.descriptor.kind === "tool" ? tool.descriptor.name : "", tool.execute!]));
  const ctx = { sessionId: studio, projectId: "p", cwd };
  const call = async (name: string, input: Record<string, unknown>) => JSON.parse((await tools[name]!(input as never, ctx)).output);
  try {
    await writeFile(path.join(cwd, "song6.wav"), wav(6));
    const init = await call("creative_studio_init", {
      idea: "Two orbs dance to the kick until the end of the song", effort: "sketch", autonomy: "autonomous", audioPath: "song6.wav",
      mediaKind: "dance", delivery: { height: 720, fps: 24, matchSongLength: true, outputPath: "final/music-video.mp4", reportPath: "report.md" },
    });
    assert.deepEqual(init.studio.delivery, { width: 1280, height: 720, fps: 24, matchSongLength: true, outputPath: "final/music-video.mp4", reportPath: "report.md" });
    await call("creative_audio_analyze", {});
    await call("creative_studio_update", { patch: { scenes: [
      { id: "one", title: "One", start: 0, end: 3, renderer: "canvas2d", description: "Orb pulses on the kick" },
      { id: "two", title: "Two", start: 3, end: 6, renderer: "svg", description: "Vector orb grows with energy", transition: { kind: "fade", duration: 0.3 } },
    ] } });
    await call("creative_scene_write", { sceneId: "one", code: CANVAS, renderStill: false });
    await call("creative_scene_write", { sceneId: "two", code: SVG, renderStill: false });
    const { job } = await call("creative_render", { kind: "final" });
    const finished = await call("creative_render_wait", { jobId: job.id, timeoutSec: 220 });
    assert.equal(finished.job.status, "done", JSON.stringify(finished.job));
    assert.equal(finished.job.verification.ok, true, JSON.stringify(finished.job.verification));
    assert.equal(finished.job.verification.width, 1280);
    assert.equal(finished.job.verification.fps, 24);
    assert.ok(Math.abs(finished.job.verification.durationSec - 6) <= 0.1, `length ${finished.job.verification.durationSec}`);
    assert.equal(finished.job.delivered, "final/music-video.mp4");
    assert.ok((await stat(path.join(cwd, "final/music-video.mp4"))).size > 10_000);
    let state = (await store.read({ cwd, studioId: studio }))!;
    assert.deepEqual(stageCriteria(state, "export").map((criterion) => [criterion.id, criterion.met]), [["final", true], ["verified", true], ["delivered", true], ["report", false]]);
    const report = await call("creative_report_write", { markdown: "# Report\n\nTwo orbs; verified length and codecs with the server check." });
    assert.equal(report.path, "report.md");
    assert.match(await readFile(path.join(cwd, "report.md"), "utf8"), /^# Report/);
    state = (await store.read({ cwd, studioId: studio }))!;
    assert.ok(stageCriteria(state, "export").every((criterion) => criterion.met));

    // The same check rejects a file that does not match the spec.
    const wrong = await verifyVideo(path.join(cwd, "final/music-video.mp4"), { width: 1920, height: 1080, fps: 30, durationSec: 6, songSec: 9 });
    assert.equal(wrong.ok, false);
    assert.ok(wrong.problems.some((problem) => /size is 1280×720/.test(problem)));
    assert.ok(wrong.problems.some((problem) => /frame rate is 24/.test(problem)));
    assert.ok(wrong.problems.some((problem) => /expected 9\.00 s \(the song\)/.test(problem)));
  } finally {
    await service.dispose();
  }
});
