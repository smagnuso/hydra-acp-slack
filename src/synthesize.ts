import { pipeline, env } from "@huggingface/transformers";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { logger } from "./util/log.js";

const log = logger("synthesize");

const MODEL_CACHE = join(homedir(), ".hydra-acp", "models");
mkdirSync(MODEL_CACHE, { recursive: true });
env.cacheDir = MODEL_CACHE;

let synthesizer: Awaited<ReturnType<typeof pipeline>> | undefined;

async function getSynthesizer(): Promise<Awaited<ReturnType<typeof pipeline>>> {
  if (!synthesizer) {
    log.info("loading mms-tts-eng model (first-run download may take a moment)");
    synthesizer = await pipeline("text-to-audio", "Xenova/mms-tts-eng");
    log.info("tts model ready");
  }
  return synthesizer;
}

function toWav(samples: Float32Array, sampleRate: number): Buffer {
  // Convert Float32 [-1, 1] to Int16 PCM
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const dataBytes = pcm.buffer.byteLength;
  const buf = Buffer.alloc(44 + dataBytes);
  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);       // chunk size
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  return buf;
}

export async function synthesizeText(text: string): Promise<Buffer> {
  const t = await getSynthesizer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (t as any)(text) as { audio: Float32Array; sampling_rate: number };
  return toWav(result.audio, result.sampling_rate);
}
