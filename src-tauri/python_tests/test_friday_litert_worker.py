from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest


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

    def test_should_force_web_search_matches_time_sensitive_queries(self) -> None:
        self.assertTrue(_MODULE.should_force_web_search("What's the latest stock price today?"))
        self.assertFalse(_MODULE.should_force_web_search("Explain Rust ownership."))

    def test_inject_web_search_results_prefixes_prompt_text(self) -> None:
        prompt = {"role": "user", "content": "Summarize this."}
        result = {
            "results": [
                {
                    "title": "Example",
                    "url": "https://example.com",
                    "snippet": "Fresh result",
                }
            ]
        }

        injected = _MODULE.inject_web_search_results(prompt, result)

        self.assertIn("Live web search results for this turn", injected["content"])
        self.assertIn("Example - https://example.com - Fresh result", injected["content"])
        self.assertIn("User request:\nSummarize this.", injected["content"])

    def test_calculate_impl_supports_safe_math(self) -> None:
        self.assertEqual(_MODULE.calculate_impl("2 + 2")["result"], "4.0")
        self.assertIn("error", _MODULE.calculate_impl("__import__('os').system('whoami')"))


if __name__ == "__main__":
    unittest.main()
