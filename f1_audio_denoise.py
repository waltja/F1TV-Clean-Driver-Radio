#!/usr/bin/env python3
"""F1 audio engine-noise reducer (speech-preserving, streaming-friendly).

Key goals:
- Pull down persistent Formula engine bed aggressively enough for monitoring.
- Preserve intermittent team radio / verbal content.
- Work in real time on 48 kHz stereo without third-party dependencies.
"""

from __future__ import annotations

import argparse
import math
import struct
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import List, Sequence, Tuple


@dataclass
class DenoiseConfig:
    sample_rate: int = 48_000
    channels: int = 2
    frame_ms: float = 10.0

    # How much low-frequency bed is kept.
    low_gain_nospeech: float = 0.12
    low_gain_speech: float = 0.35

    # How much high-frequency content is kept.
    high_gain_nospeech: float = 0.48
    high_gain_speech: float = 0.96

    speech_threshold: float = 0.42
    gain_rise: float = 0.36  # faster when restoring for speech
    gain_fall: float = 0.16  # slower when clamping noise


class OnePoleLPF:
    def __init__(self, cutoff_hz: float, sample_rate: int):
        if cutoff_hz <= 0:
            raise ValueError("cutoff_hz must be positive")
        self.a = math.exp(-2.0 * math.pi * cutoff_hz / sample_rate)
        self.y = 0.0

    def process(self, x: float) -> float:
        self.y = (1.0 - self.a) * x + self.a * self.y
        return self.y


class F1EngineNoiseReducer:
    """Adaptive two-band reducer for engine-heavy motorsport audio."""

    def __init__(self, config: DenoiseConfig):
        self.cfg = config
        self.frame_len = max(1, int(config.sample_rate * config.frame_ms / 1000.0))
        self.channels = config.channels

        # Sidechain filters (mono analysis path).
        self.sc_low_lpf = OnePoleLPF(280.0, config.sample_rate)
        self.sc_hp_lpf = OnePoleLPF(300.0, config.sample_rate)
        self.sc_speech_lpf = OnePoleLPF(3500.0, config.sample_rate)

        # Per-channel split filter.
        self.ch_low_lpfs = [OnePoleLPF(300.0, config.sample_rate) for _ in range(self.channels)]

        self.g_low = config.low_gain_nospeech
        self.g_high = config.high_gain_nospeech

        self.sample_buffer: List[Tuple[float, ...]] = []

    def _clamp(self, x: float, lo: float, hi: float) -> float:
        return lo if x < lo else hi if x > hi else x

    def _process_frame(self, frame: Sequence[Tuple[float, ...]]) -> List[Tuple[float, ...]]:
        low_energy = 0.0
        speech_energy = 0.0
        split: List[Tuple[List[float], List[float]]] = []

        for sample in frame:
            mono = sum(sample) / self.channels

            low_sc = self.sc_low_lpf.process(mono)
            high_sc = mono - self.sc_hp_lpf.process(mono)
            speech_sc = self.sc_speech_lpf.process(high_sc)

            low_energy += low_sc * low_sc
            speech_energy += speech_sc * speech_sc

            lows: List[float] = []
            highs: List[float] = []
            for ch, x in enumerate(sample):
                low = self.ch_low_lpfs[ch].process(x)
                highs.append(x - low)
                lows.append(low)
            split.append((lows, highs))

        eps = 1e-12
        low_rms = math.sqrt(low_energy / len(frame) + eps)
        speech_rms = math.sqrt(speech_energy / len(frame) + eps)
        speech_ratio = speech_rms / (speech_rms + low_rms + eps)

        t = self._clamp((speech_ratio - self.cfg.speech_threshold) / (1.0 - self.cfg.speech_threshold), 0.0, 1.0)

        target_low = (1.0 - t) * self.cfg.low_gain_nospeech + t * self.cfg.low_gain_speech
        target_high = (1.0 - t) * self.cfg.high_gain_nospeech + t * self.cfg.high_gain_speech

        low_coeff = self.cfg.gain_rise if target_low > self.g_low else self.cfg.gain_fall
        high_coeff = self.cfg.gain_rise if target_high > self.g_high else self.cfg.gain_fall

        self.g_low += low_coeff * (target_low - self.g_low)
        self.g_high += high_coeff * (target_high - self.g_high)

        out: List[Tuple[float, ...]] = []
        for lows, highs in split:
            y = [self.g_low * low + self.g_high * high for low, high in zip(lows, highs)]
            out.append(tuple(y))
        return out

    def process_samples(self, samples: Sequence[Tuple[float, ...]]) -> List[Tuple[float, ...]]:
        self.sample_buffer.extend(samples)
        out: List[Tuple[float, ...]] = []

        while len(self.sample_buffer) >= self.frame_len:
            frame = self.sample_buffer[: self.frame_len]
            out.extend(self._process_frame(frame))
            self.sample_buffer = self.sample_buffer[self.frame_len :]

        return out

    def flush(self) -> List[Tuple[float, ...]]:
        if not self.sample_buffer:
            return []

        # Pad short tail to keep frame math stable, then trim.
        tail_len = len(self.sample_buffer)
        pad = [self.sample_buffer[-1]] * (self.frame_len - tail_len)
        frame = self.sample_buffer + pad
        processed = self._process_frame(frame)
        self.sample_buffer = []
        return processed[:tail_len]


# ----- PCM helpers -----

def int16_to_float(v: int) -> float:
    return max(-1.0, min(1.0, v / 32768.0))


def float_to_int16(v: float) -> int:
    return int(max(-1.0, min(1.0, v)) * 32767.0)


def unpack_interleaved_s16le(raw: bytes, channels: int) -> List[Tuple[float, ...]]:
    if len(raw) % (2 * channels) != 0:
        raw = raw[: len(raw) - (len(raw) % (2 * channels))]
    count = len(raw) // 2
    vals = struct.unpack("<" + "h" * count, raw)

    out: List[Tuple[float, ...]] = []
    for i in range(0, len(vals), channels):
        out.append(tuple(int16_to_float(vals[i + ch]) for ch in range(channels)))
    return out


def pack_interleaved_s16le(samples: Sequence[Tuple[float, ...]]) -> bytes:
    vals: List[int] = []
    for sample in samples:
        vals.extend(float_to_int16(x) for x in sample)
    if not vals:
        return b""
    return struct.pack("<" + "h" * len(vals), *vals)


# ----- WAV helpers -----

def read_wav(path: Path) -> Tuple[List[Tuple[float, ...]], int, int]:
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        sample_rate = wf.getframerate()
        width = wf.getsampwidth()
        frames = wf.getnframes()
        if width != 2:
            raise ValueError("Only 16-bit PCM WAV is supported")
        raw = wf.readframes(frames)

    return unpack_interleaved_s16le(raw, channels), sample_rate, channels


def write_wav(path: Path, samples: Sequence[Tuple[float, ...]], sample_rate: int, channels: int) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pack_interleaved_s16le(samples))


def process_wav_file(input_path: Path, output_path: Path, cfg: DenoiseConfig) -> None:
    samples, sample_rate, channels = read_wav(input_path)
    cfg.sample_rate = sample_rate
    cfg.channels = channels
    reducer = F1EngineNoiseReducer(cfg)
    out = reducer.process_samples(samples)
    out.extend(reducer.flush())
    write_wav(output_path, out, sample_rate, channels)


def process_realtime_stdin_stdout(cfg: DenoiseConfig, block_frames: int) -> None:
    reducer = F1EngineNoiseReducer(cfg)
    chunk_bytes = block_frames * cfg.channels * 2

    while True:
        raw = sys.stdin.buffer.read(chunk_bytes)
        if not raw:
            break
        samples = unpack_interleaved_s16le(raw, cfg.channels)
        out = reducer.process_samples(samples)
        if out:
            sys.stdout.buffer.write(pack_interleaved_s16le(out))
            sys.stdout.buffer.flush()

    tail = reducer.flush()
    if tail:
        sys.stdout.buffer.write(pack_interleaved_s16le(tail))
        sys.stdout.buffer.flush()


def self_test() -> None:
    sr = 48_000
    channels = 2
    duration = 6.0
    total = int(sr * duration)

    def sample_at(i: int) -> Tuple[float, float]:
        t = i / sr
        engine = (
            0.65 * math.sin(2 * math.pi * 110 * t)
            + 0.30 * math.sin(2 * math.pi * 220 * t)
            + 0.15 * math.sin(2 * math.pi * 440 * t)
        )

        speech = 0.0
        if 1.2 <= t <= 2.0 or 3.5 <= t <= 4.4:
            env = 0.5 * (1 + math.sin(2 * math.pi * 4.0 * t))
            speech = env * (
                0.30 * math.sin(2 * math.pi * 700 * t)
                + 0.23 * math.sin(2 * math.pi * 1300 * t)
                + 0.14 * math.sin(2 * math.pi * 2100 * t)
            )

        x = max(-1.0, min(1.0, engine + speech))
        return (x, x)

    test_samples = [sample_at(i) for i in range(total)]

    cfg = DenoiseConfig(sample_rate=sr, channels=channels)
    reducer = F1EngineNoiseReducer(cfg)
    out = reducer.process_samples(test_samples)
    out.extend(reducer.flush())

    def rms(vals: Sequence[float]) -> float:
        if not vals:
            return 0.0
        return math.sqrt(sum(v * v for v in vals) / len(vals))

    nonspeech_in: List[float] = []
    nonspeech_out: List[float] = []
    speech_in: List[float] = []
    speech_out: List[float] = []

    for i, (x, y) in enumerate(zip(test_samples, out)):
        t = i / sr
        in_mono = 0.5 * (x[0] + x[1])
        out_mono = 0.5 * (y[0] + y[1])
        in_speech_window = (1.2 <= t <= 2.0) or (3.5 <= t <= 4.4)
        if in_speech_window:
            speech_in.append(in_mono)
            speech_out.append(out_mono)
        else:
            nonspeech_in.append(in_mono)
            nonspeech_out.append(out_mono)

    ns_db = 20 * math.log10((rms(nonspeech_in) + 1e-12) / (rms(nonspeech_out) + 1e-12))
    sp_db = 20 * math.log10((rms(speech_in) + 1e-12) / (rms(speech_out) + 1e-12))

    print(f"non-speech reduction (dB): {ns_db:.2f}")
    print(f"speech reduction (dB): {sp_db:.2f}")

    if ns_db < 3.0:
        raise SystemExit("Self-test failed: engine/no-speech reduction was too small")
    if sp_db > ns_db:
        raise SystemExit("Self-test failed: speech was reduced more than non-speech")


def main() -> None:
    parser = argparse.ArgumentParser(description="Reduce Formula engine noise while preserving radio speech")
    parser.add_argument("--input", type=Path, help="Input WAV (16-bit PCM)")
    parser.add_argument("--output", type=Path, help="Output WAV")

    parser.add_argument("--sample-rate", type=int, default=48_000, help="Stream mode sample rate")
    parser.add_argument("--channels", type=int, default=2, help="Stream mode channels")
    parser.add_argument("--frame-ms", type=float, default=10.0, help="Processing frame size")
    parser.add_argument("--block-frames", type=int, default=480, help="Stream mode read/write block size")

    parser.add_argument("--low-gain-nospeech", type=float, default=0.12)
    parser.add_argument("--low-gain-speech", type=float, default=0.35)
    parser.add_argument("--high-gain-nospeech", type=float, default=0.48)
    parser.add_argument("--high-gain-speech", type=float, default=0.96)
    parser.add_argument("--speech-threshold", type=float, default=0.42)

    parser.add_argument("--realtime-stdin-stdout", action="store_true", help="Read/write raw s16le PCM via stdin/stdout")
    parser.add_argument("--self-test", action="store_true", help="Run synthetic test")

    args = parser.parse_args()

    cfg = DenoiseConfig(
        sample_rate=args.sample_rate,
        channels=args.channels,
        frame_ms=args.frame_ms,
        low_gain_nospeech=args.low_gain_nospeech,
        low_gain_speech=args.low_gain_speech,
        high_gain_nospeech=args.high_gain_nospeech,
        high_gain_speech=args.high_gain_speech,
        speech_threshold=args.speech_threshold,
    )

    if args.self_test:
        self_test()
        return

    if args.realtime_stdin_stdout:
        process_realtime_stdin_stdout(cfg, block_frames=args.block_frames)
        return

    if not args.input or not args.output:
        raise SystemExit("Use --input/--output for WAV mode, or --realtime-stdin-stdout for live pipe mode")

    process_wav_file(args.input, args.output, cfg)


if __name__ == "__main__":
    main()
