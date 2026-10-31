// Short, quiet tones that make turn changes audible without words. They use
// the shared output context so they follow the same unlock and routing.
import { speechAudioContext } from "@polyth/dictation/voice-runtime";

export type Earcon = "start" | "listen" | "send" | "end" | "error";

const NOTES: Readonly<Record<Earcon, ReadonlyArray<readonly [number, number]>>> = {
  // [frequency Hz, start offset s]
  start: [[523.25, 0], [783.99, 0.09]],
  listen: [[880, 0]],
  send: [[659.25, 0], [987.77, 0.07]],
  end: [[783.99, 0], [523.25, 0.1]],
  error: [[311.13, 0], [261.63, 0.12]],
};

export function playEarcon(kind: Earcon, volume = 0.07): void {
  const context = speechAudioContext();
  if (!context) return;
  if (context.state === "suspended") void context.resume().catch(() => {});
  const now = context.currentTime + 0.01;
  for (const [frequency, offset] of NOTES[kind]) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    const at = now + offset;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.18);
    oscillator.onended = () => {
      try { oscillator.disconnect(); gain.disconnect(); } catch { /* already detached */ }
    };
  }
}
