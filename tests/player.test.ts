import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Player, type SpeakerFactory, type SpeakerLike } from "../src/player.js";

class FakeSpeaker extends EventEmitter implements SpeakerLike {
  public writes: Buffer[] = [];
  public closed = false;
  public ended = false;
  public nextWriteReturnValue = true;

  write(buffer: Buffer): boolean {
    this.writes.push(Buffer.from(buffer));
    const returnValue = this.nextWriteReturnValue;
    this.nextWriteReturnValue = true;
    return returnValue;
  }

  close(): void {
    this.closed = true;
  }

  end(buffer?: Buffer): void {
    if (buffer) {
      this.writes.push(Buffer.from(buffer));
    }
    this.ended = true;
  }
}

function createPlayerHarness(): {
  player: Player;
  speakers: FakeSpeaker[];
} {
  const speakers: FakeSpeaker[] = [];
  const speakerFactory: SpeakerFactory = () => {
    const speaker = new FakeSpeaker();
    speakers.push(speaker);
    return speaker;
  };

  return {
    player: new Player(speakerFactory),
    speakers,
  };
}

test("Player.reseek clears pre-seek queue and resets playhead", () => {
  const { player, speakers } = createPlayerHarness();

  player.enqueue({ number: 0, pcm: Buffer.from([1, 2]) });
  player.reseek(5, 0);
  player.enqueue({ number: 4, pcm: Buffer.from([3, 4]) });
  player.enqueue({ number: 5, pcm: Buffer.from([5, 6]) });

  assert.equal(player.playhead, 6);
  assert.equal(speakers.length, 2);
  assert.equal(speakers[0].ended, true);
  assert.equal(speakers[0].closed, false);
  assert.deepEqual(speakers[1].writes, [Buffer.from([5, 6])]);
});

test("Player.reseek trims the first post-seek segment only once", () => {
  const { player, speakers } = createPlayerHarness();

  player.reseek(7, 0.00003);
  player.enqueue({ number: 7, pcm: Buffer.from([10, 11, 12, 13, 14, 15]) });
  player.enqueue({ number: 8, pcm: Buffer.from([20, 21, 22, 23]) });

  assert.deepEqual(speakers[1].writes[0], Buffer.from([12, 13, 14, 15]));
  assert.deepEqual(speakers[1].writes[1], Buffer.from([20, 21, 22, 23]));
});

test("Player.reseek can trim away an entire first segment and continue", () => {
  const { player, speakers } = createPlayerHarness();

  player.reseek(3, 0.00005);
  player.enqueue({ number: 3, pcm: Buffer.from([1, 2, 3, 4]) });
  player.enqueue({ number: 4, pcm: Buffer.from([5, 6, 7, 8]) });

  assert.deepEqual(speakers[1].writes[0], Buffer.alloc(0));
  assert.deepEqual(speakers[1].writes[1], Buffer.from([5, 6, 7, 8]));
  assert.equal(player.playhead, 5);
});

test("Player.reseek carries remaining trim into the next segment when the first buffer is too short", () => {
  const { player, speakers } = createPlayerHarness();

  player.reseek(12, 0.00007);
  player.enqueue({ number: 12, pcm: Buffer.from([1, 2, 3, 4]) });
  player.enqueue({ number: 13, pcm: Buffer.from([5, 6, 7, 8, 9, 10]) });

  assert.deepEqual(speakers[1].writes[0], Buffer.alloc(0));
  assert.deepEqual(speakers[1].writes[1], Buffer.from([7, 8, 9, 10]));
  assert.equal(player.playhead, 14);
});

test("Player.reseek while paused preserves paused state and silence feed can target the new speaker after real playback starts", async () => {
  const { player, speakers } = createPlayerHarness();

  player.pause();
  player.reseek(9, 0);

  assert.equal(player.paused, true);
  assert.equal(speakers.length, 2);
  assert.equal(speakers[0].ended, true);
  assert.equal(speakers[0].closed, false);

  player.resume();
  player.enqueue({ number: 9, pcm: Buffer.from([1, 2, 3, 4]) });
  player.pause();
  await new Promise((resolve) => setTimeout(resolve, 110));
  player.close();

  assert.ok(speakers[1].writes.length >= 1);
});

test("Player does not queue synthetic silence before the first real segment when started paused", async () => {
  const { player, speakers } = createPlayerHarness();

  player.pause();
  await new Promise((resolve) => setTimeout(resolve, 110));
  player.resume();
  player.enqueue({ number: 0, pcm: Buffer.from([1, 2, 3, 4]) });
  player.close();

  assert.deepEqual(speakers[0].writes, [Buffer.from([1, 2, 3, 4])]);
});

test("Player.reseek recovers from prior drain backpressure without waiting on the old speaker", () => {
  const { player, speakers } = createPlayerHarness();

  speakers[0].nextWriteReturnValue = false;
  player.enqueue({ number: 0, pcm: Buffer.from([1, 2, 3, 4]) });

  player.reseek(10, 0);
  player.enqueue({ number: 10, pcm: Buffer.from([9, 8, 7, 6]) });

  assert.deepEqual(speakers[1].writes, [Buffer.from([9, 8, 7, 6])]);
  assert.equal(player.playhead, 11);
});

test("Player.reseek ignores stale drain events from the old speaker", () => {
  const { player, speakers } = createPlayerHarness();

  speakers[0].nextWriteReturnValue = false;
  player.enqueue({ number: 0, pcm: Buffer.from([1, 2, 3, 4]) });

  player.reseek(10, 0);
  speakers[1].nextWriteReturnValue = false;
  player.enqueue({ number: 10, pcm: Buffer.from([9, 8, 7, 6]) });
  player.enqueue({ number: 11, pcm: Buffer.from([5, 4, 3, 2]) });

  speakers[0].emit("drain");

  assert.deepEqual(speakers[1].writes, [Buffer.from([9, 8, 7, 6])]);
  assert.equal(player.playhead, 11);

  speakers[1].emit("drain");

  assert.deepEqual(speakers[1].writes, [Buffer.from([9, 8, 7, 6]), Buffer.from([5, 4, 3, 2])]);
  assert.equal(player.playhead, 12);
});
