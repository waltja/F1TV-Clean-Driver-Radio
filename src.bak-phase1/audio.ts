import { spawn } from "node:child_process";

const FFMPEG_ARGS = ["-i", "pipe:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"];

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
