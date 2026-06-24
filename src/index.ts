import process from "node:process";
import { ask, cacheToken, clearTokenCache, loadCachedToken, promptForToken } from "./auth.js";
import { decodeSegmentRaw, decodeSegmentSingleDenoise } from "./audio.js";
import { buildSegmentUrl, fetchManifest } from "./dash.js";
import { fetchEntitlementToken, fetchStreamUrl } from "./f1api.js";
import { Player } from "./player.js";
import { concatInitAndSegment, downloadInit, downloadSegment } from "./segments.js";
import { createVadSession, runVad } from "./vad.js";
import { fetchPlayers, isSeek, segmentNumberForTime } from "./sync.js";
import { LATENCY_COMPENSATION_S, POLL_INTERVAL_MS, RING_BUFFER_DEPTH, SEGMENT_DURATION_S, VAD_SPEECH_PCT, VAD_THRESHOLD } from "./types.js";
import type { MvPlayer, Tokens } from "./types.js";

async function selectDriver(players: MvPlayer[]): Promise<MvPlayer> {
  if (players.length === 0) {
    throw new Error("selectDriver: no players available in MultiViewer");
  }

  for (;;) {
    for (const [index, player] of players.entries()) {
      console.log(
        `${index + 1}. ${player.driverData.tla} #${player.driverData.driverNumber} ${player.driverData.teamName}`,
      );
    }

    const answer = await ask("Select driver: ");
    const selectedIndex = Number.parseInt(answer, 10) - 1;

    if (Number.isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= players.length) {
      console.log("Invalid selection. Try again.");
      continue;
    }
    return players[selectedIndex];
  }
}

async function main(): Promise<void> {
  let ascendonToken: string;
  let entitlementToken: string;

  const cached = await loadCachedToken();
  if (cached) {
    try {
      entitlementToken = await fetchEntitlementToken(cached);
      ascendonToken = cached;
    } catch {
      console.warn("Cached token is invalid or expired. Please re-enter.");
      await clearTokenCache();
      ascendonToken = await promptForToken();
      entitlementToken = await fetchEntitlementToken(ascendonToken);
      await cacheToken(ascendonToken);
    }
  } else {
    ascendonToken = await promptForToken();
    entitlementToken = await fetchEntitlementToken(ascendonToken);
    await cacheToken(ascendonToken);
  }

  const tokens: Tokens = { ascendonToken, entitlementToken };

  const players = await fetchPlayers();
  const selectedPlayer = await selectDriver(players);
  const selectedPlayerId = selectedPlayer.id;
  const { contentId, channelId } = selectedPlayer.streamData;

  const streamUrl = await fetchStreamUrl(tokens, contentId, channelId);
  const manifest = await fetchManifest(streamUrl);
  const initSegment = await downloadInit(manifest.initUrl);

  const vadSession = await createVadSession();

  // Serialize VAD inference: runVad() mutates session state per-frame, so concurrent
  // calls on the same session would interleave their frame writes. Downloads and raw
  // decodes still run concurrently; only the ONNX inference step is queued.
  let vadQueue = Promise.resolve();
  function enqueueVad<T>(fn: () => Promise<T>): Promise<T> {
    const result = vadQueue.then(fn, fn);
    vadQueue = result.then(() => {}, () => {});
    return result;
  }

  const player = new Player();
  const inFlight = new Set<number>();

  let previousTime = 0;
  let previousTickMs = Date.now();
  let firstTick = true;
  let generation = 0;
  let tickRunning = false;

  const intervalId = setInterval(() => {
    // Skip overlapping ticks so a slow fetch cannot run two ticks concurrently
    // and race on previousTime/previousTickMs/firstTick/generation.
    if (tickRunning) return;
    tickRunning = true;

    void (async () => {
      try {
        const tickStartedAt = Date.now();
        const refreshedPlayers = await fetchPlayers();
        const currentPlayer = refreshedPlayers.find((candidate) => candidate.id === selectedPlayerId);

        if (!currentPlayer) {
          console.warn(`Player ${selectedPlayerId} not found. Skipping tick.`);
          return;
        }

        const currentTime = currentPlayer.state.interpolatedCurrentTime + LATENCY_COMPENSATION_S;
        const currentSegment = segmentNumberForTime(currentTime);

        const h = Math.floor(currentTime / 3600);
        const m = Math.floor((currentTime % 3600) / 60);
        const s = Math.floor(currentTime % 60);
        const timeStr = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        if (!currentPlayer.state.paused) {
          console.log(
            `[sync] MV time: ${timeStr} | segment: ${currentSegment} | playhead: ${player.playhead}`,
          );
        }

        const shouldReseek = firstTick || isSeek(previousTime, currentTime, tickStartedAt - previousTickMs);
        if (shouldReseek) {
          generation += 1;
          const offsetIntoSegmentS = currentTime - (currentSegment - 1) * SEGMENT_DURATION_S;
          player.reseek(currentSegment, offsetIntoSegmentS);
          console.log(`[sync] reseek to segment ${currentSegment} offset ${offsetIntoSegmentS.toFixed(2)}s`);
        }

        // Mirror MV pause state to the audio player.
        if (currentPlayer.state.paused && !player.paused) {
          player.pause();
          console.log("[sync] paused");
        } else if (!currentPlayer.state.paused && player.paused) {
          player.resume();
          console.log("[sync] resumed");
        }

        if (!currentPlayer.state.paused) {
          const startSegment = player.playhead;
          const endSegment = startSegment + RING_BUFFER_DEPTH;
          const activeGeneration = generation;

          for (let segmentNumber = startSegment; segmentNumber < endSegment; segmentNumber += 1) {
            if (player.has(segmentNumber) || inFlight.has(segmentNumber)) {
              continue;
            }
            inFlight.add(segmentNumber);

            // Fire-and-forget: never blocks the poll tick.
            void (async () => {
              try {
                const segmentUrl = buildSegmentUrl(manifest.mediaTemplate, segmentNumber);
                const compressedSegment = await downloadSegment(segmentUrl);
                const joinedSegment = concatInitAndSegment(initSegment, compressedSegment);

                // Step 1: raw decode (~30ms) -- concurrent across segments.
                const rawPcm = await decodeSegmentRaw(joinedSegment);

                // Step 2: serialized VAD inference (~5ms).
                const vadResult = await enqueueVad(() => runVad(vadSession, rawPcm, VAD_THRESHOLD));

                // Step 3: branch on VAD result.
                let pcmSegment: Buffer;
                if (vadResult.speechPct >= VAD_SPEECH_PCT) {
                  // Speech detected: single arnndn pass (~150ms).
                  pcmSegment = await decodeSegmentSingleDenoise(joinedSegment);
                  console.log(
                    `[vad] seg ${segmentNumber}: SPEECH (${(vadResult.speechPct * 100).toFixed(1)}%, p=${vadResult.probability.toFixed(2)})`,
                  );
                } else {
                  // Engine-only: output silence.
                  pcmSegment = Buffer.alloc(rawPcm.length);
                  console.log(
                    `[vad] seg ${segmentNumber}: noise  (${(vadResult.speechPct * 100).toFixed(1)}%, p=${vadResult.probability.toFixed(2)})`,
                  );
                }

                // Drop results decoded against a pre-seek generation.
                if (activeGeneration !== generation) {
                  return;
                }
                player.enqueue({ number: segmentNumber, pcm: pcmSegment });
              } catch (error) {
                console.error(`segment ${segmentNumber}: ${error instanceof Error ? error.message : String(error)}`);
              } finally {
                inFlight.delete(segmentNumber);
              }
            })();
          }
        }

        previousTime = currentTime;
        previousTickMs = tickStartedAt;
        firstTick = false;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      } finally {
        tickRunning = false;
      }
    })();
  }, POLL_INTERVAL_MS);

  const cleanup = (): void => {
    clearInterval(intervalId);
    player.close();
  };

  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
