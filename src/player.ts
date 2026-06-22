import Speaker from "speaker";
import type { PcmSegment } from "./types.js";
import { RING_BUFFER_DEPTH } from "./types.js";

export class Player {
  private speaker: Speaker;
  private readonly queuedSegments = new Map<number, Buffer>();
  private _playhead = 0;
  private closed = false;
  private _paused = false;
  private pumping = false;
  private waitingForDrain = false;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  // Bytes to trim from the start of the first segment after a reseek.
  private trimBytes = 0;

  // 100ms of silence at 48kHz mono s16le (4800 samples * 2 bytes)
  private static readonly SILENCE = Buffer.alloc(9600);

  constructor() {
    this.speaker = this.createSpeaker();
  }

  private createSpeaker(): Speaker {
    const s = new Speaker({ channels: 1, bitDepth: 16, sampleRate: 48000 });
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

    // Apply byte-level trim to the first segment after a reseek so we start
    // at the correct position within that segment rather than at its boundary.
    let pcm = segment.pcm;
    if (segment.number === this._playhead && this.trimBytes > 0) {
      pcm = pcm.subarray(Math.min(this.trimBytes, pcm.length));
      this.trimBytes = 0;
    }
    this.queuedSegments.set(segment.number, pcm);

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
    // Recreate the Speaker to flush CoreAudio's internal buffer (~200-400ms of
    // stale pre-seek audio). Causes a brief gap but gives a clean cut on seek.
    try {
      this.speaker.close(false);
    } catch {
      // ignore close errors
    }
    this.pumping = false;
    this.waitingForDrain = false;
    this.speaker = this.createSpeaker();
    // If paused, restart the silence feed on the new speaker instance.
    if (this._paused && this.silenceTimer === null) {
      this.silenceTimer = setInterval(() => {
        if (!this.closed) this.speaker.write(Player.SILENCE);
      }, 90);
    }
    // Compute how many PCM bytes to skip from the first segment so playback
    // starts at the right position within it rather than at the segment boundary.
    // 48000 samples/s, 2 bytes/sample (s16le), 1 channel.
    const trimSamples = Math.max(0, Math.floor(offsetIntoSegmentS * 48000));
    this.trimBytes = trimSamples * 2;
    this.queuedSegments.clear();
    this._playhead = segmentNumber;
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
        const pcm = this.queuedSegments.get(this._playhead);
        if (!pcm) break;

        this.queuedSegments.delete(this._playhead);
        this._playhead += 1;

        const canContinue = this.speaker.write(pcm);
        if (!canContinue) {
          this.waitingForDrain = true;
          this.speaker.once("drain", () => {
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
