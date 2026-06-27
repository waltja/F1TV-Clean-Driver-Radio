import process from "node:process";

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
  startNumber: number;
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
export const SEEK_THRESHOLD_S = 2;
export const RING_BUFFER_DEPTH = 3;
export const POLL_INTERVAL_MS = 250;
export const MV_GRAPHQL_ENDPOINT = `http://${process.env.MV_HOST ?? "localhost:10101"}/api/graphql`;
// Compensates for pipeline latency (poll + download + FFmpeg decode + speaker buffer).
// Audio lags MV by ~800ms total; 500ms compensation keeps us slightly behind video
// rather than risking audio leading video, which is more jarring.
export const LATENCY_COMPENSATION_S = 0.5;

// VAD gate thresholds (shared by collect.ts and the live playback pipeline).
// A frame is counted as speech if its probability >= VAD_THRESHOLD.
// A segment is classified as speech if >= VAD_SPEECH_PCT of frames exceed the threshold.
export const VAD_THRESHOLD = 0.3;
export const VAD_SPEECH_PCT = 0.05;
