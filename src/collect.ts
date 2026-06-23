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
  numDrivers: number;       // number of randomly-selected MV OBC players to use
  outDir: string;
  maxMinutes: number | null; // max minutes of saved noise per driver (null = unlimited)
  retireAfter: number | null; // stop after this many consecutive below-threshold segments (null = disabled)
  // Auto-skip dead zones (pre-race filler / post-race silence at stream boundaries).
  autoSkip: boolean;        // enabled by default; disable with --no-auto-skip
  deadZoneDb: number;       // RMS dB below which a segment is considered dead-zone (default -70)
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
    retireAfter: null,
    autoSkip: true,
    deadZoneDb: -70,
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
      case "--retire-after":
        args.retireAfter = Number(next);
        i++;
        break;
      case "--no-auto-skip":
        args.autoSkip = false;
        break;
      case "--dead-zone-db":
        args.deadZoneDb = Number(next);
        i++;
        break;
    }
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

// ---- OBC-off loop detector -------------------------------------------------
//
// When the OBC is off, F1TV streams a short looping idle tone (~600ms period)
// instead of silence. It sits at around -48 dB RMS — above the normal noise
// threshold — so it would be misclassified as speech if not caught early.
//
// Signature: the 600ms envelope repeats with near-zero variance. We split the
// raw decoded segment into 600ms windows and check that the per-window RMS
// values are almost identical (stddev < 1.5 dB). Real audio (engine or speech)
// has far more dynamic variation.
//
// Call this on the raw decoded PCM *before* the expensive denoise decode.
// Returns true if the OBC-off loop pattern is detected → skip the segment.

const OBC_LOOP_WINDOW_SAMPLES = 28800; // 600ms at 48kHz
const OBC_LOOP_MAX_STDDEV_DB  = 1.5;  // dB — any real audio varies more than this

function isObcOffLoop(rawPcm: Buffer): boolean {
  const bytesPerWindow = OBC_LOOP_WINDOW_SAMPLES * 2; // int16 = 2 bytes
  const numWindows = Math.floor(rawPcm.length / bytesPerWindow);
  if (numWindows < 4) return false; // need at least 4 windows (~2.4s) to be confident

  const windowRms: number[] = [];
  for (let w = 0; w < numWindows; w++) {
    const offset = w * bytesPerWindow;
    let sumSq = 0;
    for (let i = offset; i < offset + bytesPerWindow; i += 2) {
      const s = rawPcm.readInt16LE(i);
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / OBC_LOOP_WINDOW_SAMPLES);
    windowRms.push(rms > 0 ? 20 * Math.log10(rms / 32768) : -100);
  }

  const mean = windowRms.reduce((a, b) => a + b, 0) / windowRms.length;
  const variance = windowRms.reduce((a, b) => a + (b - mean) ** 2, 0) / windowRms.length;
  const stddev = Math.sqrt(variance);

  return stddev < OBC_LOOP_MAX_STDDEV_DB;
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

// ---- Auto-skip: dead-zone probe --------------------------------------------

// How many segments must be consistently above deadZoneDb to confirm real audio.
const PROBE_CONFIRM_COUNT = 3;
// Coarse probe step size in segments.
const PROBE_COARSE_STEP = 20;
// Maximum segments to scan forward when searching for stream start (~38 min).
const PROBE_MAX_FORWARD = 400;

/**
 * Binary-search for the last downloadable segment number.
 * Starts at `hint` and doubles until a 404 is hit, then narrows down.
 */
async function findLastSegment(
  mediaTemplate: string,
  hint: number,
): Promise<number> {
  // Phase 1: double upward from hint until we get a 404.
  let lo = hint;
  let hi = hint;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = buildSegmentUrl(mediaTemplate, hi);
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) break;
    lo = hi;
    hi = hi * 2;
    if (hi > 100000) break; // safety cap
  }

  // Phase 2: binary search between lo (known good) and hi (known bad).
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const url = buildSegmentUrl(mediaTemplate, mid);
    const res = await fetch(url, { method: "HEAD" });
    if (res.ok) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Sample a segment: download, decode (denoised), return RMS dB.
 * Returns -Infinity on download/decode error.
 */
async function probeSegment(
  initSegment: Buffer,
  mediaTemplate: string,
  segNumber: number,
): Promise<number> {
  try {
    const raw = await downloadSegment(buildSegmentUrl(mediaTemplate, segNumber));
    const concat = concatInitAndSegment(initSegment, raw);
    const pcm = await decodeSegment(concat);
    return rmsDb(pcm);
  } catch {
    return -Infinity;
  }
}

/**
 * Scan forward from `from` in coarse steps to find the first segment above
 * deadZoneDb. Returns the coarse candidate segment, or null if not found.
 */
async function coarseScanForward(
  initSegment: Buffer,
  mediaTemplate: string,
  from: number,
  deadZoneDb: number,
  label: string,
): Promise<number | null> {
  for (let seg = from; seg <= from + PROBE_MAX_FORWARD; seg += PROBE_COARSE_STEP) {
    const db = await probeSegment(initSegment, mediaTemplate, seg);
    process.stdout.write(`\r[${label}] Probing start... seg ${seg} (${(seg * SEGMENT_DURATION_S / 60).toFixed(1)} min) ${db.toFixed(1)} dB    `);
    if (db > deadZoneDb) {
      return seg;
    }
  }
  return null;
}

/**
 * Scan backward from `from` in coarse steps to find the last segment above
 * deadZoneDb. Returns the coarse candidate, or null if not found.
 */
async function coarseScanBackward(
  initSegment: Buffer,
  mediaTemplate: string,
  from: number,
  deadZoneDb: number,
  label: string,
): Promise<number | null> {
  for (let seg = from; seg >= 1; seg -= PROBE_COARSE_STEP) {
    const db = await probeSegment(initSegment, mediaTemplate, seg);
    process.stdout.write(`\r[${label}] Probing end... seg ${seg} (${(seg * SEGMENT_DURATION_S / 60).toFixed(1)} min) ${db.toFixed(1)} dB    `);
    if (db > deadZoneDb) {
      return seg;
    }
  }
  return null;
}

/**
 * Fine scan forward from `from`, require PROBE_CONFIRM_COUNT consecutive
 * above-threshold segments. Returns the first confirmed segment.
 */
async function fineScanForward(
  initSegment: Buffer,
  mediaTemplate: string,
  from: number,
  deadZoneDb: number,
  label: string,
): Promise<number> {
  let consecutive = 0;
  let candidate = from;
  for (let seg = Math.max(1, from - PROBE_COARSE_STEP); ; seg++) {
    const db = await probeSegment(initSegment, mediaTemplate, seg);
    process.stdout.write(`\r[${label}] Fine scan start... seg ${seg} ${db.toFixed(1)} dB    `);
    if (db > deadZoneDb) {
      if (consecutive === 0) candidate = seg;
      consecutive++;
      if (consecutive >= PROBE_CONFIRM_COUNT) {
        process.stdout.write("\n");
        return candidate;
      }
    } else {
      consecutive = 0;
    }
    // Safety: don't scan past the original coarse hit + one step
    if (seg > from + PROBE_COARSE_STEP) {
      process.stdout.write("\n");
      return candidate;
    }
  }
}

/**
 * Fine scan backward from `from`, require PROBE_CONFIRM_COUNT consecutive
 * above-threshold segments. Returns the last confirmed segment.
 */
async function fineScanBackward(
  initSegment: Buffer,
  mediaTemplate: string,
  from: number,
  deadZoneDb: number,
  label: string,
): Promise<number> {
  let consecutive = 0;
  let candidate = from;
  for (let seg = Math.min(from + PROBE_COARSE_STEP, from + 20); seg >= 1; seg--) {
    const db = await probeSegment(initSegment, mediaTemplate, seg);
    process.stdout.write(`\r[${label}] Fine scan end... seg ${seg} ${db.toFixed(1)} dB    `);
    if (db > deadZoneDb) {
      if (consecutive === 0) candidate = seg;
      consecutive++;
      if (consecutive >= PROBE_CONFIRM_COUNT) {
        process.stdout.write("\n");
        return candidate;
      }
    } else {
      consecutive = 0;
      candidate = seg - 1; // reset: last good candidate is before this run
    }
    if (seg < from - PROBE_COARSE_STEP) {
      process.stdout.write("\n");
      return candidate;
    }
  }
  process.stdout.write("\n");
  return candidate;
}

interface ProbedBounds {
  startSegment: number;
  endSegment: number | null;
}

/**
 * Probe one driver's stream to find the real audio start/end,
 * skipping dead-zone filler at the boundaries.
 *
 * Auto-skip is constrained within any user-specified --start-min / --end-min.
 */
async function probeStreamBounds(
  tokens: Tokens,
  player: MvPlayer,
  args: CollectArgs,
): Promise<ProbedBounds> {
  const tla = player.driverData.tla;
  const { contentId, channelId } = player.streamData;

  const streamUrl = await fetchStreamUrl(tokens, contentId, channelId);
  const manifest = await fetchManifest(streamUrl);
  const initSegment = await downloadInit(manifest.initUrl);

  const userStartSeg = Math.floor((args.startMin * 60) / SEGMENT_DURATION_S) + 1;
  const userEndSeg = args.endMin !== null
    ? Math.floor((args.endMin * 60) / SEGMENT_DURATION_S)
    : null;

  console.log(`[auto-skip] Probing stream bounds using ${tla}...`);

  // --- Find start ---
  let startSegment = userStartSeg;
  const coarseStart = await coarseScanForward(
    initSegment, manifest.mediaTemplate, userStartSeg, args.deadZoneDb, "auto-skip",
  );
  if (coarseStart === null) {
    console.log(`\n[auto-skip] Warning: no real audio found in first ${PROBE_MAX_FORWARD} segments from seg ${userStartSeg}. Using user start.`);
  } else {
    startSegment = await fineScanForward(
      initSegment, manifest.mediaTemplate, coarseStart, args.deadZoneDb, "auto-skip",
    );
    const startMin = (startSegment * SEGMENT_DURATION_S / 60).toFixed(1);
    console.log(`[auto-skip] Race audio starts at segment ${startSegment} (~${startMin} min into stream)`);
  }

  // --- Find end ---
  let endSegment: number | null = userEndSeg;

  // Only probe for end if --end-min wasn't explicitly set
  if (userEndSeg === null) {
    console.log(`[auto-skip] Finding last stream segment...`);
    const lastSeg = await findLastSegment(manifest.mediaTemplate, startSegment + 400);
    const lastMin = (lastSeg * SEGMENT_DURATION_S / 60).toFixed(1);
    console.log(`[auto-skip] Last segment: ${lastSeg} (~${lastMin} min)`);

    const coarseEnd = await coarseScanBackward(
      initSegment, manifest.mediaTemplate, lastSeg, args.deadZoneDb, "auto-skip",
    );
    if (coarseEnd === null) {
      console.log(`\n[auto-skip] Warning: no real audio found scanning backward from seg ${lastSeg}. No end limit set.`);
    } else {
      endSegment = await fineScanBackward(
        initSegment, manifest.mediaTemplate, coarseEnd, args.deadZoneDb, "auto-skip",
      );
      const endMin = (endSegment * SEGMENT_DURATION_S / 60).toFixed(1);
      console.log(`[auto-skip] Race audio ends at segment ${endSegment} (~${endMin} min into stream)`);
    }
  }

  const startMin = (startSegment * SEGMENT_DURATION_S / 60).toFixed(1);
  const endMin = endSegment !== null ? (endSegment * SEGMENT_DURATION_S / 60).toFixed(1) : "stream end";
  console.log(`[auto-skip] Collection range: segments ${startSegment}-${endSegment ?? "∞"} (~${startMin}-${endMin} min)`);

  return { startSegment, endSegment };
}

// ---- Per-driver collect loop -----------------------------------------------

interface CollectResult {
  tla: string;
  total: number;
  kept: number;
  skipped: number;
  errors: number;
  stoppedEarly: boolean; // true if stopped by --max-minutes
  retired: boolean;      // true if stopped by --retire-after consecutive silence
  outPath: string;
  durationSaved: number; // seconds
  wallTimeMs: number;
}

// Override start/end segments (e.g. from auto-skip probe). Null means use args.
interface SegmentBoundsOverride {
  startSegment: number | null;
  endSegment: number | null;
}

// Global cleanup registry so SIGINT can close open fds across all drivers.
const openFds = new Map<string, number>();

async function collectDriver(
  tokens: Tokens,
  player: MvPlayer,
  args: CollectArgs,
  boundsOverride: SegmentBoundsOverride = { startSegment: null, endSegment: null },
): Promise<CollectResult> {
  const tla = player.driverData.tla;
  const { contentId, channelId } = player.streamData;

  const streamUrl = await fetchStreamUrl(tokens, contentId, channelId);
  const manifest: DashManifest = await fetchManifest(streamUrl);
  const initSegment = await downloadInit(manifest.initUrl);

  const startSegment = boundsOverride.startSegment
    ?? (Math.floor((args.startMin * 60) / SEGMENT_DURATION_S) + 1);
  // --length takes precedence over --end-min. --end-min is absolute from stream start.
  // boundsOverride.endSegment comes from auto-skip and is used when neither --length nor --end-min is set.
  const endSegment = args.length !== null
    ? startSegment + args.length - 1
    : args.endMin !== null
      ? Math.floor((args.endMin * 60) / SEGMENT_DURATION_S)
      : boundsOverride.endSegment ?? null;
  const maxSavedSamples = args.maxMinutes !== null ? args.maxMinutes * 60 : null;

  const outPath = path.join(args.outDir, `noise_${tla}.raw`);
  const outFd = fs.openSync(outPath, "a");
  openFds.set(tla, outFd);

  let total = 0;
  let kept = 0;
  let skipped = 0;
  let errors = 0;
  let stoppedEarly = false;
  let retired = false;
  let consecutiveSilent = 0;
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

    // OBC-off check: decode raw first (cheap), look for the repeating idle tone.
    // This runs before the expensive denoise decode and saves an FFmpeg call.
    let rawPcmForCheck: Buffer;
    try {
      rawPcmForCheck = await withRetry(
        () => decodeSegmentRaw(concatBuffer),
        `[${tla} seg ${segmentNumber}] raw decode (obc check)`,
        2,
        200,
      );
    } catch (err) {
      errors++;
      console.log(`[${tla}  ${label}] raw decode error — ${err instanceof Error ? err.message : String(err)} — skipping`);
      segmentNumber++;
      continue;
    }

    if (isObcOffLoop(rawPcmForCheck)) {
      skipped++;
      console.log(`[${tla}  ${label}] OBC-off loop detected — stopping`);
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
      // rawPcmForCheck was already decoded above for the OBC-off check — reuse it.
      fs.writeSync(outFd, rawPcmForCheck);
      kept++;
      consecutiveSilent++;
      const keptMin = ((savedDurationS + kept * SEGMENT_DURATION_S) / 60).toFixed(1);
      console.log(`[${tla}  ${label}] ${dbStr} — NOISE  (saved | ${keptMin} min total)`);

      // Retirement detection: N consecutive below-threshold segments suggests car stopped.
      if (args.retireAfter !== null && consecutiveSilent >= args.retireAfter) {
        retired = true;
        console.log(
          `[${tla}] ${consecutiveSilent} consecutive silent segments — likely retired. Stopping.`,
        );
        segmentNumber++;
        break;
      }
    } else {
      consecutiveSilent = 0; // Reset on any speech segment.
      skipped++;
      console.log(`[${tla}  ${label}] ${dbStr} — SPEECH (skipped)`);
    }

    segmentNumber++;
  }

  fs.closeSync(outFd);
  openFds.delete(tla);

  const durationSaved = kept * SEGMENT_DURATION_S;
  const wallTimeMs = Date.now() - startTime;
  return { tla, total, kept, skipped, errors, stoppedEarly, retired, outPath, durationSaved, wallTimeMs };
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

  // Build the driver list from MultiViewer OBC players.
  const players = await fetchPlayers();
  const obcPlayers = players.filter((p) => p.streamData.contentId && p.streamData.channelId);

  if (obcPlayers.length === 0) {
    console.error("No OBC players found in MultiViewer. Open some OBC streams first.");
    process.exit(1);
  }

  // Randomly select N drivers
  const shuffled = [...obcPlayers].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(args.numDrivers, shuffled.length));

  console.log(
    `Selected ${selected.length} driver(s): ${selected.map((p) => p.driverData.driverNumber ? `${p.driverData.tla} #${p.driverData.driverNumber}` : p.driverData.tla).join(", ")}`,
  );
  if (args.maxMinutes !== null) {
    console.log(`Max noise to save per driver: ${args.maxMinutes} min`);
  }

  // Ensure output directory exists
  await fsPromises.mkdir(args.outDir, { recursive: true });

  // Auto-skip: probe stream boundaries before launching all drivers.
  let boundsOverride: SegmentBoundsOverride = { startSegment: null, endSegment: null };
  if (args.autoSkip && args.length === null) {
    // Try each driver in order until one produces a usable probe result.
    for (const probePlayer of selected) {
      try {
        const probed = await probeStreamBounds(tokens, probePlayer, args);
        boundsOverride = { startSegment: probed.startSegment, endSegment: probed.endSegment };
        break;
      } catch (err) {
        console.warn(
          `[auto-skip] Probe failed for ${probePlayer.driverData.tla}: ${err instanceof Error ? err.message : String(err)}. Trying next driver...`,
        );
      }
    }
  } else if (!args.autoSkip) {
    console.log("[auto-skip] Disabled via --no-auto-skip");
  } else if (args.length !== null) {
    console.log("[auto-skip] Skipped (--length overrides segment range)");
  }

  const wallStart = Date.now();

  // Run all drivers concurrently
  const results = await Promise.all(
    selected.map((player) => collectDriver(tokens, player, args, boundsOverride)),
  );

  const totalWallMs = Date.now() - wallStart;

  // Summary
  console.log("\n--- Collection Summary ---");
  if (args.autoSkip && boundsOverride.startSegment !== null) {
    const startMin = (boundsOverride.startSegment * SEGMENT_DURATION_S / 60).toFixed(1);
    const endMin = boundsOverride.endSegment !== null
      ? (boundsOverride.endSegment * SEGMENT_DURATION_S / 60).toFixed(1)
      : "stream end";
    console.log(`Auto-skip range: segs ${boundsOverride.startSegment}-${boundsOverride.endSegment ?? "∞"} (~${startMin}-${endMin} min)`);
  }
  for (const r of results) {
    const mins = (r.durationSaved / 60).toFixed(1);
    const stat = await fsPromises.stat(r.outPath).catch(() => null);
    const sizeMb = stat ? (stat.size / 1_048_576).toFixed(1) : "?";
    const noiseRatio = r.total > 0 ? ((r.kept / r.total) * 100).toFixed(0) : "0";
    const wallSec = (r.wallTimeMs / 1000).toFixed(0);
    const earlyTag = r.stoppedEarly ? " [max-minutes reached]" : r.retired ? " [retired]" : "";
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
  console.log("  Play a file:  ffplay -f s16le -ar 48000 -ch_layout mono training-data/noise_<TLA>.raw");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
