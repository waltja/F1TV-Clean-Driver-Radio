export interface Tokens {
  ascendonToken: string;
  entitlementToken: string;
}

export interface MvDriverData {
  tla: string;
  driverNumber: number;
  teamName: string;
}

export interface MvStreamData {
  contentId: number;
  channelId: number;
}

export interface MvPlayerState {
  interpolatedCurrentTime: number; // seconds, float
  paused: boolean;
  live: boolean;
}

export interface MvPlayer {
  id: string;
  type: string;
  state: MvPlayerState;
  streamData: MvStreamData;
  driverData: MvDriverData;
}

export interface DashManifest {
  baseUrl: string;
  initUrl: string;
  mediaTemplate: string; // absolute media URL template containing literal "$Number$"
}

export interface SegmentRef {
  number: number; // 1-indexed
  url: string;
}

export interface PcmSegment {
  number: number; // 1-indexed segment number
  pcm: Buffer; // 48kHz mono s16le
}

export const SEGMENT_DURATION_S = 5.76;
export const SEEK_THRESHOLD_S = 5;
export const RING_BUFFER_DEPTH = 5;
export const POLL_INTERVAL_MS = 500;
export const MV_GRAPHQL_ENDPOINT = "http://localhost:10101/api/graphql";
