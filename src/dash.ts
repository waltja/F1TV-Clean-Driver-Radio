import { XMLParser } from "fast-xml-parser";
import type { DashManifest } from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

interface ParsedSegmentTemplate {
  "@_initialization"?: string;
  "@_media"?: string;
  "@_startNumber"?: string;
}

interface ParsedRole {
  "@_value"?: string;
}

interface ParsedRepresentation {
  "@_id"?: string;
  BaseURL?: string;
  SegmentTemplate?: ParsedSegmentTemplate;
}

interface ParsedAdaptationSet {
  "@_audioTrackId"?: string;
  "@_id"?: string;
  "@_lang"?: string;
  "@_label"?: string;
  Label?: string | { "#text"?: string };
  Role?: ParsedRole | ParsedRole[] | string;
  BaseURL?: string;
  SegmentTemplate?: ParsedSegmentTemplate;
  Representation?: ParsedRepresentation | ParsedRepresentation[];
}

interface ParsedPeriod {
  BaseURL?: string;
  AdaptationSet?: ParsedAdaptationSet | ParsedAdaptationSet[];
}

interface ParsedMpdDocument {
  MPD?: {
    BaseURL?: string;
    Period?: ParsedPeriod | ParsedPeriod[];
  };
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function extractLabelValue(label: ParsedAdaptationSet["Label"]): string | undefined {
  if (typeof label === "string") return label;
  if (label && typeof label === "object" && typeof label["#text"] === "string") return label["#text"];
  return undefined;
}

function extractRoleValues(role: ParsedAdaptationSet["Role"]): string[] {
  if (role === undefined) return [];
  if (typeof role === "string") return [role];
  return toArray(role)
    .map((entry) => (typeof entry === "string" ? entry : entry["@_value"]))
    .filter((value): value is string => typeof value === "string");
}

// The 'tea' (team radio / driver OBC) AdaptationSet may be identified by any of
// several attributes depending on the manifest variant; check all known carriers.
function isTeaAdaptationSet(a: ParsedAdaptationSet): boolean {
  return (
    a["@_audioTrackId"] === "tea" ||
    a["@_id"] === "tea" ||
    a["@_lang"] === "tea" ||
    a["@_label"] === "tea" ||
    extractLabelValue(a.Label) === "tea" ||
    extractRoleValues(a.Role).includes("tea")
  );
}

function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref).href; // ref already absolute
  } catch {
    return new URL(ref, base).href;
  }
}

function resolveTemplateSource(
  periodBaseUrl: string,
  adaptationSet: ParsedAdaptationSet,
): { baseUrl: string; template: ParsedSegmentTemplate; representationId: string } | undefined {
  const adaptationBaseUrl = adaptationSet.BaseURL
    ? resolveUrl(periodBaseUrl, adaptationSet.BaseURL)
    : periodBaseUrl;

  const firstRepresentation = toArray(adaptationSet.Representation)[0];
  const representationId = firstRepresentation?.["@_id"] ?? "";

  if (adaptationSet.SegmentTemplate) {
    return { baseUrl: adaptationBaseUrl, template: adaptationSet.SegmentTemplate, representationId };
  }

  if (!firstRepresentation?.SegmentTemplate) return undefined;

  const representationBaseUrl = firstRepresentation.BaseURL
    ? resolveUrl(adaptationBaseUrl, firstRepresentation.BaseURL)
    : adaptationBaseUrl;

  return { baseUrl: representationBaseUrl, template: firstRepresentation.SegmentTemplate, representationId };
}

export async function fetchManifest(mpdUrl: string): Promise<DashManifest> {
  // console.log("[dash] fetching manifest:", mpdUrl);
  const res = await fetch(mpdUrl);
  if (!res.ok) {
    throw new Error(`fetchManifest: HTTP ${res.status} from ${mpdUrl}`);
  }
  const xml = await res.text();
  // console.log("[dash] manifest:\n", xml); // temporary
  return parseManifest(xml, mpdUrl);
}

export function parseManifest(xml: string, mpdUrl: string): DashManifest {
  const parsed = parser.parse(xml) as ParsedMpdDocument;
  const mpd = parsed.MPD;
  if (!mpd) {
    throw new Error("parseManifest: missing MPD root element");
  }

  // Deliberately ignore mpd.BaseURL — it resolves to the bare CDN URL
  // which drops the authentication token present in mpdUrl.
  const mpdBaseUrl = mpdUrl;
  const periods = toArray(mpd.Period);

  for (const period of periods) {
    const periodBaseUrl = mpdBaseUrl; // ignore period.BaseURL for same reason
    const adaptationSets = toArray(period.AdaptationSet);

    for (const adaptationSet of adaptationSets) {
      if (!isTeaAdaptationSet(adaptationSet)) continue;

      const source = resolveTemplateSource(periodBaseUrl, adaptationSet);
      if (!source) {
        throw new Error("parseManifest: missing SegmentTemplate for 'tea' audio track");
      }

      const initialization = source.template["@_initialization"];
      const media = source.template["@_media"];
      if (!initialization || !media) {
        throw new Error("parseManifest: missing SegmentTemplate initialization/media for 'tea' audio track");
      }

      return {
        baseUrl: source.baseUrl,
        initUrl: resolveUrl(source.baseUrl, initialization).replace("$RepresentationID$", source.representationId),
        mediaTemplate: resolveUrl(source.baseUrl, media).replace("$RepresentationID$", source.representationId),
        startNumber: Number(source.template["@_startNumber"] ?? "1"),
      };
    }
  }

  throw new Error("No 'tea' audio track found in manifest");
}

export function buildSegmentUrl(mediaTemplate: string, segmentNumber: number, startNumber: number): string {
  if (!mediaTemplate.includes("$Number$")) {
    throw new Error("buildSegmentUrl: media template missing $Number$");
  }
  return mediaTemplate.replace("$Number$", String(startNumber + segmentNumber - 1));
}
