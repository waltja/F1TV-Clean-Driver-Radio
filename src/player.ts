import Speaker from "speaker";
import { EventEmitter } from "node:events";
import process from "node:process";
import type { PcmSegment } from "./types.js";
import { RING_BUFFER_DEPTH } from "./types.js";

const DEBUG = process.argv.includes("--debug");

function debugLog(message: string): void {
  if (DEBUG) {
    console.log(message);
  }
}

export interface SpeakerLike extends EventEmitter {
  write(buffer: Buffer): boolean;
  end(buffer?: Buffer): void;
  close(flush?: boolean): void;
}

export type SpeakerFactory = () => SpeakerLike;

export class Player {
  private speaker: SpeakerLike;
  private readonly queuedSegments = new Map<number, Buffer>();
  private _playhead = 0;
  private closed = false;
  private _paused = false;
  private pumping = false;
  private waitingForDrain = false;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private hasWrittenRealAudio = false;
  // Bytes to trim from the start of the first segment after a reseek.
  private trimBytes = 0;

  // 100ms of silence at 48kHz mono s16le (4800 samples * 2 bytes)
  private static readonly SILENCE = Buffer.alloc(9600);

  constructor(private readonly speakerFactory: SpeakerFactory = () => new Speaker({ channels: 1, bitDepth: 16, sampleRate: 48000 })) {
    this.speaker = this.createSpeaker();
  }

  private createSpeaker(): SpeakerLike {
    const s = this.speakerFactory();
    s.on("error", (err: Error) => {
      console.error(`speaker error: ${err.message}`);
    });
    return s;
  }

  get playhead(): number {
    return this._playhead;
  }

  get paused(): boolean {
    return this._paused;
  }

  pause(): void {
    if (this.closed || this._paused) return;
    this._paused = true;
    if (!this.hasWrittenRealAudio) {
      return;
    }
    // Write silence to keep CoreAudio fed and avoid buffer underflow warnings.
    this.silenceTimer = setInterval(() => {
      if (!this.closed) this.speaker.write(Player.SILENCE);
    }, 90);
  }

  resume(): void {
    if (this.closed || !this._paused) return;
    this._paused = false;
    if (this.silenceTimer !== null) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.pump();
  }

  has(segmentNumber: number): boolean {
    return this.queuedSegments.has(segmentNumber);
  }

  enqueue(segment: PcmSegment): void {
    if (this.closed || segment.number < this._playhead) {
      return;
    }

    this.queuedSegments.set(segment.number, segment.pcm);

    // Bound memory. Already-played segments (< playhead) are dropped above, so
    // every queued entry is >= playhead; keep the ones closest to the playhead
    // (lowest numbers) and evict the furthest-ahead segment when over capacity.
    while (this.queuedSegments.size > RING_BUFFER_DEPTH) {
      let furthest = -Infinity;
      for (const key of this.queuedSegments.keys()) {
        if (key > furthest) furthest = key;
      }
      this.queuedSegments.delete(furthest);
    }

    this.pump();
  }

  reseek(segmentNumber: number, offsetIntoSegmentS = 0): void {
    if (this.closed) return;
    debugLog(`[player] reseek start segment=${segmentNumber} offset=${offsetIntoSegmentS.toFixed(3)} paused=${this._paused} playhead=${this._playhead}`);
    const staleSpeaker = this.speaker;
    this.pumping = false;
    this.waitingForDrain = false;
    this.speaker = this.createSpeaker();

    // Rotate to a fresh speaker immediately, then let the old one flush/close on
    // its own writable lifecycle instead of blocking the reseek path on close().
    // This avoids the hard freeze, but it is still only a best-effort flush: the
    // backend may drain a short tail of pre-seek audio before the old stream ends.
    // TODO: plan and implement a cleaner reseek handoff that can flush stale
    // backend audio deterministically without risking the previous close() stall.
    try {
      staleSpeaker.end();
    } catch {
      try {
        staleSpeaker.close(false);
      } catch {
        // ignore speaker shutdown errors during reseek
      }
    }

    // Compute how many PCM bytes to skip from the first segment so playback
    // starts at the right position within it rather than at the segment boundary.
    // 48000 samples/s, 2 bytes/sample (s16le), 1 channel.
    const trimSamples = Math.max(0, Math.floor(offsetIntoSegmentS * 48000));
    this.trimBytes = trimSamples * 2;
    this.queuedSegments.clear();
    this._playhead = segmentNumber;
    debugLog(`[player] reseek ready trimBytes=${this.trimBytes} nextPlayhead=${this._playhead}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.silenceTimer !== null) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.queuedSegments.clear();
    try {
      this.speaker.close(false);
    } catch {
      // ignore close errors during shutdown
    }
  }

  private pump(): void {
    if (this.closed || this._paused || this.pumping || this.waitingForDrain) {
      return;
    }
    this.pumping = true;
    try {
      while (!this.closed) {
        const queued = this.queuedSegments.get(this._playhead);
        if (!queued) break;

        let pcm = queued;
        if (this.trimBytes > 0) {
          const bytesToTrim = Math.min(this.trimBytes, pcm.length);
          pcm = pcm.subarray(bytesToTrim);
          this.trimBytes -= bytesToTrim;
        }

        this.queuedSegments.delete(this._playhead);
        this._playhead += 1;
        this.hasWrittenRealAudio = true;

        const activeSpeaker = this.speaker;
        const canContinue = activeSpeaker.write(pcm);
        if (!canContinue) {
          this.waitingForDrain = true;
          activeSpeaker.once("drain", () => {
            if (this.closed || this.speaker !== activeSpeaker) {
              return;
            }
            this.waitingForDrain = false;
            this.pump();
          });
          break;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
