// Compact binary audio framing for the dictation WebSocket hot path.
// Control messages remain JSON; raw PCM never needs base64/JSON encoding.

export const DICTATION_WIRE_MAGIC = 0x5044; // "PD"
export const DICTATION_WIRE_VERSION = 1;
export const DICTATION_AUDIO_FORMAT_PCM16 = 1;
const FIXED_HEADER_BYTES = 16;
const MAX_ID_BYTES = 1024;

export type DictationWireErrorCode = "protocol_error" | "audio_format_error";

export class DictationWireError extends Error {
  readonly code: DictationWireErrorCode;
  constructor(code: DictationWireErrorCode, message: string) {
    super(message);
    this.name = "DictationWireError";
    this.code = code;
  }
}

export interface DictationAudioFrame {
  version: number;
  flags: number;
  format: "pcm_s16le";
  dictationId: string;
  seq: number;
  sampleRate: number;
  channels: number;
  payload: Uint8Array;
}

export interface EncodeDictationAudioFrame {
  dictationId: string;
  seq: number;
  sampleRate: number;
  channels: number;
  payload: Uint8Array;
  flags?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const bytesOf = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

const validateAudio = (sampleRate: number, channels: number, payloadBytes: number): void => {
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) {
    throw new DictationWireError("audio_format_error", `unsupported sample rate ${sampleRate}`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new DictationWireError("audio_format_error", `unsupported channel count ${channels}`);
  }
  if ((payloadBytes & 1) !== 0) {
    throw new DictationWireError("audio_format_error", "pcm_s16le payload must contain whole 16-bit samples");
  }
};

export function encodeDictationAudioFrame(frame: EncodeDictationAudioFrame): Uint8Array {
  if (!Number.isInteger(frame.seq) || frame.seq < 1 || frame.seq > 0xffff_ffff) {
    throw new DictationWireError("protocol_error", "seq must be a uint32 greater than zero");
  }
  validateAudio(frame.sampleRate, frame.channels, frame.payload.byteLength);
  const id = encoder.encode(frame.dictationId);
  if (id.byteLength === 0 || id.byteLength > MAX_ID_BYTES) {
    throw new DictationWireError("protocol_error", "dictation id is missing or too long");
  }
  const flags = frame.flags ?? 0;
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new DictationWireError("protocol_error", "flags must fit in one byte");
  }

  const out = new Uint8Array(FIXED_HEADER_BYTES + id.byteLength + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint16(0, DICTATION_WIRE_MAGIC, false);
  view.setUint8(2, DICTATION_WIRE_VERSION);
  view.setUint8(3, flags);
  view.setUint8(4, DICTATION_AUDIO_FORMAT_PCM16);
  view.setUint8(5, frame.channels);
  view.setUint16(6, id.byteLength, true);
  view.setUint32(8, frame.seq, true);
  view.setUint32(12, frame.sampleRate, true);
  out.set(id, FIXED_HEADER_BYTES);
  out.set(frame.payload, FIXED_HEADER_BYTES + id.byteLength);
  return out;
}

export function isDictationAudioFrame(value: ArrayBuffer | ArrayBufferView): boolean {
  const bytes = bytesOf(value);
  return bytes.byteLength >= FIXED_HEADER_BYTES
    && bytes[0] === 0x50
    && bytes[1] === 0x44;
}

export function decodeDictationAudioFrame(value: ArrayBuffer | ArrayBufferView): DictationAudioFrame {
  const bytes = bytesOf(value);
  if (bytes.byteLength < FIXED_HEADER_BYTES) {
    throw new DictationWireError("protocol_error", "dictation audio frame is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, false) !== DICTATION_WIRE_MAGIC) {
    throw new DictationWireError("protocol_error", "dictation audio frame magic is invalid");
  }
  const version = view.getUint8(2);
  if (version !== DICTATION_WIRE_VERSION) {
    throw new DictationWireError("protocol_error", `unsupported dictation wire version ${version}`);
  }
  const formatCode = view.getUint8(4);
  if (formatCode !== DICTATION_AUDIO_FORMAT_PCM16) {
    throw new DictationWireError("audio_format_error", `unsupported dictation audio format ${formatCode}`);
  }
  const channels = view.getUint8(5);
  const idBytes = view.getUint16(6, true);
  const seq = view.getUint32(8, true);
  const sampleRate = view.getUint32(12, true);
  const payloadOffset = FIXED_HEADER_BYTES + idBytes;
  if (idBytes === 0 || idBytes > MAX_ID_BYTES || payloadOffset > bytes.byteLength) {
    throw new DictationWireError("protocol_error", "dictation audio frame id is invalid");
  }
  if (seq === 0) throw new DictationWireError("protocol_error", "seq must be greater than zero");
  const payload = bytes.subarray(payloadOffset);
  validateAudio(sampleRate, channels, payload.byteLength);
  let dictationId: string;
  try {
    dictationId = decoder.decode(bytes.subarray(FIXED_HEADER_BYTES, payloadOffset));
  } catch {
    throw new DictationWireError("protocol_error", "dictation id is not valid UTF-8");
  }
  if (!dictationId) throw new DictationWireError("protocol_error", "dictation id is missing");
  return {
    version,
    flags: view.getUint8(3),
    format: "pcm_s16le",
    dictationId,
    seq,
    sampleRate,
    channels,
    payload,
  };
}
