# F1 Audio Fix

A streaming-friendly Formula car audio denoiser that:

- gently suppresses steady engine/background noise,
- preserves occasional verbal/radio communication,
- keeps engine context audible (no heavy "underwater" suppression).

## Requirements

- Python 3.10+
- No third-party dependencies

## Run on real audio

```bash
python f1_audio_denoise.py --input input.wav --output cleaned.wav --stream-demo
```

## Quick built-in validation

```bash
python f1_audio_denoise.py --self-test
```

This synthetic test creates an engine-like bed + speech-like bursts and checks that:

1. non-speech sections are attenuated, and
2. speech sections are attenuated less than non-speech.

## Tuning knobs

- `--strength` (default `0.32`): how much suppression is applied.
- `--min-gain` (default `0.72`): floor for retained original signal.

## Input format notes

- Input must be **16-bit PCM WAV**.
- Mono and stereo input are supported (stereo is downmixed to mono).

## Algorithm (high level)

1. Split incoming audio into overlapping STFT frames.
2. Learn a running noise profile (faster during non-speech, slower during speech-like frames).
3. Estimate speech likelihood from spectral flatness and energy ratio in speech bands.
4. Apply conservative Wiener-like gain shaping with a protective gain floor.
