/**
 * Silero VAD v6 ONNX wrapper.
 *
 * Model interface (v6):
 *   inputs:  input [1, context_size + chunk_size], state [2, 1, 128], sr [1]
 *   outputs: (positional) [probability_scalar, new_state [2, 1, 128]]
 *
 * At 16kHz: context_size = 64, chunk_size = 512, input shape = [1, 576]
 *
 * Context (last 64 samples of the previous chunk) is prepended to each new
 * chunk and carries across frames within a segment. State and context are
 * reset between segments since segments are independent.
 */

import * as ort from "onnxruntime-node";
import path from "node:path";

const MODEL_PATH = path.join(import.meta.dirname, "..", "models", "silero_vad.onnx");

// 16kHz constants
const SAMPLE_RATE = 16000;
const CHUNK_SIZE = 512;   // 32ms at 16kHz
const CONTEXT_SIZE = 64;  // samples prepended from previous chunk
const STATE_SIZE = 128;   // per Silero v6 spec

export interface VadResult {
  hasSpeech: boolean;
  /** Max speech probability across all frames in the segment. */
  probability: number;
  speechFrames: number;
  totalFrames: number;
  /** speechFrames / totalFrames */
  speechPct: number;
  frameProbs: number[];
}

export interface VadSession {
  session: ort.InferenceSession;
  /** Hidden state [2, 1, 128] carried across frames, reset per segment. */
  state: Float32Array;
  /** Last 64 samples of the previous chunk; zeros at segment start. */
  context: Float32Array;
  srTensor: ort.Tensor;
  /** Cached output tensor names (resolved once on first run). */
  outputNames: string[] | null;
}

/** Load the ONNX model once. Call once at startup, reuse across all segments. */
export async function createVadSession(): Promise<VadSession> {
  const session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });

  const state = new Float32Array(2 * 1 * STATE_SIZE); // zeros
  const context = new Float32Array(CONTEXT_SIZE);      // zeros
  const srTensor = new ort.Tensor(
    "int64",
    BigInt64Array.from([BigInt(SAMPLE_RATE)]),
    [1],
  );

  return { session, state, context, srTensor, outputNames: null };
}

/** Reset state and context between independent segments. */
function resetState(vs: VadSession): void {
  vs.state.fill(0);
  vs.context.fill(0);
}

/**
 * Decimate 48kHz s16le PCM to 16kHz float32 by taking every 3rd sample.
 * Naive decimation is appropriate here: F1 OBC audio is bandlimited to
 * 300-3400Hz, well below the 8kHz Nyquist of 16kHz output.
 */
function downsample48to16(pcm48k: Buffer): Float32Array {
  const sampleCount48 = Math.floor(pcm48k.length / 2);
  const sampleCount16 = Math.floor(sampleCount48 / 3);
  const out = new Float32Array(sampleCount16);
  for (let i = 0; i < sampleCount16; i++) {
    out[i] = pcm48k.readInt16LE(i * 6) / 32768; // i*3 samples * 2 bytes
  }
  return out;
}

/**
 * Run Silero VAD v6 on a single segment buffer.
 *
 * @param vs      - Session returned by createVadSession(). Mutated in place.
 * @param pcm48k  - Raw s16le 48kHz mono PCM (from decodeSegmentRaw).
 * @param threshold - Probability threshold above which a frame counts as speech.
 */
export async function runVad(
  vs: VadSession,
  pcm48k: Buffer,
  threshold: number,
): Promise<VadResult> {
  resetState(vs);

  const samples16k = downsample48to16(pcm48k);
  const totalFrames = Math.floor(samples16k.length / CHUNK_SIZE);

  let speechFrames = 0;
  let maxProb = 0;
  const frameProbs: number[] = [];

  // Resolve output tensor names on first call (avoids hard-coding names that
  // differ between ONNX export batches).
  if (vs.outputNames === null) {
    vs.outputNames = vs.session.outputNames as string[];
  }
  const [outName, stateName] = vs.outputNames;

  for (let i = 0; i < totalFrames; i++) {
    const chunk = samples16k.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);

    // Build input: [context | chunk] -> shape [1, CONTEXT_SIZE + CHUNK_SIZE]
    const inputData = new Float32Array(CONTEXT_SIZE + CHUNK_SIZE);
    inputData.set(vs.context, 0);
    inputData.set(chunk, CONTEXT_SIZE);

    const inputTensor = new ort.Tensor("float32", inputData, [1, CONTEXT_SIZE + CHUNK_SIZE]);
    const stateTensor = new ort.Tensor("float32", vs.state, [2, 1, STATE_SIZE]);

    const feeds: Record<string, ort.Tensor> = {
      input: inputTensor,
      state: stateTensor,
      sr: vs.srTensor,
    };

    const results = await vs.session.run(feeds);

    // Update state for next frame
    vs.state = new Float32Array(results[stateName].data as Float32Array);

    // Update context: last CONTEXT_SIZE samples of the current chunk
    vs.context = chunk.slice(CHUNK_SIZE - CONTEXT_SIZE);

    const prob = (results[outName].data as Float32Array)[0];
    frameProbs.push(prob);
    if (prob > maxProb) maxProb = prob;
    if (prob >= threshold) speechFrames++;
  }

  const speechPct = totalFrames > 0 ? speechFrames / totalFrames : 0;
  return {
    hasSpeech: speechFrames > 0,
    probability: maxProb,
    speechFrames,
    totalFrames,
    speechPct,
    frameProbs
  };
}
