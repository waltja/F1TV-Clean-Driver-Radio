# F1 Audio Fix

Speech-preserving engine-noise reducer for Formula streams.

This version is tuned for your described use case: **make engine significantly lower** while preserving radio/voice whenever it appears.

## Requirements

- Python 3.10+
- No third-party Python dependencies
- `ffmpeg` for live capture/playback piping (recommended)

## 1) Process a WAV file

```bash
python f1_audio_denoise.py --input in.wav --output out.wav
```

Supported input: 16-bit PCM WAV (mono or stereo, including 48 kHz stereo).

## 2) Real-time stream mode (stdin/stdout PCM)

The program can read raw `s16le` PCM from stdin and write processed PCM to stdout:

```bash
python f1_audio_denoise.py --realtime-stdin-stdout --sample-rate 48000 --channels 2
```

## 3) End-to-end live capture -> denoise -> playback

### Linux (PulseAudio/PipeWire default source/sink)

```bash
ffmpeg -f pulse -i default -f s16le -ac 2 -ar 48000 - \
| python f1_audio_denoise.py --realtime-stdin-stdout --sample-rate 48000 --channels 2 \
| ffplay -f s16le -ac 2 -ar 48000 -
```

### If your stream is URL-based (HLS/HTTP/etc.)

```bash
ffmpeg -i "<STREAM_URL>" -f s16le -ac 2 -ar 48000 - \
| python f1_audio_denoise.py --realtime-stdin-stdout --sample-rate 48000 --channels 2 \
| ffplay -f s16le -ac 2 -ar 48000 -
```

## 4) Optional: record the cleaned stream while listening

```bash
ffmpeg -i "<STREAM_URL>" -f s16le -ac 2 -ar 48000 - \
| python f1_audio_denoise.py --realtime-stdin-stdout --sample-rate 48000 --channels 2 \
| tee >(ffplay -nodisp -autoexit -f s16le -ac 2 -ar 48000 -) \
| ffmpeg -f s16le -ac 2 -ar 48000 -i - cleaned_output.wav
```

## Tuning for “engine low, radio clear”

Use presets first:

- `--preset balanced` (default)
- `--preset radio_priority` (recommended for your goal)
- `--preset extreme_radio` (very aggressive engine suppression)

You can still override individual parameters after picking a preset.

Default tuning already favors that goal, but you can push it further:

- Lower `--low-gain-nospeech` (e.g. `0.08`) to reduce engine bed more.
- Lower `--high-gain-nospeech` (e.g. `0.40`) for more overall background suppression.
- Keep speech gains high (`--low-gain-speech`, `--high-gain-speech`) so radio pops through.

Example aggressive profile:

```bash
python f1_audio_denoise.py \
  --input in.wav --output out.wav \
  --preset radio_priority \
  --report-levels
```

## Quick validation

```bash
python f1_audio_denoise.py --self-test
```

The self-test verifies that non-speech (engine-only) sections are reduced more than speech sections.

## Suggested command for your 48 kHz stereo stream

```bash
ffmpeg -i "<STREAM_URL>" -f s16le -ac 2 -ar 48000 - \
| python f1_audio_denoise.py --realtime-stdin-stdout --sample-rate 48000 --channels 2 --preset radio_priority \
| ffplay -f s16le -ac 2 -ar 48000 -
```
