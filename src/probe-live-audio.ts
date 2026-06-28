import process from "node:process";
import { ask } from "./auth.js";
import { MV_GRAPHQL_ENDPOINT, type MvPlayer } from "./types.js";

interface GraphQlEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface LiveTimingAudioStream {
  Type?: string;
  Name: string;
  Language: string;
  Uri: string;
  Path?: string;
  Utc?: string;
}

interface LiveTimingTeamRadioCapture {
  Utc: string;
  RacingNumber: string;
  Path: string;
}

interface LiveTimingDriver {
  RacingNumber: string;
  Tla: string;
  FullName: string;
  TeamName: string;
}

interface LiveTimingState {
  SessionInfo: {
    Path: string;
    Name: string;
    Type: string;
  } | null;
  AudioStreams: {
    Streams?: LiveTimingAudioStream[];
  } | null;
  ContentStreams: {
    Streams?: LiveTimingAudioStream[];
  } | null;
  TeamRadio: {
    Captures?: LiveTimingTeamRadioCapture[];
  } | null;
  DriverList: Record<string, LiveTimingDriver> | null;
}

interface LiveTimingClock {
  paused: boolean;
  systemTime: string;
  trackTime: string;
  liveTimingStartTime: string;
}

interface ProbeResponse {
  players: MvPlayer[];
  f1LiveTimingClock: LiveTimingClock | null;
  f1LiveTimingState: LiveTimingState | null;
}

interface Selection {
  source: "obc" | "driver";
  tla: string;
  driverNumber?: number;
  player?: MvPlayer;
}

function matchesRadioHint(value: string | undefined, tla: string, driverNumber: number | undefined): boolean {
  if (!value) return false;
  const upper = value.toUpperCase();
  return upper.includes("RADIO") || upper.includes("TEAM") || upper.includes(tla.toUpperCase()) ||
    (driverNumber != null && upper.includes(String(driverNumber)));
}

const PROBE_QUERY = `
  query {
    players {
      id
      type
      state {
        interpolatedCurrentTime
        paused
        live
      }
      streamData {
        contentId
        channelId
      }
      driverData {
        tla
        driverNumber
        teamName
      }
    }
    f1LiveTimingClock {
      paused
      systemTime
      trackTime
      liveTimingStartTime
    }
    f1LiveTimingState {
      SessionInfo
      AudioStreams
      TeamRadio
      DriverList
    }
  }
`;

async function fetchProbeData(): Promise<ProbeResponse> {
  const response = await fetch(MV_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: PROBE_QUERY }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL probe failed: HTTP ${response.status} from ${MV_GRAPHQL_ENDPOINT}`);
  }

  const json = (await response.json()) as GraphQlEnvelope<ProbeResponse>;
  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join("; "));
  }
  if (!json.data) {
    throw new Error("GraphQL probe returned no data");
  }
  return json.data;
}

function formatPlayer(player: MvPlayer): string {
  return `${player.driverData.tla} #${player.driverData.driverNumber} ${player.driverData.teamName} ` +
    `(player=${player.id}, content=${player.streamData.contentId}, channel=${player.streamData.channelId}, ` +
    `time=${player.state.interpolatedCurrentTime.toFixed(2)}s, paused=${player.state.paused}, live=${player.state.live})`;
}

function getDriverByTla(driverList: Record<string, LiveTimingDriver> | null, tla: string): LiveTimingDriver | undefined {
  if (!driverList) return undefined;
  return Object.values(driverList).find((driver) => driver.Tla.toUpperCase() === tla.toUpperCase());
}

function buildTeamRadioUrl(sessionPath: string, capturePath: string): string {
  return `https://livetiming.formula1.com/static/${sessionPath}${capturePath}`;
}

function printPlayerGroup(title: string, players: MvPlayer[]): void {
  if (players.length === 0) {
    console.log(`${title}: none`);
    return;
  }
  console.log(`${title}:`);
  for (const player of players) {
    console.log(`- ${formatPlayer(player)}`);
  }
}

function printStreamCandidates(streams: LiveTimingAudioStream[], selection: Selection): void {
  const candidates = streams.filter((stream) => (
    matchesRadioHint(stream.Type, selection.tla, selection.driverNumber) ||
    matchesRadioHint(stream.Name, selection.tla, selection.driverNumber) ||
    matchesRadioHint(stream.Uri, selection.tla, selection.driverNumber) ||
    matchesRadioHint(stream.Path, selection.tla, selection.driverNumber)
  ));

  if (candidates.length === 0) {
    console.log(`No continuous stream candidates matched ${selection.tla}.`);
    return;
  }

  console.log(`Continuous stream candidates for ${selection.tla}:`);
  for (const stream of candidates) {
    console.log(`- ${(stream.Type ?? "unknown")} ${stream.Name} [${stream.Language}]`);
    console.log(`  Uri: ${stream.Uri}`);
    if (stream.Path) {
      console.log(`  Path: ${stream.Path}`);
    }
  }
}

function summarizeSync(player: MvPlayer | undefined, clock: LiveTimingClock | null): string {
  if (!player) {
    return "No OBC selected, so OBC sync feasibility was not checked.";
  }
  if (!clock) {
    return "Live timing clock unavailable, so sync feasibility could not be estimated.";
  }

  const systemTimeMs = Number(clock.systemTime);
  const trackTimeMs = Number(clock.trackTime);
  if (!Number.isFinite(systemTimeMs) || !Number.isFinite(trackTimeMs)) {
    return "Live timing clock values were not numeric.";
  }

  const liveEdgeOffsetS = (systemTimeMs - trackTimeMs) / 1000;
  return `Selected OBC is ${player.state.interpolatedCurrentTime.toFixed(2)}s into its stream. ` +
    `Live timing is ${liveEdgeOffsetS.toFixed(2)}s behind wall clock. ` +
    `Continuous live commentary can likely be aligned near the live edge; team radio clips can only be scheduled by capture Utc.`;
}

async function chooseSelection(players: MvPlayer[], driverList: Record<string, LiveTimingDriver> | null): Promise<Selection> {
  const obcPlayers = players.filter((player) => player.type === "OBC" && player.driverData != null);

  if (obcPlayers.length > 0) {
    console.log("Open OBC players:");
    for (const [index, player] of obcPlayers.entries()) {
      console.log(`${index + 1}. ${formatPlayer(player)}`);
    }
    const answer = (await ask("Select OBC number, or type a driver TLA: ")).trim().toUpperCase();
    const index = Number.parseInt(answer, 10);
    if (!Number.isNaN(index) && index >= 1 && index <= obcPlayers.length) {
      const player = obcPlayers[index - 1];
      return {
        source: "obc",
        tla: player.driverData.tla,
        driverNumber: player.driverData.driverNumber,
        player,
      };
    }
    const driver = getDriverByTla(driverList, answer);
    if (driver) {
      const matchingPlayer = obcPlayers.find((player) => player.driverData.tla === driver.Tla);
      return {
        source: matchingPlayer ? "obc" : "driver",
        tla: driver.Tla,
        driverNumber: Number(driver.RacingNumber),
        player: matchingPlayer,
      };
    }
    throw new Error(`Unknown selection: ${answer}`);
  }

  if (!driverList) {
    throw new Error("No OBC players open and no DriverList available from live timing.");
  }

  const drivers = Object.values(driverList).sort((a, b) => a.Tla.localeCompare(b.Tla));
  console.log("Available drivers:");
  for (const driver of drivers) {
    console.log(`${driver.Tla} #${driver.RacingNumber} ${driver.FullName} ${driver.TeamName}`);
  }
  const answer = (await ask("Select driver TLA: ")).trim().toUpperCase();
  const driver = getDriverByTla(driverList, answer);
  if (!driver) {
    throw new Error(`Unknown driver TLA: ${answer}`);
  }
  return {
    source: "driver",
    tla: driver.Tla,
    driverNumber: Number(driver.RacingNumber),
  };
}

async function main(): Promise<void> {
  const probe = await fetchProbeData();
  const selection = await chooseSelection(probe.players, probe.f1LiveTimingState?.DriverList ?? null);
  const sessionInfo = probe.f1LiveTimingState?.SessionInfo;
  const audioStreams = probe.f1LiveTimingState?.AudioStreams?.Streams ?? [];
  const contentStreams = probe.f1LiveTimingState?.ContentStreams?.Streams ?? [];
  const captures = probe.f1LiveTimingState?.TeamRadio?.Captures ?? [];
  const matchingCaptures = selection.driverNumber == null
    ? []
    : captures.filter((capture) => Number(capture.RacingNumber) === selection.driverNumber);
  const obcPlayers = probe.players.filter((player) => player.type === "OBC");
  const additionalPlayers = probe.players.filter((player) => player.type === "ADDITIONAL");

  console.log("");
  console.log(`Selection: ${selection.tla}${selection.driverNumber == null ? "" : ` #${selection.driverNumber}`} (${selection.source})`);
  if (sessionInfo) {
    console.log(`Session: ${sessionInfo.Name} ${sessionInfo.Type}`);
    console.log(`Session path: ${sessionInfo.Path}`);
  }

  console.log("");
  printPlayerGroup("Open OBC players", obcPlayers);
  printPlayerGroup("Open ADDITIONAL players", additionalPlayers);

  console.log("");
  if (audioStreams.length === 0) {
    console.log("No live AudioStreams exposed by f1LiveTimingState.");
  } else {
    console.log("Live AudioStreams:");
    for (const stream of audioStreams) {
      console.log(`- ${(stream.Type ?? "Audio")} ${stream.Name} [${stream.Language}]`);
      console.log(`  Uri: ${stream.Uri}`);
      if (stream.Path) {
        console.log(`  Path: ${stream.Path}`);
      }
    }
  }

  console.log("");
  if (contentStreams.length === 0) {
    console.log("No ContentStreams exposed by f1LiveTimingState.");
  } else {
    console.log("All ContentStreams:");
    for (const stream of contentStreams) {
      console.log(`- ${(stream.Type ?? "unknown")} ${stream.Name} [${stream.Language}]`);
      console.log(`  Uri: ${stream.Uri}`);
      if (stream.Path) {
        console.log(`  Path: ${stream.Path}`);
      }
    }
  }

  console.log("");
  printStreamCandidates([...audioStreams, ...contentStreams], selection);

  console.log("");
  if (!sessionInfo) {
    console.log("SessionInfo unavailable, so TeamRadio URLs cannot be resolved.");
  } else if (matchingCaptures.length === 0) {
    console.log(`No TeamRadio captures currently exposed for ${selection.tla}.`);
  } else {
    console.log(`TeamRadio captures for ${selection.tla}:`);
    for (const capture of matchingCaptures.slice(-5)) {
      console.log(`- ${capture.Utc}`);
      console.log(`  ${buildTeamRadioUrl(sessionInfo.Path, capture.Path)}`);
    }
  }

  console.log("");
  console.log(summarizeSync(selection.player, probe.f1LiveTimingClock));

  console.log("");
  console.log("Feasibility summary:");
  console.log(`- Open OBC selection works: ${probe.players.some((player) => player.type === "OBC")}`);
  console.log(`- Driver TLA selection works: ${probe.f1LiveTimingState?.DriverList != null}`);
  console.log(`- Continuous live audio endpoint present: ${audioStreams.length > 0}`);
  console.log(`- Continuous per-driver live audio endpoint present: false`);
  console.log(`- TeamRadio clip endpoint present: ${matchingCaptures.length > 0}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
