#!/usr/bin/env python3
"""Real-time Formula car audio denoiser with no third-party dependencies.

This processor gently reduces steady engine/background noise while preserving
intermittent verbal/radio communication.
"""

from __future__ import annotations

import argparse
import cmath
import math
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Generator, Iterable, List, Sequence, Tuple


@dataclass
class DenoiseConfig:
    sample_rate: int = 16_000
    frame_ms: float = 20.0
    overlap: float = 0.5
    reduction_strength: float = 0.32
    min_gain: float = 0.72
    noise_rise: float = 0.06
    noise_fall: float = 0.002
    speech_threshold: float = 0.55


class F1AudioDenoiser:
    """Streaming denoiser for Formula audio.

    Conservative processing is used so that engine character remains present.
    """

    def __init__(self, config: DenoiseConfig):
        self.config = config
        self.frame_len = int(config.sample_rate * config.frame_ms / 1000.0)
        self.hop = int(self.frame_len * (1.0 - config.overlap))
        if self.frame_len < 32:
            raise ValueError("frame size too small")
        if self.hop <= 0:
            raise ValueError("overlap too high; hop must be > 0")

        self.window = [0.5 - 0.5 * math.cos(2.0 * math.pi * n / (self.frame_len - 1)) for n in range(self.frame_len)]
        self.win_energy = sum(w * w for w in self.window)

        self.freq_bins = self.frame_len // 2 + 1
        self.noise_psd = [1e-5] * self.freq_bins
        self.initialized = False

        self.in_buffer: List[float] = []
        self.ola_buffer: List[float] = [0.0] * self.frame_len

        nyquist = self.config.sample_rate / 2.0
        self.freqs = [k * nyquist / (self.freq_bins - 1) for k in range(self.freq_bins)]
        self.speech_idx = [i for i, f in enumerate(self.freqs) if 250 <= f <= 3800]
        self.low_idx = [i for i, f in enumerate(self.freqs) if 40 <= f <= 200]

    def _rfft(self, frame: Sequence[float]) -> List[complex]:
        n = len(frame)
        out = []
        for k in range(n // 2 + 1):
            s = 0j
            ang = -2.0 * math.pi * k / n
            for i, v in enumerate(frame):
                s += v * cmath.exp(1j * ang * i)
            out.append(s)
        return out

    def _irfft(self, spectrum: Sequence[complex], n: int) -> List[float]:
        out = [0.0] * n
        for t in range(n):
            s = spectrum[0]
            for k in range(1, n // 2):
                tw = cmath.exp(1j * 2.0 * math.pi * k * t / n)
                s += spectrum[k] * tw + spectrum[k].conjugate() * tw.conjugate()
            if n % 2 == 0:
                s += spectrum[-1] * (1 if t % 2 == 0 else -1)
            out[t] = (s.real / n)
        return out

    def _speech_likelihood(self, power_spec: Sequence[float]) -> float:
        eps = 1e-10
        gm_log_sum = 0.0
        am = 0.0
        for p in power_spec:
            gm_log_sum += math.log(p + eps)
            am += (p + eps)
        geometric_mean = math.exp(gm_log_sum / len(power_spec))
        arithmetic_mean = am / len(power_spec)
        flatness = geometric_mean / arithmetic_mean

        speech_energy = sum(power_spec[i] for i in self.speech_idx) + eps
        low_energy = sum(power_spec[i] for i in self.low_idx) + eps
        ratio = speech_energy / (speech_energy + low_energy)

        score = 0.7 * ratio + 0.3 * (1.0 - flatness)
        return max(0.0, min(1.0, score))

    def _update_noise(self, power_spec: Sequence[float], speech_prob: float) -> None:
        if not self.initialized:
            self.noise_psd = [float(p) for p in power_spec]
            self.initialized = True
            return

        adapt = self.config.noise_rise if speech_prob < self.config.speech_threshold else self.config.noise_fall
        inv = 1.0 - adapt
        self.noise_psd = [inv * n + adapt * p for n, p in zip(self.noise_psd, power_spec)]

    def _frame_process(self, frame: Sequence[float]) -> List[float]:
        win_frame = [x * w for x, w in zip(frame, self.window)]
        spec = self._rfft(win_frame)
        power_spec = [s.real * s.real + s.imag * s.imag for s in spec]

        speech_prob = self._speech_likelihood(power_spec)
        self._update_noise(power_spec, speech_prob)

        gains = []
        min_gain = min(0.95, self.config.min_gain + 0.15 * speech_prob)
        for p, n in zip(power_spec, self.noise_psd):
            post_snr = p / (n + 1e-10)
            base_gain = post_snr / (1.0 + post_snr)
            target_gain = (1.0 - self.config.reduction_strength) + self.config.reduction_strength * base_gain
            gains.append(max(min_gain, min(1.0, target_gain)))

        out_spec = [s * g for s, g in zip(spec, gains)]
        return self._irfft(out_spec, self.frame_len)

    def process_chunk(self, chunk: Sequence[float]) -> List[float]:
        self.in_buffer.extend(float(c) for c in chunk)
        out: List[float] = []

        while len(self.in_buffer) >= self.frame_len:
            frame = self.in_buffer[: self.frame_len]
            processed = self._frame_process(frame)

            for i in range(self.frame_len):
                self.ola_buffer[i] += processed[i] * self.window[i]

            out.extend(self.ola_buffer[: self.hop])
            self.ola_buffer = self.ola_buffer[self.hop :] + [0.0] * self.hop
            self.in_buffer = self.in_buffer[self.hop :]

        norm = self.win_energy / self.hop
        return [s / norm for s in out]

    def flush(self) -> List[float]:
        tail: List[float] = []
        if self.in_buffer:
            padded = self.in_buffer + [0.0] * (self.frame_len - len(self.in_buffer))
            tail.extend(self.process_chunk(padded))

        norm = self.win_energy / self.hop
        tail.extend(s / norm for s in self.ola_buffer)

        self.in_buffer = []
        self.ola_buffer = [0.0] * self.frame_len
        return tail


def pcm16_to_float(x: bytes) -> List[float]:
    out = []
    for i in range(0, len(x), 2):
        sample = int.from_bytes(x[i : i + 2], byteorder="little", signed=True)
        out.append(max(-1.0, min(1.0, sample / 32768.0)))
    return out


def float_to_pcm16(x: Sequence[float]) -> bytes:
    b = bytearray()
    for s in x:
        v = int(max(-1.0, min(1.0, s)) * 32767.0)
        b.extend(int(v).to_bytes(2, byteorder="little", signed=True))
    return bytes(b)


def read_wav_mono(path: Path) -> Tuple[List[float], int]:
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        sample_rate = wf.getframerate()
        width = wf.getsampwidth()
        frames = wf.getnframes()
        if width != 2:
            raise ValueError("Only 16-bit PCM WAV is supported")

        raw = wf.readframes(frames)

    samples = pcm16_to_float(raw)
    if channels == 1:
        return samples, sample_rate
    if channels == 2:
        mono: List[float] = []
        for i in range(0, len(samples), 2):
            mono.append((samples[i] + samples[i + 1]) * 0.5)
        return mono, sample_rate
    raise ValueError("Only mono or stereo WAV is supported")


def write_wav_mono(path: Path, audio: Sequence[float], sample_rate: int) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(float_to_pcm16(audio))


def chunked(audio: Sequence[float], n: int) -> Generator[List[float], None, None]:
    for i in range(0, len(audio), n):
        yield list(audio[i : i + n])


def process_stream(audio: Iterable[Sequence[float]], denoiser: F1AudioDenoiser) -> List[float]:
    out: List[float] = []
    for c in audio:
        out.extend(denoiser.process_chunk(c))
    out.extend(denoiser.flush())
    return out


def _rms(x: Sequence[float]) -> float:
    if not x:
        return 0.0
    return math.sqrt(sum(v * v for v in x) / len(x))


def self_test() -> None:
    """Simple synthetic test for quick local validation."""
    sr = 16_000
    seconds = 4.0
    total = int(sr * seconds)
    t = [i / sr for i in range(total)]

    # Engine bed: low-frequency tones + harmonics.
    engine = [
        0.55 * math.sin(2 * math.pi * 120 * ti)
        + 0.22 * math.sin(2 * math.pi * 240 * ti)
        + 0.15 * math.sin(2 * math.pi * 360 * ti)
        for ti in t
    ]

    # Speech-like bursts: amplitude-modulated mixture in voice bands.
    speech = [0.0] * total
    for i, ti in enumerate(t):
        burst = 0.0
        if 0.9 <= ti <= 1.6 or 2.4 <= ti <= 3.2:
            env = 0.5 * (1.0 + math.sin(2 * math.pi * 3.7 * ti))
            burst = env * (
                0.32 * math.sin(2 * math.pi * 650 * ti)
                + 0.24 * math.sin(2 * math.pi * 1150 * ti)
                + 0.18 * math.sin(2 * math.pi * 1900 * ti)
            )
        speech[i] = burst

    mix = [max(-1.0, min(1.0, e + s)) for e, s in zip(engine, speech)]

    denoiser = F1AudioDenoiser(DenoiseConfig(sample_rate=sr))
    cleaned = process_stream(chunked(mix, denoiser.hop), denoiser)
    cleaned = cleaned[: len(mix)]

    nonspeech_idx = [i for i, ti in enumerate(t) if not (0.9 <= ti <= 1.6 or 2.4 <= ti <= 3.2)]
    speech_idx = [i for i, ti in enumerate(t) if (0.9 <= ti <= 1.6 or 2.4 <= ti <= 3.2)]

    in_nonspeech = _rms([mix[i] for i in nonspeech_idx])
    out_nonspeech = _rms([cleaned[i] for i in nonspeech_idx])

    in_speech = _rms([mix[i] for i in speech_idx])
    out_speech = _rms([cleaned[i] for i in speech_idx])

    nonspeech_drop_db = 20 * math.log10((in_nonspeech + 1e-9) / (out_nonspeech + 1e-9))
    speech_drop_db = 20 * math.log10((in_speech + 1e-9) / (out_speech + 1e-9))

    print(f"non-speech reduction (dB): {nonspeech_drop_db:.2f}")
    print(f"speech reduction (dB): {speech_drop_db:.2f}")

    if nonspeech_drop_db < 0.8:
        raise SystemExit("Self-test failed: non-speech reduction too small")
    if speech_drop_db > nonspeech_drop_db:
        raise SystemExit("Self-test failed: speech reduced more than non-speech")


def main() -> None:
    parser = argparse.ArgumentParser(description="Reduce Formula engine noise while preserving voice")
    parser.add_argument("--input", type=Path, help="Input 16-bit PCM WAV")
    parser.add_argument("--output", type=Path, help="Output denoised WAV")
    parser.add_argument("--strength", type=float, default=0.32, help="Reduction strength [0..1]")
    parser.add_argument("--min-gain", type=float, default=0.72, help="Minimum retained gain [0..1]")
    parser.add_argument("--stream-demo", action="store_true", help="Process in small chunks to emulate streaming")
    parser.add_argument("--self-test", action="store_true", help="Run built-in synthetic validation")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return

    if not args.input or not args.output:
        raise SystemExit("--input and --output are required unless --self-test is used")

    x, sr = read_wav_mono(args.input)
    cfg = DenoiseConfig(sample_rate=sr, reduction_strength=args.strength, min_gain=args.min_gain)
    denoiser = F1AudioDenoiser(cfg)

    if args.stream_demo:
        y = process_stream(chunked(x, max(128, denoiser.hop // 2)), denoiser)
    else:
        y = process_stream([x], denoiser)

    write_wav_mono(args.output, y, sr)


if __name__ == "__main__":
    main()
