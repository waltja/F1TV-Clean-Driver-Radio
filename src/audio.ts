import { spawn } from "node:child_process";

const FFMPEG_RAW_ARGS = [
  "-i", "pipe:0",
  "-ac", "1",
  "-ar", "48000",
  "-f", "s16le",
  "pipe:1",
];

function runFfmpeg(input: Buffer, args: string[], name: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args, {
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
      reject(new Error(`${name}: ${error.message}`));
    });

    ffmpeg.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(new Error(`${name}: stdin error: ${error.message}`));
    });

    ffmpeg.once("spawn", () => {
      if (!settled) {
        ffmpeg.stdin.end(input);
      }
    });

    ffmpeg.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`${name}: ffmpeg exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

export function decodeSegmentRaw(concatBuffer: Buffer): Promise<Buffer> {
  return runFfmpeg(concatBuffer, FFMPEG_RAW_ARGS, "decodeSegmentRaw");
}

export function decodeSegmentWithFilter(pcm: Buffer): Promise<Buffer> {
  return runFfmpeg(
    pcm,
    [
      "-f", "s16le", "-ar", "48000", "-ac", "1",
      "-i", "pipe:0",
      "-af", "highpass=f=300,lowpass=f=3400",
      "-f", "s16le",
      "pipe:1",
    ],
    "decodeSegmentWithFilter",
  );
}
