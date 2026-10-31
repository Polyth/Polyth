// Listens for the user starting to talk while the agent speaks (barge-in).
// It only measures loudness on an echo-cancelled stream — no audio leaves the
// device and nothing is transcribed — and runs only while a reply plays.
import { createVoiceActivityDetector } from "@polyth/dictation";
import { speechAudioContext } from "@polyth/dictation/voice-runtime";
import { voiceModeStrings } from "../src/strings.ts";
import { getLocale } from "../../../apps/web/src/i18n/index.ts";

export interface MicMonitor {
  stop(): void;
}

export interface MicMonitorEvents {
  onSpeech(): void;
  onLevel?(level: number): void;
}

export async function startMicMonitor(events: MicMonitorEvents): Promise<MicMonitor> {
  const context = speechAudioContext();
  if (!context || !navigator.mediaDevices?.getUserMedia) throw new Error(voiceModeStrings(getLocale()).micMonitorUnavailable);
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (context.state === "suspended") await context.resume().catch(() => {});
  const source = context.createMediaStreamSource(media);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  // Stricter than turn-taking: residual echo of the agent's own voice must
  // not count, so speech needs a clear margin and a deliberate onset.
  const vad = createVoiceActivityDetector({ minSpeechRms: 0.035, speechRatio: 3.4, onsetMs: 240, calibrationMs: 300 });
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    events.onLevel?.(vad.level(rms));
    if (vad.push(rms, performance.now()) === "speech-start") events.onSpeech();
  }, 40);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try { source.disconnect(); } catch { /* already detached */ }
      for (const track of media.getTracks()) track.stop();
    },
  };
}
