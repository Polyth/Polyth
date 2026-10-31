// Built-in read-aloud voices, run on this server by the sherpa runtime that
// also runs local dictation. Every archive is pinned by size and SHA-256 from
// the k2-fsa/sherpa-onnx "tts-models" release. Each Piper voice and Kokoro
// language was synthesized and transcribed back before it was listed;
// alternatives that failed that check (a "text"-phoneme Ukrainian voice, two
// Chinese voices the runtime rejects) are deliberately absent.

export type LocalVoiceEngine = "piper" | "kokoro";
/** natural: neural voice with prosody; clear: Piper medium; basic: Piper low. */
export type LocalVoiceQuality = "natural" | "clear" | "basic";

export interface LocalVoiceSpeaker {
  /** Speaker id inside the model. */
  id: number;
  name: string;
  /** BCP-47 language this speaker reads. */
  lang: string;
}

export interface LocalVoiceDescriptor {
  id: string;
  label: string;
  engine: LocalVoiceEngine;
  /** BCP-47 languages, e.g. "uk-UA". */
  languages: readonly string[];
  quality: LocalVoiceQuality;
  /** Multi-speaker models; a single-speaker voice has none. */
  speakers?: readonly LocalVoiceSpeaker[];
  archiveUrl: string;
  archiveBytes: number;
  sha256: string;
}

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";

const piper = (
  name: string,
  label: string,
  lang: string,
  quality: LocalVoiceQuality,
  archiveBytes: number,
  sha256: string,
): LocalVoiceDescriptor => ({
  id: `piper-${name}`,
  label,
  engine: "piper",
  languages: [lang],
  quality,
  archiveUrl: `${RELEASE}/vits-piper-${name}.tar.bz2`,
  archiveBytes,
  sha256,
});

// Kokoro v1.0 speaker table (the model's own `speaker_names` metadata). The
// first letter is the language, the second the voice's gender; Japanese
// speakers are omitted because the runtime cannot phonemize Japanese.
const KOKORO_LANGS: Record<string, string> = {
  a: "en-US", b: "en-GB", e: "es-ES", f: "fr-FR", h: "hi-IN", i: "it-IT", p: "pt-BR", z: "zh-CN",
};
const KOKORO_NAMES = "af_alloy,af_aoede,af_bella,af_heart,af_jessica,af_kore,af_nicole,af_nova,af_river,af_sarah,af_sky,am_adam,am_echo,am_eric,am_fenrir,am_liam,am_michael,am_onyx,am_puck,am_santa,bf_alice,bf_emma,bf_isabella,bf_lily,bm_daniel,bm_fable,bm_george,bm_lewis,ef_dora,em_alex,ff_siwis,hf_alpha,hf_beta,hm_omega,hm_psi,if_sara,im_nicola,jf_alpha,jf_gongitsune,jf_nezumi,jf_tebukuro,jm_kumo,pf_dora,pm_alex,pm_santa,zf_xiaobei,zf_xiaoni,zf_xiaoxiao,zf_xiaoyi,zm_yunjian,zm_yunxi,zm_yunxia,zm_yunyang,em_santa";
const KOKORO_SPEAKERS: LocalVoiceSpeaker[] = KOKORO_NAMES.split(",").flatMap((code, id) => {
  const lang = KOKORO_LANGS[code[0]!];
  const name = code.slice(3);
  return lang ? [{ id, name: name.charAt(0).toUpperCase() + name.slice(1), lang }] : [];
});

export const KOKORO_VOICE_ID = "kokoro-int8-multi-lang-v1_0";

const VOICES: readonly LocalVoiceDescriptor[] = [
  {
    id: KOKORO_VOICE_ID,
    label: "Kokoro",
    engine: "kokoro",
    languages: [...new Set(KOKORO_SPEAKERS.map((speaker) => speaker.lang))],
    quality: "natural",
    speakers: KOKORO_SPEAKERS,
    archiveUrl: `${RELEASE}/${KOKORO_VOICE_ID}.tar.bz2`,
    archiveBytes: 132_303_094,
    sha256: "4c3052abaa60943a341f193888cf6abd68787dae6ab8ae5c925a706caa247e4e",
  },
  piper("en_US-lessac-medium", "Lessac", "en-US", "clear", 67_230_653, "9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e"),
  piper("en_US-ryan-medium", "Ryan", "en-US", "clear", 67_213_100, "c546af78b6395b4e7c4ce1ed899438b64426a362f5d4ec5fecd090ded9ad7505"),
  piper("en_GB-alba-medium", "Alba", "en-GB", "clear", 67_212_349, "fcd45962906933eec4431d3688f7d74aaac8713c87c6717f91fd3b23463aa1a1"),
  piper("en_GB-alan-medium", "Alan", "en-GB", "clear", 67_220_121, "a48d4017da0f77668b27bed63fe6e04dd64c6397e1fadad4f460efb0ef7c9012"),
  piper("uk_UA-lada-x_low", "Lada", "uk-UA", "basic", 26_520_908, "7a2228f249299d19016cd6ca170bf6916f8664231bcbd9e61f447b861a039cf5"),
  piper("de_DE-thorsten-medium", "Thorsten", "de-DE", "clear", 67_214_254, "50487d9c95fdf2191f31d2588569381063ba1591dcd4c7d4bdd30f12b2191714"),
  piper("de_DE-kerstin-low", "Kerstin", "de-DE", "basic", 67_107_768, "4bfe121d5f690a3b87acecd7ae1e70b48f4589ce6ae9f45a1809e6eb19fad97b"),
  piper("fr_FR-siwis-medium", "Siwis", "fr-FR", "clear", 67_207_459, "375909aa30842b3a4efa10b1beb1d761af792960ae6873b4d53889f96c66195b"),
  piper("fr_FR-tom-medium", "Tom", "fr-FR", "clear", 67_202_955, "3d8258ef8466b5d5f2cc46c06e1415d3d01c9cbaeed8b6d5b3d152073672472c"),
  piper("es_ES-davefx-medium", "Dave", "es-ES", "clear", 67_184_952, "a3f6beb54a9cb893279f72978a22f807a4d9fc9c7848157b524d5cc7b7f58b22"),
  piper("es_MX-ald-medium", "Ald", "es-MX", "clear", 67_196_497, "c60cf7bc853eb01a875fba0756523fecf9d9f46c763b19785d223fc981fb4fb6"),
  piper("it_IT-paola-medium", "Paola", "it-IT", "clear", 67_221_173, "7541f75778afa164e44e34baaef63befad7698595df26a95ca944b63ef1a16b4"),
  piper("it_IT-riccardo-x_low", "Riccardo", "it-IT", "basic", 26_496_614, "8ad0791558ae2b3e96054fc5756ae3ae2f6457fb1765bc01f43bbab85e0a7021"),
  piper("pt_BR-faber-medium", "Faber", "pt-BR", "clear", 67_183_065, "7add3f923ad6bc25ca8a192805fd1a64d1b3893e4611c4a9719545a825039a83"),
  piper("pt_PT-tugao-medium", "Tugão", "pt-PT", "clear", 67_195_014, "6b4f0a7bfc957bef26d6ac0703a8fa1ba659c8ab2df8b294f20206551859070c"),
  piper("pl_PL-gosia-medium", "Gosia", "pl-PL", "clear", 67_211_182, "75bd34dcbdc4dd98d763954756b4b34b4208100497c836381542e4d73dcefa9c"),
  piper("pl_PL-darkman-medium", "Darkman", "pl-PL", "clear", 67_215_635, "444727aa46eb6db645a2bc88fe73868e4bd7596b7f56ca39fad5ef53c41210d4"),
  piper("ar_JO-kareem-medium", "Kareem", "ar-JO", "clear", 67_177_830, "9ebbcea30e0fbd588f7b2cb45ee897d6aeb1bf5791cbc037a7b5a3f641e3dbce"),
  piper("zh_CN-huayan-medium", "Huayan", "zh-CN", "clear", 67_255_926, "dbdfec42b91d9cee31cce9ff4b3e9c305eb6fbf60546d071f7e46273554cce6b"),
];

export const localVoiceCatalog = (): readonly LocalVoiceDescriptor[] => VOICES;

export const localVoice = (id: string): LocalVoiceDescriptor | undefined => VOICES.find((voice) => voice.id === id);

// Kokoro's best-rated voices lead their language; elsewhere the first wins.
const PREFERRED_SPEAKERS = new Set([3 /* af_heart */, 21 /* bf_emma */]);

/** Speaker default per language. */
export function defaultSpeaker(voice: LocalVoiceDescriptor, lang: string): number {
  const primary = lang.toLowerCase().split("-")[0];
  const speakers = [...(voice.speakers ?? [])].sort((a, b) =>
    Number(PREFERRED_SPEAKERS.has(b.id)) - Number(PREFERRED_SPEAKERS.has(a.id)));
  const exact = speakers.find((speaker) => speaker.lang.toLowerCase() === lang.toLowerCase());
  return (exact ?? speakers.find((speaker) => speaker.lang.toLowerCase().startsWith(primary!)))?.id ?? 0;
}
