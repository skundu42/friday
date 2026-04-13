#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
import traceback
from dataclasses import dataclass
from typing import Any


def write_event(event_type: str, **payload: Any) -> None:
    sys.stdout.write(json.dumps({"type": event_type, **payload}) + "\n")
    sys.stdout.flush()


def split_messages_for_conversation(
    messages: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not messages:
        raise ValueError("Chat request must include at least one message.")

    prompt = messages[-1]
    if prompt.get("role") != "user":
        raise ValueError("The final message in a chat request must be from the user.")

    return messages[:-1], prompt


def chunk_to_events(
    request_id: str,
    chunk: dict[str, Any],
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    for item in chunk.get("content", []):
        if item.get("type") != "text":
            continue
        text = item.get("text", "")
        if text:
            events.append({"type": "token", "request_id": request_id, "text": text})

    channels = chunk.get("channels", {})
    if isinstance(channels, dict):
        for channel_name, channel_text in channels.items():
            if channel_name != "thought" or not channel_text:
                continue
            events.append(
                {"type": "thought", "request_id": request_id, "text": channel_text}
            )

    return events


@dataclass(frozen=True)
class EngineConfig:
    model_path: str
    max_num_tokens: int


class LiteRtWorker:
    def __init__(self) -> None:
        self._litert_lm = None
        self._engine = None
        self._engine_config: EngineConfig | None = None
        self._active_conversation = None
        self._active_request_id: str | None = None
        self._cancelled_request_id: str | None = None

    def _load_litert_module(self):
        if self._litert_lm is None:
            import litert_lm  # pylint: disable=import-outside-toplevel

            litert_lm.set_min_log_severity(litert_lm.LogSeverity.ERROR)
            self._litert_lm = litert_lm
        return self._litert_lm

    def close_engine(self) -> None:
        if self._active_conversation is not None:
            try:
                self._active_conversation.cancel_process()
            except Exception:
                pass
            try:
                self._active_conversation.__exit__(None, None, None)
            except Exception:
                pass
            self._active_conversation = None

        if self._engine is not None:
            try:
                self._engine.__exit__(None, None, None)
            finally:
                self._engine = None

        self._engine_config = None
        self._active_request_id = None
        self._cancelled_request_id = None

    def ensure_engine(self, model_path: str, max_num_tokens: int) -> None:
        next_config = EngineConfig(model_path=model_path, max_num_tokens=max_num_tokens)
        if self._engine is not None and self._engine_config == next_config:
            return

        self.close_engine()
        litert_lm = self._load_litert_module()
        engine = litert_lm.Engine(
            model_path,
            backend=litert_lm.Backend.CPU,
            max_num_tokens=max_num_tokens,
            # Gemma 4 image prompts require the Metal-backed vision encoder on
            # macOS; CPU vision initialization accepts images but does not
            # actually ground responses in them.
            vision_backend=litert_lm.Backend.GPU,
            audio_backend=litert_lm.Backend.CPU,
        )
        engine.__enter__()
        self._engine = engine
        self._engine_config = next_config

    def handle_warm(self, command: dict[str, Any]) -> None:
        model_path = str(command["model_path"])
        max_num_tokens = int(command["max_num_tokens"])
        self.ensure_engine(model_path, max_num_tokens)
        write_event(
            "ready",
            model_path=model_path,
            max_num_tokens=max_num_tokens,
        )

    def handle_chat(self, command: dict[str, Any]) -> None:
        if self._engine is None:
            raise RuntimeError("Worker received chat before warm.")

        request_id = str(command["request_id"])
        messages = command.get("messages")
        if not isinstance(messages, list):
            raise ValueError("Chat request messages must be a list.")

        preface, prompt = split_messages_for_conversation(messages)
        generation_config = command.get("generation_config") or {}
        thinking_enabled = bool(generation_config.get("thinking_enabled"))

        conversation = self._engine.create_conversation(
            messages=preface or None,
            extra_context={"enable_thinking": thinking_enabled},
        )
        conversation.__enter__()
        self._active_conversation = conversation
        self._active_request_id = request_id
        self._cancelled_request_id = None

        try:
            for chunk in conversation.send_message_async(prompt):
                for event in chunk_to_events(request_id, chunk):
                    write_event(event["type"], **{k: v for k, v in event.items() if k != "type"})
        except Exception as exc:
            if self._cancelled_request_id == request_id:
                write_event("done", request_id=request_id)
            else:
                write_event("error", request_id=request_id, message=str(exc))
                traceback.print_exc(file=sys.stderr)
        else:
            write_event("done", request_id=request_id)
        finally:
            try:
                conversation.__exit__(None, None, None)
            finally:
                self._active_conversation = None
                self._active_request_id = None
                self._cancelled_request_id = None

    def handle_cancel(self, command: dict[str, Any]) -> None:
        request_id = str(command["request_id"])
        if request_id != self._active_request_id or self._active_conversation is None:
            return

        self._cancelled_request_id = request_id
        self._active_conversation.cancel_process()

    def run(self) -> int:
        try:
            for raw_line in sys.stdin:
                line = raw_line.strip()
                if not line:
                    continue

                command = json.loads(line)
                command_type = command.get("type")

                if command_type == "warm":
                    self.handle_warm(command)
                elif command_type == "chat":
                    self.handle_chat(command)
                elif command_type == "cancel":
                    self.handle_cancel(command)
                elif command_type == "shutdown":
                    self.close_engine()
                    return 0
                else:
                    raise ValueError(f"Unsupported worker command: {command_type}")
        except Exception as exc:
            write_event("error", request_id=None, message=str(exc))
            traceback.print_exc(file=sys.stderr)
            return 1
        finally:
            self.close_engine()

        return 0


def main() -> int:
    return LiteRtWorker().run()


if __name__ == "__main__":
    raise SystemExit(main())
