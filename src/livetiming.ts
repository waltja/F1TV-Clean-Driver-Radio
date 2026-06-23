// F1 live timing API (livetiming.formula1.com/static/)
// No authentication required — fully public CDN.

const LIVETIMING_BASE = "https://livetiming.formula1.com/static/";

// ---- Year index types -------------------------------------------------------

export interface LiveTimingSession {
  key: number;
  type: string;   // "Race", "Qualifying", "Practice 1", "Sprint", etc.
  name: string;
  startDate: string;
  endDate: string;
  path: string;   // e.g. "2026/2026-06-14_Barcelona_Grand_Prix/2026-06-14_Race/"
}

export interface LiveTimingMeeting {
  key: number;
  name: string;     // "Barcelona Grand Prix"
  location: string;
  sessions: LiveTimingSession[];
}

// ---- TeamRadio types --------------------------------------------------------

export interface TeamRadioCapture {
  Utc: string;
  RacingNumber: string;
  Path: string;  // relative, e.g. "TeamRadio/HAM_44_20260614_142413.mp3"
}

// ---- Helpers ----------------------------------------------------------------

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

// Parse a .jsonStream file: each line is {12-char session time}{json payload}.
// Returns only the parsed JSON objects (session times discarded).
function parseJsonStream(body: string): unknown[] {
  const results: unknown[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (line.length <= 12) continue; // empty or time-only line
    const jsonPart = line.slice(12);
    try {
      results.push(JSON.parse(jsonPart));
    } catch {
      // Malformed line — skip silently.
    }
  }
  return results;
}

// ---- Public API -------------------------------------------------------------

// Fetch the full year index from livetiming.formula1.com.
// Returns all meetings with their sessions for the given year.
export async function fetchSeasonIndex(year: number): Promise<LiveTimingMeeting[]> {
  const url = `${LIVETIMING_BASE}${year}/Index.json`;
  let raw: string;
  try {
    raw = await fetchText(url);
  } catch (err) {
    throw new Error(
      `Failed to fetch ${year} season index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The year index is a plain JSON file, not a .jsonStream.
  interface RawSession {
    Key?: number;
    Type?: string;
    Name?: string;
    StartDate?: string;
    EndDate?: string;
    Path?: string;
  }
  interface RawMeeting {
    Key?: number;
    Name?: string;
    Location?: string;
    Sessions?: RawSession[];
  }
  interface RawIndex {
    Meetings?: RawMeeting[];
  }

  let parsed: RawIndex;
  try {
    parsed = JSON.parse(raw) as RawIndex;
  } catch {
    throw new Error(`Failed to parse ${year} season index (invalid JSON)`);
  }

  const meetings = parsed.Meetings ?? [];
  return meetings.map((m): LiveTimingMeeting => ({
    key: m.Key ?? 0,
    name: m.Name ?? "",
    location: m.Location ?? "",
    sessions: (m.Sessions ?? []).map((s): LiveTimingSession => ({
      key: s.Key ?? 0,
      type: s.Type ?? "",
      name: s.Name ?? "",
      startDate: s.StartDate ?? "",
      endDate: s.EndDate ?? "",
      path: s.Path ?? "",
    })),
  }));
}

// Fetch TeamRadio.jsonStream for a session path and return all captures.
// sessionPath: e.g. "2026/2026-06-14_Barcelona_Grand_Prix/2026-06-14_Race/"
export async function fetchTeamRadioCaptures(sessionPath: string): Promise<TeamRadioCapture[]> {
  const url = `${LIVETIMING_BASE}${sessionPath}TeamRadio.jsonStream`;
  let raw: string;
  try {
    raw = await fetchText(url);
  } catch (err) {
    throw new Error(
      `Failed to fetch TeamRadio data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lines = parseJsonStream(raw);
  const captures: TeamRadioCapture[] = [];

  interface CaptureShape { Utc?: string; RacingNumber?: string; Path?: string }

  for (const line of lines) {
    const entry = line as { Captures?: CaptureShape[] | Record<string, CaptureShape> };
    if (!entry.Captures) continue;

    if (Array.isArray(entry.Captures)) {
      // First line format: Captures is an array.
      for (const c of entry.Captures) {
        if (c.Utc && c.RacingNumber && c.Path) {
          captures.push({ Utc: c.Utc, RacingNumber: c.RacingNumber, Path: c.Path });
        }
      }
    } else {
      // Subsequent lines: Captures is an object keyed by numeric strings.
      for (const c of Object.values(entry.Captures)) {
        if (c.Utc && c.RacingNumber && c.Path) {
          captures.push({ Utc: c.Utc, RacingNumber: c.RacingNumber, Path: c.Path });
        }
      }
    }
  }

  return captures;
}

// Fetch DriverList.jsonStream for a session path.
// Returns a map of RacingNumber -> TLA.
export async function fetchDriverList(sessionPath: string): Promise<Map<string, string>> {
  const tlaMap = new Map<string, string>();
  const url = `${LIVETIMING_BASE}${sessionPath}DriverList.jsonStream`;
  let raw: string;
  try {
    raw = await fetchText(url);
  } catch {
    // Non-fatal — caller can fall back to racing numbers.
    return tlaMap;
  }

  const lines = parseJsonStream(raw);
  if (lines.length === 0) return tlaMap;

  // First line contains the full driver roster as an object keyed by numeric strings.
  const first = lines[0] as Record<string, { RacingNumber?: string; Tla?: string }>;
  for (const info of Object.values(first)) {
    if (info.RacingNumber && info.Tla) {
      tlaMap.set(info.RacingNumber, info.Tla);
    }
  }

  return tlaMap;
}

// Build the full MP3 URL from a session path and a capture's relative path.
export function buildRadioUrl(sessionPath: string, capturePath: string): string {
  const normalizedSession = sessionPath.endsWith("/") ? sessionPath : `${sessionPath}/`;
  const normalizedCapture = capturePath.startsWith("/") ? capturePath.slice(1) : capturePath;
  return `${LIVETIMING_BASE}${normalizedSession}${normalizedCapture}`;
}
