# F1-Radio Agent Guide

## Goal

Keep live F1 team radio playback synced with MultiViewer while preserving only speech-relevant audio from OBC `tea` streams.

## Primary Commands

- `pnpm start` - run the live radio player

## Architecture

- `src/index.ts` is the live runtime entrypoint and owns orchestration.
- `src/auth.ts` handles browser-token loading and cache usage via `.f1-radio-token`.
- `src/f1api.ts` resolves entitlement and stream URLs.
- `src/dash.ts` parses the MPD and identifies the `tea` audio track.
- `src/segments.ts` builds and downloads DASH segment payloads.
- `src/audio.ts` decodes/filter audio through FFmpeg.
- `src/vad.ts` runs Silero VAD v6 via `onnxruntime-node`.
- `src/player.ts` manages playback, buffering, pause/seek, and PCM trimming.
- `src/sync.ts` tracks MultiViewer time and seek state.

## Runtime Facts

- Use `BIG_SCREEN_HLS` for the F1TV PLAY endpoint. Do not switch to `WEB_HLS` or `WEB_DASH`.
- The desired audio track is `tea`, not commentary tracks.
- Segment duration is 5.76 seconds.
- Playback sync should use MultiViewer GraphQL `interpolatedCurrentTime`.
- Keep normal playback fully in-memory. Do not introduce temp audio files unless the task explicitly requires diagnostics.
- The live path currently uses Silero VAD plus a 300-3400 Hz FFmpeg speech-band filter.

## Editing Rules

- Prefer small fixes that preserve the current runtime shape.
- Do not reintroduce old collection, concat, or RNNoise training flows unless the task explicitly asks for them.
- Do not automate F1TV login. Authentication depends on browser-extracted tokens because of Imperva.
- Do not hardcode DASH segment URLs. Parse the MPD and respect `startNumber`.
- Be careful with shared VAD state. `runVad()` is serialized because the session is mutable.
- Preserve cross-platform behavior for Windows and WSL2 where possible.

## Verification

- For code changes, run the smallest relevant command first.
- If the change affects runtime startup, use `pnpm start` only when the environment prerequisites are available.
- Call out when verification is limited by local dependencies such as FFmpeg, MultiViewer, F1TV auth, `speaker`, or `onnxruntime-node`.

## Known Constraints

- Automated end-to-end verification is limited because real playback depends on F1TV auth, MultiViewer, and local audio output.
- WSL2 playback may require `PULSE_SERVER=unix:/mnt/wslg/PulseServer`.
- MultiViewer on Windows from WSL may require `MV_HOST=$(ip route show default | awk '{print $3}'):10101`.
