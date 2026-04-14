#!/usr/bin/env python3

from __future__ import annotations

import ast
import copy
import datetime
import html
import ipaddress
import json
import math
import pathlib
import socket
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

WEB_FETCH_TIMEOUT_SECONDS = 15
WEB_FETCH_MAX_BYTES = 1_000_000
WEB_FETCH_MAX_CHARS = 20_000


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
    backend: str


@dataclass(frozen=True)
class ToolPermissions:
    web: bool = False
    local_files: bool = False
    calculate: bool = False
    current_datetime: bool = False

    @classmethod
    def from_command(cls, command: dict[str, Any]) -> ToolPermissions:
        raw = command.get("tool_permissions") or {}
        return cls(
            web=bool(raw.get("web")),
            local_files=bool(raw.get("local_files")),
            calculate=bool(raw.get("calculate")),
            current_datetime=bool(raw.get("current_datetime")),
        )


class FridayToolEventHandler:
    def __init__(self, request_id: str) -> None:
        self._request_id = request_id

    def approve_tool_call(self, tool_call: dict[str, Any]) -> bool:
        function = tool_call.get("function", {})
        write_event(
            "tool_call",
            request_id=self._request_id,
            name=str(function.get("name", "")),
            args=function.get("arguments", {}) or {},
        )
        return True

    def process_tool_response(self, tool_response: dict[str, Any]) -> dict[str, Any]:
        write_event(
            "tool_result",
            request_id=self._request_id,
            name=str(tool_response.get("name", "")),
            result=tool_response.get("response"),
        )
        return tool_response


def extract_text_from_message(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                text_parts.append(part["text"])
        return "\n".join(text_parts)
    return ""


def should_force_web_search(user_text: str) -> bool:
    lowered = user_text.lower()
    return any(
        needle in lowered
        for needle in (
            "today",
            "current",
            "latest",
            "now",
            "live",
            "news",
            "weather",
            "forecast",
            "price",
            "stock",
            "score",
            "schedule",
        )
    )


def inject_web_search_results(
    prompt: dict[str, Any],
    search_result: dict[str, Any],
) -> dict[str, Any]:
    results = search_result.get("results")
    if not isinstance(results, list) or not results:
        return prompt

    lines: list[str] = []
    for result in results[:5]:
        if not isinstance(result, dict):
            continue
        pieces = [
            result.get("title", ""),
            result.get("url", ""),
            result.get("snippet", ""),
        ]
        line = " - ".join(piece for piece in pieces if isinstance(piece, str) and piece)
        if line:
            lines.append(line)

    if not lines:
        return prompt

    prefix = (
        "Live web search results for this turn:\n"
        + "\n".join(lines)
        + "\n\nUse these results as current external context when relevant."
    )
    next_prompt = copy.deepcopy(prompt)
    content = next_prompt.get("content")
    if isinstance(content, str):
        next_prompt["content"] = f"{prefix}\n\nUser request:\n{content}"
        return next_prompt
    if isinstance(content, list):
        content.insert(0, {"type": "text", "text": prefix})
        return next_prompt
    next_prompt["content"] = prefix
    return next_prompt


def extract_between(haystack: str, start_marker: str, end_marker: str) -> str:
    start = haystack.find(start_marker)
    if start == -1:
        return ""
    rest = haystack[start:]
    start_content = rest.find(">")
    if start_content == -1:
        return ""
    rest = rest[start_content + 1 :]
    end = rest.find(end_marker)
    if end == -1:
        return ""
    return rest[:end]


def strip_tags(value: str) -> str:
    output: list[str] = []
    inside_tag = False
    for ch in value:
        if ch == "<":
            inside_tag = True
        elif ch == ">":
            inside_tag = False
        elif not inside_tag:
            output.append(ch)
    return html.unescape("".join(output)).strip()


def truncate_to_char_limit(value: str, max_chars: int) -> tuple[str, bool]:
    if len(value) <= max_chars:
        return value, False
    return value[:max_chars], True


def is_disallowed_web_host(host: str) -> bool:
    lowered = host.strip().lower()
    return (
        lowered == "localhost"
        or lowered == "local"
        or lowered == "localdomain"
        or lowered.endswith(".localhost")
        or lowered.endswith(".local")
    )


def is_disallowed_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
        return True
    if isinstance(ip, ipaddress.IPv4Address):
        return ip.is_reserved
    return ip in ipaddress.ip_network("2001:db8::/32")


def validate_remote_web_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http and https URLs are allowed.")
    if parsed.username or parsed.password:
        raise ValueError("Authenticated URLs are not allowed.")

    host = parsed.hostname
    if not host:
        raise ValueError("A hostname is required.")
    if is_disallowed_web_host(host):
        raise ValueError("Local and private network hosts are blocked.")

    try:
        parsed_ip = ipaddress.ip_address(host)
    except ValueError:
        parsed_ip = None

    if parsed_ip is not None:
        if is_disallowed_ip(parsed_ip):
            raise ValueError("Local and private network hosts are blocked.")
        return url

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    resolved = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not resolved:
        raise ValueError(f"Host {host} did not resolve to a public address.")
    for *_, sockaddr in resolved:
        ip = ipaddress.ip_address(sockaddr[0])
        if is_disallowed_ip(ip):
            raise ValueError("Local and private network hosts are blocked.")

    return url


def is_supported_web_fetch_content_type(content_type: str) -> bool:
    mime = content_type.split(";", 1)[0].strip().lower()
    return mime in {
        "text/plain",
        "text/html",
        "text/markdown",
        "text/csv",
        "application/json",
        "application/xml",
        "application/xhtml+xml",
        "application/rss+xml",
    } or mime.startswith("text/")


def web_search_impl(query: str, max_results: int = 5) -> dict[str, Any]:
    if not query.strip():
        return {"error": "Query is required."}

    encoded_query = urllib.parse.quote(query)
    request = urllib.request.Request(
        f"https://html.duckduckgo.com/html/?q={encoded_query}",
        headers={"User-Agent": "Friday/0.1", "Accept-Encoding": "identity"},
    )
    try:
        with urllib.request.urlopen(request, timeout=WEB_FETCH_TIMEOUT_SECONDS) as response:
            html_body = response.read().decode("utf-8", errors="replace")
    except Exception as exc:  # pragma: no cover - exercised through integration, not unit
        return {"error": str(exc)}

    results: list[dict[str, Any]] = []
    limit = max(1, min(int(max_results), 10))
    for segment in html_body.split("result__body")[1 : limit + 1]:
        title = strip_tags(extract_between(segment, "result__a", "</a>"))
        url = ""
        if "uddg=" in segment:
            encoded_url = segment.split("uddg=", 1)[1].split("&", 1)[0]
            url = urllib.parse.unquote(encoded_url)
        snippet = strip_tags(extract_between(segment, "result__snippet", "</a>"))
        if title or url or snippet:
            results.append({"title": title, "url": url, "snippet": snippet})

    return {"query": query, "results": results, "total": len(results)}


def web_fetch_impl(url: str, max_chars: int = 5000) -> dict[str, Any]:
    if not url.strip():
        return {"error": "URL is required."}

    try:
        validated_url = validate_remote_web_url(url)
    except ValueError as exc:
        return {"error": str(exc)}

    request = urllib.request.Request(
        validated_url,
        headers={"User-Agent": "Friday/0.1", "Accept-Encoding": "identity"},
    )
    try:
        with urllib.request.urlopen(request, timeout=WEB_FETCH_TIMEOUT_SECONDS) as response:
            final_url = response.geturl()
            validate_remote_web_url(final_url)
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > WEB_FETCH_MAX_BYTES:
                return {"error": f"Response exceeds {WEB_FETCH_MAX_BYTES} bytes."}
            content_type = response.headers.get_content_type().lower()
            if not is_supported_web_fetch_content_type(content_type):
                return {"error": f"Unsupported content type: {content_type or 'unknown'}"}
            body = response.read(WEB_FETCH_MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        return {"error": f"Fetch failed with HTTP {exc.code}"}
    except Exception as exc:  # pragma: no cover - exercised through integration, not unit
        return {"error": str(exc)}

    if len(body) > WEB_FETCH_MAX_BYTES:
        return {"error": f"Response exceeds {WEB_FETCH_MAX_BYTES} bytes."}

    body_text = body.decode("utf-8", errors="replace")
    snippet, was_truncated = truncate_to_char_limit(
        strip_tags(body_text), max(1, min(int(max_chars), WEB_FETCH_MAX_CHARS))
    )
    content = f"{snippet}... [truncated]" if was_truncated else snippet
    return {
        "url": final_url,
        "content": content,
        "length": len(content),
        "contentType": content_type,
    }


_ALLOWED_BINOPS = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.Pow: lambda a, b: a**b,
    ast.Mod: lambda a, b: a % b,
    ast.FloorDiv: lambda a, b: a // b,
}
_ALLOWED_UNARYOPS = {
    ast.UAdd: lambda a: +a,
    ast.USub: lambda a: -a,
}
_ALLOWED_NAMES = {"pi": math.pi, "e": math.e, "tau": math.tau}
_ALLOWED_FUNCTIONS = {
    "abs": abs,
    "round": round,
    "sqrt": math.sqrt,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "log": math.log,
    "log10": math.log10,
    "exp": math.exp,
}


def _eval_math(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _eval_math(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.Name) and node.id in _ALLOWED_NAMES:
        return float(_ALLOWED_NAMES[node.id])
    if isinstance(node, ast.BinOp) and type(node.op) in _ALLOWED_BINOPS:
        return _ALLOWED_BINOPS[type(node.op)](_eval_math(node.left), _eval_math(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _ALLOWED_UNARYOPS:
        return _ALLOWED_UNARYOPS[type(node.op)](_eval_math(node.operand))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        func = _ALLOWED_FUNCTIONS.get(node.func.id)
        if func is None or node.keywords:
            raise ValueError("Expression contains unsupported functions.")
        return float(func(*[_eval_math(arg) for arg in node.args]))
    raise ValueError("Expression contains unsupported syntax.")


def calculate_impl(expression: str) -> dict[str, Any]:
    cleaned = expression.strip()
    if not cleaned:
        return {"error": "Expression is required."}
    try:
        parsed = ast.parse(cleaned, mode="eval")
        result = _eval_math(parsed)
    except Exception as exc:
        return {"error": str(exc)}
    return {"result": str(result)}


def get_current_datetime_impl() -> dict[str, Any]:
    now = datetime.datetime.now().astimezone()
    raw_offset = now.strftime("%z")
    if len(raw_offset) == 5:
        formatted_offset = f"{raw_offset[:3]}:{raw_offset[3:]}"
    else:
        formatted_offset = raw_offset

    utc_offset = f"UTC{formatted_offset}" if formatted_offset else "UTC"
    timezone_name = now.tzname() or "local"
    return {
        "local_iso": now.isoformat(timespec="seconds"),
        "local_datetime": (
            f"{now.strftime('%Y-%m-%d %H:%M:%S')} "
            f"({utc_offset}, {now.strftime('%A')})"
        ),
        "local_date": now.strftime("%Y-%m-%d"),
        "local_time": now.strftime("%H:%M:%S"),
        "weekday": now.strftime("%A"),
        "timezone": timezone_name,
        "utc_offset": utc_offset,
    }


def file_read_impl(path: str) -> dict[str, Any]:
    file_path = pathlib.Path(path)
    if not file_path.exists():
        return {"error": f"File not found: {file_path}"}
    try:
        content = file_path.read_text()
    except Exception as exc:
        return {"error": str(exc)}
    return {"content": content[:50000], "size": len(content)}


def list_directory_impl(path: str) -> dict[str, Any]:
    dir_path = pathlib.Path(path)
    try:
        entries = list(dir_path.iterdir())
    except Exception as exc:
        return {"error": str(exc)}

    items = []
    for entry in entries:
        try:
            size = entry.stat().st_size
        except Exception:
            size = None
        items.append(
            {
                "name": entry.name,
                "type": "dir" if entry.is_dir() else "file",
                "size": size,
            }
        )
    return {"entries": items, "total": len(items)}


def build_tools(tool_permissions: ToolPermissions) -> list[Any]:
    tools: list[Any] = []

    if tool_permissions.current_datetime:

        def get_current_datetime() -> dict[str, Any]:
            """Get the device's current local date and time.

            Use this whenever the user asks about the current date or time,
            what day it is, or relative dates like today, yesterday, and tomorrow.
            """

            return get_current_datetime_impl()

        tools.append(get_current_datetime)

    if tool_permissions.web:

        def web_search(query: str, max_results: int = 5) -> dict[str, Any]:
            """Search the web for current information.

            Args:
                query: The search query.
                max_results: The maximum number of results to return.
            """

            return web_search_impl(query, max_results)

        def web_fetch(url: str, max_chars: int = 5000) -> dict[str, Any]:
            """Fetch a URL and extract visible text content.

            Args:
                url: The URL to fetch.
                max_chars: The maximum number of visible characters to return.
            """

            return web_fetch_impl(url, max_chars)

        tools.extend([web_search, web_fetch])

    if tool_permissions.local_files:

        def file_read(path: str) -> dict[str, Any]:
            """Read a local text file from disk.

            Args:
                path: The file path to read.
            """

            return file_read_impl(path)

        def list_directory(path: str) -> dict[str, Any]:
            """List files and folders in a local directory.

            Args:
                path: The directory path to inspect.
            """

            return list_directory_impl(path)

        tools.extend([file_read, list_directory])

    if tool_permissions.calculate:

        def calculate(expression: str) -> dict[str, Any]:
            """Evaluate a simple math expression.

            Args:
                expression: The expression to evaluate.
            """

            return calculate_impl(expression)

        tools.append(calculate)

    return tools


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

    def _resolve_backend(self, backend: str, litert_lm: Any) -> Any:
        normalized = backend.strip().lower()
        if normalized == "gpu":
            return litert_lm.Backend.GPU
        if normalized == "cpu":
            return litert_lm.Backend.CPU
        raise ValueError(f"Unsupported LiteRT backend: {backend}")

    def ensure_engine(
        self,
        model_path: str,
        max_num_tokens: int,
        backend: str,
    ) -> None:
        next_config = EngineConfig(
            model_path=model_path,
            max_num_tokens=max_num_tokens,
            backend=backend,
        )
        if self._engine is not None and self._engine_config == next_config:
            return

        self.close_engine()
        litert_lm = self._load_litert_module()
        main_backend = self._resolve_backend(backend, litert_lm)
        engine = litert_lm.Engine(
            model_path,
            backend=main_backend,
            max_num_tokens=max_num_tokens,
            # Gemma 4 image prompts require the Metal-backed vision encoder on
            # macOS; CPU vision initialization accepts images but does not
            # actually ground responses in them.
            vision_backend=litert_lm.Backend.GPU,
            # Gemma 4 audio inputs currently require the CPU audio backend even
            # when the main model executor runs on GPU.
            audio_backend=litert_lm.Backend.CPU,
        )
        engine.__enter__()
        self._engine = engine
        self._engine_config = next_config

    def handle_warm(self, command: dict[str, Any]) -> None:
        model_path = str(command["model_path"])
        max_num_tokens = int(command["max_num_tokens"])
        backend = str(command.get("backend") or "cpu")
        self.ensure_engine(
            model_path,
            max_num_tokens,
            backend,
        )
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
        tool_permissions = ToolPermissions.from_command(command)
        thinking_enabled = bool(generation_config.get("thinking_enabled"))
        user_text = extract_text_from_message(prompt)
        if tool_permissions.web and should_force_web_search(user_text):
            search_args = {"query": user_text, "max_results": 5}
            write_event(
                "tool_call",
                request_id=request_id,
                name="web_search",
                args=search_args,
            )
            search_result = web_search_impl(user_text, 5)
            write_event(
                "tool_result",
                request_id=request_id,
                name="web_search",
                result=search_result,
            )
            prompt = inject_web_search_results(prompt, search_result)

        tools = build_tools(tool_permissions)
        tool_handler = FridayToolEventHandler(request_id) if tools else None

        conversation = self._engine.create_conversation(
            messages=preface or None,
            tools=tools or None,
            tool_event_handler=tool_handler,
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
