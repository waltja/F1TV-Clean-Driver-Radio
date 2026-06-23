# F1TV-Clean-Driver-Radio

Isolates team radio audio from F1 on-board camera streams and plays it in sync with MultiViewer. Strips engine noise with RNNoise (via FFmpeg), leaving only driver/engineer comms. Includes tools for collecting training data to build a custom RNNoise model tuned to F1 radio noise.

## Prerequisites

An F1TV Pro subscription and your `ascendontoken` from browser devtools. **MultiViewer for F1** must be running at `localhost:10101`.

### macOS

```bash
xcode-select --install
brew install node ffmpeg pnpm
```

### Ubuntu (24.04+)

```bash
sudo apt update && sudo apt install -y build-essential ffmpeg curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
corepack enable && corepack prepare pnpm@latest --activate
```

### Fedora

```bash
sudo dnf install -y gcc-c++ make
sudo dnf install -y https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf install -y ffmpeg nodejs
corepack enable && corepack prepare pnpm@latest --activate
```

### Windows (PowerShell as Admin)

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

Gyan.FFmpeg installs to `C:\ffmpeg\bin` but does not add itself to PATH. Run this after:

```powershell
setx PATH "%PATH%;C:\ffmpeg\bin"
```

Then open a **new** terminal and run:

```powershell
corepack enable && corepack prepare pnpm@latest --activate
```

## Setup

```bash
pnpm install
pnpm approve-builds speaker
```

On first run you'll be prompted for your Ascendon token. Grab it from browser devtools on f1tv.formula1.com (Application > Cookies or Network headers). The token is cached at `.f1-radio-token` for subsequent runs.

## Live Playback

Open a race replay in MultiViewer with at least one on-board camera player visible.

```bash
pnpm start
```

Pick a driver from the list. Audio plays through your system speakers, synced to the MV player position. Seeking, pausing, and resuming in MV are mirrored automatically.

The audio pipeline per segment:
1. Download the `tea` (team audio) DASH segment from F1TV CDN
2. Decode and filter through FFmpeg: bandpass 300-3400Hz, double RNNoise pass, noise gate, compressor
3. Push 48kHz mono PCM to `node-speaker`

Segments are 5.76 seconds each. A ring buffer of 5 segments (~29s) stays ahead of the MV playhead.

## Project Structure

```
src/
  index.ts            CLI entry, driver selection, sync loop, playback orchestration
  auth.ts             Token prompt, cache (.f1-radio-token), clear
  f1api.ts            F1TV entitlement + stream URL resolution
  dash.ts             MPD XML parse, tea audio track extraction, segment URL building
  segments.ts         Segment download, init+segment concatenation
  audio.ts            FFmpeg decode pipelines (filtered, raw, mp3)
  player.ts           node-speaker wrapper, ring buffer, seek/pause, PCM trim
  sync.ts             MV GraphQL polling, segment number math, seek detection
  types.ts            Shared interfaces and constants
  collect.ts          Noise collection CLI
  collect-speech.ts   Speech collection CLI
  list-races.ts       Race and OBC channel discovery CLI
  types/speaker.d.ts  Type declarations for node-speaker
scripts/
  concat-noise.sh     Concatenates noise_*.raw files
  concat-signal.sh    Concatenates signal_*.raw files (+ optional LibriSpeech)
models/
  bd.rnnn             Default RNNoise model (Xiph banded)
```

## Architecture Notes

- No audio files written to disk during playback. All processing is in-memory via FFmpeg stdin/stdout pipes.
- DASH segments are downloaded directly from CloudFront CDN. No DRM, no cookies needed.
- The `tea` audio track (team/car audio) is identified by language/label/role attributes in the MPD manifest.
- Sync polls `interpolatedCurrentTime` from MV every 500ms. Seeks detected via 5s threshold trigger a Speaker recreation to flush CoreAudio buffers.
- Pause feeds silence to CoreAudio to prevent buffer underflow warnings.
- Auth tokens come from browser devtools (Imperva blocks automated login).

---

## Development

The tools below are for collecting training data to build a custom RNNoise model. MultiViewer is not required for most of these -- `pnpm list-races` + `--content-id`/`--channel-ids` flags let you run everything against F1TV directly.

### Finding race and driver IDs (`pnpm list-races`)

Discovers race sessions and OBC driver channel IDs from the F1TV content API. No MultiViewer needed -- only your `ascendontoken`.

```bash
pnpm list-races
```

Lists all races in the current season. Each entry shows the race name, `contentId`, and per-driver `channelId` values, plus a ready-to-run `pnpm collect-noise` command you can copy directly:

```
Barcelona GP 2026
  contentId: 1000010279
  HAM  (44)  channelId: 1007
  VER  (1)   channelId: 1008
  ...
  pnpm collect-noise --content-id 1000010279 --channel-ids HAM:1007,VER:1008,...
```

Flags:
- `--season YYYY` -- defaults to current year
- `--count N` -- last N races only

Use the `--content-id` and `--channel-ids` flags on `collect-noise` (and `collect-speech`) to skip MV entirely and run against any race on record.

### Noise collection (`pnpm collect-noise`)

Downloads race segments, classifies each as speech or engine-only using the denoise chain + RMS measurement, and saves raw PCM from engine-only segments.

```bash
# MV mode: picks random drivers from open OBC players
pnpm collect-noise --drivers 4 --start-min 5

# MV-free mode: specify race and drivers directly (use list-races to get IDs)
pnpm collect-noise --content-id 1000010279 --channel-ids HAM:1007,VER:1008 --start-min 20 --end-min 115

# Quick test: 1 driver, 11 segments starting at minute 20
pnpm collect-noise --start-min 20 --length 11 --drivers 1

# Cap saved noise at 30 minutes per driver
pnpm collect-noise --drivers 4 --max-minutes 30
```

Outputs `training-data/noise_<TLA>.raw` files (16-bit LE mono 48kHz). Appends across runs so data accumulates from multiple races.

Flags:
- `--start-min N` -- skip to minute N (avoids formation lap silence)
- `--end-min N` -- stop at minute N from stream start (avoids post-race silence)
- `--length N` -- scan N segments then stop (takes precedence over `--end-min`)
- `--threshold N` -- RMS dB cutoff, default -55
- `--drivers N` -- random driver count in MV mode, default 2
- `--max-minutes N` -- stop per driver after N min of saved noise
- `--out-dir DIR` -- default `./training-data`
- `--content-id N` -- skip MV, use this race contentId directly
- `--channel-ids TLA:channelId,...` -- skip MV, use these driver channels

Typical full-race invocation: `--start-min 20 --end-min 115 --max-minutes 30` (adjust end-min to race length).

### Speech collection (`pnpm collect-speech`)

Scrapes F1's curated TeamRadio clips from the live timing feed via MultiViewer. These are clean, pre-processed voice clips that supplement LibriSpeech as signal data for training.

Open the race replay in MV, open the live timing page, and scrub to the end so all radio messages load. Then:

```bash
# Grab all drivers' radio clips
pnpm collect-speech

# Filter to specific drivers
pnpm collect-speech --drivers HAM,VER,LEC
```

Outputs `training-data/signal_radio.raw`. Appends across sessions.

Flags:
- `--drivers TLA,TLA` -- filter to specific drivers
- `--concurrency N` -- parallel downloads, default 5
- `--out-dir DIR` -- default `./training-data`
- `--out-file NAME` -- default `signal_radio.raw`

### Preparing LibriSpeech data

LibriSpeech provides clean speech samples to pair with the F1 engine noise for RNNoise training. The training pipeline expects a single `.raw` file (16-bit LE mono 48kHz PCM).

Download and extract `dev-clean` (~337MB compressed, ~1.7GB raw):

```bash
wget https://www.openslr.org/resources/12/dev-clean.tar.gz
tar xzf dev-clean.tar.gz
```

Concatenate all FLAC files into a single raw PCM file. Use a `while read` loop -- `xargs -I{}` does not work reliably here (each ffmpeg stdout captures separately, producing ~1MB files):

```bash
find LibriSpeech/dev-clean -name "*.flac" | sort | while read f; do
  ffmpeg -i "$f" -f s16le -ar 48000 - 2>/dev/null >> librispeech.raw
done
echo "Done: $(wc -c < librispeech.raw) bytes"
# Expected: ~1.7GB for full dev-clean (~5h of audio)
```

### Concatenating training data

After collecting noise and speech, merge into single files for the training pipeline:

```bash
# Merge all per-driver noise files -> training-data/noise.raw
pnpm concat-noise

# Merge speech clips + LibriSpeech -> training-data/signal.raw
pnpm concat-signal --librispeech path/to/librispeech.raw
```

Or manually on the training machine:

```bash
cat training-data/signal_radio.raw path/to/librispeech.raw > rnnoise-training/src/signal.raw
```

### Quick playback check

```bash
# Listen to collected noise
ffplay -f s16le -ar 48000 training-data/noise_HAM.raw

# Listen to collected speech clips
ffplay -f s16le -ar 48000 training-data/signal_radio.raw

# Seek into a file (e.g. 60 seconds in)
ffplay -f s16le -ar 48000 -ss 60 training-data/noise_HAM.raw
```
