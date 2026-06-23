import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cacheToken, clearTokenCache, loadCachedToken, promptForToken } from "./auth.js";
import { decodeSegment, decodeSegmentRaw } from "./audio.js";
import { buildSegmentUrl, fetchManifest } from "./dash.js";
import { fetchEntitlementToken, fetchStreamUrl } from "./f1api.js";
import { concatInitAndSegment, downloadInit, downloadSegment } from "./segments.js";
import { fetchPlayers } from "./sync.js";
import { SEGMENT_DURATION_S } from "./types.js";
import type { DashManifest, MvPlayer, Tokens } from "./types.js";

// ---- CLI arg parsing -------------------------------------------------------

interface CollectArgs {
  startMin: number;
  endMin: number | null;    // stop scanning at this many minutes into stream (null = no limit)
  length: number | null;    // number of segments to scan (null = all); overrides endMin if both set
  threshold: number;        // RMS dB below which a segment is classified as noise
  numDrivers: number;       // only used when sourcing drivers from MV (ignored when --channel-ids set)
  outDir: string;
  maxMinutes: number | null; // max minutes of saved noise per driver (null = unlimited)
  // MV-free mode: provide drivers explicitly instead of querying MultiViewer.
  contentId: number | null;         // race session contentId
  channelIds: { tla: string; channelId: number }[] | null; // explicit driver list
}

function parseArgs(): CollectArgs {
  const argv = process.argv.slice(2);
  const args: CollectArgs = {
    startMin: 0,
    endMin: null,
    length: null,
    threshold: -55,
    numDrivers: 2,
    outDir: "./training-data",
    maxMinutes: null,
    contentId: null,
    channelIds: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    switch (flag) {
      case "--start-min":
        args.startMin = Number(next);
        i++;
        break;
      case "--end-min":
        args.endMin = Number(next);
        i++;
        break;
      case "--length":
        args.length = Number(next);
        i++;
        break;
      case "--threshold":
        args.threshold = Number(next);
        i++;
        break;
      case "--drivers":
        args.numDrivers = Number(next);
        i++;
        break;
      case "--out-dir":
        args.outDir = next;
        i++;
        break;
      case "--max-minutes":
        args.maxMinutes = Number(next);
        i++;
        break;
      case "--content-id":
        args.contentId = Number(next);
        i++;
        break;
      case "--channel-ids": {
        // Format: TLA:channelId,TLA:channelId,...
        const pairs = next.split(",").map((s) => s.trim()).filter(Boolean);
        args.channelIds = pairs.map((pair) => {
          const [tla, id] = pair.split(":");
          if (!tla || !id) {
            console.error(`Invalid --channel-ids entry: "${pair}". Expected format: TLA:channelId`);
            process.exit(1);
          }
          return { tla: tla.toUpperCase(), channelId: Number(id) };
        });
        i++;
        break;
      }
    }
  }

  // Validate: --channel-ids requires --content-id and vice versa.
  if ((args.contentId !== null) !== (args.channelIds !== null)) {
    console.error("--content-id and --channel-ids must be used together.");
    process.exit(1);
  }

  return args;
}

// ---- RMS measurement -------------------------------------------------------

function rmsDb(pcm: Buffer): number {
  if (pcm.length < 2) return -Infinity;
  const sampleCount = Math.floor(pcm.length / 2);
  let sumSq = 0;
  for (let i = 0; i < sampleCount * 2; i += 2) {
    const sample = pcm.readInt16LE(i);
    sumSq += sample * sample;
  }
  const rms = Math.sqrt(sumSq / sampleCount);
  if (rms === 0) return -Infinity;
  return 20 * Math.log10(rms / 32768);
}

// ---- Retry helper ----------------------------------------------------------

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
  baseDelayMs = 500,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * attempt;
        console.log(
          `  [retry] ${label} attempt ${attempt}/${maxAttempts} failed — ${err instanceof Error ? err.message : String(err)} — retrying in ${delay}ms`,
        );
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }
  throw lastErr;
}

// ---- Per-driver collect loop -----------------------------------------------

interface CollectResult {
  tla: string;
  total: number;
  kept: number;
  skipped: number;
  errors: number;
  stoppedEarly: boolean; // true if stopped by --max-minutes
  outPath: string;
  durationSaved: number; // seconds
  wallTimeMs: number;
}

// Global cleanup registry so SIGINT can close open fds across all drivers.
const openFds = new Map<string, number>();

async function collectDriver(
  tokens: Tokens,
  player: MvPlayer,
  args: CollectArgs,
): Promise<CollectResult> {
  const tla = player.driverData.tla;
  const { contentId, channelId } = player.streamData;

  const streamUrl = await fetchStreamUrl(tokens, contentId, channelId);
  const manifest: DashManifest = await fetchManifest(streamUrl);
  const initSegment = await downloadInit(manifest.initUrl);

  const startSegment = Math.floor((args.startMin * 60) / SEGMENT_DURATION_S) + 1;
  // --length takes precedence over --end-min. --end-min is absolute from stream start.
  const endSegment = args.length !== null
    ? startSegment + args.length - 1
    : args.endMin !== null
      ? Math.floor((args.endMin * 60) / SEGMENT_DURATION_S)
      : null;
  const maxSavedSamples = args.maxMinutes !== null ? args.maxMinutes * 60 : null;

  const outPath = path.join(args.outDir, `noise_${tla}.raw`);
  const outFd = fs.openSync(outPath, "a");
  openFds.set(tla, outFd);

  let total = 0;
  let kept = 0;
  let skipped = 0;
  let errors = 0;
  let stoppedEarly = false;
  let segmentNumber = startSegment;
  const startTime = Date.now();

  // Compute already-saved duration from existing file size (for max-minutes tracking across runs).
  let savedDurationS = 0;
  try {
    const existing = await fsPromises.stat(outPath);
    // 2 bytes per sample, 48000 samples/sec
    savedDurationS = existing.size / (2 * 48000);
  } catch {
    // File didn't exist yet, start from 0.
  }

  const maxLabel = endSegment !== null ? `/${endSegment - startSegment + 1}` : "";
  const rangeDesc = args.length !== null
    ? `, scanning ${args.length} segments`
    : args.endMin !== null
      ? `, scanning to min ${args.endMin} (seg ${endSegment})`
      : " (until stream end)";
  console.log(
    `[${tla}] Starting at segment ${startSegment} (min ${args.startMin})${rangeDesc} | threshold: ${args.threshold} dB | out: ${outPath}`,
  );

  while (endSegment === null || segmentNumber <= endSegment) {
    // Check --max-minutes cap (include already-saved from prior runs).
    if (maxSavedSamples !== null && savedDurationS + kept * SEGMENT_DURATION_S >= maxSavedSamples) {
      stoppedEarly = true;
      console.log(`[${tla}] Reached --max-minutes ${args.maxMinutes} — stopping`);
      break;
    }

    total++;
    const relSeg = segmentNumber - startSegment + 1;
    const label = `${relSeg}${maxLabel}`;

    let concatBuffer: Buffer;
    try {
      concatBuffer = await withRetry(
        async () => {
          const raw = await downloadSegment(buildSegmentUrl(manifest.mediaTemplate, segmentNumber));
          return concatInitAndSegment(initSegment, raw);
        },
        `[${tla} seg ${segmentNumber}] download`,
        3,
        500,
      );
    } catch (err) {
      // Consecutive failures after retries: likely past end of stream.
      console.log(
        `[${tla}  ${label}] download failed after retries — ${err instanceof Error ? err.message : String(err)} — stopping`,
      );
      break;
    }

    let denoisedPcm: Buffer;
    try {
      denoisedPcm = await withRetry(
        () => decodeSegment(concatBuffer),
        `[${tla} seg ${segmentNumber}] denoise decode`,
        2,
        200,
      );
    } catch (err) {
      errors++;
      console.log(`[${tla}  ${label}] decode error — ${err instanceof Error ? err.message : String(err)} — skipping`);
      segmentNumber++;
      continue;
    }

    const db = rmsDb(denoisedPcm);
    const dbStr = Number.isFinite(db) ? `${db.toFixed(1)} dB` : "-inf dB";
    const isSilent = db < args.threshold;

    if (isSilent) {
      let rawPcm: Buffer;
      try {
        rawPcm = await withRetry(
          () => decodeSegmentRaw(concatBuffer),
          `[${tla} seg ${segmentNumber}] raw decode`,
          2,
          200,
        );
      } catch (err) {
        errors++;
        console.log(`[${tla}  ${label}] raw decode error — ${err instanceof Error ? err.message : String(err)} — skipping`);
        segmentNumber++;
        skipped++;
        continue;
      }
      fs.writeSync(outFd, rawPcm);
      kept++;
      const keptMin = ((savedDurationS + kept * SEGMENT_DURATION_S) / 60).toFixed(1);
      console.log(`[${tla}  ${label}] ${dbStr} — NOISE  (saved | ${keptMin} min total)`);
    } else {
      skipped++;
      console.log(`[${tla}  ${label}] ${dbStr} — SPEECH (skipped)`);
    }

    segmentNumber++;
  }

  fs.closeSync(outFd);
  openFds.delete(tla);

  const durationSaved = kept * SEGMENT_DURATION_S;
  const wallTimeMs = Date.now() - startTime;
  return { tla, total, kept, skipped, errors, stoppedEarly, outPath, durationSaved, wallTimeMs };
}

// ---- SIGINT handler --------------------------------------------------------

function installSigintHandler(): void {
  process.once("SIGINT", () => {
    console.log("\n[collect] Interrupted — closing output files...");
    for (const [tla, fd] of openFds) {
      try {
        fs.closeSync(fd);
        console.log(`[collect] Closed fd for ${tla}`);
      } catch {
        // Already closed or never opened fully.
      }
    }
    openFds.clear();
    console.log("[collect] Shutdown complete. Partial data saved.");
    process.exit(0);
  });
}

// ---- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  installSigintHandler();

  // Auth
  let ascendonToken: string;
  let entitlementToken: string;

  const cached = await loadCachedToken();
  if (cached) {
    try {
      entitlementToken = await fetchEntitlementToken(cached);
      ascendonToken = cached;
    } catch {
      console.warn("Cached token invalid or expired. Re-enter.");
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

  // Build the driver list — either from explicit CLI args (MV-free) or from MultiViewer.
  let selected: MvPlayer[];

  if (args.contentId !== null && args.channelIds !== null) {
    // MV-free mode: construct synthetic MvPlayer objects from CLI args.
    selected = args.channelIds.map(({ tla, channelId }) => ({
      id: `cli-${tla}`,
      type: "OBC",
      state: { interpolatedCurrentTime: 0, paused: false, live: false },
      streamData: { contentId: args.contentId as number, channelId },
      driverData: { tla, driverNumber: 0, teamName: "" },
    }));
  } else {
    // MV mode: query MultiViewer for open OBC players.
    const players = await fetchPlayers();
    const obcPlayers = players.filter((p) => p.streamData.contentId && p.streamData.channelId);

    if (obcPlayers.length === 0) {
      console.error("No OBC players found in MultiViewer. Open some OBC streams first.");
      process.exit(1);
    }

    // Randomly select N drivers
    const shuffled = [...obcPlayers].sort(() => Math.random() - 0.5);
    selected = shuffled.slice(0, Math.min(args.numDrivers, shuffled.length));
  }

  console.log(
    `Selected ${selected.length} driver(s): ${selected.map((p) => p.driverData.driverNumber ? `${p.driverData.tla} #${p.driverData.driverNumber}` : p.driverData.tla).join(", ")}`,
  );
  if (args.maxMinutes !== null) {
    console.log(`Max noise to save per driver: ${args.maxMinutes} min`);
  }

  // Ensure output directory exists
  await fsPromises.mkdir(args.outDir, { recursive: true });

  const wallStart = Date.now();

  // Run all drivers concurrently
  const results = await Promise.all(
    selected.map((player) => collectDriver(tokens, player, args)),
  );

  const totalWallMs = Date.now() - wallStart;

  // Summary
  console.log("\n--- Collection Summary ---");
  for (const r of results) {
    const mins = (r.durationSaved / 60).toFixed(1);
    const stat = await fsPromises.stat(r.outPath).catch(() => null);
    const sizeMb = stat ? (stat.size / 1_048_576).toFixed(1) : "?";
    const noiseRatio = r.total > 0 ? ((r.kept / r.total) * 100).toFixed(0) : "0";
    const wallSec = (r.wallTimeMs / 1000).toFixed(0);
    const earlyTag = r.stoppedEarly ? " [max-minutes reached]" : "";
    console.log(
      `${r.tla}: ${r.kept}/${r.total} segments noise (${noiseRatio}%) | ${r.errors} errors | ${mins} min saved | ${sizeMb} MB | ${wallSec}s elapsed${earlyTag}`,
    );
    console.log(`       ${r.outPath}`);
  }

  const totalKept = results.reduce((s, r) => s + r.kept, 0);
  const totalDuration = (totalKept * SEGMENT_DURATION_S / 60).toFixed(1);
  console.log(`\nTotal across all drivers: ${totalDuration} min of noise data`);
  console.log(`Wall time: ${(totalWallMs / 1000).toFixed(0)}s`);
  console.log("\nNext steps:");
  console.log("  Concatenate:  pnpm concat-noise");
  console.log("  Play a file:  ffplay -f s16le -ar 48000 training-data/noise_<TLA>.raw");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
