import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { decodeMp3Raw } from "./audio.js";
import {
  buildRadioUrl,
  fetchDriverList,
  fetchSeasonIndex,
  fetchTeamRadioCaptures,
  type LiveTimingMeeting,
  type LiveTimingSession,
} from "./livetiming.js";

// ---- CLI arg parsing -------------------------------------------------------

interface SpeechArgs {
  outDir: string;
  outFile: string;
  drivers: Set<string> | null; // null = all drivers
  concurrency: number;
  season: number;
  race: string | null;        // meeting name substring or round number as string
  sessionType: string;        // "Race", "Qualifying", "Practice 1", etc.
  sessionPath: string | null; // direct override, skips discovery
}

function parseArgs(): SpeechArgs {
  const argv = process.argv.slice(2);
  const args: SpeechArgs = {
    outDir: "./training-data",
    outFile: "signal_radio.raw",
    drivers: null,
    concurrency: 5,
    season: new Date().getFullYear(),
    race: null,
    sessionType: "Race",
    sessionPath: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    switch (flag) {
      case "--out-dir":
        args.outDir = next;
        i++;
        break;
      case "--out-file":
        args.outFile = next;
        i++;
        break;
      case "--drivers":
        args.drivers = new Set(next.toUpperCase().split(",").map((s) => s.trim()));
        i++;
        break;
      case "--concurrency":
        args.concurrency = Number(next);
        i++;
        break;
      case "--season":
        args.season = Number(next);
        i++;
        break;
      case "--race":
        args.race = next;
        i++;
        break;
      case "--session-type":
        args.sessionType = next;
        i++;
        break;
      case "--session-path":
        args.sessionPath = next;
        i++;
        break;
      default:
        console.error(`Unknown flag: ${flag}`);
        process.exit(1);
    }
  }

  return args;
}

// ---- Race / session discovery ----------------------------------------------

function printUsageHint(): void {
  console.error(
    "\nUsage: pnpm collect-speech --race <name|number> [--season YYYY] [--session-type TYPE]\n" +
    "       pnpm collect-speech --session-path <path>\n\n" +
    "Examples:\n" +
    "  pnpm collect-speech --race barcelona\n" +
    "  pnpm collect-speech --race 10 --season 2026\n" +
    "  pnpm collect-speech --race monaco --session-type Qualifying\n" +
    "  pnpm collect-speech --session-path 2026/2026-06-14_Barcelona_Grand_Prix/2026-06-14_Race/",
  );
}

function findMeeting(meetings: LiveTimingMeeting[], raceArg: string): LiveTimingMeeting {
  // Try as a round number first (1-indexed position in season array).
  const roundNum = Number(raceArg);
  if (!isNaN(roundNum) && Number.isInteger(roundNum) && roundNum >= 1) {
    if (roundNum > meetings.length) {
      throw new Error(
        `Round ${roundNum} not found — season has ${meetings.length} meetings so far.`,
      );
    }
    return meetings[roundNum - 1];
  }

  // Substring match on meeting name (case-insensitive).
  const query = raceArg.toLowerCase();
  const matches = meetings.filter((m) => m.name.toLowerCase().includes(query));

  if (matches.length === 0) {
    const names = meetings.map((m, i) => `  R${i + 1}: ${m.name}`).join("\n");
    throw new Error(`No meeting found matching "${raceArg}". Available:\n${names}`);
  }
  if (matches.length > 1) {
    const names = matches.map((m, i) => `  R${meetings.indexOf(m) + 1}: ${m.name}`).join("\n");
    throw new Error(`Multiple meetings match "${raceArg}" — be more specific:\n${names}`);
  }

  return matches[0];
}

function findSession(meeting: LiveTimingMeeting, sessionType: string): LiveTimingSession {
  // Normalize: "Race" matches session.type "Race", "Practice 1" matches "Practice 1", etc.
  const query = sessionType.toLowerCase();
  const matches = meeting.sessions.filter((s) => s.type.toLowerCase() === query);

  if (matches.length === 0) {
    const types = meeting.sessions.map((s) => `  ${s.type}`).join("\n");
    throw new Error(
      `No "${sessionType}" session found for ${meeting.name}. Available:\n${types}`,
    );
  }

  return matches[0];
}

// ---- Download + decode worker ----------------------------------------------

interface ClipResult {
  url: string;
  label: string;
  durationS: number;
  error?: string;
}

async function processClip(
  url: string,
  label: string,
  outFd: number,
): Promise<ClipResult> {
  let mp3Buffer: Buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mp3Buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { url, label, durationS: 0, error: `download: ${err instanceof Error ? err.message : String(err)}` };
  }

  let pcm: Buffer;
  try {
    pcm = await decodeMp3Raw(mp3Buffer);
  } catch (err) {
    return { url, label, durationS: 0, error: `decode: ${err instanceof Error ? err.message : String(err)}` };
  }

  fs.writeSync(outFd, pcm);
  const durationS = (pcm.length / 2) / 48000;
  return { url, label, durationS };
}

// ---- Concurrency pool ------------------------------------------------------

async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  // ---- Resolve session path ------------------------------------------------

  let sessionPath: string;

  if (args.sessionPath !== null) {
    // Direct override — skip discovery.
    sessionPath = args.sessionPath.endsWith("/")
      ? args.sessionPath
      : `${args.sessionPath}/`;
    console.log(`Session: ${sessionPath}`);
  } else {
    if (args.race === null) {
      console.error("Error: --race or --session-path is required.");
      printUsageHint();
      process.exit(1);
    }

    process.stdout.write(`Fetching ${args.season} season index... `);
    let meetings;
    try {
      meetings = await fetchSeasonIndex(args.season);
    } catch (err) {
      console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    console.log(`${meetings.length} meetings`);

    let meeting: LiveTimingMeeting;
    let session: LiveTimingSession;
    try {
      meeting = findMeeting(meetings, args.race);
      session = findSession(meeting, args.sessionType);
    } catch (err) {
      console.error(`\n${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    sessionPath = session.path;
    console.log(`Found: ${meeting.name} (${session.type}, ${session.startDate.slice(0, 10)})`);
    console.log(`Session: ${sessionPath}`);
  }

  // ---- Fetch TeamRadio captures + driver list ------------------------------

  process.stdout.write("Fetching TeamRadio captures... ");
  let captures;
  try {
    captures = await fetchTeamRadioCaptures(sessionPath);
  } catch (err) {
    console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (captures.length === 0) {
    console.error("\nNo TeamRadio captures found for this session.");
    console.error("The session may not have aired yet or data is not archived.");
    process.exit(1);
  }
  console.log(`${captures.length} clips`);

  process.stdout.write("Fetching driver list... ");
  const driverMap = await fetchDriverList(sessionPath);
  console.log(`${driverMap.size} drivers`);

  // ---- Filter by --drivers -------------------------------------------------

  const filtered = args.drivers !== null
    ? captures.filter((c) => {
        const tla = driverMap.get(c.RacingNumber) ?? c.RacingNumber;
        return args.drivers!.has(tla) || args.drivers!.has(c.RacingNumber);
      })
    : captures;

  if (filtered.length === 0) {
    console.error("No captures match the specified --drivers filter.");
    process.exit(1);
  }

  if (args.drivers !== null) {
    console.log(`Filtered to ${filtered.length} clips for drivers: ${[...args.drivers].join(", ")}`);
  }

  // ---- Output file ---------------------------------------------------------

  await fsPromises.mkdir(args.outDir, { recursive: true });

  const outPath = path.join(args.outDir, args.outFile);
  const outFd = fs.openSync(outPath, "a");

  let existingS = 0;
  try {
    const stat = await fsPromises.stat(outPath);
    existingS = stat.size / (2 * 48000);
  } catch { /* new file */ }

  console.log(`\nOutput: ${outPath}${existingS > 0 ? ` (${(existingS / 60).toFixed(1)} min already saved)` : ""}`);
  console.log(`Downloading ${filtered.length} clips (concurrency: ${args.concurrency})...\n`);

  // ---- Download + decode pool ----------------------------------------------

  let completed = 0;

  const tasks = filtered.map((capture) => async (): Promise<ClipResult> => {
    const tla = driverMap.get(capture.RacingNumber) ?? `#${capture.RacingNumber}`;
    const url = buildRadioUrl(sessionPath, capture.Path);
    const label = `${tla} @ ${capture.Utc.slice(11, 19)}`;

    const result = await processClip(url, label, outFd);
    completed++;

    if (result.error) {
      console.log(`[${completed}/${filtered.length}] ${label} — ERROR: ${result.error}`);
    } else {
      console.log(`[${completed}/${filtered.length}] ${label} — ${result.durationS.toFixed(1)}s`);
    }

    return result;
  });

  const results = await runPool(tasks, args.concurrency);

  fs.closeSync(outFd);

  // ---- Summary -------------------------------------------------------------

  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  const totalDurationS = ok.reduce((s, r) => s + r.durationS, 0);

  const stat = await fsPromises.stat(outPath).catch(() => null);
  const sizeMb = stat ? (stat.size / 1_048_576).toFixed(1) : "?";

  console.log("\n--- Summary ---");
  console.log(`Downloaded: ${ok.length}/${filtered.length} clips`);
  if (failed.length > 0) {
    console.log(`Failed:     ${failed.length} clips`);
  }
  console.log(`New audio:  ${(totalDurationS / 60).toFixed(1)} min`);
  console.log(`File:       ${outPath} (${sizeMb} MB total)`);
  console.log("\nNext steps:");
  console.log("  Concatenate signal files:  pnpm concat-signal");
  console.log("  Or manually combine with LibriSpeech:");
  console.log(`    cat training-data/signal_radio.raw path/to/librispeech_signal.raw > rnnoise-training/src/signal.raw`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
