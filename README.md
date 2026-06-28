# F1TV-Clean-Driver-Radio

Plays F1 team radio from on-board camera streams in sync with MultiViewer. The runtime uses Silero VAD to detect speech, mutes engine-only regions, and applies a speech-band FFmpeg filter before playback.

## Prerequisites

You need an F1TV Pro subscription, your `ascendontoken` from browser devtools, FFmpeg on `PATH`, and **MultiViewer for F1** running for live playback.

### macOS

```bash
xcode-select --install
brew install node ffmpeg pnpm
```

### Ubuntu (24.04+)

```bash
sudo apt update && sudo apt install -y build-essential ffmpeg curl libasound2-dev libasound2-plugins
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm
```

### Fedora

```bash
sudo dnf install -y gcc-c++ make
sudo dnf install -y https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf install -y ffmpeg nodejs
sudo npm install -g pnpm
```

### Windows

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
npm install -g pnpm
```

If FFmpeg is not on `PATH`, add `C:\ffmpeg\bin` and restart the terminal.

### WSL2 notes

For audio playback through WSLg:

```bash
echo -e "pcm.default pulse\nctl.default pulse" > ~/.asoundrc
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
```

If MultiViewer is running on Windows, point WSL to the Windows host IP:

```bash
export MV_HOST=$(ip route show default | awk '{print $3}'):10101
```

## Setup

```bash
pnpm install
pnpm approve-builds speaker
pnpm approve-builds onnxruntime-node
pnpm install
curl -L -o models/silero_vad.onnx https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
```

On first run the app prompts for your Ascendon token and caches it at `.f1-radio-token`.

## Usage

Open a race replay in MultiViewer with at least one on-board camera player visible, then run:

```bash
pnpm start
```

Pick a driver from the list. Audio stays synced to the selected MultiViewer player, including pause, resume, and seek behavior.

## Runtime Flow

For each 5.76 second segment the app:

1. Downloads the `tea` DASH audio segment from F1TV.
2. Decodes it to raw 48 kHz mono PCM with FFmpeg.
3. Runs Silero VAD over the raw PCM.
4. Zeroes non-speech frames with padding around detected speech.
5. Applies a 300-3400 Hz speech-band filter.
6. Enqueues the result to `node-speaker`, or silence for engine-only segments.

The player keeps a 3-segment ring buffer ahead of the playhead. MultiViewer sync is polled every 250 ms. Seek detection uses a 2 second threshold.

## Project Structure

```text
src/
  index.ts            CLI entry, driver selection, sync loop, playback orchestration
  auth.ts             Token prompt, cache (.f1-radio-token), clear
  f1api.ts            F1TV entitlement + stream URL resolution
  dash.ts             MPD XML parse, tea audio track extraction, segment URL building
  segments.ts         Segment download, init+segment concatenation
  audio.ts            FFmpeg raw decode and speech-band filter helpers
  vad.ts              Silero VAD v6 ONNX wrapper
  player.ts           node-speaker wrapper, ring buffer, seek/pause, PCM trim
  sync.ts             MV GraphQL polling, segment number math, seek detection
  types.ts            Shared interfaces and constants
  types/speaker.d.ts  Type declarations for node-speaker
models/
  silero_vad.onnx     Silero VAD v6 ONNX model
```

## Notes

- Playback stays in memory. No audio files are written during normal runtime.
- DASH segments are fetched directly from the CDN once the stream URL is resolved.
- The `tea` audio track is identified from the MPD by known language, label, id, and role variants.
- Auth tokens come from browser devtools because automated login is blocked upstream.
