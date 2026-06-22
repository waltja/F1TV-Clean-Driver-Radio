import type { MvPlayer } from "./types.js";
import { MV_GRAPHQL_ENDPOINT, SEGMENT_DURATION_S, SEEK_THRESHOLD_S } from "./types.js";

interface GraphQLResponse {
  data?: { players: MvPlayer[] | null };
  errors?: Array<{ message: string }>;
}

const MV_QUERY = `
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
  }
`;

export async function fetchPlayers(): Promise<MvPlayer[]> {
  let res: Response;
  try {
    res = await fetch(MV_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: MV_QUERY }),
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause as NodeJS.ErrnoException | undefined) : undefined;
    if (cause?.code === "ECONNREFUSED") {
      throw new Error(`fetchPlayers: connection refused — is MultiViewer running at ${MV_GRAPHQL_ENDPOINT}?`);
    }
    throw new Error(
      `fetchPlayers: network error contacting ${MV_GRAPHQL_ENDPOINT}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new Error(`fetchPlayers: HTTP ${res.status} from ${MV_GRAPHQL_ENDPOINT}`);
  }

  const json = (await res.json()) as GraphQLResponse;

  if (json.errors && json.errors.length > 0) {
    throw new Error(`fetchPlayers: GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  return json.data?.players ?? [];
}

export function segmentNumberForTime(interpolatedCurrentTime: number): number {
  if (!Number.isFinite(interpolatedCurrentTime) || interpolatedCurrentTime < 0) {
    return 1;
  }
  return Math.floor(interpolatedCurrentTime / SEGMENT_DURATION_S) + 1;
}

export function isSeek(previousTime: number, currentTime: number, elapsedMs: number): boolean {
  return Math.abs(currentTime - (previousTime + elapsedMs / 1000)) > SEEK_THRESHOLD_S;
}
