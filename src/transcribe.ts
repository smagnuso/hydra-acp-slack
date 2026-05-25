import { pipeline, env } from "@huggingface/transformers";
// Provide Web Audio API for Node.js so the pipeline can decode audio files.
import { AudioContext } from "node-web-audio-api";
(globalThis as Record<string, unknown>).AudioContext = AudioContext;
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "./util/log.js";

// Store models alongside other hydra-acp state rather than inside node_modules
// (which gets wiped on reinstall).
const MODEL_CACHE = join(homedir(), ".hydra-acp", "models");
mkdirSync(MODEL_CACHE, { recursive: true });
env.cacheDir = MODEL_CACHE;

const log = logger("transcribe");

// Lazily initialized — downloads ~40MB model weights on first call.
let transcriber: Awaited<ReturnType<typeof pipeline>> | undefined;

async function getTranscriber(): Promise<Awaited<ReturnType<typeof pipeline>>> {
  if (!transcriber) {
    log.info("loading whisper-tiny.en model (first-run download may take a moment)");
    transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en");
    log.info("whisper model ready");
  }
  return transcriber;
}

function extForMime(mimeType: string): string {
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return ".m4a";
  if (mimeType.includes("webm")) return ".webm";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("wav")) return ".wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return ".mp3";
  return ".audio";
}

export async function transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const tmpPath = join(tmpdir(), `voice-${Date.now()}${extForMime(mimeType)}`);
  writeFileSync(tmpPath, audioBuffer);
  try {
    const t = await getTranscriber();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (t as any)(tmpPath) as { text: string };
    return result.text.trim();
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}
