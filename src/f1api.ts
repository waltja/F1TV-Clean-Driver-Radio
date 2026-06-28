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
