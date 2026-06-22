import process from "node:process";
import { ask, promptForToken } from "./auth.js";
import { decodeSegment } from "./audio.js";
import { buildSegmentUrl, fetchManifest } from "./dash.js";
import { fetchEntitlementToken, fetchStreamUrl } from "./f1api.js";
import { Player } from "./player.js";
import { concatInitAndSegment, downloadInit, downloadSegment } from "./segments.js";
import { fetchPlayers, isSeek, segmentNumberForTime } from "./sync.js";
import { POLL_INTERVAL_MS, RING_BUFFER_DEPTH } from "./types.js";
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
  const ascendonToken = await promptForToken();
  const entitlementToken = await fetchEntitlementToken(ascendonToken);
  const tokens: Tokens = { ascendonToken, entitlementToken };

  const players = await fetchPlayers();
  const selectedPlayer = await selectDriver(players);
  const selectedPlayerId = selectedPlayer.id;
  const { contentId, channelId } = selectedPlayer.streamData;

  const streamUrl = await fetchStreamUrl(tokens, contentId, channelId);
  const manifest = await fetchManifest(streamUrl);
  const initSegment = await downloadInit(manifest.initUrl);

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

        const currentTime = currentPlayer.state.interpolatedCurrentTime;
        const currentSegment = segmentNumberForTime(currentTime);

        const shouldReseek = firstTick || isSeek(previousTime, currentTime, tickStartedAt - previousTickMs);
        if (shouldReseek) {
          generation += 1;
          player.reseek(currentSegment);
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
                const pcmSegment = await decodeSegment(joinedSegment);

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
