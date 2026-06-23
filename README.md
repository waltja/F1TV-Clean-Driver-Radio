# F1TV-Clean-Driver-Radio

Isolates team radio audio from F1 on-board camera streams and plays it in sync with MultiViewer. Strips engine noise with RNNoise (via FFmpeg), leaving only driver/engineer comms. Includes tools for collecting training data to build a custom RNNoise model tuned to F1 radio noise.

## Prerequisites

An F1TV Pro subscription and your `ascendontoken` from browser devtools. **MultiViewer for F1** must be running at `localhost:10101` for live playback (`pnpm start`). Data collection tools (`collect-noise`, `collect-speech`, `list-races`) work without MV running.

### macOS

```bash
xcode-select --install
brew install node ffmpeg pnpm
```

### Ubuntu (24.04+)

```bash
sudo apt update && sudo apt install -y build-essential ffmpeg curl libasound2-dev libasound2-plugins
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
# NodeSource's postinstall runs `corepack enable` without root and fails.
# Disable corepack and install pnpm directly instead:
sudo corepack disable
sudo npm install -g pnpm
```

#### WSL2 audio (required for live playback, not needed for data collection)

WSL2 has no direct audio hardware access. Route through WSLg's PulseAudio socket:

```bash
echo -e "pcm.default pulse\nctl.default pulse" > ~/.asoundrc
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
```

Add the `export` line to your `~/.bashrc` so it persists across sessions. This requires Windows 11 WSL2 with WSLg (ships by default on recent builds).

#### WSL2 MultiViewer connection

MultiViewer runs on Windows. WSL2's `localhost` does not reach the Windows loopback stack, so you need to route via the Hyper-V gateway IP instead. That IP is dynamic and changes on WSL restart, so resolve it at shell startup:

```bash
export MV_HOST=$(ip route show default | awk '{print $3}'):10101
```

Add that line to `~/.bashrc`. Verify MV is reachable before running `pnpm start`:

```bash
curl -s "http://$MV_HOST/api/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ players { id } }"}' | head -c 100
```

You should see `{"data":{"players":[...]}}`. If you get connection refused, check that the Windows Firewall allows inbound TCP on port 10101 (add a rule in Windows Defender Firewall or via Admin PowerShell: `New-NetFirewallRule -DisplayName "MultiViewer WSL2" -Direction Inbound -LocalPort 10101 -Protocol TCP -Action Allow`).

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
  collect-speech.ts   Speech collection CLI (MV-free, uses livetiming API)
  livetiming.ts       F1 live timing API client (public, no auth)
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
- `--season YYYY` -- defaults to current year; past seasons use the F1TV archive hub to discover the season page
- `--count N` -- last N races only
- `--page N` -- override the season page ID (bypass discovery; useful when the hardcoded current-season ID goes stale)
- `--debug` -- dumps raw API container data to stderr (type, subtype, season, pageId per container); useful if no races are found

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
- `--retire-after N` -- stop a driver after N consecutive below-threshold segments (detects retirement/car stopped); default disabled
- `--out-dir DIR` -- default `./training-data`
- `--content-id N` -- skip MV, use this race contentId directly
- `--channel-ids TLA:channelId,...` -- skip MV, use these driver channels

Typical full-race invocation: `--start-min 20 --end-min 115 --max-minutes 30` (adjust end-min to race length).

### Speech collection (`pnpm collect-speech`)

Downloads F1's curated TeamRadio clips directly from the F1 live timing API (`livetiming.formula1.com`). No MultiViewer required, no F1TV auth required.

```bash
# All drivers for a race (name substring match, case-insensitive)
pnpm collect-speech --race barcelona

# Specific round number
pnpm collect-speech --race 10 --season 2026

# Filter to specific drivers
pnpm collect-speech --race monaco --drivers HAM,RUS

# Qualifying clips instead of race
pnpm collect-speech --race singapore --session-type Qualifying

# Direct path override (skip discovery)
pnpm collect-speech --session-path 2026/2026-06-14_Barcelona_Grand_Prix/2026-06-14_Race/
```

Outputs `training-data/signal_radio.raw`. Appends across sessions.

Flags:
- `--race NAME|N` -- meeting name substring or round number (required unless `--session-path` given)
- `--season YYYY` -- default current year
- `--session-type TYPE` -- default `Race`; other values: `Qualifying`, `Practice 1`, `Sprint`, etc.
- `--session-path PATH` -- direct livetiming path override, skips discovery
- `--drivers TLA,TLA` -- filter to specific drivers
- `--concurrency N` -- parallel downloads, default 5
- `--out-dir DIR` -- default `./training-data`
- `--out-file NAME` -- default `signal_radio.raw`

### Preparing LibriSpeech data

LibriSpeech provides clean speech samples to pair with F1 engine noise for RNNoise training. More data produces a better model. Available subsets at https://www.openslr.org/12 :

| Subset | Compressed | Duration |
|---|---|---|
| `dev-clean` | 337 MB | ~5h |
| `train-clean-100` | 6.3 GB | ~100h |
| `train-clean-360` | 23 GB | ~360h |
| `train-other-500` | 30 GB | ~500h |

Download whichever subsets you want:

```bash
# Minimum viable (quick test):
wget https://www.openslr.org/resources/12/dev-clean.tar.gz

# Recommended for a good model:
wget https://www.openslr.org/resources/12/train-clean-100.tar.gz
wget https://www.openslr.org/resources/12/train-other-500.tar.gz

# Extract all downloaded archives:
for f in *.tar.gz; do tar xzf "$f"; done
```

Concatenate all FLAC files into a single raw PCM file (16-bit LE mono 48kHz). Use a `while read` loop -- `xargs -I{}` does not work reliably here (each ffmpeg stdout captures separately, producing ~1MB files per call):

```bash
find LibriSpeech/ -name "*.flac" | sort | while read f; do
  ffmpeg -i "$f" -f s16le -ac 1 -ar 48000 - 2>/dev/null >> librispeech.raw
done
echo "Done: $(wc -c < librispeech.raw) bytes"
# dev-clean only: ~1.7 GB (~5h)
# train-clean-100: ~34 GB (~100h)
# All four subsets: ~330 GB (~960h)
```

The `find` picks up all extracted subsets automatically -- no need to adjust the command based on which archives you downloaded.

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
