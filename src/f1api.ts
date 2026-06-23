import type { Tokens } from "./types.js";

const ENTITLEMENT_URL =
  "https://f1tv.formula1.com/2.0/R/ENG/WEB_DASH/ALL/USER/ENTITLEMENT";
const PLAY_URL_BASE =
  "https://f1tv.formula1.com/2.0/R/ENG/BIG_SCREEN_HLS/ALL/CONTENT/PLAY";

// Content discovery — no entitlement token required for browse/metadata endpoints.
const PAGE_URL_BASE =
  "https://f1tv.formula1.com/2.0/R/ENG/WEB_DASH/ALL/PAGE";
const CONTENT_DETAILS_BASE =
  "https://f1tv.formula1.com/3.0/R/ENG/BIG_SCREEN_HLS/ALL/CONTENT/VIDEO";
const CONTENT_ENTITLEMENT = "F1_TV_Pro_Annual";

// PAGE IDs that serve as season entry points.
// CURRENT_SEASON_PAGE_ID: the dedicated season calendar page for the current year.
// Update this once per year when F1TV creates the new season page.
const CURRENT_SEASON_PAGE_ID = 12343; // 2026 season
const ARCHIVE_PAGE_ID = 493; // past seasons hub (LAUNCHER entries link to per-season pages)

interface EntitlementResponse {
  resultObj: { entitlementToken: string };
}

interface PlayResponse {
  resultObj: { url: string };
}

export async function fetchEntitlementToken(ascendonToken: string): Promise<string> {
  const res = await fetch(ENTITLEMENT_URL, {
    method: "GET",
    headers: { ascendontoken: ascendonToken },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`fetchEntitlementToken: HTTP ${res.status} — ascendon token may be expired`);
  }
  if (!res.ok) {
    throw new Error(`fetchEntitlementToken: HTTP ${res.status} from ${ENTITLEMENT_URL}`);
  }

  const json = (await res.json()) as EntitlementResponse;
  if (!json.resultObj?.entitlementToken) {
    throw new Error("fetchEntitlementToken: missing entitlementToken in response");
  }
  return json.resultObj.entitlementToken;
}

export async function fetchStreamUrl(tokens: Tokens, contentId: number, channelId: number): Promise<string> {
  const url = new URL(PLAY_URL_BASE);
  url.searchParams.set("contentId", String(contentId));
  url.searchParams.set("channelId", String(channelId));

  const res = await fetch(url, {
    method: "GET",
    headers: {
      ascendontoken: tokens.ascendonToken,
      entitlementtoken: tokens.entitlementToken,
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`fetchStreamUrl: HTTP ${res.status} — tokens may be expired`);
  }
  if (!res.ok) {
    throw new Error(`fetchStreamUrl: HTTP ${res.status} from ${url.href}`);
  }

  const json = (await res.json()) as PlayResponse;
  if (!json.resultObj?.url) {
    throw new Error("fetchStreamUrl: missing resultObj.url in response");
  }
  return json.resultObj.url;
}

// ---- Content discovery types -----------------------------------------------

export interface RaceWeekend {
  pageId: number;
  season: number;
  roundNumber: number;
  name: string;         // e.g. "Spanish Grand Prix"
  officialName: string; // e.g. "FORMULA 1 2026 PIRELLI GRAN PREMIO DE ESPAÑA"
  startDate: string;    // ISO date string
}

export interface OBCChannel {
  tla: string;
  driverNumber: number;
  channelId: number;
  teamName: string;
}

export interface RaceSession {
  contentId: number;
  channels: OBCChannel[];
}

// Internal shapes for F1TV browse API responses.

interface EmfAttributes {
  VideoType?: string;
  Meeting_Name?: string;
  Meeting_Number?: string;
  Season_Meeting_Ordinal?: number;
  Meeting_Start_Date?: string;
  Meeting_Official_Name?: string;
  PageID?: number;
  OBC?: boolean;
  SessionPeriod?: string;
  [key: string]: unknown;
}

interface ContainerMetadata {
  contentId?: number;
  contentType?: string;
  contentSubtype?: string;
  emfAttributes?: EmfAttributes;
  title?: string;
  season?: number;
  properties?: { season?: number | string; [key: string]: unknown };
  additionalStreams?: AdditionalStream[];
}

interface ContainerAction {
  uri?: string;
  targetType?: string;
}

interface ContainerItem {
  id?: string;
  metadata?: ContainerMetadata;
  containers?: ContainerItem[] | { bundles?: unknown[] };
  retrieveItems?: { resultObj?: { containers?: ContainerItem[] } };
  actions?: ContainerAction[];
  onTitleClick?: ContainerAction;
}

interface AdditionalStream {
  type?: string;
  channelId?: number;
  title?: string;
  racingNumber?: number;
  teamName?: string;
  reportingName?: string;
}

interface PageResponse {
  resultObj?: {
    containers?: ContainerItem[];
  };
}

// ---- Helper: authenticated fetch with optional ascendon token --------------

async function apiFetch(url: string, ascendonToken?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (ascendonToken) headers["ascendontoken"] = ascendonToken;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`F1TV API HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

// Recursively collect all ContainerItem objects that have metadata.
function collectContainers(items: ContainerItem[]): ContainerItem[] {
  const result: ContainerItem[] = [];
  for (const item of items) {
    if (item.metadata) result.push(item);
    // Some responses nest containers inside retrieveItems.
    const nested = item.retrieveItems?.resultObj?.containers;
    if (Array.isArray(nested)) result.push(...collectContainers(nested));
    // Also handle inline containers array.
    if (Array.isArray(item.containers)) result.push(...collectContainers(item.containers as ContainerItem[]));
  }
  return result;
}

// ---- discoverSeasonPageId --------------------------------------------------
// Finds the F1TV page ID for a given season's race calendar.
// For current year: uses CURRENT_SEASON_PAGE_ID constant as fallback.
// For past years: scans the archive hub (PAGE 493) for a LAUNCHER entry.
// Pass pageIdOverride to bypass discovery entirely (e.g. from --page flag).

async function discoverSeasonPageId(
  ascendonToken: string,
  targetSeason: number,
  debug?: boolean,
  pageIdOverride?: number,
): Promise<number | null> {
  if (pageIdOverride !== undefined) {
    if (debug) process.stderr.write(`[debug] using --page override: ${pageIdOverride}\n`);
    return pageIdOverride;
  }

  const currentYear = new Date().getFullYear();

  if (targetSeason === currentYear) {
    if (debug) process.stderr.write(`[debug] current season -- using CURRENT_SEASON_PAGE_ID: ${CURRENT_SEASON_PAGE_ID}\n`);
    return CURRENT_SEASON_PAGE_ID;
  }

  // For past seasons: scan the archive hub for a LAUNCHER whose URI contains the target year.
  const archiveUrl = `${PAGE_URL_BASE}/${ARCHIVE_PAGE_ID}/${CONTENT_ENTITLEMENT}/2`;
  if (debug) process.stderr.write(`[debug] scanning archive hub: GET ${archiveUrl}\n`);

  const json = (await apiFetch(archiveUrl, ascendonToken)) as PageResponse;
  const allContainers = collectContainers(json.resultObj?.containers ?? []);

  for (const c of allContainers) {
    const meta = c.metadata;
    if (!meta) continue;
    if (meta.contentType !== "LAUNCHER") continue;

    // LAUNCHER URI format: /PAGE/{pageId} — extract pageId and check title/year.
    const action = c.actions?.[0] ?? c.onTitleClick;
    const uri = action?.uri ?? "";
    const match = uri.match(/\/PAGE\/(\d+)/i);
    if (!match) continue;

    const pageId = Number(match[1]);
    const title = meta.title ?? "";
    // Title is typically the year as a string, e.g. "2025".
    if (title.trim() === String(targetSeason)) {
      if (debug) process.stderr.write(`[debug] found archive LAUNCHER for ${targetSeason}: page ${pageId}\n`);
      return pageId;
    }
  }

  if (debug) process.stderr.write(`[debug] no LAUNCHER found for ${targetSeason} in archive hub\n`);
  return null;
}

// ---- fetchSeasonRaceWeekends ------------------------------------------------
// Returns all race weekends (BUNDLEs with contentSubtype MEETING) for a season.
// season defaults to the current calendar year.

export async function fetchSeasonRaceWeekends(
  ascendonToken: string,
  season?: number,
  debug?: boolean,
  pageIdOverride?: number,
): Promise<RaceWeekend[]> {
  const targetSeason = season ?? new Date().getFullYear();

  const seasonPageId = await discoverSeasonPageId(ascendonToken, targetSeason, debug, pageIdOverride);
  if (seasonPageId === null) {
    if (debug) process.stderr.write(`[debug] could not find season page for ${targetSeason}\n`);
    return [];
  }

  const url = `${PAGE_URL_BASE}/${seasonPageId}/${CONTENT_ENTITLEMENT}/2`;
  if (debug) process.stderr.write(`[debug] GET ${url}\n`);

  const json = (await apiFetch(url, ascendonToken)) as PageResponse;
  const topLevel = json.resultObj?.containers ?? [];

  if (debug) process.stderr.write(`[debug] top-level containers: ${topLevel.length}\n`);

  const allContainers = collectContainers(topLevel);

  if (debug) {
    process.stderr.write(`[debug] total containers after recursive collect: ${allContainers.length}\n`);
    for (const c of allContainers) {
      const meta = c.metadata;
      if (!meta) continue;
      const emf = meta.emfAttributes ?? {};
      const seasonVal = meta.season ?? Number(meta.properties?.season) ?? emf["season"] ?? "?";
      process.stderr.write(
        `[debug]   type=${meta.contentType ?? "?"} subtype=${meta.contentSubtype ?? "?"} season=${seasonVal} pageId=${emf.PageID ?? "?"} title=${meta.title ?? ""}\n`,
      );
    }
  }

  const weekends: RaceWeekend[] = [];
  for (const c of allContainers) {
    const meta = c.metadata;
    if (!meta) continue;
    if (meta.contentType !== "BUNDLE") continue;
    if (meta.contentSubtype !== "MEETING") continue;

    const emf = meta.emfAttributes ?? {};

    // Season can be in metadata.season (2025 style) or metadata.properties.season (2026 style).
    const itemSeason = meta.season ?? Number(meta.properties?.season) ?? Number(emf["season"]);
    // For current year, season may not be populated yet — accept items where it's missing.
    const currentYear = new Date().getFullYear();
    if (itemSeason && itemSeason !== targetSeason) continue;

    const pageIdVal = emf.PageID;
    if (!pageIdVal) continue;

    // Season_Meeting_Ordinal is sometimes 0 (2026); fall back to Meeting_Number.
    const ordinal = emf.Season_Meeting_Ordinal;
    const roundNumber = (ordinal && ordinal > 0) ? ordinal : Number(emf.Meeting_Number ?? 0);

    weekends.push({
      pageId: pageIdVal,
      season: itemSeason || targetSeason,
      roundNumber,
      name: emf.Meeting_Name ?? meta.title ?? "",
      officialName: emf.Meeting_Official_Name ?? meta.title ?? "",
      startDate: emf.Meeting_Start_Date ?? "",
    });
  }

  if (debug) process.stderr.write(`[debug] matched weekends: ${weekends.length}\n`);

  // Sort by round number ascending.
  weekends.sort((a, b) => a.roundNumber - b.roundNumber);
  return weekends;
}

// ---- fetchRaceSession -------------------------------------------------------
// Given a race weekend pageId and target season, returns the Race session
// contentId (VIDEO with OBC: true + SessionPeriod "R") that matches the season.
// Returns null if the race hasn't happened yet or no matching session is found.

export async function fetchRaceSession(
  ascendonToken: string,
  raceWeekendPageId: number,
  targetSeason: number,
): Promise<number | null> {
  const url = `${PAGE_URL_BASE}/${raceWeekendPageId}/${CONTENT_ENTITLEMENT}/2`;
  const json = (await apiFetch(url, ascendonToken)) as PageResponse;
  const allContainers = collectContainers(json.resultObj?.containers ?? []);

  // Prefer: contentType VIDEO + OBC true + SessionPeriod R + matching season
  // Fallback: same but any SessionPeriod (still season-filtered)
  let fallback: number | null = null;
  for (const c of allContainers) {
    const meta = c.metadata;
    if (!meta || meta.contentType !== "VIDEO") continue;
    const emf = meta.emfAttributes ?? {};
    if (!emf.OBC) continue;
    if (!meta.contentId) continue;

    // Season can live in metadata.season or metadata.properties.season (same as BUNDLE items).
    const itemSeason = meta.season ?? Number(meta.properties?.season);
    if (itemSeason && itemSeason !== targetSeason) continue;

    if (emf.SessionPeriod === "R") return meta.contentId;
    fallback = meta.contentId;
  }
  return fallback;
}

// ---- fetchOBCChannels -------------------------------------------------------
// Given a race session contentId, returns all OBC driver channels.

export async function fetchOBCChannels(
  ascendonToken: string,
  contentId: number,
): Promise<OBCChannel[]> {
  const url = `${CONTENT_DETAILS_BASE}/${contentId}/${CONTENT_ENTITLEMENT}/14`;
  const json = (await apiFetch(url, ascendonToken)) as PageResponse;
  const allContainers = collectContainers(json.resultObj?.containers ?? []);

  for (const c of allContainers) {
    const streams = c.metadata?.additionalStreams;
    if (!Array.isArray(streams)) continue;

    const channels: OBCChannel[] = [];
    for (const s of streams) {
      if (s.type !== "obc") continue;
      if (!s.channelId) continue;

      // title is typically the TLA (e.g. "HAM"), reportingName is "HAM|44".
      const tla = (s.title ?? s.reportingName?.split("|")[0] ?? "UNK").toUpperCase();
      channels.push({
        tla,
        driverNumber: s.racingNumber ?? 0,
        channelId: s.channelId,
        teamName: s.teamName ?? "",
      });
    }

    if (channels.length > 0) return channels;
  }

  return [];
}
