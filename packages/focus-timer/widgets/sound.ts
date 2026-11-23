// The timer's sounds, synthesised with Web Audio: no audio files to ship or
// fetch, crisp at any volume, and each one short enough not to startle. A
// browser lets a page make sound only after a gesture, so the context is
// opened on the person's first Start or preview press and kept for later.
import type { SoundId } from "../src/settings.ts";

type AudioContextCtor = new () => AudioContext;

let context: AudioContext | null = null;

function audioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Open (or wake) the audio context. Call from a user gesture. */
export function unlockAudio(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    context ??= new Ctor();
    if (context.state === "suspended") void context.resume().catch(() => {});
    return context;
  } catch {
    return null;
  }
}

export function closeAudio(): void {
  const current = context;
  context = null;
  void current?.close().catch(() => {});
}

interface Voice {
  /** Seconds after the pattern start. */
  at: number;
  freq: number;
  /** Seconds to fade out. */
  decay: number;
  type?: OscillatorType;
  gain?: number;
  /** Seconds the note holds before it decays (digital beeps). */
  hold?: number;
}

/** A struck tone: the fundamental plus quieter partials, each decaying
 *  exponentially, which reads as a small bell instead of a beep. */
function partials(at: number, freq: number, decay: number, ratios: readonly [number, number][]): Voice[] {
  return ratios.map(([ratio, gain]) => ({ at, freq: freq * ratio, decay: decay / Math.max(1, ratio * 0.6), gain }));
}

const PATTERNS: Record<SoundId, { voices: Voice[]; length: number }> = {
  // Two rising notes, a soft major sixth.
  chime: {
    voices: [
      ...partials(0, 659.25, 1.6, [[1, 0.55], [2, 0.18], [3, 0.07]]),
      ...partials(0.22, 1046.5, 1.9, [[1, 0.5], [2, 0.14], [3, 0.05]]),
    ],
    length: 1.4,
  },
  // A desk bell: inharmonic partials ring the way metal does.
  bell: {
    voices: partials(0, 880, 2.6, [[1, 0.5], [2.76, 0.22], [5.4, 0.1], [8.93, 0.04]]),
    length: 1.9,
  },
  // Three short clean beeps.
  digital: {
    voices: [0, 0.16, 0.32].map((at) => ({ at, freq: 1318.5, decay: 0.05, hold: 0.08, type: "square" as const, gain: 0.12 })),
    length: 0.9,
  },
  // A low wooden marimba pair.
  soft: {
    voices: [
      ...partials(0, 523.25, 0.9, [[1, 0.6], [4, 0.08]]),
      ...partials(0.18, 783.99, 1.1, [[1, 0.55], [4, 0.06]]),
    ],
    length: 1.1,
  },
};

function scheduleVoice(audio: AudioContext, out: AudioNode, voice: Voice, start: number): void {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = voice.type ?? "sine";
  osc.frequency.setValueAtTime(voice.freq, start);
  const peak = Math.max(0.0001, voice.gain ?? 0.4);
  const hold = voice.hold ?? 0;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
  if (hold > 0) gain.gain.setValueAtTime(peak, start + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + hold + voice.decay);
  osc.connect(gain);
  gain.connect(out);
  osc.start(start);
  osc.stop(start + hold + voice.decay + 0.05);
}

/** Play `soundId` `repeat` times at `volume` (0..1). Returns a stop. */
export function playSound(soundId: SoundId, volume: number, repeat = 1): () => void {
  const audio = unlockAudio();
  if (!audio || volume <= 0) return () => {};
  const pattern = PATTERNS[soundId] ?? PATTERNS.chime;
  const master = audio.createGain();
  // Perceived loudness is roughly logarithmic: square the slider.
  master.gain.value = Math.min(1, Math.max(0, volume)) ** 2 * 0.9;
  const compressor = audio.createDynamicsCompressor();
  master.connect(compressor);
  compressor.connect(audio.destination);
  const begin = audio.currentTime + 0.03;
  const times = Math.min(5, Math.max(1, Math.round(repeat)));
  for (let index = 0; index < times; index += 1) {
    const offset = begin + index * (pattern.length + 0.35);
    for (const voice of pattern.voices) scheduleVoice(audio, master, voice, offset + voice.at);
  }
  return () => {
    try {
      master.gain.cancelScheduledValues(audio.currentTime);
      master.gain.setValueAtTime(master.gain.value, audio.currentTime);
      master.gain.linearRampToValueAtTime(0, audio.currentTime + 0.08);
      setTimeout(() => { try { master.disconnect(); compressor.disconnect(); } catch { /* already gone */ } }, 120);
    } catch { /* context closed */ }
  };
}
