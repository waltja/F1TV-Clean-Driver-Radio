import type { Tokens } from "./types.js";

const ENTITLEMENT_URL =
  "https://f1tv.formula1.com/2.0/R/ENG/WEB_DASH/ALL/USER/ENTITLEMENT";
const PLAY_URL_BASE =
  "https://f1tv.formula1.com/2.0/R/ENG/BIG_SCREEN_HLS/ALL/CONTENT/PLAY";

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
