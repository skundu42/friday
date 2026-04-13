#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import struct
import subprocess
import sys
import tarfile
import tempfile
import wave
import zipfile
import zlib
from typing import Any


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_ARCHIVE = (
    REPO_ROOT
    / "src-tauri"
    / "resources"
    / "litert-python"
    / "macos-aarch64"
    / "cpython-3.12.10+20250521-aarch64-apple-darwin-install_only.tar.gz"
)
PYTHON_WHEEL = (
    REPO_ROOT
    / "src-tauri"
    / "resources"
    / "litert-python"
    / "macos-aarch64"
    / "wheelhouse"
    / "litert_lm_api-0.10.1-cp312-cp312-macosx_12_0_arm64.whl"
)
WORKER_SCRIPT = (
    REPO_ROOT
    / "src-tauri"
    / "resources"
    / "litert-python"
    / "macos-aarch64"
    / "worker"
    / "friday_litert_worker.py"
)
DEFAULT_MODEL_PATH = pathlib.Path.home() / "Library/Application Support/com.friday.app/lit-home/models/gemma-4-e2b-it/model.litertlm"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=pathlib.Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--blockscout-image", type=pathlib.Path)
    parser.add_argument("--audio-path", type=pathlib.Path)
    return parser.parse_args()


def ensure_runtime(temp_root: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
    runtime_dir = temp_root / "runtime"
    python_dir = runtime_dir / "python"
    site_dir = runtime_dir / "python-site"

    with tarfile.open(PYTHON_ARCHIVE, "r:gz") as archive:
        archive.extractall(runtime_dir)

    with zipfile.ZipFile(PYTHON_WHEEL) as archive:
        archive.extractall(site_dir)

    python_binary = python_dir / "bin" / "python3"
    return python_binary, site_dir, python_dir / "lib"


def make_png(path: pathlib.Path) -> None:
    width = 96
    height = 96
    raw = b"".join(b"\x00" + bytes([220, 30, 30]) * width for _ in range(height))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    data = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, level=9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(data)


def make_tone_wav(path: pathlib.Path) -> None:
    sample_rate = 16_000
    duration_seconds = 1.2
    frequency = 440.0
    amplitude = 0.35
    frames: list[bytes] = []

    for sample_index in range(int(sample_rate * duration_seconds)):
        value = int(
            amplitude
            * 32767
            * math.sin(2.0 * math.pi * frequency * sample_index / sample_rate)
        )
        frames.append(struct.pack("<h", value))

    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"".join(frames))


class WorkerProcess:
    def __init__(
        self,
        python_binary: pathlib.Path,
        site_dir: pathlib.Path,
        python_lib_dir: pathlib.Path,
    ) -> None:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONNOUSERSITE"] = "1"
        env["PYTHONPATH"] = str(site_dir)
        env["DYLD_LIBRARY_PATH"] = f"{site_dir / 'litert_lm'}:{python_lib_dir}"
        self.process = subprocess.Popen(
            [str(python_binary), str(WORKER_SCRIPT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        assert self.process.stderr is not None

    def send(self, payload: dict[str, Any]) -> None:
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()

    def recv(self) -> dict[str, Any]:
        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read()
            raise RuntimeError(f"worker exited early: {stderr}")
        return json.loads(line)

    def close(self) -> None:
        try:
            self.send({"type": "shutdown"})
        except Exception:
            pass
        self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()


def expect_ready(worker: WorkerProcess, model_path: pathlib.Path, max_num_tokens: int) -> None:
    worker.send(
        {
            "type": "warm",
            "model_path": str(model_path),
            "max_num_tokens": max_num_tokens,
        }
    )
    event = worker.recv()
    if event.get("type") != "ready":
        raise RuntimeError(f"expected ready event, got {event}")


def run_chat(
    worker: WorkerProcess,
    *,
    model_path: pathlib.Path,
    request_id: str,
    messages: list[dict[str, Any]],
    thinking_enabled: bool = False,
    max_num_tokens: int = 4096,
) -> tuple[str, str]:
    worker.send(
        {
            "type": "chat",
            "request_id": request_id,
            "model_path": str(model_path),
            "max_num_tokens": max_num_tokens,
            "generation_config": {
                "max_output_tokens": 512,
                "thinking_enabled": thinking_enabled,
            },
            "messages": messages,
        }
    )

    answer_parts: list[str] = []
    thought_parts: list[str] = []

    while True:
        event = worker.recv()
        event_type = event.get("type")
        if event_type == "token":
            answer_parts.append(event.get("text", ""))
        elif event_type == "thought":
            thought_parts.append(event.get("text", ""))
        elif event_type == "done":
            break
        elif event_type == "error":
            raise RuntimeError(f"worker chat failed: {event}")

    return "".join(answer_parts), "".join(thought_parts)


def main() -> int:
    args = parse_args()
    if not args.model_path.exists():
        print(f"Model file not found: {args.model_path}", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="friday-worker-smoke-") as temp_dir_name:
        temp_dir = pathlib.Path(temp_dir_name)
        python_binary, site_dir, python_lib_dir = ensure_runtime(temp_dir)
        worker = WorkerProcess(python_binary, site_dir, python_lib_dir)

        try:
            expect_ready(worker, args.model_path, 4096)

            text_answer, _ = run_chat(
                worker,
                model_path=args.model_path,
                request_id="text-smoke",
                messages=[{"role": "user", "content": "Reply with exactly: smoke ok"}],
            )
            print("text:", text_answer.strip())

            generated_image = temp_dir / "red-square.png"
            make_png(generated_image)
            image_path = args.blockscout_image or generated_image
            image_prompt = (
                "Describe this screenshot."
                if args.blockscout_image
                else "What color is the square in this image?"
            )
            image_answer, _ = run_chat(
                worker,
                model_path=args.model_path,
                request_id="image-smoke",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "image", "path": str(image_path)},
                            {"type": "text", "text": image_prompt},
                        ],
                    }
                ],
            )
            print("image:", image_answer.strip())

            tone_path = args.audio_path or (temp_dir / "tone.wav")
            if args.audio_path is None:
                make_tone_wav(tone_path)
            audio_answer, _ = run_chat(
                worker,
                model_path=args.model_path,
                request_id="audio-smoke",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "audio", "path": str(tone_path)},
                            {
                                "type": "text",
                                "text": "Does this audio contain speech or a simple tone?",
                            },
                        ],
                    }
                ],
            )
            print("audio:", audio_answer.strip())

            thinking_answer, thinking_trace = run_chat(
                worker,
                model_path=args.model_path,
                request_id="thinking-smoke",
                thinking_enabled=True,
                messages=[
                    {
                        "role": "system",
                        "content": "Answer accurately and concisely.",
                    },
                    {"role": "user", "content": "What is 13 + 29?"},
                ],
            )
            print("thinking:", thinking_answer.strip())
            print("thought-bytes:", len(thinking_trace))

            if "smoke ok" not in text_answer.lower():
                raise RuntimeError("text smoke did not return the expected phrase")
            normalized_image_answer = image_answer.lower()
            if args.blockscout_image:
                expected_keywords = ("blockscout", "gnosis", "explorer", "dashboard")
                if not any(keyword in normalized_image_answer for keyword in expected_keywords):
                    raise RuntimeError(
                        "image smoke did not recognize the blockscout screenshot"
                    )
            elif "red" not in normalized_image_answer:
                raise RuntimeError("image smoke did not identify the red square")
            if not audio_answer.strip():
                raise RuntimeError("audio smoke returned an empty answer")
            if "42" not in thinking_answer:
                raise RuntimeError("thinking smoke did not answer 42")
            if not thinking_trace.strip():
                raise RuntimeError("thinking smoke did not emit any thought tokens")
        finally:
            worker.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
