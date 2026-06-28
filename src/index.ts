import process from "node:process";
import { ask, cacheToken, clearTokenCache, loadCachedToken, promptForToken } from "./auth.js";
import { decodeSegmentRaw, decodeSegmentWithFilter } from "./audio.js";
import { buildSegmentUrl, fetchManifest } from "./dash.js";
import { fetchEntitlementToken, fetchStreamUrl } from "./f1api.js";
import { Player } from "./player.js";
import { concatInitAndSegment, downloadInit, downloadSegment } from "./segments.js";
import { createVadSession, runVad } from "./vad.js";
import { fetchPlayers, isSeek, segmentNumberForTime } from "./sync.js";
import { LATENCY_COMPENSATION_S, POLL_INTERVAL_MS, RING_BUFFER_DEPTH, SEGMENT_DURATION_S, VAD_SPEECH_PCT, VAD_THRESHOLD } from "./types.js";
import type { MvPlayer, Tokens } from "./types.js";

const FRAME_BYTES_48K = 512 * 3 * 2;
const PAD_FRAMES = 16;
const SEGMENT_LOOKAHEAD = RING_BUFFER_DEPTH + 1;
const DEBUG = process.argv.includes("--debug");

interface PendingSegment {
  generation: number;
  rawPcm: Buffer;
  vadResult: Awaited<ReturnType<typeof runVad>>;
  enqueued: boolean;
  finalizing: boolean;
}

interface ActiveStreamState {
  manifest: Awaited<ReturnType<typeof fetchManifest>>;
  initSegment: Buffer;
}

interface PendingSeek {
  syncTime: number;
  tickMs: number;
}

interface RefreshReseekPlan {
  nextGeneration: number;
  currentSegment: number;
  offsetIntoSegmentS: number;
}

async function selectDriver(players: MvPlayer[]): Promise<MvPlayer> {
  const validPlayers = players.filter((p) => p.driverData != null);
  if (validPlayers.length === 0) {
    throw new Error("selectDriver: no players with driver data available — is a session active in MultiViewer?");
  }

  for (;;) {
    for (const [index, player] of validPlayers.entries()) {
      console.log(
        `${index + 1}. ${player.driverData.tla} #${player.driverData.driverNumber} ${player.driverData.teamName}`,
      );
    }

    const answer = await ask("Select driver: ");
    const selectedIndex = Number.parseInt(answer, 10) - 1;

    if (Number.isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= validPlayers.length) {
      console.log("Invalid selection. Try again.");
      continue;
    }
    return validPlayers[selectedIndex];
  }
}

function formatClockTime(currentTime: number): string {
  const h = Math.floor(currentTime / 3600);
  const m = Math.floor((currentTime % 3600) / 60);
  const s = Math.floor(currentTime % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(3)}s`;
}

function debugLog(message: string): void {
  if (DEBUG) {
    console.log(message);
  }
}

function shouldFinalizeSegment(
  segmentNumber: number,
  firstPendingNumber: number,
  playhead: number,
  hasPrevious: boolean,
  hasNext: boolean,
): boolean {
  if (segmentNumber !== firstPendingNumber && !hasPrevious) {
    return false;
  }

  if (hasNext) {
    return true;
  }

  return segmentNumber === playhead;
}

function isSegmentInFlight(inFlight: Map<number, number>, segmentNumber: number, generation: number): boolean {
  return inFlight.get(segmentNumber) === generation;
}

function markSegmentInFlight(inFlight: Map<number, number>, segmentNumber: number, generation: number): void {
  inFlight.set(segmentNumber, generation);
}

function clearSegmentInFlight(inFlight: Map<number, number>, segmentNumber: number, generation: number): void {
  if (inFlight.get(segmentNumber) === generation) {
    inFlight.delete(segmentNumber);
  }
}

function isRetryableStreamError(error: unknown): boolean {
  return error instanceof Error && /HTTP (401|403)\b/.test(error.message);
}

function shouldAcceptSegmentResult(activeGeneration: number, currentGeneration: number): boolean {
  return activeGeneration === currentGeneration;
}

function planRefreshReseek(currentGeneration: number, playbackTime: number, segmentDurationS: number): RefreshReseekPlan {
  const currentSegment = Math.floor(playbackTime / segmentDurationS) + 1;
  return {
    nextGeneration: currentGeneration + 1,
    currentSegment,
    offsetIntoSegmentS: playbackTime - (currentSegment - 1) * segmentDurationS,
  };
}

function shouldHandleRetryableStreamFailure(
  error: unknown,
  taskGeneration: number,
  currentGeneration: number,
): boolean {
  return isRetryableStreamError(error) && shouldAcceptSegmentResult(taskGeneration, currentGeneration);
}

function hasSpeechWithinPadding(
  frameIndex: number,
  frameProbs: number[],
  previousFrameProbs: number[] | undefined,
  nextFrameProbs: number[] | undefined,
): boolean {
  for (let offset = -PAD_FRAMES; offset <= PAD_FRAMES; offset += 1) {
    const candidateIndex = frameIndex + offset;
    if (candidateIndex >= 0 && candidateIndex < frameProbs.length) {
      if (frameProbs[candidateIndex] >= VAD_THRESHOLD) {
        return true;
      }
      continue;
    }

    if (candidateIndex < 0) {
      if (!previousFrameProbs) {
        continue;
      }

      const previousIndex = previousFrameProbs.length + candidateIndex;
      if (previousIndex >= 0 && previousFrameProbs[previousIndex] >= VAD_THRESHOLD) {
        return true;
      }
      continue;
    }

    const nextIndex = candidateIndex - frameProbs.length;
    if (nextFrameProbs && nextIndex < nextFrameProbs.length && nextFrameProbs[nextIndex] >= VAD_THRESHOLD) {
      return true;
    }
  }

  return false;
}

async function finalizeSegment(
  segment: PendingSegment,
  previous: PendingSegment | undefined,
  next: PendingSegment | undefined,
): Promise<Buffer> {
  if (segment.vadResult.speechPct < VAD_SPEECH_PCT) {
    return Buffer.alloc(segment.rawPcm.length);
  }

  const masked = Buffer.from(segment.rawPcm);
  let anySpeech = false;

  for (let frameIndex = 0; frameIndex < segment.vadResult.frameProbs.length; frameIndex += 1) {
    if (
      hasSpeechWithinPadding(
        frameIndex,
        segment.vadResult.frameProbs,
        previous?.vadResult.frameProbs,
        next?.vadResult.frameProbs,
      )
    ) {
      anySpeech = true;
      continue;
    }

    const start = frameIndex * FRAME_BYTES_48K;
    masked.fill(0, start, Math.min(start + FRAME_BYTES_48K, masked.length));
  }

  return anySpeech ? decodeSegmentWithFilter(masked) : Buffer.alloc(segment.rawPcm.length);
}

async function main(): Promise<void> {
  debugLog("[boot] src/index.ts with reseek diagnostics loaded");

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

  async function loadStreamState(): Promise<ActiveStreamState> {
    const streamUrl = await fetchStreamUrl(tokens, contentId, channelId);
    const manifest = await fetchManifest(streamUrl);
    const initSegment = await downloadInit(manifest.initUrl);
    return { manifest, initSegment };
  }

  let streamState = await loadStreamState();

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
  const inFlight = new Map<number, number>();
  const pendingSegments = new Map<number, PendingSegment>();

  let previousTime = 0;
  let previousTickMs = Date.now();
  let firstTick = true;
  let generation = 0;
  let tickRunning = false;
  let refreshPromise: Promise<void> | null = null;
  let pendingSeek: PendingSeek | null = null;

  function prunePendingSegments(): void {
    for (const [segmentNumber, segment] of pendingSegments) {
      if (segment.generation !== generation || segmentNumber < player.playhead - 1) {
        pendingSegments.delete(segmentNumber);
      }
    }
  }

  async function flushReadySegments(activeGeneration: number): Promise<void> {
    const pendingNumbers = [...pendingSegments.entries()]
      .filter(([, segment]) => segment.generation === activeGeneration && !segment.enqueued)
      .map(([segmentNumber]) => segmentNumber)
      .sort((a, b) => a - b);
    if (pendingNumbers.length === 0) {
      return;
    }

    const firstPendingNumber = pendingNumbers[0];
    for (const segmentNumber of pendingNumbers) {
      const segment = pendingSegments.get(segmentNumber);
      if (!segment || segment.enqueued || segment.finalizing || segment.generation !== activeGeneration) {
        continue;
      }

      const previous = pendingSegments.get(segmentNumber - 1);
      const next = pendingSegments.get(segmentNumber + 1);
      if (!shouldFinalizeSegment(segmentNumber, firstPendingNumber, player.playhead, previous != null, next != null)) {
        continue;
      }

      segment.finalizing = true;

      let pcm: Buffer;
      try {
        pcm = await finalizeSegment(segment, previous, next);
      } catch (error) {
        pendingSegments.delete(segmentNumber);
        throw error;
      }

      if (segment.generation !== generation || activeGeneration !== generation) {
        return;
      }

      player.enqueue({ number: segmentNumber, pcm });
      segment.enqueued = true;
      segment.rawPcm = Buffer.alloc(0);
      prunePendingSegments();
    }
  }

  async function refreshStreamState(reason: string): Promise<void> {
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      console.warn(`[stream] refreshing signed stream after ${reason}`);
      const refreshStartedAt = Date.now();
      tokens.entitlementToken = await fetchEntitlementToken(tokens.ascendonToken);
      streamState = await loadStreamState();

      const refreshedPlayers = await fetchPlayers();
      const currentPlayer = refreshedPlayers.find((candidate) => candidate.id === selectedPlayerId);
      if (!currentPlayer) {
        throw new Error(`Player ${selectedPlayerId} not found during stream refresh`);
      }

      const syncTime = currentPlayer.state.interpolatedCurrentTime;
      const playbackTime = syncTime + LATENCY_COMPENSATION_S;
      const refreshPlan = planRefreshReseek(generation, playbackTime, SEGMENT_DURATION_S);
      debugLog(
        `[stream] refresh syncTime=${formatSeconds(syncTime)} playbackTime=${formatSeconds(playbackTime)} reseekSegment=${refreshPlan.currentSegment} reseekOffset=${formatSeconds(refreshPlan.offsetIntoSegmentS)}`,
      );
      generation = refreshPlan.nextGeneration;
      pendingSegments.clear();
      pendingSeek = null;
      player.reseek(refreshPlan.currentSegment, refreshPlan.offsetIntoSegmentS);
      previousTime = syncTime;
      previousTickMs = refreshStartedAt;
      firstTick = false;
      debugLog(`[stream] refreshed and reseeked to segment ${refreshPlan.currentSegment} offset ${refreshPlan.offsetIntoSegmentS.toFixed(2)}s`);
    })().finally(() => {
      refreshPromise = null;
    });

    return refreshPromise;
  }

  const intervalId = setInterval(() => {
    // Skip overlapping ticks so a slow fetch cannot run two ticks concurrently
    // and race on previousTime/previousTickMs/firstTick/generation.
    if (tickRunning) return;
    tickRunning = true;

    void (async () => {
      try {
        const tickStartedAt = Date.now();
        debugLog("[tick] polling MultiViewer state");
        const refreshedPlayers = await fetchPlayers();
        const currentPlayer = refreshedPlayers.find((candidate) => candidate.id === selectedPlayerId);

        if (!currentPlayer) {
          console.warn(`Player ${selectedPlayerId} not found. Skipping tick.`);
          return;
        }

        const syncTime = currentPlayer.state.interpolatedCurrentTime;
        const playbackTime = syncTime + LATENCY_COMPENSATION_S;
        const currentSegment = segmentNumberForTime(playbackTime);
        const expectedSyncTime = previousTime + (tickStartedAt - previousTickMs) / 1000;
        const seekDelta = syncTime - expectedSyncTime;
        if (!currentPlayer.state.paused) {
          debugLog(
            `[sync] MV time: ${formatClockTime(syncTime)} | raw=${formatSeconds(syncTime)} | playback=${formatSeconds(playbackTime)} | delta=${formatSeconds(seekDelta)} | segment: ${currentSegment} | playhead: ${player.playhead}`,
          );
        }

        if (pendingSeek) {
          if (isSeek(pendingSeek.syncTime, syncTime, tickStartedAt - pendingSeek.tickMs)) {
            pendingSeek = { syncTime, tickMs: tickStartedAt };
            debugLog(
              `[sync] reseek target still moving raw=${formatSeconds(syncTime)} delta=${formatSeconds(seekDelta)} waiting for stabilization`,
            );
          } else {
            generation += 1;
            pendingSeek = null;
            const reseekSegment = segmentNumberForTime(playbackTime);
            const offsetIntoSegmentS = playbackTime - (reseekSegment - 1) * SEGMENT_DURATION_S;
            pendingSegments.clear();
            player.reseek(reseekSegment, offsetIntoSegmentS);
            debugLog(
              `[sync] reseek committed after stabilization actualRaw=${formatSeconds(syncTime)} playback=${formatSeconds(playbackTime)} targetSegment=${reseekSegment} targetOffset=${formatSeconds(offsetIntoSegmentS)}`,
            );
          }
        } else if (firstTick) {
          generation += 1;
          const reseekSegment = segmentNumberForTime(playbackTime);
          const offsetIntoSegmentS = playbackTime - (reseekSegment - 1) * SEGMENT_DURATION_S;
          pendingSegments.clear();
          player.reseek(reseekSegment, offsetIntoSegmentS);
          debugLog(
            `[sync] reseek triggered firstTick=${firstTick} expectedRaw=${formatSeconds(expectedSyncTime)} actualRaw=${formatSeconds(syncTime)} playback=${formatSeconds(playbackTime)} delta=${formatSeconds(seekDelta)} targetSegment=${reseekSegment} targetOffset=${formatSeconds(offsetIntoSegmentS)}`,
          );
        } else if (isSeek(previousTime, syncTime, tickStartedAt - previousTickMs)) {
          pendingSeek = { syncTime, tickMs: tickStartedAt };
          debugLog(
            `[sync] seek detected expectedRaw=${formatSeconds(expectedSyncTime)} actualRaw=${formatSeconds(syncTime)} delta=${formatSeconds(seekDelta)} waiting one poll to stabilize`,
          );
        }

        // Mirror MV pause state to the audio player.
        if (currentPlayer.state.paused && !player.paused) {
          player.pause();
          debugLog("[sync] paused");
        } else if (!currentPlayer.state.paused && player.paused) {
          player.resume();
          debugLog("[sync] resumed");
        }

        if (!currentPlayer.state.paused) {
          const startSegment = player.playhead;
          const endSegment = startSegment + SEGMENT_LOOKAHEAD;
          const activeGeneration = generation;

          for (let segmentNumber = startSegment; segmentNumber < endSegment; segmentNumber += 1) {
            if (player.has(segmentNumber) || isSegmentInFlight(inFlight, segmentNumber, activeGeneration) || pendingSegments.has(segmentNumber)) {
              continue;
            }
            markSegmentInFlight(inFlight, segmentNumber, activeGeneration);
            const taskStreamState = streamState;

            // Fire-and-forget: never blocks the poll tick.
            void (async () => {
              try {
                const segmentUrl = buildSegmentUrl(taskStreamState.manifest.mediaTemplate, segmentNumber, taskStreamState.manifest.startNumber);
                const compressedSegment = await downloadSegment(segmentUrl);
                const joinedSegment = concatInitAndSegment(taskStreamState.initSegment, compressedSegment);

                // Step 1: raw decode (~30ms) -- concurrent across segments.
                const rawPcm = await decodeSegmentRaw(joinedSegment);

                // Step 2: serialized VAD inference (~5ms).
                const vadResult = await enqueueVad(() => runVad(vadSession, rawPcm, VAD_THRESHOLD));

                // Drop results decoded against a pre-seek generation.
                if (!shouldAcceptSegmentResult(activeGeneration, generation)) {
                  return;
                }

                pendingSegments.set(segmentNumber, {
                  generation: activeGeneration,
                  rawPcm,
                  vadResult,
                  enqueued: false,
                  finalizing: false,
                });

                await flushReadySegments(activeGeneration);

                const kind = vadResult.speechPct >= VAD_SPEECH_PCT ? "SPEECH" : "noise ";
                debugLog(
                  `[vad] seg ${segmentNumber}: ${kind} (${(vadResult.speechPct * 100).toFixed(1)}%, p=${vadResult.probability.toFixed(2)})`,
                );
              } catch (error) {
                if (shouldHandleRetryableStreamFailure(error, activeGeneration, generation)) {
                  try {
                    await refreshStreamState(`segment ${segmentNumber} fetch failure`);
                  } catch (refreshError) {
                    console.error(refreshError instanceof Error ? refreshError.message : String(refreshError));
                  }
                }
                console.error(`segment ${segmentNumber}: ${error instanceof Error ? error.message : String(error)}`);
              } finally {
                clearSegmentInFlight(inFlight, segmentNumber, activeGeneration);
              }
            })();
          }
        }

        previousTime = syncTime;
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
