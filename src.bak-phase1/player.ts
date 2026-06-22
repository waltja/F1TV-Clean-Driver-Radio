import Speaker from "speaker";
import type { PcmSegment } from "./types.js";
import { RING_BUFFER_DEPTH } from "./types.js";

export class Player {
  private readonly speaker: Speaker;
  private readonly queuedSegments = new Map<number, Buffer>();
  private _playhead = 0;
  private closed = false;
  private pumping = false;
  private waitingForDrain = false;

  constructor() {
    this.speaker = new Speaker({ channels: 1, bitDepth: 16, sampleRate: 48000 });
    // Prevent an unhandled 'error' (e.g. audio device fault) from crashing the process.
    this.speaker.on("error", (err: Error) => {
      console.error(`speaker error: ${err.message}`);
    });
  }

  get playhead(): number {
    return this._playhead;
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

  reseek(segmentNumber: number): void {
    if (this.closed) return;
    // Note (MVP): does not flush PCM already handed to the Speaker stream; the
    // small amount of buffered pre-seek audio drains naturally. Clean mid-stream
    // flush would require device re-acquisition and an audible glitch.
    this.queuedSegments.clear();
    this._playhead = segmentNumber;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queuedSegments.clear();
    try {
      this.speaker.close(false);
    } catch {
      // ignore close errors during shutdown
    }
  }

  private pump(): void {
    if (this.closed || this.pumping || this.waitingForDrain) {
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
