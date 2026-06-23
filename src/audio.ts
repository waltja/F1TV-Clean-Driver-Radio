import { spawn } from "node:child_process";
import path from "node:path";

const MODEL_PATH = path.join(import.meta.dirname, "..", "models", "bd.rnnn");

const FFMPEG_ARGS = [
  "-i", "pipe:0",
  "-ar", "48000",
  "-af", `highpass=f=300,lowpass=f=3400,arnndn=m=${MODEL_PATH},arnndn=m=${MODEL_PATH},agate=threshold=-45dB:range=-30dB:attack=0.1:release=200,acompressor=threshold=-20dB:ratio=4:attack=5:release=50`,
  "-f", "s16le",
  "pipe:1",
];

const FFMPEG_RAW_ARGS = [
  "-i", "pipe:0",
  "-ar", "48000",
  "-f", "s16le",
  "pipe:1",
];

// MP3 decode: same as raw but forces mp3 demuxer for clarity.
// ffmpeg auto-detects fine via pipe, so args are identical -- kept as a
// named alias so call sites are self-documenting.
const FFMPEG_MP3_ARGS = FFMPEG_RAW_ARGS;

export function decodeMp3Raw(mp3Buffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", FFMPEG_MP3_ARGS, {
      stdio: ["pipe", "pipe", "ignore"],
    });

    const chunks: Buffer[] = [];
    let settled = false;

    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    ffmpeg.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        reject(new Error("ffmpeg not found in PATH"));
        return;
      }
      reject(new Error(`decodeMp3Raw: ${error.message}`));
    });

    ffmpeg.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(new Error(`decodeMp3Raw: stdin error: ${error.message}`));
    });

    ffmpeg.once("spawn", () => {
      if (settled) return;
      ffmpeg.stdin.end(mp3Buffer);
    });

    ffmpeg.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`decodeMp3Raw: ffmpeg exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

export function decodeSegmentRaw(concatBuffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", FFMPEG_RAW_ARGS, {
      stdio: ["pipe", "pipe", "ignore"],
    });

    const chunks: Buffer[] = [];
    let settled = false;

    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    ffmpeg.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        reject(new Error("ffmpeg not found in PATH"));
        return;
      }
      reject(new Error(`decodeSegmentRaw: ${error.message}`));
    });

    ffmpeg.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(new Error(`decodeSegmentRaw: stdin error: ${error.message}`));
    });

    ffmpeg.once("spawn", () => {
      if (settled) return;
      ffmpeg.stdin.end(concatBuffer);
    });

    ffmpeg.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`decodeSegmentRaw: ffmpeg exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

export function decodeSegment(concatBuffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", FFMPEG_ARGS, {
      stdio: ["pipe", "pipe", "ignore"],
    });

    const chunks: Buffer[] = [];
    let settled = false;

    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    ffmpeg.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        reject(new Error("ffmpeg not found in PATH"));
        return;
      }
      reject(new Error(`decodeSegment: ${error.message}`));
    });

    // Guard against EPIPE when the process failed to spawn (e.g. ENOENT).
    ffmpeg.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(new Error(`decodeSegment: stdin error: ${error.message}`));
    });

    // Only write once the child is confirmed running.
    ffmpeg.once("spawn", () => {
      if (settled) return;
      ffmpeg.stdin.end(concatBuffer);
    });

    ffmpeg.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`decodeSegment: ffmpeg exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
