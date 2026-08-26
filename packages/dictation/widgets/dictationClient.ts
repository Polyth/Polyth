// F8: browser mic capture → 16 kHz PCM s16le → the existing /ws dictation
// protocol (dictation/audio + acks + transcripts), with reconnect-safe replay
// through the shared chunk buffer. Raw audio goes to the server adapter only;
// nothing here touches the session event log.
import { createChunkBuffer, DICTATION_FORMAT, downsampleToPcm16 } from "@polyth/dictation";
import { api } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export interface StreamingDictation {
  /** Stop capture, finalize on the server, resolve the final transcript. */
  stop(): Promise<string>;
  cancel(): void;
}

const b64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
};

export async function startStreamingDictation(opts: {
  sessionId?: string;
  language?: string;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
}): Promise<StreamingDictation> {
  const dto = await api.dictationCreate({
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.language ? { language: opts.language } : {}),
  });
  const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });

  const buffer = createChunkBuffer();
  let ws: WebSocket | null = null;
  let active = true;
  let failed: string | null = null;

  const fail = (message: string) => {
    if (!active) return;
    failed = message;
    opts.onError?.(message);
  };

  const send = (chunk: { seq: number; pcm: Uint8Array }) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "dictation/audio", dictationId: dto.id, seq: chunk.seq, pcm: b64(chunk.pcm) }));
    }
  };

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => {
      // replay everything unacked — the server re-acks duplicates
      for (const chunk of buffer.unacked()) send(chunk);
    };
    sock.onmessage = (e: MessageEvent) => {
      let msg: { type?: string; seq?: number; text?: string; message?: string; code?: string };
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (msg.type === "dictation/ack" && typeof msg.seq === "number") buffer.ack(msg.seq);
      else if (msg.type === "dictation/transcript" && typeof msg.text === "string") opts.onPartial?.(msg.text);
      else if (msg.type === "dictation/error") fail(msg.message ?? msg.code ?? tr("dictationclient.dictationFailed"));
    };
    sock.onclose = () => {
      if (active && ws === sock) setTimeout(() => { if (active) connect(); }, 600);
    };
    sock.onerror = () => sock.close();
  };
  connect();

  // ScriptProcessor keeps the capture path dependency-free; the worklet
  // upgrade can come later without changing the wire format.
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(media);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    if (!active || failed) return;
    const pcm = downsampleToPcm16(e.inputBuffer.getChannelData(0), ctx.sampleRate, DICTATION_FORMAT.sampleRate);
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    send({ seq: buffer.push(bytes), pcm: bytes });
  };
  source.connect(proc);
  proc.connect(ctx.destination); // required for onaudioprocess to fire

  const teardown = () => {
    active = false;
    proc.disconnect();
    source.disconnect();
    for (const track of media.getTracks()) track.stop();
    void ctx.close().catch(() => {});
    ws?.close();
    ws = null;
  };

  return {
    async stop() {
      if (failed) { teardown(); void api.dictationCancel(dto.id).catch(() => {}); throw new Error(failed); }
      // give in-flight chunks a moment to be acked before finalizing
      const deadline = Date.now() + 2000;
      while (buffer.unacked().length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      teardown();
      const final = await api.dictationFinalize(dto.id);
      return final.transcript;
    },
    cancel() {
      teardown();
      void api.dictationCancel(dto.id).catch(() => {});
    },
  };
}
