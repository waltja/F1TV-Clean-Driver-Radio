import { spawn } from "node:child_process";

const FFMPEG_RAW_ARGS = [
  "-i", "pipe:0",
  "-ac", "1",
  "-ar", "48000",
  "-f", "s16le",
  "pipe:1",
];

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

export function decodeSegmentWithFilter(pcm: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-f", "s16le", "-ar", "48000", "-ac", "1",
      "-i", "pipe:0",
      "-af", "highpass=f=300,lowpass=f=3400",
      "-f", "s16le",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "ignore"] });

    const chunks: Buffer[] = [];
    let settled = false;

    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.once("error", (e: NodeJS.ErrnoException) => {
      if (settled) return; settled = true;
      reject(new Error(`decodeSegmentWithFilter: ${e.message}`));
    });
    ffmpeg.stdin.once("error", (e: NodeJS.ErrnoException) => {
      if (settled) return; settled = true;
      reject(new Error(`decodeSegmentWithFilter: stdin: ${e.message}`));
    });
    ffmpeg.once("spawn", () => { if (!settled) ffmpeg.stdin.end(pcm); });
    ffmpeg.once("close", (code) => {
      if (settled) return; settled = true;
      if (code !== 0) { reject(new Error(`decodeSegmentWithFilter: exited ${code}`)); return; }
      resolve(Buffer.concat(chunks));
    });
  });
}
