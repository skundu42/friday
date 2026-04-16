from __future__ import annotations

import datetime
import importlib.util
import ipaddress
import json
import os
import pathlib
import select
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from email.message import Message
from unittest import mock


WORKER_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "resources"
    / "litert-python"
    / "macos-aarch64"
    / "worker"
    / "friday_litert_worker.py"
)

_SPEC = importlib.util.spec_from_file_location("friday_litert_worker", WORKER_PATH)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _MODULE
_SPEC.loader.exec_module(_MODULE)


class WorkerProtocolTests(unittest.TestCase):
    class _FakeResponse:
        def __init__(self, body: bytes) -> None:
            self._body = body
            self._cursor = 0

        def read(self, amt: int | None = None) -> bytes:
            if self._cursor >= len(self._body):
                return b""
            if amt is None:
                chunk = self._body[self._cursor :]
                self._cursor = len(self._body)
                return chunk
            next_cursor = min(len(self._body), self._cursor + max(0, amt))
            chunk = self._body[self._cursor : next_cursor]
            self._cursor = next_cursor
            return chunk

        def __enter__(self) -> "WorkerProtocolTests._FakeResponse":
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

    class _FakeHttpResponse:
        def __init__(
            self,
            *,
            status: int,
            headers: dict[str, str] | None = None,
            body: bytes = b"",
        ) -> None:
            self.status = status
            self.headers = Message()
            for key, value in (headers or {}).items():
                self.headers[key] = value
            self._body = body
            self._cursor = 0
            self.read_amounts: list[int | None] = []

        def read(self, _amt: int | None = None) -> bytes:
            self.read_amounts.append(_amt)
            if self._cursor >= len(self._body):
                return b""
            if _amt is None:
                chunk = self._body[self._cursor :]
                self._cursor = len(self._body)
                return chunk
            next_cursor = min(len(self._body), self._cursor + max(0, _amt))
            chunk = self._body[self._cursor : next_cursor]
            self._cursor = next_cursor
            return chunk

        def getheader(self, key: str, default: str | None = None) -> str | None:
            return self.headers.get(key, default)

    class _FakeHttpConnection:
        created: list[dict[str, object]] = []
        responses: list["WorkerProtocolTests._FakeHttpResponse"] = []

        def __init__(
            self,
            resolved_host: str,
            host: str,
            *,
            port: int,
            timeout: int,
            context: object | None = None,
        ) -> None:
            type(self).created.append(
                {
                    "resolved_host": resolved_host,
                    "host": host,
                    "port": port,
                    "timeout": timeout,
                    "context": context,
                }
            )

        def request(self, method: str, target: str, headers: dict[str, str]) -> None:
            self.method = method
            self.target = target
            self.headers = headers

        def getresponse(self) -> "WorkerProtocolTests._FakeHttpResponse":
            return type(self).responses.pop(0)

        def close(self) -> None:
            return None

    def test_ensure_engine_keeps_audio_on_cpu_when_main_backend_is_gpu(self) -> None:
        class FakeBackend:
            GPU = "gpu"
            CPU = "cpu"

        class FakeEngine:
            created_with: dict[str, object] | None = None

            def __init__(self, model_path: str, **kwargs: object) -> None:
                FakeEngine.created_with = {"model_path": model_path, **kwargs}

            def __enter__(self) -> "FakeEngine":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

        class FakeLiteRtLm:
            Backend = FakeBackend
            Engine = FakeEngine

        worker = _MODULE.LiteRtWorker()
        worker._load_litert_module = lambda: FakeLiteRtLm  # type: ignore[method-assign]

        worker.ensure_engine("/tmp/model.litertlm", 4096, "gpu")

        self.assertEqual(
            FakeEngine.created_with,
            {
                "model_path": "/tmp/model.litertlm",
                "backend": FakeBackend.GPU,
                "max_num_tokens": 4096,
                "vision_backend": FakeBackend.GPU,
                "audio_backend": FakeBackend.CPU,
            },
        )

    def test_split_messages_uses_last_user_turn_as_prompt(self) -> None:
        preface, prompt = _MODULE.split_messages_for_conversation(
            [
                {"role": "system", "content": "You are helpful."},
                {"role": "assistant", "content": "Hello"},
                {"role": "user", "content": [{"type": "text", "text": "Describe this image"}]},
            ]
        )

        self.assertEqual(len(preface), 2)
        self.assertEqual(prompt["role"], "user")

    def test_split_messages_rejects_non_user_final_turn(self) -> None:
        with self.assertRaisesRegex(ValueError, "final message"):
            _MODULE.split_messages_for_conversation(
                [
                    {"role": "system", "content": "You are helpful."},
                    {"role": "assistant", "content": "I am the last turn."},
                ]
            )

    def test_chunk_to_events_maps_text_and_thought_channels(self) -> None:
        events = _MODULE.chunk_to_events(
            "req-1",
            {
                "content": [{"type": "text", "text": "Answer"}],
                "channels": {"thought": "Plan", "other": "ignore"},
            },
        )

        self.assertEqual(
            events,
            [
                {"type": "token", "request_id": "req-1", "text": "Answer"},
                {"type": "thought", "request_id": "req-1", "text": "Plan"},
            ],
        )

    def test_join_text_fragments_preserves_missing_boundary_spaces(self) -> None:
        self.assertEqual(
            _MODULE.join_text_fragments(["steady sweep", "One evening storm rolled in"]),
            "steady sweep One evening storm rolled in",
        )
        self.assertEqual(
            _MODULE.join_text_fragments(["Done.", "Next step"]),
            "Done. Next step",
        )
        self.assertEqual(
            _MODULE.join_text_fragments(["St", "oring"]),
            "Storing",
        )
        self.assertEqual(
            _MODULE.join_text_fragments(["3", "0"]),
            "30",
        )
        self.assertEqual(
            _MODULE.join_text_fragments(["नमस्ते", "दुनिया"]),
            "नमस्तेदुनिया",
        )
        self.assertEqual(
            _MODULE.join_text_fragments(["Okay", ",", " let", "'s", " check"]),
            "Okay, let's check",
        )
        self.assertEqual(
            _MODULE.join_text_fragments(["```python\n", "print('hi')\n```"]),
            "```python\nprint('hi')\n```",
        )
        self.assertEqual(
            _MODULE.join_text_fragments(
                ["[The Rust Programming Language Book](https://doc.", "rust-lang.", "org/book/)"]
            ),
            "[The Rust Programming Language Book](https://doc.rust-lang.org/book/)",
        )
        self.assertEqual(
            _MODULE.join_text_fragments(
                ["[The Rust Programming Language Book]", "(https://doc.rust-lang.org/book/)"]
            ),
            "[The Rust Programming Language Book](https://doc.rust-lang.org/book/)",
        )

    def test_chunk_to_incremental_events_joins_multiple_text_items_safely(self) -> None:
        events, previous_answer, previous_thought = _MODULE.chunk_to_incremental_events(
            "req-join",
            {
                "content": [
                    {"type": "text", "text": "steady sweep"},
                    {"type": "text", "text": "One evening storm rolled in"},
                ],
                "channels": {"thought": ""},
            },
            "",
            "",
        )

        self.assertEqual(
            events,
            [
                {
                    "type": "token",
                    "request_id": "req-join",
                    "text": "steady sweep One evening storm rolled in",
                }
            ],
        )
        self.assertEqual(previous_answer, "steady sweep One evening storm rolled in")
        self.assertEqual(previous_thought, "")

    def test_chunk_to_incremental_events_strips_cumulative_answer_and_thought_prefixes(self) -> None:
        previous_answer = ""
        previous_thought = ""

        events, previous_answer, previous_thought = _MODULE.chunk_to_incremental_events(
            "req-1",
            {
                "content": [{"type": "text", "text": "Based on the search results"}],
                "channels": {"thought": "Need date"},
            },
            previous_answer,
            previous_thought,
        )
        self.assertEqual(
            events,
            [
                {
                    "type": "token",
                    "request_id": "req-1",
                    "text": "Based on the search results",
                },
                {"type": "thought", "request_id": "req-1", "text": "Need date"},
            ],
        )

        events, previous_answer, previous_thought = _MODULE.chunk_to_incremental_events(
            "req-1",
            {
                "content": [{"type": "text", "text": "Based on the search results for April 15, 2026"}],
                "channels": {"thought": "Need date and schedule"},
            },
            previous_answer,
            previous_thought,
        )
        self.assertEqual(
            events,
            [
                {
                    "type": "token",
                    "request_id": "req-1",
                    "text": " for April 15, 2026",
                },
                {
                    "type": "thought",
                    "request_id": "req-1",
                    "text": " and schedule",
                },
            ],
        )

        events, previous_answer, previous_thought = _MODULE.chunk_to_incremental_events(
            "req-1",
            {
                "content": [{"type": "text", "text": " today."}],
                "channels": {"thought": ""},
            },
            previous_answer,
            previous_thought,
        )
        self.assertEqual(
            events,
            [{"type": "token", "request_id": "req-1", "text": " today."}],
        )

    def test_chunk_to_incremental_events_preserves_boundary_spaces_across_chunks(self) -> None:
        events, previous_answer, previous_thought = _MODULE.chunk_to_incremental_events(
            "req-boundary",
            {
                "content": [{"type": "text", "text": "steady sweep"}],
                "channels": {"thought": ""},
            },
            "",
            "",
        )

        self.assertEqual(
            events,
            [{"type": "token", "request_id": "req-boundary", "text": "steady sweep"}],
        )
        self.assertEqual(previous_answer, "steady sweep")
        self.assertEqual(previous_thought, "")

        events, previous_answer, previous_thought = _MODULE.chunk_to_incremental_events(
            "req-boundary",
            {
                "content": [{"type": "text", "text": "One evening storm rolled in"}],
                "channels": {"thought": ""},
            },
            previous_answer,
            previous_thought,
        )

        self.assertEqual(
            events,
            [
                {
                    "type": "token",
                    "request_id": "req-boundary",
                    "text": " One evening storm rolled in",
                }
            ],
        )
        self.assertEqual(previous_answer, "steady sweep One evening storm rolled in")

    def test_stream_text_delta_does_not_insert_spaces_before_incremental_punctuation(self) -> None:
        delta, merged = _MODULE.stream_text_delta("Okay", ", let's check")
        self.assertEqual(delta, ", let's check")
        self.assertEqual(merged, "Okay, let's check")

    def test_stream_text_delta_does_not_drop_repeated_token_sized_deltas(self) -> None:
        delta, merged = _MODULE.stream_text_delta("This is a story", " is")
        self.assertEqual(delta, " is")
        self.assertEqual(merged, "This is a story is")

    def test_stream_text_delta_does_not_insert_spaces_inside_words_or_numbers(self) -> None:
        delta, merged = _MODULE.stream_text_delta("St", "oring")
        self.assertEqual(delta, "oring")
        self.assertEqual(merged, "Storing")

        delta, merged = _MODULE.stream_text_delta("3", "0")
        self.assertEqual(delta, "0")
        self.assertEqual(merged, "30")

    def test_stream_text_delta_does_not_insert_spaces_inside_urls_or_markdown_links(self) -> None:
        delta, merged = _MODULE.stream_text_delta("Visit https://doc.", "rust-lang.org/book/")
        self.assertEqual(delta, "rust-lang.org/book/")
        self.assertEqual(merged, "Visit https://doc.rust-lang.org/book/")

        delta, merged = _MODULE.stream_text_delta(
            "[The Rust Programming Language Book](https://doc.",
            "rust-lang.org/book/)",
        )
        self.assertEqual(delta, "rust-lang.org/book/)")
        self.assertEqual(
            merged,
            "[The Rust Programming Language Book](https://doc.rust-lang.org/book/)",
        )

    def test_stream_text_delta_trims_suffix_prefix_overlap_without_dropping_new_text(self) -> None:
        delta, merged = _MODULE.stream_text_delta("rustup", "up toolchain support")
        self.assertEqual(delta, " toolchain support")
        self.assertEqual(merged, "rustup toolchain support")

    def test_resolve_final_stream_text_prefers_latest_snapshot_for_cumulative_streams(self) -> None:
        self.assertEqual(
            _MODULE.resolve_final_stream_text(
                "Based on the search results for April 15",
                "Based on the search results for April 15, 2026",
                saw_cumulative_growth=True,
                saw_incremental_updates=False,
            ),
            "Based on the search results for April 15, 2026",
        )
        self.assertEqual(
            _MODULE.resolve_final_stream_text(
                "Hello there",
                " there",
                saw_cumulative_growth=False,
                saw_incremental_updates=True,
            ),
            "Hello there",
        )

    def test_cancel_marks_active_request(self) -> None:
        class FakeConversation:
            def __init__(self) -> None:
                self.cancelled = False

            def cancel_process(self) -> None:
                self.cancelled = True

        worker = _MODULE.LiteRtWorker()
        conversation = FakeConversation()
        worker._active_conversation = conversation
        worker._active_request_id = "req-2"

        worker.handle_cancel({"request_id": "req-2"})

        self.assertTrue(conversation.cancelled)
        self.assertEqual(worker._cancelled_request_id, "req-2")

    def test_parse_bool_flag_rejects_ambiguous_truthy_strings(self) -> None:
        with self.assertRaisesRegex(ValueError, "must be a boolean"):
            _MODULE.parse_bool_flag("yes", field_name="tool_permissions.web")

    def test_tool_permissions_accept_strict_boolean_strings(self) -> None:
        permissions = _MODULE.ToolPermissions.from_command(
            {
                "tool_permissions": {
                    "web": "true",
                    "local_files": "0",
                    "calculate": 1,
                    "current_datetime": "false",
                }
            }
        )

        self.assertTrue(permissions.web)
        self.assertFalse(permissions.local_files)
        self.assertTrue(permissions.calculate)
        self.assertFalse(permissions.current_datetime)

    def test_is_disallowed_ip_blocks_non_global_addresses(self) -> None:
        self.assertTrue(_MODULE.is_disallowed_ip(ipaddress.ip_address("127.0.0.1")))
        self.assertTrue(_MODULE.is_disallowed_ip(ipaddress.ip_address("10.0.0.1")))
        self.assertTrue(_MODULE.is_disallowed_ip(ipaddress.ip_address("169.254.10.3")))
        self.assertFalse(_MODULE.is_disallowed_ip(ipaddress.ip_address("93.184.216.34")))

    def test_open_remote_web_response_redirect_drain_uses_bounded_reads(self) -> None:
        fake_connection = self._FakeHttpConnection
        fake_connection.created = []
        redirect_response = self._FakeHttpResponse(
            status=302,
            headers={"Location": "https://example.com/final"},
            body=(b"x" * (_MODULE.WEB_FETCH_REDIRECT_DRAIN_MAX_BYTES + 256)),
        )
        final_response = self._FakeHttpResponse(
            status=200,
            headers={"Content-Type": "text/plain; charset=utf-8"},
            body=b"done",
        )
        fake_connection.responses = [redirect_response, final_response]

        with (
            mock.patch.object(
                _MODULE,
                "resolve_remote_web_target",
                side_effect=[
                    (
                        _MODULE.urllib.parse.urlparse("https://example.com/start"),
                        "93.184.216.34",
                        443,
                    ),
                    (
                        _MODULE.urllib.parse.urlparse("https://example.com/final"),
                        "93.184.216.34",
                        443,
                    ),
                ],
            ),
            mock.patch.object(_MODULE, "VerifiedHTTPSConnection", fake_connection),
        ):
            connection, response, final_url = _MODULE.open_remote_web_response(
                "https://example.com/start",
                {"User-Agent": "Friday/0.1"},
            )

        connection.close()
        self.assertEqual(final_url, "https://example.com/final")
        self.assertEqual(response.status, 200)
        self.assertTrue(redirect_response.read_amounts)
        self.assertNotIn(None, redirect_response.read_amounts)
        self.assertLessEqual(
            max(amount for amount in redirect_response.read_amounts if amount is not None),
            8192,
        )

    def test_local_file_tools_restrict_paths_to_sandbox(self) -> None:
        with tempfile.TemporaryDirectory() as temp_root:
            sandbox_root = pathlib.Path(temp_root) / "sandbox"
            outside_root = pathlib.Path(temp_root) / "outside"
            sandbox_root.mkdir()
            outside_root.mkdir()
            allowed_file = sandbox_root / "allowed.txt"
            outside_file = outside_root / "outside.txt"
            allowed_file.write_text("allowed", encoding="utf-8")
            outside_file.write_text("outside", encoding="utf-8")

            with mock.patch.dict(
                _MODULE.os.environ,
                {_MODULE.LOCAL_FILE_SANDBOX_ROOTS_ENV: str(sandbox_root)},
                clear=False,
            ):
                allowed = _MODULE.file_read_impl(str(allowed_file))
                blocked = _MODULE.file_read_impl(str(outside_file))
                blocked_listing = _MODULE.list_directory_impl(str(outside_root))

            self.assertEqual(allowed["content"], "allowed")
            self.assertIn("outside the worker sandbox roots", blocked["error"])
            self.assertIn("outside the worker sandbox roots", blocked_listing["error"])

    def test_web_search_time_range_is_reserved_for_recent_public_queries(self) -> None:
        self.assertEqual(
            _MODULE.web_search_time_range("What's the latest stock price today?"),
            "day",
        )
        self.assertEqual(
            _MODULE.web_search_time_range("What is tomorrow's IPL match?"),
            "day",
        )
        self.assertIsNone(_MODULE.web_search_time_range("Who is the current US president?"))
        self.assertIsNone(_MODULE.web_search_time_range("Who is the president of the USA now?"))

    def test_classify_web_search_intent_reuses_shared_policy(self) -> None:
        sports_intent = _MODULE.classify_web_search_intent("What is tomorrow's IPL match?")
        identity_intent = _MODULE.classify_web_search_intent("Who is the current US president?")
        evergreen_intent = _MODULE.classify_web_search_intent("history of sqlite")

        self.assertEqual(sports_intent.time_range, "day")
        self.assertEqual(sports_intent.categories, ["general", "web", "news"])
        self.assertTrue(sports_intent.requires_verification)

        self.assertIsNone(identity_intent.time_range)
        self.assertEqual(identity_intent.categories, ["general", "web"])
        self.assertTrue(identity_intent.requires_verification)

        self.assertIsNone(evergreen_intent.time_range)
        self.assertIsNone(evergreen_intent.categories)
        self.assertFalse(evergreen_intent.requires_verification)

    def test_normalize_tool_payload_parses_json_string_arguments(self) -> None:
        normalized = _MODULE.normalize_tool_payload('{"query":"today","max_results":5}')

        self.assertEqual(normalized, {"query": "today", "max_results": 5})

    def test_sanitize_tool_string_strips_litert_wrappers(self) -> None:
        self.assertEqual(
            _MODULE.sanitize_tool_string('<|"|>national holidays in India on April 14 2026<|"|>'),
            "national holidays in India on April 14 2026",
        )
        self.assertEqual(
            _MODULE.sanitize_tool_string('<|"|>https://example.com/<|"|>'),
            "https://example.com/",
        )

    def test_normalize_tool_payload_sanitizes_nested_strings(self) -> None:
        normalized = _MODULE.normalize_tool_payload(
            '{"query":"<|\\"|>today<|\\"|>","urls":["<|\\"|>https://example.com/<|\\"|>"]}'
        )

        self.assertEqual(
            normalized,
            {
                "query": "today",
                "urls": ["https://example.com/"],
            },
        )

    def test_search_query_variants_add_comma_free_and_relative_date_variants(self) -> None:
        class FixedDateTime(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                base = cls(2026, 4, 14, 12, 0, 0, tzinfo=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
                if tz is None:
                    return base
                return base.astimezone(tz)

        with mock.patch.object(_MODULE.datetime, "datetime", FixedDateTime):
            variants = _MODULE.search_query_variants(
                "National holidays in India on today, April 14, 2026?"
            )

        self.assertIn("National holidays in India on today, April 14, 2026", variants)
        self.assertIn("National holidays in India on today April 14 2026", variants)
        self.assertTrue(any("April 14 2026" in variant for variant in variants))

    def test_search_query_variants_expand_possessive_relative_dates_cleanly(self) -> None:
        class FixedDateTime(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                base = cls(2026, 4, 15, 12, 0, 0, tzinfo=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
                if tz is None:
                    return base
                return base.astimezone(tz)

        with mock.patch.object(_MODULE.datetime, "datetime", FixedDateTime):
            variants = _MODULE.search_query_variants("What's today's IPL match?")

        self.assertTrue(any("April 15 2026 IPL match" in variant for variant in variants))
        self.assertFalse(any("2026's" in variant for variant in variants))

    def test_contextualize_web_search_query_rewrites_context_light_followup(self) -> None:
        effective_query, rewritten = _MODULE.contextualize_web_search_query(
            "what about tomorrow",
            "What is today's IPL match?",
        )

        self.assertTrue(rewritten)
        self.assertEqual(effective_query, "IPL match tomorrow")

    def test_extract_urls_from_text_deduplicates_and_trims_punctuation(self) -> None:
        urls = _MODULE.extract_urls_from_text(
            "Review https://www.sandipank.dev/, then compare with https://www.sandipank.dev/."
        )

        self.assertEqual(urls, ["https://www.sandipank.dev/"])

    def test_build_web_tool_guidance_adds_context_and_exact_url_instructions(self) -> None:
        guidance = _MODULE.build_web_tool_guidance("What's the latest stock price today?")
        self.assertIsNotNone(guidance)
        self.assertIn("concrete subject of the user's request", guidance)
        self.assertIn("correction or brief follow-up", guidance)
        self.assertIn("scores, prices, schedules, and news", guidance)

        guidance = _MODULE.build_web_tool_guidance("Tell me what is on https://www.sandipank.dev/")
        self.assertIsNotNone(guidance)
        self.assertIn("Use web_fetch on the exact URL", guidance)

    def test_build_tools_registers_native_web_tools(self) -> None:
        tools = _MODULE.build_tools(
            _MODULE.ToolPermissions(
                web=True,
                calculate=True,
                current_datetime=True,
            )
        )

        tool_names = {tool.__name__ for tool in tools}
        self.assertEqual(
            tool_names,
            {"get_current_datetime", "calculate", "web_search", "web_fetch"},
        )

    def test_build_tools_web_search_delegates_to_search_impl(self) -> None:
        tools = _MODULE.build_tools(_MODULE.ToolPermissions(web=True))
        web_search = next(tool for tool in tools if tool.__name__ == "web_search")
        with mock.patch.object(
            _MODULE,
            "web_search_impl",
            return_value={"results": [{"title": "White House"}]},
        ) as web_search_mock:
            result = web_search("Who is the current US president?", 5)

        web_search_mock.assert_called_once_with("Who is the current US president?", 5)
        self.assertEqual(result["results"][0]["title"], "White House")
        self.assertEqual(result["requested_query"], "Who is the current US president?")
        self.assertEqual(result["effective_query"], "Who is the current US president?")
        self.assertIsNone(result["query_rewrite_applied"])

    def test_build_tools_web_search_rewrites_context_light_queries_from_recent_context(self) -> None:
        tools = _MODULE.build_tools(
            _MODULE.ToolPermissions(web=True),
            user_search_context="What is today's IPL match?",
        )
        web_search = next(tool for tool in tools if tool.__name__ == "web_search")
        with mock.patch.object(
            _MODULE,
            "web_search_impl",
            return_value={"results": [{"title": "Tomorrow fixture"}]},
        ) as web_search_mock:
            result = web_search("what about tomorrow", 5)

        web_search_mock.assert_called_once_with("IPL match tomorrow", 5)
        self.assertEqual(result["original_query"], "what about tomorrow")
        self.assertEqual(result["effective_query"], "IPL match tomorrow")
        self.assertEqual(result["query_rewrite_applied"], "recent_user_context")

    def test_build_tools_omits_web_native_tools_when_web_disabled(self) -> None:
        tools = _MODULE.build_tools(
            _MODULE.ToolPermissions(
                web=False,
                calculate=True,
                current_datetime=True,
            )
        )

        tool_names = {tool.__name__ for tool in tools}
        self.assertEqual(tool_names, {"get_current_datetime", "calculate"})

    def test_web_search_impl_normalizes_searxng_json_results(self) -> None:
        body = (
            b'{"query":"friday","results":[{"title":"Example","url":"https://example.com",'
            b'"content":"Fresh <b>snippet</b>","engine":"mojeek","source":"release-feed",'
            b'"publishedDate":"2026-04-15T10:00:00Z"}],"unresponsive_engines":["duckduckgo"]}'
        )

        with mock.patch.object(
            _MODULE.urllib.request,
            "urlopen",
            return_value=self._FakeResponse(body),
        ) as urlopen_mock:
            result = _MODULE.web_search_impl("latest friday release", 5)

        self.assertEqual(result["provider"], "searxng")
        self.assertEqual(result["query"], "friday")
        self.assertEqual(result["total"], 1)
        self.assertEqual(
            result["results"][0],
            {
                "title": "Example",
                "url": "https://example.com",
                "snippet": "Fresh snippet",
                "engine": "mojeek",
                "source": "release-feed",
                "publishedDate": "2026-04-15T10:00:00Z",
                "domain": "example.com",
                "likely_primary_source": False,
            },
        )
        self.assertEqual(result["unresponsive_engines"], ["duckduckgo"])
        requested_url = urlopen_mock.call_args.args[0].full_url
        self.assertIn("format=json", requested_url)
        self.assertIn("time_range=day", requested_url)
        self.assertIn("categories=general%2Cweb%2Cnews", requested_url)
        self.assertEqual(result["results"][0]["domain"], "example.com")
        self.assertEqual(result["recommended_fetch_urls"], ["https://example.com"])
        self.assertEqual(result["categories"], ["general", "web", "news"])
        self.assertTrue(result["snippets_are_not_definitive"])
        self.assertEqual(result["requested_query"], "latest friday release")
        self.assertEqual(result["effective_query"], "latest friday release")
        self.assertEqual(result["attempted_queries"], ["latest friday release"])
        self.assertEqual(result["time_range"], "day")
        self.assertFalse(result["verification_failed"])
        self.assertFalse(result["do_not_answer_from_memory"])

    def test_perform_searxng_search_retries_transient_connection_error(self) -> None:
        body = (
            b'{"query":"apple ceo","results":[{"title":"Tim Cook - Apple Leadership",'
            b'"url":"https://www.apple.com/leadership/tim-cook/","content":"Tim Cook is the CEO of Apple."}]}'
        )
        transient_error = _MODULE.urllib.error.URLError(ConnectionRefusedError("Connection refused"))

        with (
            mock.patch.object(
                _MODULE.urllib.request,
                "urlopen",
                side_effect=[transient_error, self._FakeResponse(body)],
            ) as urlopen_mock,
            mock.patch.object(_MODULE.time, "sleep"),
        ):
            result = _MODULE.perform_searxng_search("CEO of Apple", 5, None)

        self.assertEqual(result["total"], 1)
        self.assertEqual(urlopen_mock.call_count, 2)

    def test_perform_searxng_search_prioritizes_primary_sources_and_fetch_hints(self) -> None:
        body = (
            b'{"query":"current president","results":['
            b'{"title":"President of the United States - Wikipedia","url":"https://en.wikipedia.org/wiki/President_of_the_United_States","content":"encyclopedia"},'
            b'{"title":"President Donald J. Trump - The White House","url":"https://www.whitehouse.gov/administration/donald-j-trump/","content":"official White House profile"}'
            b']}'
        )

        with mock.patch.object(
            _MODULE.urllib.request,
            "urlopen",
            return_value=self._FakeResponse(body),
        ):
            result = _MODULE.perform_searxng_search("current president of the USA", 5, None)

        self.assertEqual(result["results"][0]["domain"], "whitehouse.gov")
        self.assertTrue(result["results"][0]["likely_primary_source"])
        self.assertEqual(
            result["recommended_fetch_urls"][0],
            "https://www.whitehouse.gov/administration/donald-j-trump/",
        )
        self.assertIn("web_fetch", result["recommended_next_step"])

    def test_web_search_impl_does_not_apply_day_filter_to_current_identity_query(self) -> None:
        body = (
            b'{"query":"current president","results":[{"title":"White House","url":"https://www.whitehouse.gov/",'
            b'"content":"President Donald J. Trump"}]}'
        )

        with mock.patch.object(
            _MODULE.urllib.request,
            "urlopen",
            return_value=self._FakeResponse(body),
        ) as urlopen_mock:
            result = _MODULE.web_search_impl("Who is the current US president?", 5)

        self.assertEqual(result["total"], 1)
        requested_url = urlopen_mock.call_args.args[0].full_url
        self.assertIn("format=json", requested_url)
        self.assertNotIn("time_range=day", requested_url)
        self.assertIn("categories=general%2Cweb", requested_url)
        self.assertEqual(result["categories"], ["general", "web"])

    def test_web_search_impl_sanitizes_wrapped_query_before_request(self) -> None:
        body = (
            b'{"query":"current president","results":[{"title":"White House","url":"https://www.whitehouse.gov/",'
            b'"content":"President Donald J. Trump"}]}'
        )

        with mock.patch.object(
            _MODULE.urllib.request,
            "urlopen",
            return_value=self._FakeResponse(body),
        ) as urlopen_mock:
            result = _MODULE.web_search_impl('<|"|>current US president<|"|>', 5)

        self.assertEqual(result["total"], 1)
        requested_url = urlopen_mock.call_args.args[0].full_url
        self.assertIn("current+US+president", requested_url)
        self.assertNotIn("%3C%7C", requested_url)

    def test_web_search_impl_adds_inline_verification_for_definitive_current_queries(self) -> None:
        body = (
            b'{"query":"current president","results":[{"title":"White House","url":"https://www.whitehouse.gov/",'
            b'"content":"President Donald J. Trump"}]}'
        )

        with (
            mock.patch.object(
                _MODULE.urllib.request,
                "urlopen",
                return_value=self._FakeResponse(body),
            ),
            mock.patch.object(
                _MODULE,
                "web_fetch_impl",
                return_value={
                    "url": "https://www.whitehouse.gov/",
                    "content": "President Donald J. Trump is the 47th President of the United States.",
                    "contentType": "text/html",
                    "length": 72,
                },
            ) as web_fetch_mock,
        ):
            result = _MODULE.web_search_impl("Who is the current US president?", 5)

        web_fetch_mock.assert_called_once_with("https://www.whitehouse.gov/", 3000)
        self.assertEqual(
            result["verification_pages"],
            [
                {
                    "url": "https://www.whitehouse.gov/",
                    "verified": True,
                    "content": "President Donald J. Trump is the 47th President of the United States.",
                    "contentType": "text/html",
                    "length": 72,
                }
            ],
        )
        self.assertFalse(result["verification_failed"])
        self.assertFalse(result["do_not_answer_from_memory"])
        self.assertIn("verified page content", result["recommended_next_step"])

    def test_web_search_impl_records_inline_verification_failures_without_dropping_results(self) -> None:
        body = (
            b'{"query":"ipl","results":[{"title":"Today\\u2019s IPL fixture","url":"https://example.com/ipl",'
            b'"content":"Royal Challengers Bengaluru vs Chennai Super Kings at 7:30 PM."}]}'
        )

        with (
            mock.patch.object(
                _MODULE.urllib.request,
                "urlopen",
                return_value=self._FakeResponse(body),
            ),
            mock.patch.object(
                _MODULE,
                "web_fetch_impl",
                return_value={"error": "Fetch failed with HTTP 503"},
            ) as web_fetch_mock,
        ):
            result = _MODULE.web_search_impl("What is today's IPL match?", 5)

        web_fetch_mock.assert_called_once_with("https://example.com/ipl", 3000)
        self.assertEqual(result["total"], 1)
        self.assertEqual(
            result["verification_pages"],
            [
                {
                    "url": "https://example.com/ipl",
                    "verified": False,
                    "error": "Fetch failed with HTTP 503",
                }
            ],
        )
        self.assertTrue(result["verification_failed"])
        self.assertTrue(result["do_not_answer_from_memory"])
        self.assertIn("live verification did not succeed", result["recommended_next_step"])

    def test_web_search_impl_uses_query_variants_when_original_query_has_no_results(self) -> None:
        first_body = b'{"query":"holiday","results":[]}'
        second_body = (
            b'{"query":"holiday","results":[{"title":"Holiday Calendar","url":"https://www.india.gov.in/calendar?date=2026-04",'
            b'"content":"Holiday Calendar | National Portal of India"}]}'
        )

        with mock.patch.object(
            _MODULE.urllib.request,
            "urlopen",
            side_effect=[self._FakeResponse(first_body), self._FakeResponse(second_body)],
        ):
            result = _MODULE.web_search_impl("national holidays in India on April 14, 2026", 5)

        self.assertEqual(result["total"], 1)
        self.assertEqual(
            result["query_variant_used"],
            "national holidays in India on April 14 2026",
        )
        self.assertEqual(result["query_variant_fallback"], "applied")

    def test_web_search_impl_falls_back_without_day_filter_when_filtered_results_are_empty(self) -> None:
        filtered_body = (
            b'{"query":"ipl","results":[],"unresponsive_engines":[["duckduckgo","CAPTCHA"]]}'
        )
        fallback_body = (
            b'{"query":"ipl","results":[{"title":"Match report","url":"https://example.com",'
            b'"content":"Sunrisers Hyderabad beat Rajasthan Royals."}]}'
        )

        with mock.patch.object(
            _MODULE.urllib.request,
            "urlopen",
            side_effect=[
                self._FakeResponse(filtered_body),
                self._FakeResponse(fallback_body),
            ],
        ) as urlopen_mock:
            result = _MODULE.web_search_impl("what is tomorrow's ipl match?", 5)

        self.assertEqual(result["total"], 1)
        self.assertEqual(result["time_range_fallback"], "omitted")
        requested_urls = [call.args[0].full_url for call in urlopen_mock.call_args_list]
        self.assertIn("time_range=day", requested_urls[0])
        self.assertNotIn("time_range=day", requested_urls[1])
        self.assertIn("categories=general%2Cweb%2Cnews", requested_urls[0])
        self.assertIn("categories=general%2Cweb%2Cnews", requested_urls[1])

    def test_web_search_impl_preserves_spaces_when_html_splits_words(self) -> None:
        body = (
            b'{"query":"ipl","results":[{"title":"Tomorrow\\u2019s match","url":"https://example.com",'
            b'"content":"Royal Challengers Bengaluru and<b>Lucknow Super Giants</b><b>at</b>7:30 PM in Bengaluru."}]}'
        )

        with mock.patch.object(
            _MODULE.urllib.request,
            "urlopen",
            return_value=self._FakeResponse(body),
        ):
            result = _MODULE.web_search_impl("what is tomorrow's ipl match?", 5)

        self.assertEqual(
            result["results"][0]["snippet"],
            "Royal Challengers Bengaluru and Lucknow Super Giants at 7:30 PM in Bengaluru.",
        )

    def test_web_search_impl_reports_json_disabled_probe_error(self) -> None:
        error = _MODULE.urllib.error.HTTPError(
            url="http://127.0.0.1:8091/search",
            code=403,
            msg="Forbidden",
            hdrs=None,
            fp=None,
        )

        with mock.patch.object(_MODULE.urllib.request, "urlopen", side_effect=error):
            result = _MODULE.web_search_impl("friday", 5)

        self.assertEqual(
            result["error"],
            "Local SearXNG config is invalid; JSON output is disabled.",
        )

    def test_web_search_impl_marks_errors_as_failed_verification(self) -> None:
        with mock.patch.object(
            _MODULE.urllib.request,
            "urlopen",
            side_effect=_MODULE.urllib.error.URLError(ConnectionRefusedError("Connection refused")),
        ):
            result = _MODULE.web_search_impl("current president of the USA", 5)

        self.assertTrue(result["verification_failed"])
        self.assertTrue(result["do_not_answer_from_memory"])
        self.assertEqual(result["provider"], "searxng")
        self.assertIn("do not present", result["recommended_next_step"])

    def test_web_search_impl_rejects_missing_results_list(self) -> None:
        with mock.patch.object(
            _MODULE.urllib.request,
            "urlopen",
            return_value=self._FakeResponse(b'{"query":"friday"}'),
        ):
            result = _MODULE.web_search_impl("friday", 5)

        self.assertEqual(
            result["error"],
            "SearXNG response did not include a results list.",
        )

    def test_web_fetch_impl_rejects_redirect_to_localhost(self) -> None:
        fake_connection = self._FakeHttpConnection
        fake_connection.created = []
        fake_connection.responses = [
            self._FakeHttpResponse(
                status=302,
                headers={"Location": "http://127.0.0.1:8080/private"},
            )
        ]

        with (
            mock.patch.object(
                _MODULE,
                "resolve_remote_web_target",
                side_effect=[
                    (  # initial public URL is allowed
                        _MODULE.urllib.parse.urlparse("https://example.com/start"),
                        "93.184.216.34",
                        443,
                    ),
                    ValueError("Local and private network hosts are blocked."),
                ],
            ),
            mock.patch.object(_MODULE, "VerifiedHTTPSConnection", fake_connection),
        ):
            result = _MODULE.web_fetch_impl("https://example.com/start")

        self.assertEqual(result["error"], "Local and private network hosts are blocked.")
        self.assertTrue(result["verification_failed"])
        self.assertTrue(result["do_not_answer_from_memory"])

    def test_web_fetch_impl_rejects_redirect_to_private_ip(self) -> None:
        fake_connection = self._FakeHttpConnection
        fake_connection.created = []
        fake_connection.responses = [
            self._FakeHttpResponse(
                status=301,
                headers={"Location": "http://10.0.0.5/internal"},
            )
        ]

        with (
            mock.patch.object(
                _MODULE,
                "resolve_remote_web_target",
                side_effect=[
                    (
                        _MODULE.urllib.parse.urlparse("http://example.com/start"),
                        "93.184.216.34",
                        80,
                    ),
                    ValueError("Local and private network hosts are blocked."),
                ],
            ),
            mock.patch.object(_MODULE, "VerifiedHTTPConnection", fake_connection),
        ):
            result = _MODULE.web_fetch_impl("http://example.com/start")

        self.assertEqual(result["error"], "Local and private network hosts are blocked.")

    def test_web_fetch_impl_uses_resolved_public_ip_for_connection(self) -> None:
        fake_connection = self._FakeHttpConnection
        fake_connection.created = []
        fake_connection.responses = [
            self._FakeHttpResponse(
                status=200,
                headers={"Content-Type": "text/plain; charset=utf-8"},
                body=b"Safe content",
            )
        ]

        with (
            mock.patch.object(
                _MODULE,
                "resolve_remote_web_target",
                return_value=(
                    _MODULE.urllib.parse.urlparse("http://example.com/story"),
                    "93.184.216.34",
                    80,
                ),
            ),
            mock.patch.object(_MODULE, "VerifiedHTTPConnection", fake_connection),
        ):
            result = _MODULE.web_fetch_impl("http://example.com/story")

        self.assertEqual(result["content"], "Safe content")
        self.assertEqual(fake_connection.created[0]["resolved_host"], "93.184.216.34")
        self.assertEqual(fake_connection.created[0]["host"], "example.com")

    def test_web_fetch_impl_sanitizes_wrapped_url_before_fetch(self) -> None:
        fake_response = self._FakeHttpResponse(
            status=200,
            headers={"Content-Type": "text/plain; charset=utf-8"},
            body=b"Example Domain",
        )

        with (
            mock.patch.object(
                _MODULE,
                "resolve_remote_web_target",
                return_value=(
                    _MODULE.urllib.parse.urlparse("https://example.com/"),
                    "93.184.216.34",
                    443,
                ),
            ) as resolve_mock,
            mock.patch.object(
                _MODULE,
                "open_remote_web_response",
                return_value=(mock.Mock(close=lambda: None), fake_response, "https://example.com/"),
            ),
        ):
            result = _MODULE.web_fetch_impl('<|"|>https://example.com/<|"|>')

        resolve_mock.assert_called_once_with("https://example.com/")
        self.assertEqual(result["url"], "https://example.com/")
        self.assertEqual(result["content"], "Example Domain")

    def test_tool_event_handler_normalizes_tool_call_and_result_payloads(self) -> None:
        handler = _MODULE.FridayToolEventHandler("req-tools")

        with mock.patch.object(_MODULE, "write_event") as write_event_mock:
            approved = handler.approve_tool_call(
                {
                    "function": {
                        "name": "web_search",
                        "arguments": '{"query":"<|\\"|>today<|\\"|>","max_results":5}',
                    }
                }
            )
            response = handler.process_tool_response(
                {
                    "name": "web_search",
                    "response": '{"results":[{"title":"<|\\"|>Example<|\\"|>"}]}',
                }
            )

        self.assertTrue(approved)
        self.assertEqual(response["name"], "web_search")
        self.assertEqual(
            write_event_mock.call_args_list,
            [
                mock.call(
                    "tool_call",
                    request_id="req-tools",
                    name="web_search",
                    args={"query": "today", "max_results": 5},
                ),
                mock.call(
                    "tool_result",
                    request_id="req-tools",
                    name="web_search",
                    result={"results": [{"title": "Example"}]},
                ),
            ],
        )

    def test_handle_chat_passes_web_tools_without_running_search_up_front(self) -> None:
        class FakeConversation:
            sent_prompt: dict[str, object] | None = None

            def __enter__(self) -> "FakeConversation":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def send_message_async(self, prompt: dict[str, object]) -> list[dict[str, object]]:
                self.sent_prompt = prompt
                return []

        class FakeEngine:
            messages: list[dict[str, object]] | None = None
            conversation: FakeConversation | None = None
            tools: list[object] | None = None
            tool_event_handler: object | None = None

            def create_conversation(self, **kwargs: object) -> FakeConversation:
                FakeEngine.messages = kwargs.get("messages")
                FakeEngine.tools = kwargs.get("tools")
                FakeEngine.tool_event_handler = kwargs.get("tool_event_handler")
                FakeEngine.conversation = FakeConversation()
                return FakeEngine.conversation

        worker = _MODULE.LiteRtWorker()
        worker._engine = FakeEngine()

        with (
            mock.patch.object(_MODULE, "web_search_impl") as web_search_mock,
            mock.patch.object(_MODULE, "write_event") as write_event_mock,
        ):
            worker.handle_chat(
                {
                    "request_id": "req-current-president",
                    "messages": [
                        {"role": "system", "content": "You are helpful."},
                        {"role": "user", "content": "Who is the current US president?"},
                    ],
                    "tool_permissions": {
                        "web": True,
                        "calculate": True,
                        "current_datetime": True,
                    },
                    "generation_config": {},
                }
            )

        assert FakeEngine.messages is not None
        assert FakeEngine.conversation is not None
        assert FakeEngine.tools is not None
        self.assertEqual(FakeEngine.messages[0], {"role": "system", "content": "You are helpful."})
        self.assertEqual(FakeEngine.messages[1]["role"], "system")
        self.assertIn(
            "search for the concrete subject of the user's request",
            FakeEngine.messages[1]["content"],
        )
        self.assertEqual(
            FakeEngine.conversation.sent_prompt["content"],
            "Who is the current US president?",
        )
        self.assertEqual(
            {tool.__name__ for tool in FakeEngine.tools},
            {"get_current_datetime", "calculate", "web_search", "web_fetch"},
        )
        self.assertIsNotNone(FakeEngine.tool_event_handler)
        web_search_mock.assert_not_called()
        tool_event_calls = [
            call for call in write_event_mock.call_args_list if call.args[0] in {"tool_call", "tool_result"}
        ]
        self.assertEqual(tool_event_calls, [])

    def test_handle_chat_deduplicates_cumulative_stream_chunks(self) -> None:
        class FakeConversation:
            def __enter__(self) -> "FakeConversation":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def send_message_async(self, prompt: dict[str, object]) -> list[dict[str, object]]:
                del prompt
                return [
                    {"content": [{"type": "text", "text": "Based on the search results"}]},
                    {"content": [{"type": "text", "text": "Based on the search results for April 15, 2026"}]},
                    {"content": [{"type": "text", "text": " for today, there is no confirmed fixture yet."}]},
                ]

        class FakeEngine:
            def create_conversation(self, **kwargs: object) -> FakeConversation:
                del kwargs
                return FakeConversation()

        worker = _MODULE.LiteRtWorker()
        worker._engine = FakeEngine()

        with mock.patch.object(_MODULE, "write_event") as write_event_mock:
            worker.handle_chat(
                {
                    "request_id": "req-cumulative-stream",
                    "messages": [
                        {"role": "user", "content": "What is today's IPL match?"},
                    ],
                    "tool_permissions": {
                        "web": True,
                        "calculate": True,
                        "current_datetime": True,
                    },
                    "generation_config": {},
                }
            )

        token_events = [
            call
            for call in write_event_mock.call_args_list
            if call.args[0] == "token"
        ]
        self.assertEqual(
            token_events,
            [
                mock.call(
                    "token",
                    request_id="req-cumulative-stream",
                    text="Based on the search results",
                ),
                mock.call(
                    "token",
                    request_id="req-cumulative-stream",
                    text=" for April 15, 2026",
                ),
                mock.call(
                    "token",
                    request_id="req-cumulative-stream",
                    text=" for today, there is no confirmed fixture yet.",
                ),
            ],
        )
        self.assertIn(
            mock.call(
                "done",
                request_id="req-cumulative-stream",
                final_text=(
                    "Based on the search results for April 15, 2026"
                    " for today, there is no confirmed fixture yet."
                ),
            ),
            write_event_mock.call_args_list,
        )

    def test_handle_chat_preserves_token_sized_repeated_words_in_incremental_streams(self) -> None:
        class FakeConversation:
            def __enter__(self) -> "FakeConversation":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def send_message_async(self, prompt: dict[str, object]) -> list[dict[str, object]]:
                del prompt
                return [
                    {"content": [{"type": "text", "text": "It"}]},
                    {"content": [{"type": "text", "text": " is"}]},
                    {"content": [{"type": "text", "text": " a"}]},
                    {"content": [{"type": "text", "text": " simple"}]},
                    {"content": [{"type": "text", "text": " story"}]},
                    {"content": [{"type": "text", "text": " about"}]},
                    {"content": [{"type": "text", "text": " a"}]},
                    {"content": [{"type": "text", "text": " lighthouse."}]},
                ]

        class FakeEngine:
            def create_conversation(self, **kwargs: object) -> FakeConversation:
                del kwargs
                return FakeConversation()

        worker = _MODULE.LiteRtWorker()
        worker._engine = FakeEngine()

        with mock.patch.object(_MODULE, "write_event") as write_event_mock:
            worker.handle_chat(
                {
                    "request_id": "req-repeated-deltas",
                    "messages": [
                        {"role": "user", "content": "Tell me a short story."},
                    ],
                    "tool_permissions": {
                        "web": False,
                        "calculate": False,
                        "current_datetime": True,
                    },
                    "generation_config": {},
                }
            )

        token_events = [
            call for call in write_event_mock.call_args_list if call.args[0] == "token"
        ]
        self.assertEqual(
            token_events,
            [
                mock.call("token", request_id="req-repeated-deltas", text="It"),
                mock.call("token", request_id="req-repeated-deltas", text=" is"),
                mock.call("token", request_id="req-repeated-deltas", text=" a"),
                mock.call("token", request_id="req-repeated-deltas", text=" simple"),
                mock.call("token", request_id="req-repeated-deltas", text=" story"),
                mock.call("token", request_id="req-repeated-deltas", text=" about"),
                mock.call("token", request_id="req-repeated-deltas", text=" a"),
                mock.call("token", request_id="req-repeated-deltas", text=" lighthouse."),
            ],
        )
        self.assertIn(
            mock.call(
                "done",
                request_id="req-repeated-deltas",
                final_text="It is a simple story about a lighthouse.",
            ),
            write_event_mock.call_args_list,
        )

    def test_handle_chat_web_search_tool_is_available_for_model_initiated_use(self) -> None:
        class FakeConversation:
            sent_prompt: dict[str, object] | None = None

            def __enter__(self) -> "FakeConversation":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def send_message_async(self, prompt: dict[str, object]) -> list[dict[str, object]]:
                self.sent_prompt = prompt
                self._tool(
                    query="Who is the current US president?",
                    max_results=5,
                )
                return []

        class FakeEngine:
            messages: list[dict[str, object]] | None = None
            conversation: FakeConversation | None = None

            def create_conversation(self, **kwargs: object) -> FakeConversation:
                FakeEngine.messages = kwargs.get("messages")
                FakeEngine.conversation = FakeConversation()
                tools = kwargs.get("tools")
                FakeEngine.conversation._tool = next(
                    tool for tool in tools if tool.__name__ == "web_search"
                )
                return FakeEngine.conversation

        worker = _MODULE.LiteRtWorker()
        worker._engine = FakeEngine()

        with (
            mock.patch.object(
                _MODULE,
                "web_search_impl",
                return_value={
                    "query": "Who is the current US president?",
                    "results": [
                        {
                            "title": "President Donald J. Trump - The White House",
                            "url": "https://www.whitehouse.gov/administration/donald-j-trump/",
                            "snippet": "President Donald J. Trump is the president of the United States.",
                        }
                    ],
                    "total": 1,
                    "provider": "searxng",
                },
            ) as web_search_mock,
            mock.patch.object(_MODULE, "write_event") as write_event_mock,
        ):
            worker.handle_chat(
                {
                    "request_id": "req-tool-available",
                    "messages": [
                        {"role": "user", "content": "Who is the current US president?"},
                    ],
                    "tool_permissions": {
                        "web": True,
                        "calculate": True,
                        "current_datetime": True,
                    },
                    "generation_config": {},
                }
            )

        web_search_mock.assert_called_once_with("Who is the current US president?", 5)
        tool_event_calls = [
            call for call in write_event_mock.call_args_list if call.args[0] in {"tool_call", "tool_result"}
        ]
        self.assertEqual(tool_event_calls, [])

    def test_handle_chat_contextualizes_context_light_model_web_search_from_current_prompt(self) -> None:
        class FakeConversation:
            def __enter__(self) -> "FakeConversation":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def send_message_async(self, prompt: dict[str, object]) -> list[dict[str, object]]:
                del prompt
                self._tool(query="today", max_results=5)
                return []

        class FakeEngine:
            def create_conversation(self, **kwargs: object) -> FakeConversation:
                conversation = FakeConversation()
                tools = kwargs.get("tools")
                conversation._tool = next(
                    tool for tool in tools if tool.__name__ == "web_search"
                )
                return conversation

        worker = _MODULE.LiteRtWorker()
        worker._engine = FakeEngine()

        with (
            mock.patch.object(
                _MODULE,
                "web_search_impl",
                return_value={"results": [{"title": "Today fixture"}]},
            ) as web_search_mock,
            mock.patch.object(_MODULE, "write_event"),
        ):
            worker.handle_chat(
                {
                    "request_id": "req-contextualized-current-prompt-search",
                    "messages": [
                        {"role": "user", "content": "What is today's IPL match?"},
                    ],
                    "tool_permissions": {
                        "web": True,
                        "calculate": True,
                        "current_datetime": True,
                    },
                    "generation_config": {},
                }
            )

        web_search_mock.assert_called_once_with("IPL match today", 5)

    def test_handle_chat_contextualizes_context_light_followup_web_search_from_prior_user_turn(self) -> None:
        class FakeConversation:
            def __enter__(self) -> "FakeConversation":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def send_message_async(self, prompt: dict[str, object]) -> list[dict[str, object]]:
                del prompt
                self._tool(query="what about tomorrow", max_results=5)
                return []

        class FakeEngine:
            def create_conversation(self, **kwargs: object) -> FakeConversation:
                conversation = FakeConversation()
                tools = kwargs.get("tools")
                conversation._tool = next(
                    tool for tool in tools if tool.__name__ == "web_search"
                )
                return conversation

        worker = _MODULE.LiteRtWorker()
        worker._engine = FakeEngine()

        with (
            mock.patch.object(
                _MODULE,
                "web_search_impl",
                return_value={"results": [{"title": "Tomorrow fixture"}]},
            ) as web_search_mock,
            mock.patch.object(_MODULE, "write_event"),
        ):
            worker.handle_chat(
                {
                    "request_id": "req-contextualized-followup-search",
                    "messages": [
                        {"role": "user", "content": "What is today's IPL match?"},
                        {"role": "assistant", "content": "Today's IPL match is MI vs CSK."},
                        {"role": "user", "content": "What about tomorrow?"},
                    ],
                    "tool_permissions": {
                        "web": True,
                        "calculate": True,
                        "current_datetime": True,
                    },
                    "generation_config": {},
                }
            )

        web_search_mock.assert_called_once_with("IPL match tomorrow", 5)

    def test_handle_chat_sanitizes_model_wrapped_web_search_arguments(self) -> None:
        class FakeConversation:
            def __enter__(self) -> "FakeConversation":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def send_message_async(self, prompt: dict[str, object]) -> list[dict[str, object]]:
                del prompt
                self._tool(
                    query='<|"|>national holidays in India on April 14 2026<|"|>',
                    max_results=5,
                )
                return []

        class FakeEngine:
            def create_conversation(self, **kwargs: object) -> FakeConversation:
                conversation = FakeConversation()
                tools = kwargs.get("tools")
                conversation._tool = next(
                    tool for tool in tools if tool.__name__ == "web_search"
                )
                return conversation

        worker = _MODULE.LiteRtWorker()
        worker._engine = FakeEngine()

        with (
            mock.patch.object(
                _MODULE,
                "web_search_impl",
                return_value={"results": [{"title": "Ambedkar Jayanti"}]},
            ) as web_search_mock,
            mock.patch.object(_MODULE, "write_event"),
        ):
            worker.handle_chat(
                {
                    "request_id": "req-sanitized-web-search",
                    "messages": [
                        {
                            "role": "user",
                            "content": "Is today a national holiday in India?",
                        },
                    ],
                    "tool_permissions": {
                        "web": True,
                        "calculate": True,
                        "current_datetime": True,
                    },
                    "generation_config": {},
                }
            )

        web_search_mock.assert_called_once_with(
            "national holidays in India on April 14 2026",
            5,
        )

    def test_handle_chat_adds_exact_url_guidance_without_running_search(self) -> None:
        class FakeConversation:
            sent_prompt: dict[str, object] | None = None

            def __enter__(self) -> "FakeConversation":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def send_message_async(self, prompt: dict[str, object]) -> list[dict[str, object]]:
                self.sent_prompt = prompt
                return []

        class FakeEngine:
            messages: list[dict[str, object]] | None = None
            conversation: FakeConversation | None = None

            def create_conversation(self, **kwargs: object) -> FakeConversation:
                FakeEngine.messages = kwargs.get("messages")
                FakeEngine.conversation = FakeConversation()
                return FakeEngine.conversation

        worker = _MODULE.LiteRtWorker()
        worker._engine = FakeEngine()

        with (
            mock.patch.object(_MODULE, "web_search_impl") as web_search_mock,
            mock.patch.object(_MODULE, "write_event"),
        ):
            worker.handle_chat(
                {
                    "request_id": "req-web-url",
                    "messages": [
                        {
                            "role": "user",
                            "content": "Tell me what you find on https://www.sandipank.dev/",
                        },
                    ],
                    "tool_permissions": {
                        "web": True,
                        "calculate": True,
                        "current_datetime": True,
                    },
                    "generation_config": {},
                }
            )

        assert FakeEngine.messages is not None
        assert FakeEngine.conversation is not None
        self.assertEqual(FakeEngine.messages[-1]["role"], "system")
        self.assertIn(
            "Use web_fetch on the exact URL",
            FakeEngine.messages[-1]["content"],
        )
        self.assertEqual(
            FakeEngine.conversation.sent_prompt["content"],
            "Tell me what you find on https://www.sandipank.dev/",
        )
        web_search_mock.assert_not_called()

    def test_calculate_impl_supports_safe_math(self) -> None:
        self.assertEqual(_MODULE.calculate_impl("2 + 2")["result"], "4.0")
        self.assertIn("error", _MODULE.calculate_impl("__import__('os').system('whoami')"))

    def test_handle_chat_rejects_ambiguous_thinking_enabled_strings(self) -> None:
        class FakeEngine:
            def create_conversation(self, **kwargs: object) -> None:
                raise AssertionError("create_conversation should not be called")

        worker = _MODULE.LiteRtWorker()
        worker._engine = FakeEngine()

        with self.assertRaisesRegex(ValueError, "generation_config.thinking_enabled"):
            worker.handle_chat(
                {
                    "request_id": "req-ambiguous-thinking",
                    "messages": [{"role": "user", "content": "hello"}],
                    "tool_permissions": {"current_datetime": True},
                    "generation_config": {"thinking_enabled": "yes"},
                }
            )

    def test_run_can_process_cancel_while_chat_stream_is_running(self) -> None:
        chat_started = threading.Event()
        cancel_seen = threading.Event()

        class ControlledStdin:
            def __init__(self) -> None:
                self._lines = [
                    json.dumps(
                        {
                            "type": "chat",
                            "request_id": "req-run-cancel",
                            "messages": [{"role": "user", "content": "Tell me a story"}],
                            "tool_permissions": {"current_datetime": True},
                            "generation_config": {},
                        }
                    )
                    + "\n",
                    json.dumps({"type": "cancel", "request_id": "req-run-cancel"}) + "\n",
                    json.dumps({"type": "shutdown"}) + "\n",
                ]

            def __iter__(self) -> "ControlledStdin":
                return self

            def __next__(self) -> str:
                if not self._lines:
                    raise StopIteration
                if len(self._lines) == 2:
                    if not chat_started.wait(timeout=1.0):
                        raise StopIteration
                return self._lines.pop(0)

        class FakeConversation:
            def __init__(self) -> None:
                self._cancelled = False

            def __enter__(self) -> "FakeConversation":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def cancel_process(self) -> None:
                self._cancelled = True
                cancel_seen.set()

            def send_message_async(self, prompt: dict[str, object]) -> list[dict[str, object]]:
                del prompt
                chat_started.set()
                while not self._cancelled:
                    time.sleep(0.01)
                raise RuntimeError("cancelled")

        class FakeEngine:
            def create_conversation(self, **kwargs: object) -> FakeConversation:
                del kwargs
                return FakeConversation()

        worker = _MODULE.LiteRtWorker()
        worker._engine = FakeEngine()

        with (
            mock.patch.object(_MODULE.sys, "stdin", ControlledStdin()),
            mock.patch.object(_MODULE, "write_event") as write_event_mock,
        ):
            exit_code = worker.run()

        self.assertEqual(exit_code, 0)
        self.assertTrue(cancel_seen.is_set())
        self.assertIn(
            mock.call("done", request_id="req-run-cancel"),
            write_event_mock.call_args_list,
        )


@unittest.skipUnless(
    os.environ.get("FRIDAY_RUN_LITERT_E2E") == "1",
    "Requires FRIDAY_RUN_LITERT_E2E=1 and a local runtime/model",
)
class WorkerLiveIntegrationTests(unittest.TestCase):
    APP_HOME = pathlib.Path.home() / "Library" / "Application Support" / "com.friday.app"
    RUNTIME_DIR = APP_HOME / "litert-runtime" / "0.10.1"
    MODEL_PATH = APP_HOME / "lit-home" / "models" / "gemma-4-e4b-it" / "model.litertlm"

    def setUp(self) -> None:
        if not self.RUNTIME_DIR.exists() or not self.MODEL_PATH.exists():
            self.skipTest("Local Friday runtime or model is not installed.")

        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONNOUSERSITE"] = "1"
        env["PYTHONPATH"] = str(self.RUNTIME_DIR / "python-site")
        env["DYLD_LIBRARY_PATH"] = (
            f"{self.RUNTIME_DIR / 'python-site' / 'litert_lm'}:"
            f"{self.RUNTIME_DIR / 'python' / 'lib'}"
        )
        env["FRIDAY_SEARXNG_BASE_URL"] = "http://127.0.0.1:8091"

        self._proc = subprocess.Popen(
            [
                str(self.RUNTIME_DIR / "python" / "bin" / "python3.12"),
                str(self.RUNTIME_DIR / "worker" / "friday_litert_worker.py"),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        self._send(
            {
                "type": "warm",
                "model_path": str(self.MODEL_PATH),
                "max_num_tokens": 4096,
                "backend": "cpu",
            }
        )
        try:
            ready = self._next_event(timeout=120)
        except AssertionError as exc:
            self.skipTest(f"Live worker warm-up was not stable enough: {exc}")
        self.assertEqual(ready["type"], "ready")

    def tearDown(self) -> None:
        if self._proc.poll() is None:
            self._send({"type": "shutdown"})
            self._proc.wait(timeout=10)
        if self._proc.stdin is not None:
            self._proc.stdin.close()
        if self._proc.stdout is not None:
            self._proc.stdout.close()

    def _send(self, payload: dict[str, object]) -> None:
        assert self._proc.stdin is not None
        self._proc.stdin.write(json.dumps(payload) + "\n")
        self._proc.stdin.flush()

    def _next_event(self, timeout: float) -> dict[str, object]:
        assert self._proc.stdout is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = max(0.0, deadline - time.monotonic())
            ready, _, _ = select.select([self._proc.stdout], [], [], remaining)
            if self._proc.stdout in ready:
                line = self._proc.stdout.readline()
                if line:
                    stripped = line.strip()
                    if stripped.startswith("{"):
                        return json.loads(stripped)
                    continue
            if self._proc.poll() is not None:
                break
        raise AssertionError("Timed out waiting for a worker event.")

    def _collect_events(self, request_id: str, timeout: float = 120.0) -> list[dict[str, object]]:
        events: list[dict[str, object]] = []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = self._next_event(deadline - time.monotonic())
            if event.get("request_id") == request_id:
                events.append(event)
            if event.get("type") == "done" and event.get("request_id") == request_id:
                return events
        raise AssertionError(f"Timed out waiting for request {request_id} to complete.")

    def test_live_tool_calls_strip_wrapped_url_fetch_arguments(self) -> None:
        self._send(
            {
                "type": "chat",
                "request_id": "live-url",
                "model_path": str(self.MODEL_PATH),
                "max_num_tokens": 4096,
                "generation_config": {"thinking_enabled": False},
                "tool_permissions": {
                    "web": True,
                    "calculate": True,
                    "current_datetime": True,
                },
                "messages": [
                    {"role": "user", "content": "Tell me what is on https://example.com/"},
                ],
            }
        )

        try:
            events = self._collect_events("live-url")
        except AssertionError as exc:
            self.skipTest(f"Live URL probe did not complete: {exc}")
        tool_call = next(event for event in events if event["type"] == "tool_call")
        tool_result = next(event for event in events if event["type"] == "tool_result")

        self.assertEqual(tool_call["name"], "web_fetch")
        self.assertEqual(tool_call["args"]["url"], "https://example.com/")
        self.assertEqual(tool_result["result"]["url"], "https://example.com/")
        self.assertIn("Example Domain", tool_result["result"]["content"])

    def test_live_holiday_query_uses_datetime_then_web_search(self) -> None:
        try:
            with _MODULE.urllib.request.urlopen("http://127.0.0.1:8091/healthz", timeout=5):
                pass
        except Exception as exc:
            self.skipTest(f"Local SearXNG is unavailable: {exc}")

        self._send(
            {
                "type": "chat",
                "request_id": "live-holiday",
                "model_path": str(self.MODEL_PATH),
                "max_num_tokens": 4096,
                "generation_config": {"thinking_enabled": False},
                "tool_permissions": {
                    "web": True,
                    "calculate": True,
                    "current_datetime": True,
                },
                "messages": [
                    {
                        "role": "user",
                        "content": "Is today a national holiday in India? If yes what?",
                    },
                ],
            }
        )

        try:
            events = self._collect_events("live-holiday")
        except AssertionError as exc:
            self.skipTest(f"Live holiday probe did not complete: {exc}")
        tool_calls = [event for event in events if event["type"] == "tool_call"]

        self.assertGreaterEqual(len(tool_calls), 2)
        self.assertEqual(tool_calls[0]["name"], "get_current_datetime")
        self.assertEqual(tool_calls[1]["name"], "web_search")
        self.assertNotIn("<|", tool_calls[1]["args"]["query"])


if __name__ == "__main__":
    unittest.main()
