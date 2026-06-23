import process from "node:process";
import { cacheToken, clearTokenCache, loadCachedToken, promptForToken } from "./auth.js";
import { fetchEntitlementToken, fetchOBCChannels, fetchRaceSession, fetchSeasonRaceWeekends } from "./f1api.js";
import type { RaceWeekend } from "./f1api.js";

// ---- CLI arg parsing -------------------------------------------------------

interface ListArgs {
  season: number | null;  // null = current year
  count: number | null;   // null = all races in season
  debug: boolean;
  page: number | null;    // override season page ID (bypasses discovery)
}

function parseArgs(): ListArgs {
  const argv = process.argv.slice(2);
  const args: ListArgs = { season: null, count: null, debug: false, page: null };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    switch (flag) {
      case "--season":
        args.season = Number(next);
        i++;
        break;
      case "--count":
        args.count = Number(next);
        i++;
        break;
      case "--debug":
        args.debug = true;
        break;
      case "--page":
        args.page = Number(next);
        i++;
        break;
      default:
        console.error(`Unknown flag: ${flag}`);
        process.exit(1);
    }
  }

  return args;
}

// ---- Formatting ------------------------------------------------------------

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const targetSeason = args.season ?? new Date().getFullYear();

  // Auth — same flow as collect-noise
  let ascendonToken: string;

  const cached = await loadCachedToken();
  if (cached) {
    try {
      // Validate cached token is still good by fetching entitlement
      await fetchEntitlementToken(cached);
      ascendonToken = cached;
    } catch {
      console.warn("Cached token invalid or expired. Re-enter.");
      await clearTokenCache();
      ascendonToken = await promptForToken();
      await fetchEntitlementToken(ascendonToken); // validate
      await cacheToken(ascendonToken);
    }
  } else {
    ascendonToken = await promptForToken();
    await fetchEntitlementToken(ascendonToken); // validate
    await cacheToken(ascendonToken);
  }

  console.log(`Fetching ${targetSeason} race calendar...`);

  let weekends: RaceWeekend[];
  try {
    weekends = await fetchSeasonRaceWeekends(ascendonToken, targetSeason, args.debug, args.page ?? undefined);
  } catch (err) {
    console.error(`Failed to fetch season: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (weekends.length === 0) {
    console.error(`No race weekends found for ${targetSeason}. The season page may use a different page ID.`);
    process.exit(1);
  }

  // Apply --count: last N races
  const selected = args.count !== null ? weekends.slice(-args.count) : weekends;

  console.log(`Found ${weekends.length} race weekends. Fetching OBC channel data for ${selected.length}...\n`);

  for (const weekend of selected) {
    process.stdout.write(`  R${weekend.roundNumber} ${weekend.name} (${formatDate(weekend.startDate)})... `);

    let contentId: number | null = null;
    try {
      contentId = await fetchRaceSession(ascendonToken, weekend.pageId);
    } catch (err) {
      console.log(`FAILED (race session): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (contentId === null) {
      console.log("no race session found");
      continue;
    }

    let channels;
    try {
      channels = await fetchOBCChannels(ascendonToken, contentId);
    } catch (err) {
      console.log(`FAILED (channels): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (channels.length === 0) {
      console.log("no OBC channels found");
      continue;
    }

    console.log(`${channels.length} drivers`);

    const channelIds = channels
      .map((c) => `${c.tla}:${c.channelId}`)
      .join(",");

    console.log(`${targetSeason} R${weekend.roundNumber} ${weekend.name}`);
    console.log(`  pnpm collect-noise --content-id ${contentId} --channel-ids ${channelIds}`);
    console.log("");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
