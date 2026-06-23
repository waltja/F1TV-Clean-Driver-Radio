import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { decodeMp3Raw } from "./audio.js";
import { MV_GRAPHQL_ENDPOINT } from "./types.js";

// ---- CLI arg parsing -------------------------------------------------------

interface SpeechArgs {
  outDir: string;
  outFile: string;
  drivers: Set<string> | null; // null = all drivers
  concurrency: number;
}

function parseArgs(): SpeechArgs {
  const argv = process.argv.slice(2);
  const args: SpeechArgs = {
    outDir: "./training-data",
    outFile: "signal_radio.raw",
    drivers: null,
    concurrency: 5,
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
    }
  }

  return args;
}

// ---- MV GraphQL query ------------------------------------------------------

interface TeamRadioCapture {
  Utc: string;
  RacingNumber: string;
  Path: string;
}

interface TeamRadioData {
  Captures: TeamRadioCapture[];
}

interface SessionInfo {
  Path: string;
}

interface F1LiveTimingState {
  TeamRadio: TeamRadioData | null;
  SessionInfo: SessionInfo | null;
}

interface TimingGraphQLResponse {
  data?: { f1LiveTimingState: F1LiveTimingState | null };
  errors?: Array<{ message: string }>;
}

const TIMING_QUERY = `
  query {
    f1LiveTimingState {
      SessionInfo {
        Path
      }
      TeamRadio {
        Captures {
          Utc
          RacingNumber
          Path
        }
      }
    }
  }
`;

// Also query DriverList so we can map RacingNumber -> TLA for display.
interface DriverInfo {
  RacingNumber: string;
  Tla: string;
  FullName: string;
}

interface DriverListState {
  data?: { f1LiveTimingState: { DriverList: Record<string, DriverInfo> | null } | null };
  errors?: Array<{ message: string }>;
}

const DRIVER_QUERY = `
  query {
    f1LiveTimingState {
      DriverList
    }
  }
`;

async function fetchTimingState(): Promise<{ sessionPath: string; captures: TeamRadioCapture[] }> {
  let res: Response;
  try {
    res = await fetch(MV_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: TIMING_QUERY }),
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause as NodeJS.ErrnoException | undefined) : undefined;
    if (cause?.code === "ECONNREFUSED") {
      throw new Error(`Connection refused — is MultiViewer running at ${MV_GRAPHQL_ENDPOINT}?`);
    }
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from MV GraphQL`);
  }

  const json = (await res.json()) as TimingGraphQLResponse;

  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const state = json.data?.f1LiveTimingState;
  if (!state) {
    throw new Error(
      "f1LiveTimingState is null — open the MultiViewer live timing page and scrub the replay to the end first.",
    );
  }

  const sessionPath = state.SessionInfo?.Path;
  if (!sessionPath) {
    throw new Error(
      "SessionInfo.Path is missing — open the MultiViewer live timing page and scrub the replay to the end first.",
    );
  }

  const captures = state.TeamRadio?.Captures ?? [];
  if (captures.length === 0) {
    throw new Error(
      "TeamRadio.Captures is empty — scrub the MV replay to the end so all radio messages load, then retry.",
    );
  }

  return { sessionPath, captures };
}

async function fetchDriverMap(): Promise<Map<string, string>> {
  const tlaMap = new Map<string, string>();
  try {
    const res = await fetch(MV_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: DRIVER_QUERY }),
    });
    if (!res.ok) return tlaMap;
    const json = (await res.json()) as DriverListState;
    const driverList = json.data?.f1LiveTimingState?.DriverList;
    if (driverList) {
      for (const [, info] of Object.entries(driverList)) {
        if (info.RacingNumber && info.Tla) {
          tlaMap.set(info.RacingNumber, info.Tla);
        }
      }
    }
  } catch {
    // Non-fatal — display falls back to racing number.
  }
  return tlaMap;
}

// ---- Download + decode worker ----------------------------------------------

const LIVETIMING_BASE = "https://livetiming.formula1.com/static/";

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

  console.log("Querying MultiViewer for TeamRadio captures...");
  const [{ sessionPath, captures }, driverMap] = await Promise.all([
    fetchTimingState(),
    fetchDriverMap(),
  ]);

  console.log(`Session: ${sessionPath}`);
  console.log(`Total captures found: ${captures.length}`);

  // Filter by driver if requested.
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
    console.log(`Filtered to ${filtered.length} captures for drivers: ${[...args.drivers].join(", ")}`);
  }

  await fsPromises.mkdir(args.outDir, { recursive: true });

  const outPath = path.join(args.outDir, args.outFile);
  const outFd = fs.openSync(outPath, "a");

  // Compute already-saved duration for display.
  let existingS = 0;
  try {
    const stat = await fsPromises.stat(outPath);
    existingS = stat.size / (2 * 48000);
  } catch { /* new file */ }

  console.log(`Output: ${outPath}${existingS > 0 ? ` (${(existingS / 60).toFixed(1)} min already saved)` : ""}`);
  console.log(`Downloading ${filtered.length} clips (concurrency: ${args.concurrency})...\n`);

  let completed = 0;

  const tasks = filtered.map((capture) => async (): Promise<ClipResult> => {
    const tla = driverMap.get(capture.RacingNumber) ?? `#${capture.RacingNumber}`;
    // sessionPath from MV already has trailing slash in known formats, but guard either way.
    const normalizedSession = sessionPath.endsWith("/") ? sessionPath : `${sessionPath}/`;
    const capturePath = capture.Path.startsWith("/") ? capture.Path.slice(1) : capture.Path;
    const url = `${LIVETIMING_BASE}${normalizedSession}${capturePath}`;
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
