#!/usr/bin/env python3

from __future__ import annotations

import ast
import datetime
import html
import http.client
import ipaddress
import json
import math
import os
import pathlib
import re
import socket
import ssl
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

WEB_FETCH_TIMEOUT_SECONDS = 15
WEB_FETCH_MAX_BYTES = 1_000_000
WEB_FETCH_MAX_CHARS = 20_000
WEB_FETCH_MAX_REDIRECTS = 3
WEB_FETCH_REDIRECT_DRAIN_MAX_BYTES = 32_768
WEB_SEARCH_INLINE_FETCH_MAX_URLS = 1
WEB_SEARCH_INLINE_FETCH_MAX_CHARS = 3000
SEARXNG_MAX_BYTES = 1_000_000
LOCAL_FILE_MAX_CHARS = 50_000
LOCAL_FILE_SANDBOX_ROOTS_ENV = "FRIDAY_LOCAL_FILE_TOOL_ROOTS"
_STRICT_TRUE_STRINGS = {"1", "true"}
_STRICT_FALSE_STRINGS = {"0", "false"}
SEARXNG_BASE_URL = os.environ.get("FRIDAY_SEARXNG_BASE_URL", "http://127.0.0.1:8091").rstrip(
    "/"
)
HTML_BLOCK_TAG_RE = re.compile(
    r"</?(?:address|article|aside|blockquote|br|caption|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)[^>]*>",
    re.IGNORECASE,
)
HTML_TAG_RE = re.compile(r"<[^>]+>")
HORIZONTAL_WHITESPACE_RE = re.compile(r"[ \t\f\v]+")
BLANK_LINE_RE = re.compile(r"\n{3,}")
SPACE_BEFORE_PUNCTUATION_RE = re.compile(r"\s+([,.;:!?])")
URL_RE = re.compile(r"https?://[^\s<>()]+", re.IGNORECASE)
TRAILING_URL_PUNCTUATION = ".,!?;:)]}>\"'"
TOOL_SENTINEL_RE = re.compile(r"<\|[^<>]{0,32}\|>")
TOKEN_RE = re.compile(r"[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?")
MONTH_NAME_RE = re.compile(
    r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|"
    r"nov(?:ember)?|dec(?:ember)?)\b",
    re.IGNORECASE,
)
OUTER_QUOTE_PAIRS = {
    '"': '"',
    "'": "'",
    "`": "`",
    "“": "”",
    "‘": "’",
}
SEARCH_QUERY_STOPWORDS = {
    "a",
    "about",
    "an",
    "and",
    "are",
    "at",
    "for",
    "from",
    "how",
    "i",
    "if",
    "in",
    "is",
    "it",
    "me",
    "of",
    "on",
    "please",
    "right",
    "so",
    "tell",
    "the",
    "then",
    "to",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "yes",
    "also",
}
CONTEXT_LIGHT_QUERY_TERMS = {
    "today",
    "todays",
    "tomorrow",
    "tomorrows",
    "yesterday",
    "yesterdays",
    "latest",
    "current",
    "now",
    "live",
    "match",
    "fixture",
    "schedule",
    "score",
    "scores",
    "result",
    "results",
    "price",
    "prices",
    "weather",
    "forecast",
    "news",
    "won",
    "update",
    "updates",
    "there",
    "that",
    "this",
}
TRANSIENT_SEARCH_HTTP_STATUS_CODES = {429, 502, 503, 504}
TRANSIENT_SEARCH_ERROR_MARKERS = (
    "connection refused",
    "connection reset",
    "temporarily unavailable",
    "timed out",
    "timeout",
    "network is unreachable",
)
TIME_SENSITIVE_QUERY_TERMS = (
    "today",
    "tomorrow",
    "yesterday",
    "latest",
    "current",
    "now",
    "holiday",
    "weather",
    "forecast",
    "price",
    "stock",
    "score",
    "match",
    "fixture",
    "schedule",
    "won",
    "ceo",
    "president",
    "release",
    "model",
)
DAY_SCOPED_QUERY_TERMS = (
    "today",
    "tomorrow",
    "yesterday",
    "latest",
    "live",
    "news",
    "weather",
    "forecast",
    "price",
    "stock",
    "score",
    "match",
    "fixture",
    "schedule",
)
NEWS_HEAVY_QUERY_TERMS = (
    "today",
    "tomorrow",
    "yesterday",
    "latest",
    "live",
    "news",
    "weather",
    "forecast",
    "price",
    "stock",
    "score",
    "match",
    "fixture",
    "schedule",
    "won",
)
SEARCH_RESULT_OPTIONAL_FIELDS = (
    "engine",
    "source",
    "publishedDate",
    "published_date",
    "date",
    "category",
)


def write_event(event_type: str, **payload: Any) -> None:
    sys.stdout.write(json.dumps({"type": event_type, **payload}) + "\n")
    sys.stdout.flush()


def sanitize_tool_string(value: str) -> str:
    cleaned = TOOL_SENTINEL_RE.sub("", value).strip()
    while len(cleaned) >= 2:
        closing_quote = OUTER_QUOTE_PAIRS.get(cleaned[0])
        if closing_quote is None or not cleaned.endswith(closing_quote):
            break
        inner = cleaned[1:-1].strip()
        if not inner:
            break
        cleaned = inner
    cleaned = html.unescape(cleaned)
    cleaned = HORIZONTAL_WHITESPACE_RE.sub(" ", cleaned)
    return cleaned.strip()


def sanitize_tool_payload(value: Any) -> Any:
    if isinstance(value, str):
        return sanitize_tool_string(value)
    if isinstance(value, dict):
        return {str(key): sanitize_tool_payload(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize_tool_payload(item) for item in value]
    return value


def normalize_search_query(query: str) -> str:
    cleaned = sanitize_tool_string(query)
    cleaned = cleaned.replace("’", "'")
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = re.sub(r"[?!.]+$", "", cleaned)
    return cleaned.strip(" ,")


def query_contains_explicit_date(query: str) -> bool:
    if MONTH_NAME_RE.search(query):
        return True
    return bool(re.search(r"\b\d{4}-\d{2}-\d{2}\b", query) or re.search(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b", query))


def expand_relative_date_terms(query: str) -> str:
    lowered = query.lower()
    if not any(term in lowered for term in ("today", "tomorrow", "yesterday")):
        return query

    local_today = datetime.datetime.now().astimezone().date()
    replacements = {
        "today": local_today.strftime("%B %-d %Y"),
        "tomorrow": (local_today + datetime.timedelta(days=1)).strftime("%B %-d %Y"),
        "yesterday": (local_today - datetime.timedelta(days=1)).strftime("%B %-d %Y"),
    }

    expanded = query
    for term, replacement in replacements.items():
        expanded = re.sub(
            rf"\b{term}(?:['’]s)\b",
            replacement,
            expanded,
            flags=re.IGNORECASE,
        )
        expanded = re.sub(rf"\b{term}\b", replacement, expanded, flags=re.IGNORECASE)
    return expanded


def simplify_search_query(query: str) -> str | None:
    tokens = TOKEN_RE.findall(query)
    keywords: list[str] = []
    for token in tokens:
        lowered = token.lower().replace("’", "'")
        if lowered in SEARCH_QUERY_STOPWORDS:
            continue
        normalized = lowered.replace("'", "")
        if len(normalized) == 1 and not normalized.isdigit():
            continue
        keywords.append(normalized)

    if len(keywords) < 2:
        return None
    return " ".join(keywords)


def search_query_variants(query: str) -> list[str]:
    variants: list[str] = []
    seen: set[str] = set()

    def add(value: str | None) -> None:
        if not value:
            return
        normalized = normalize_search_query(value)
        if not normalized:
            return
        folded = normalized.lower()
        if folded in seen:
            return
        seen.add(folded)
        variants.append(normalized)

    add(query)
    normalized = normalize_search_query(query)
    if "," in normalized:
        add(normalized.replace(",", ""))
    expanded = expand_relative_date_terms(normalized)
    if expanded != normalized:
        add(expanded)
        if "," in expanded:
            add(expanded.replace(",", ""))
    add(simplify_search_query(expanded))
    return variants


def classify_web_search_intent(query: str) -> WebSearchIntent:
    lowered = sanitize_tool_string(query).lower()
    has_news_heavy_term = any(term in lowered for term in NEWS_HEAVY_QUERY_TERMS)
    has_day_scoped_term = any(term in lowered for term in DAY_SCOPED_QUERY_TERMS)
    requires_verification = any(term in lowered for term in TIME_SENSITIVE_QUERY_TERMS)
    if bool(re.search(r"\bvs\b|\bv\b", lowered)):
        has_news_heavy_term = True
        requires_verification = True

    if has_news_heavy_term:
        categories: list[str] | None = ["general", "web", "news"]
    elif requires_verification:
        categories = ["general", "web"]
    else:
        categories = None

    return WebSearchIntent(
        time_range="day" if has_day_scoped_term else None,
        categories=categories,
        requires_verification=requires_verification,
    )


def query_requires_definitive_fetch(query: str) -> bool:
    return classify_web_search_intent(query).requires_verification


def default_search_metadata(
    requested_query: str,
    effective_query: str,
    attempted_queries: list[str],
    *,
    categories: list[str] | None,
    time_range: str | None,
    time_range_fallback: str | None,
    query_rewrite_applied: str | None = None,
) -> dict[str, Any]:
    return {
        "provider": "searxng",
        "requested_query": requested_query,
        "effective_query": effective_query,
        "attempted_queries": attempted_queries,
        "categories": categories,
        "time_range": time_range,
        "time_range_fallback": time_range_fallback,
        "query_rewrite_applied": query_rewrite_applied,
        "recommended_fetch_urls": [],
        "unresponsive_engines": [],
        "verification_failed": False,
        "do_not_answer_from_memory": False,
    }


def annotate_search_verification(
    result: dict[str, Any],
    *,
    intent: WebSearchIntent,
) -> dict[str, Any]:
    verification_pages = result.get("verification_pages")
    verified = isinstance(verification_pages, list) and any(
        isinstance(page, dict) and page.get("verified") is True for page in verification_pages
    )
    annotated = dict(result)
    annotated["verification_failed"] = intent.requires_verification and not verified
    annotated["do_not_answer_from_memory"] = intent.requires_verification and not verified

    if intent.requires_verification:
        annotated["recommended_next_step"] = (
            "Use the verified page content for any definitive claim and cite the verified source."
            if verified
            else "Explain that live verification did not succeed and do not present an unverified current fact as certain."
        )
    elif not annotated.get("recommended_next_step"):
        annotated["recommended_next_step"] = (
            "Use web_fetch on a promising result when the search snippets are not sufficient."
        )

    return annotated


def finalize_search_result(
    result: dict[str, Any],
    *,
    requested_query: str,
    effective_query: str,
    attempted_queries: list[str],
    intent: WebSearchIntent,
    time_range_fallback: str | None = None,
    query_rewrite_applied: str | None = None,
) -> dict[str, Any]:
    finalized = default_search_metadata(
        requested_query,
        effective_query,
        attempted_queries,
        categories=intent.categories,
        time_range=intent.time_range,
        time_range_fallback=time_range_fallback,
        query_rewrite_applied=query_rewrite_applied,
    )
    finalized.update(result)
    finalized["provider"] = "searxng"
    finalized["requested_query"] = requested_query
    finalized["effective_query"] = effective_query
    finalized["attempted_queries"] = attempted_queries
    finalized["categories"] = intent.categories
    finalized["time_range"] = intent.time_range
    finalized["time_range_fallback"] = time_range_fallback
    finalized["query_rewrite_applied"] = query_rewrite_applied

    if not isinstance(finalized.get("recommended_fetch_urls"), list):
        finalized["recommended_fetch_urls"] = []
    if not isinstance(finalized.get("unresponsive_engines"), list):
        finalized["unresponsive_engines"] = []

    return annotate_search_verification(finalized, intent=intent)


def annotate_search_error(
    error: dict[str, Any],
    requested_query: str,
    attempted_queries: list[str],
    *,
    effective_query: str | None = None,
    categories: list[str] | None = None,
    time_range: str | None = None,
    time_range_fallback: str | None = None,
    query_rewrite_applied: str | None = None,
) -> dict[str, Any]:
    annotated = default_search_metadata(
        requested_query,
        effective_query or requested_query,
        attempted_queries,
        categories=categories,
        time_range=time_range,
        time_range_fallback=time_range_fallback,
        query_rewrite_applied=query_rewrite_applied,
    )
    annotated.update(error)
    annotated["verification_failed"] = True
    annotated["do_not_answer_from_memory"] = True
    annotated["recommended_next_step"] = (
        "Explain that live web verification failed and do not present an "
        "unverified current fact as certain."
    )
    return annotated


def annotate_fetch_error(error: str, requested_url: str) -> dict[str, Any]:
    return {
        "error": error,
        "url": requested_url,
        "verification_failed": True,
        "do_not_answer_from_memory": True,
        "recommended_next_step": (
            "Explain that the page could not be verified and do not claim page "
            "contents that were not fetched."
        ),
    }


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


def should_insert_text_separator(previous_text: str, next_text: str) -> bool:
    if not previous_text or not next_text:
        return False

    previous_last = previous_text[-1]
    next_first = next_text[0]

    if previous_last.isspace() or next_first.isspace():
        return False
    if next_first in ",.;:!?)]}>\"'`":
        return False
    if previous_last in "([{<\"'`":
        return False
    if next_first in "#-*`~>":
        return False

    # Low-risk separator insertion only for structural boundary cases.
    if previous_last in ".!?:;" and next_first.isupper():
        return True

    if previous_last.islower() and next_first.isupper():
        return True

    if previous_last.isdigit() and next_first.isupper():
        return True

    return False


def join_text_fragments(fragments: list[str]) -> str:
    merged: list[str] = []
    for fragment in fragments:
        if not fragment:
            continue
        if merged and should_insert_text_separator(merged[-1], fragment):
            merged.append(" ")
        merged.append(fragment)
    return "".join(merged)


def extract_chunk_channel_texts(chunk: dict[str, Any]) -> tuple[str, str]:
    answer_parts: list[str] = []
    for item in chunk.get("content", []):
        if item.get("type") != "text":
            continue
        text = item.get("text", "")
        if text:
            answer_parts.append(text)

    thought_text = ""
    channels = chunk.get("channels", {})
    if isinstance(channels, dict):
        raw_thought = channels.get("thought", "")
        if isinstance(raw_thought, str):
            thought_text = raw_thought

    return join_text_fragments(answer_parts), thought_text


def suffix_prefix_overlap(previous_text: str, current_text: str) -> int:
    max_overlap = min(len(previous_text), len(current_text))
    for overlap in range(max_overlap, 0, -1):
        if previous_text.endswith(current_text[:overlap]):
            return overlap
    return 0


def stream_text_delta(previous_text: str, current_text: str) -> tuple[str, str]:
    if not current_text:
        return "", previous_text
    if not previous_text:
        return current_text, current_text
    if current_text == previous_text:
        return "", previous_text
    if current_text.startswith(previous_text):
        return current_text[len(previous_text) :], current_text

    common_prefix_len = 0
    max_prefix = min(len(previous_text), len(current_text))
    while (
        common_prefix_len < max_prefix
        and previous_text[common_prefix_len] == current_text[common_prefix_len]
    ):
        common_prefix_len += 1

    if (
        common_prefix_len >= 8
        and common_prefix_len >= len(previous_text) // 2
        and len(current_text) >= len(previous_text)
    ):
        return current_text[common_prefix_len:], current_text

    overlap = suffix_prefix_overlap(previous_text, current_text)
    if overlap > 0:
        delta = current_text[overlap:]
        return delta, previous_text + delta

    separator = " " if should_insert_text_separator(previous_text, current_text) else ""
    return f"{separator}{current_text}", f"{previous_text}{separator}{current_text}"


def snapshot_shows_cumulative_growth(previous_snapshot: str, current_snapshot: str) -> bool:
    return bool(
        previous_snapshot
        and current_snapshot
        and len(current_snapshot) > len(previous_snapshot)
        and current_snapshot.startswith(previous_snapshot)
    )


def resolve_final_stream_text(
    streamed_text: str,
    latest_snapshot: str,
    *,
    saw_cumulative_growth: bool,
    saw_incremental_updates: bool,
) -> str:
    if saw_cumulative_growth and not saw_incremental_updates and latest_snapshot:
        return latest_snapshot
    return streamed_text or latest_snapshot


def chunk_to_incremental_events(
    request_id: str,
    chunk: dict[str, Any],
    previous_answer_text: str,
    previous_thought_text: str,
) -> tuple[list[dict[str, Any]], str, str]:
    answer_text, thought_text = extract_chunk_channel_texts(chunk)
    answer_delta, next_answer_text = stream_text_delta(previous_answer_text, answer_text)
    thought_delta, next_thought_text = stream_text_delta(previous_thought_text, thought_text)

    events: list[dict[str, Any]] = []
    if answer_delta:
        events.append({"type": "token", "request_id": request_id, "text": answer_delta})
    if thought_delta:
        events.append({"type": "thought", "request_id": request_id, "text": thought_delta})

    return events, next_answer_text, next_thought_text


@dataclass(frozen=True)
class EngineConfig:
    model_path: str
    max_num_tokens: int
    backend: str


@dataclass(frozen=True)
class WebSearchIntent:
    time_range: str | None
    categories: list[str] | None
    requires_verification: bool


def parse_bool_flag(
    value: Any,
    *,
    field_name: str,
    default: bool = False,
) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        if value in (0, 1):
            return bool(value)
        raise ValueError(
            f"{field_name} must be a boolean (true/false or 1/0)."
        )
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in _STRICT_TRUE_STRINGS:
            return True
        if normalized in _STRICT_FALSE_STRINGS:
            return False
        raise ValueError(
            f"{field_name} must be a boolean (true/false or 1/0)."
        )
    raise ValueError(f"{field_name} must be a boolean.")


@dataclass(frozen=True)
class ToolPermissions:
    web: bool = False
    local_files: bool = False
    calculate: bool = False
    current_datetime: bool = False

    @classmethod
    def from_command(cls, command: dict[str, Any]) -> ToolPermissions:
        raw = command.get("tool_permissions") or {}
        if not isinstance(raw, dict):
            raise ValueError("tool_permissions must be an object.")
        return cls(
            web=parse_bool_flag(raw.get("web"), field_name="tool_permissions.web"),
            local_files=parse_bool_flag(
                raw.get("local_files"),
                field_name="tool_permissions.local_files",
            ),
            calculate=parse_bool_flag(
                raw.get("calculate"),
                field_name="tool_permissions.calculate",
            ),
            current_datetime=parse_bool_flag(
                raw.get("current_datetime"),
                field_name="tool_permissions.current_datetime",
            ),
        )


class FridayToolEventHandler:
    def __init__(self, request_id: str) -> None:
        self._request_id = request_id

    def approve_tool_call(self, tool_call: dict[str, Any]) -> bool:
        function = tool_call.get("function", {})
        raw_args = function.get("arguments", {}) or {}
        write_event(
            "tool_call",
            request_id=self._request_id,
            name=str(function.get("name", "")),
            args=normalize_tool_payload(raw_args),
        )
        return True

    def process_tool_response(self, tool_response: dict[str, Any]) -> dict[str, Any]:
        write_event(
            "tool_result",
            request_id=self._request_id,
            name=str(tool_response.get("name", "")),
            result=normalize_tool_payload(tool_response.get("response")),
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


def build_recent_user_search_context(
    messages: list[dict[str, Any]],
    max_messages: int = 3,
) -> str:
    user_texts: list[str] = []
    seen: set[str] = set()
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        text = normalize_search_query(extract_text_from_message(message))
        if not text:
            continue
        folded = text.lower()
        if folded in seen:
            continue
        seen.add(folded)
        user_texts.append(text)
        if len(user_texts) >= max_messages:
            break
    user_texts.reverse()
    return " ".join(user_texts).strip()


def strip_followup_prefixes(query: str) -> str:
    cleaned = normalize_search_query(query)
    patterns = (
        r"^(?:what|how)\s+about\s+",
        r"^(?:and|also|then|so)\s+",
        r"^(?:what(?:'s| is)|how(?:'s| is))\s+",
    )
    updated = cleaned
    for pattern in patterns:
        updated = re.sub(pattern, "", updated, flags=re.IGNORECASE).strip()
    return updated or cleaned


def query_is_context_light(query: str) -> bool:
    terms = query_entity_terms(query)
    if not terms:
        return True
    return all(term in CONTEXT_LIGHT_QUERY_TERMS for term in terms)


def extract_query_subject(query: str) -> str:
    tokens: list[str] = []
    for token in TOKEN_RE.findall(normalize_search_query(query)):
        lowered = token.lower().replace("’", "").replace("'", "")
        if lowered in SEARCH_QUERY_STOPWORDS:
            continue
        if lowered in {"today", "todays", "tomorrow", "tomorrows", "yesterday", "yesterdays", "latest", "current", "now", "live"}:
            continue
        if len(lowered) == 1 and not lowered.isdigit():
            continue
        tokens.append(token)
    return " ".join(tokens)


def combine_subject_and_query(subject: str, query: str) -> str:
    if not subject:
        return query
    if not query:
        return subject
    subject_lower = subject.lower()
    query_lower = query.lower()
    if query_lower in subject_lower:
        return subject
    if subject_lower in query_lower:
        return query
    return normalize_search_query(f"{subject} {query}")


def contextualize_web_search_query(query: str, user_search_context: str) -> tuple[str, bool]:
    cleaned_query = sanitize_tool_string(query)
    normalized_query = normalize_search_query(cleaned_query)
    normalized_context = normalize_search_query(user_search_context)
    if not normalized_query:
        return normalized_context, bool(normalized_context)
    if not normalized_context:
        return cleaned_query, False
    if not query_is_context_light(normalized_query):
        return cleaned_query, False

    subject = extract_query_subject(normalized_context)
    followup_query = strip_followup_prefixes(normalized_query)
    effective_query = combine_subject_and_query(subject, followup_query) if subject else normalized_context
    return effective_query or normalized_query, (effective_query or normalized_query) != normalized_query


def build_web_search_context(
    preface_messages: list[dict[str, Any]],
    prompt: dict[str, Any],
) -> str:
    prior_context = build_recent_user_search_context(preface_messages)
    prompt_text = normalize_search_query(extract_text_from_message(prompt))
    context_parts: list[str] = []
    if prior_context:
        context_parts.append(prior_context)
    if prompt_text and not query_is_context_light(prompt_text):
        context_parts.append(prompt_text)
    return normalize_search_query(" ".join(context_parts))


def web_search_time_range(query: str) -> str | None:
    return classify_web_search_intent(query).time_range


def extract_urls_from_text(user_text: str, limit: int = 3) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for match in URL_RE.finditer(user_text):
        normalized = match.group(0).rstrip(TRAILING_URL_PUNCTUATION)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        urls.append(normalized)
        if len(urls) >= limit:
            break
    return urls


def normalize_tool_payload(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return sanitize_tool_payload(value)
    if value is None:
        return {}
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return {}
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError:
            return {"value": sanitize_tool_string(value)}
        if isinstance(decoded, dict):
            return sanitize_tool_payload(decoded)
        return {"value": sanitize_tool_payload(decoded)}
    if isinstance(value, (list, tuple)):
        return {"value": sanitize_tool_payload(list(value))}
    return {"value": value}


def build_web_tool_guidance(user_text: str) -> str | None:
    guidance_parts = [
        "When using web tools, search for the concrete subject of the user's "
        "request rather than repeating short meta follow-ups verbatim. Carry "
        "forward relevant chat context when the latest message is a correction "
        "or brief follow-up.",
        "For current, live, recent, or breaking topics such as scores, prices, "
        "schedules, and news, include the entity names and event context in "
        "the search query and do not finalize the answer from snippets alone. "
        "Use web_fetch on a promising result when the search result does not "
        "already include verified page content.",
    ]
    if extract_urls_from_text(user_text):
        guidance_parts.append(
            "The user included explicit URLs. Use web_fetch on the exact URL "
            "before summarizing or making claims about that page."
        )
    return " ".join(guidance_parts)


def has_web_search_results(search_result: dict[str, Any]) -> bool:
    results = search_result.get("results")
    return isinstance(results, list) and any(isinstance(result, dict) for result in results)


def web_search_categories(query: str) -> list[str] | None:
    return classify_web_search_intent(query).categories


def result_domain(url: str) -> str:
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return ""
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def query_entity_terms(query: str) -> set[str]:
    terms: set[str] = set()
    for token in TOKEN_RE.findall(query):
        normalized = token.lower().replace("’", "").replace("'", "")
        if normalized in SEARCH_QUERY_STOPWORDS or len(normalized) < 3:
            continue
        terms.add(normalized)
    return terms


def is_likely_primary_source(domain: str, entity_terms: set[str]) -> bool:
    if not domain:
        return False
    if domain.endswith(".gov") or ".gov." in domain or domain.endswith(".edu") or domain.endswith(".mil"):
        return True
    return any(term in domain for term in entity_terms if len(term) >= 4)


def score_search_result(query: str, result: dict[str, Any]) -> tuple[int, int]:
    domain = result_domain(str(result.get("url") or ""))
    entity_terms = query_entity_terms(query)
    score = 0
    if is_likely_primary_source(domain, entity_terms):
        score += 100
    if domain.endswith(".org"):
        score += 10
    snippet_length = len(str(result.get("snippet") or ""))
    score += min(snippet_length, 160) // 10
    title_length = len(str(result.get("title") or ""))
    score += min(title_length, 120) // 20
    return score, snippet_length


def annotate_search_results(query: str, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    annotated: list[dict[str, Any]] = []
    entity_terms = query_entity_terms(query)
    for result in results:
        domain = result_domain(str(result.get("url") or ""))
        enriched = dict(result)
        enriched["domain"] = domain
        enriched["likely_primary_source"] = is_likely_primary_source(domain, entity_terms)
        annotated.append(enriched)
    annotated.sort(key=lambda item: score_search_result(query, item), reverse=True)
    return annotated


def normalize_result_metadata(result: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for field in SEARCH_RESULT_OPTIONAL_FIELDS:
        value = result.get(field)
        if value in (None, "", [], {}):
            continue
        normalized[field] = sanitize_tool_payload(value)

    engines = result.get("engines")
    if isinstance(engines, list) and engines:
        normalized["engines"] = [str(engine) for engine in engines if str(engine).strip()]

    if result.get("score") not in (None, ""):
        normalized["score"] = result.get("score")

    return normalized


def recommended_fetch_urls(
    query: str,
    results: list[dict[str, Any]],
    limit: int = 3,
) -> list[str]:
    preferred = [result["url"] for result in results if result.get("likely_primary_source")]
    if len(preferred) < limit:
        preferred.extend(
            result["url"]
            for result in results
            if result.get("url") not in preferred
        )
    return preferred[:limit]


def build_inline_verification_pages(
    query: str,
    results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    verification_pages: list[dict[str, Any]] = []
    for url in recommended_fetch_urls(query, results, WEB_SEARCH_INLINE_FETCH_MAX_URLS):
        fetched = web_fetch_impl(url, WEB_SEARCH_INLINE_FETCH_MAX_CHARS)
        if "error" in fetched:
            verification_pages.append(
                {
                    "url": url,
                    "verified": False,
                    "error": fetched["error"],
                }
            )
            continue
        verification_pages.append(
            {
                "url": fetched.get("url", url),
                "verified": True,
                "content": fetched.get("content", ""),
                "contentType": fetched.get("contentType"),
                "length": fetched.get("length"),
            }
        )
    return verification_pages


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
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    normalized = HTML_BLOCK_TAG_RE.sub("\n", normalized)
    normalized = HTML_TAG_RE.sub(" ", normalized)
    normalized = html.unescape(normalized).replace("\xa0", " ")
    normalized = HORIZONTAL_WHITESPACE_RE.sub(" ", normalized)
    normalized = re.sub(r" *\n *", "\n", normalized)
    normalized = BLANK_LINE_RE.sub("\n\n", normalized)
    normalized = SPACE_BEFORE_PUNCTUATION_RE.sub(r"\1", normalized)
    return normalized.strip()


def truncate_to_char_limit(value: str, max_chars: int) -> tuple[str, bool]:
    if len(value) <= max_chars:
        return value, False
    return value[:max_chars], True


def wall_clock_deadline(seconds: float) -> float:
    return time.monotonic() + max(0.1, float(seconds))


def wall_clock_remaining(deadline: float, *, operation: str) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError(f"{operation} timed out.")
    return max(0.1, remaining)


def drain_response_body(
    response: http.client.HTTPResponse,
    max_bytes: int,
    *,
    deadline: float | None = None,
    operation: str = "Web fetch",
) -> None:
    remaining = max(0, int(max_bytes))
    while remaining > 0:
        if deadline is not None:
            wall_clock_remaining(deadline, operation=operation)
        chunk = response.read(min(8192, remaining))
        if not chunk:
            break
        remaining -= len(chunk)


def read_response_limited(
    response: http.client.HTTPResponse,
    *,
    max_bytes: int,
    deadline: float,
    operation: str,
) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while total < max_bytes:
        wall_clock_remaining(deadline, operation=operation)
        chunk = response.read(min(8192, max_bytes - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks)


def resolve_host_with_timeout(
    host: str,
    port: int,
    *,
    timeout_seconds: float,
) -> list[Any]:
    payload: dict[str, Any] = {}

    def _resolve() -> None:
        try:
            payload["result"] = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except Exception as exc:  # pragma: no cover - exercised through integration
            payload["error"] = exc

    resolver = threading.Thread(target=_resolve, daemon=True)
    resolver.start()
    resolver.join(timeout_seconds)
    if resolver.is_alive():
        raise TimeoutError(f"DNS resolution timed out for host: {host}")
    if "error" in payload:
        raise payload["error"]
    result = payload.get("result")
    if isinstance(result, list):
        return result
    return []


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
    return not ip.is_global


def resolve_remote_web_target(url: str) -> tuple[urllib.parse.ParseResult, str, int]:
    deadline = wall_clock_deadline(WEB_FETCH_TIMEOUT_SECONDS)
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

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if parsed_ip is not None:
        if is_disallowed_ip(parsed_ip):
            raise ValueError("Local and private network hosts are blocked.")
        return parsed, host, port

    resolved = resolve_host_with_timeout(
        host,
        port,
        timeout_seconds=wall_clock_remaining(deadline, operation="DNS resolution"),
    )
    if not resolved:
        raise ValueError(f"Host {host} did not resolve to a public address.")
    public_address: str | None = None
    for *_, sockaddr in resolved:
        ip = ipaddress.ip_address(sockaddr[0])
        if is_disallowed_ip(ip):
            raise ValueError("Local and private network hosts are blocked.")
        if public_address is None:
            public_address = sockaddr[0]

    if public_address is None:
        raise ValueError(f"Host {host} did not resolve to a public address.")

    return parsed, public_address, port


def request_target_for_url(parsed: urllib.parse.ParseResult) -> str:
    path = parsed.path or "/"
    if parsed.query:
        return f"{path}?{parsed.query}"
    return path


class VerifiedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, resolved_host: str, *args: Any, **kwargs: Any) -> None:
        self._resolved_host = resolved_host
        super().__init__(*args, **kwargs)

    def connect(self) -> None:
        self.sock = self._create_connection(
            (self._resolved_host, self.port),
            self.timeout,
            self.source_address,
        )


class VerifiedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, resolved_host: str, *args: Any, **kwargs: Any) -> None:
        self._resolved_host = resolved_host
        super().__init__(*args, **kwargs)

    def connect(self) -> None:
        sock = self._create_connection(
            (self._resolved_host, self.port),
            self.timeout,
            self.source_address,
        )
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def open_remote_web_response(
    url: str,
    headers: dict[str, str],
    *,
    deadline: float | None = None,
) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse, str]:
    active_deadline = deadline or wall_clock_deadline(WEB_FETCH_TIMEOUT_SECONDS)
    current_url = url
    for _ in range(WEB_FETCH_MAX_REDIRECTS + 1):
        parsed, resolved_host, port = resolve_remote_web_target(current_url)
        request_headers = dict(headers)
        per_request_timeout = min(
            WEB_FETCH_TIMEOUT_SECONDS,
            wall_clock_remaining(active_deadline, operation="Web fetch"),
        )
        if parsed.scheme == "https":
            connection: http.client.HTTPConnection = VerifiedHTTPSConnection(
                resolved_host,
                parsed.hostname or "",
                port=port,
                timeout=per_request_timeout,
                context=ssl.create_default_context(),
            )
        else:
            connection = VerifiedHTTPConnection(
                resolved_host,
                parsed.hostname or "",
                port=port,
                timeout=per_request_timeout,
            )

        connection.request("GET", request_target_for_url(parsed), headers=request_headers)
        response = connection.getresponse()
        if response.status in {301, 302, 303, 307, 308}:
            location = response.getheader("Location")
            drain_response_body(
                response,
                WEB_FETCH_REDIRECT_DRAIN_MAX_BYTES,
                deadline=active_deadline,
                operation="Web fetch redirect",
            )
            connection.close()
            if not location:
                raise ValueError("Fetch failed with an invalid redirect response.")
            current_url = urllib.parse.urljoin(current_url, location)
            continue

        return connection, response, current_url

    raise ValueError(f"Fetch exceeded {WEB_FETCH_MAX_REDIRECTS} redirects.")


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


def perform_searxng_search(
    query: str,
    limit: int,
    time_range: str | None,
    categories: list[str] | None = None,
) -> dict[str, Any]:
    deadline = wall_clock_deadline(WEB_FETCH_TIMEOUT_SECONDS)
    params = {"q": query, "format": "json"}
    if time_range:
        params["time_range"] = time_range
    if categories:
        params["categories"] = ",".join(categories)

    request = urllib.request.Request(
        f"{SEARXNG_BASE_URL}/search?{urllib.parse.urlencode(params)}",
        headers={
            "User-Agent": "Friday/0.1",
            "Accept": "application/json",
            "Accept-Encoding": "identity",
        },
    )
    payload: dict[str, Any] | None = None
    retry_delays = (0.25, 0.75)
    for attempt in range(len(retry_delays) + 1):
        try:
            per_request_timeout = min(
                WEB_FETCH_TIMEOUT_SECONDS,
                wall_clock_remaining(deadline, operation="SearXNG search"),
            )
            with urllib.request.urlopen(request, timeout=per_request_timeout) as response:
                body = read_response_limited(
                    response,
                    max_bytes=SEARXNG_MAX_BYTES + 1,
                    deadline=deadline,
                    operation="SearXNG search",
                )
            if len(body) > SEARXNG_MAX_BYTES:
                return {"error": f"SearXNG response exceeds {SEARXNG_MAX_BYTES} bytes."}
            payload = json.loads(body.decode("utf-8", errors="replace"))
            break
        except TimeoutError as exc:
            return {"error": str(exc)}
        except urllib.error.HTTPError as exc:
            if exc.code == 403:
                return {"error": "Local SearXNG config is invalid; JSON output is disabled."}
            if exc.code in TRANSIENT_SEARCH_HTTP_STATUS_CODES and attempt < len(retry_delays):
                remaining = max(0.0, deadline - time.monotonic())
                if remaining <= 0:
                    return {"error": "SearXNG search timed out."}
                time.sleep(min(retry_delays[attempt], remaining))
                continue
            return {"error": f"SearXNG search failed with HTTP {exc.code}"}
        except json.JSONDecodeError as exc:
            return {"error": f"SearXNG returned invalid JSON: {exc}"}
        except Exception as exc:  # pragma: no cover - exercised through integration, not unit
            error_text = str(exc).lower()
            if (
                attempt < len(retry_delays)
                and any(marker in error_text for marker in TRANSIENT_SEARCH_ERROR_MARKERS)
            ):
                remaining = max(0.0, deadline - time.monotonic())
                if remaining <= 0:
                    return {"error": "SearXNG search timed out."}
                time.sleep(min(retry_delays[attempt], remaining))
                continue
            return {"error": str(exc)}

    if payload is None:
        return {"error": "SearXNG search did not return a response."}

    results: list[dict[str, Any]] = []
    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
        return {"error": "SearXNG response did not include a results list."}

    for result in raw_results[:limit]:
        if not isinstance(result, dict):
            continue
        title = strip_tags(str(result.get("title") or "")).strip()
        url = str(result.get("url") or "").strip()
        snippet = strip_tags(str(result.get("content") or "")).strip()
        if title or url or snippet:
            normalized_result = {"title": title, "url": url, "snippet": snippet}
            normalized_result.update(normalize_result_metadata(result))
            results.append(normalized_result)
    results = annotate_search_results(query, results)

    normalized: dict[str, Any] = {
        "query": str(payload.get("query") or query),
        "results": results,
        "total": len(results),
        "provider": "searxng",
    }
    normalized["snippets_are_not_definitive"] = True
    normalized["recommended_fetch_urls"] = recommended_fetch_urls(query, results)
    if query_requires_definitive_fetch(query):
        normalized["recommended_next_step"] = (
            "Use web_fetch on a recommended URL before giving a definitive answer, "
            "because search results only contain snippets."
        )
    unresponsive_engines = payload.get("unresponsive_engines")
    if isinstance(unresponsive_engines, list):
        normalized["unresponsive_engines"] = unresponsive_engines
    if time_range:
        normalized["time_range"] = time_range
    if categories:
        normalized["categories"] = categories
    return normalized


def web_search_impl(query: str, max_results: int = 5) -> dict[str, Any]:
    cleaned_query = normalize_search_query(query)
    if not cleaned_query:
        return {"error": "Query is required."}

    limit = max(1, min(int(max_results), 10))
    intent = classify_web_search_intent(cleaned_query)
    time_range = intent.time_range
    variants = search_query_variants(cleaned_query)
    attempted_variants: list[str] = []
    last_no_results: dict[str, Any] | None = None
    last_error: dict[str, Any] | None = None

    for index, variant in enumerate(variants):
        attempted_variants.append(variant)
        categories = web_search_categories(variant)
        primary_result = perform_searxng_search(variant, limit, time_range, categories)
        if "error" in primary_result:
            last_error = primary_result
        elif has_web_search_results(primary_result):
            if intent.requires_verification:
                primary_result["verification_pages"] = build_inline_verification_pages(
                    cleaned_query,
                    primary_result["results"],
                )
            if variant != cleaned_query:
                primary_result["query_variant_used"] = variant
            if index > 0:
                primary_result["query_variant_fallback"] = "applied"
            return finalize_search_result(
                primary_result,
                requested_query=cleaned_query,
                effective_query=cleaned_query,
                attempted_queries=attempted_variants,
                intent=intent,
            )
        else:
            last_no_results = primary_result

        if time_range is not None:
            fallback_result = perform_searxng_search(variant, limit, None, categories)
            if "error" in fallback_result:
                last_error = fallback_result
            elif has_web_search_results(fallback_result):
                if intent.requires_verification:
                    fallback_result["verification_pages"] = build_inline_verification_pages(
                        cleaned_query,
                        fallback_result["results"],
                    )
                if variant != cleaned_query:
                    fallback_result["query_variant_used"] = variant
                if index > 0:
                    fallback_result["query_variant_fallback"] = "applied"
                return finalize_search_result(
                    fallback_result,
                    requested_query=cleaned_query,
                    effective_query=cleaned_query,
                    attempted_queries=attempted_variants,
                    intent=intent,
                    time_range_fallback="omitted",
                )
            else:
                last_no_results = fallback_result

    if last_no_results is not None:
        time_range_fallback = "attempted" if time_range is not None else None
        if len(attempted_variants) > 1:
            last_no_results["query_variant_fallback"] = "attempted"
        return finalize_search_result(
            last_no_results,
            requested_query=cleaned_query,
            effective_query=cleaned_query,
            attempted_queries=attempted_variants,
            intent=intent,
            time_range_fallback=time_range_fallback,
        )

    if last_error is not None:
        return annotate_search_error(
            last_error,
            cleaned_query,
            attempted_variants,
            effective_query=cleaned_query,
            categories=intent.categories,
            time_range=intent.time_range,
        )

    return annotate_search_error(
        {"error": "SearXNG search failed unexpectedly."},
        cleaned_query,
        attempted_variants,
        effective_query=cleaned_query,
        categories=intent.categories,
        time_range=intent.time_range,
    )


def web_fetch_impl(url: str, max_chars: int = 5000) -> dict[str, Any]:
    cleaned_url = sanitize_tool_string(url)
    if not cleaned_url:
        return annotate_fetch_error("URL is required.", cleaned_url)

    try:
        _, _, _ = resolve_remote_web_target(cleaned_url)
    except ValueError as exc:
        return annotate_fetch_error(str(exc), cleaned_url)

    connection: http.client.HTTPConnection | None = None
    try:
        deadline = wall_clock_deadline(WEB_FETCH_TIMEOUT_SECONDS)
        connection, response, final_url = open_remote_web_response(
            cleaned_url,
            {"User-Agent": "Friday/0.1", "Accept-Encoding": "identity"},
            deadline=deadline,
        )
        if response.status >= 400:
            return annotate_fetch_error(
                f"Fetch failed with HTTP {response.status}",
                cleaned_url,
            )
        content_length = response.headers.get("Content-Length")
        if content_length:
            declared_size = int(content_length)
            if declared_size > WEB_FETCH_MAX_BYTES:
                return annotate_fetch_error(
                    f"Response exceeds {WEB_FETCH_MAX_BYTES} bytes.",
                    cleaned_url,
                )
        content_type = response.headers.get_content_type().lower()
        if not is_supported_web_fetch_content_type(content_type):
            return annotate_fetch_error(
                f"Unsupported content type: {content_type or 'unknown'}",
                cleaned_url,
            )
        body = read_response_limited(
            response,
            max_bytes=WEB_FETCH_MAX_BYTES + 1,
            deadline=deadline,
            operation="Web fetch",
        )
    except ValueError as exc:
        return annotate_fetch_error(str(exc), cleaned_url)
    except TimeoutError as exc:
        return annotate_fetch_error(str(exc), cleaned_url)
    except Exception as exc:  # pragma: no cover - exercised through integration, not unit
        return annotate_fetch_error(str(exc), cleaned_url)
    finally:
        if connection is not None:
            connection.close()

    if len(body) > WEB_FETCH_MAX_BYTES:
        return annotate_fetch_error(
            f"Response exceeds {WEB_FETCH_MAX_BYTES} bytes.",
            cleaned_url,
        )

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


def local_file_sandbox_roots() -> list[pathlib.Path]:
    raw = os.environ.get(LOCAL_FILE_SANDBOX_ROOTS_ENV, "")
    candidates: list[pathlib.Path] = []

    if raw.strip():
        for root in raw.split(os.pathsep):
            cleaned_root = root.strip()
            if not cleaned_root:
                continue
            candidates.append(pathlib.Path(cleaned_root).expanduser())
    else:
        candidates.append(pathlib.Path.cwd())

    resolved_roots: list[pathlib.Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        resolved = candidate.resolve(strict=False)
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        resolved_roots.append(resolved)

    return resolved_roots


def ensure_within_local_file_sandbox(path: pathlib.Path) -> pathlib.Path:
    resolved = path.resolve(strict=False)
    allowed_roots = local_file_sandbox_roots()
    for root in allowed_roots:
        if resolved == root or root in resolved.parents:
            return resolved
    allowed = ", ".join(str(root) for root in allowed_roots)
    raise ValueError(f"Path is outside the worker sandbox roots: {allowed}")


def resolve_local_tool_path(raw_path: str) -> pathlib.Path:
    cleaned = sanitize_tool_string(raw_path)
    if not cleaned:
        raise ValueError("Path is required.")
    candidate = pathlib.Path(cleaned).expanduser()
    if not candidate.is_absolute():
        candidate = pathlib.Path.cwd() / candidate
    return ensure_within_local_file_sandbox(candidate)


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
    cleaned = sanitize_tool_string(expression).strip()
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
    try:
        file_path = resolve_local_tool_path(path)
    except ValueError as exc:
        return {"error": str(exc)}
    if not file_path.exists():
        return {"error": f"File not found: {file_path}"}
    if not file_path.is_file():
        return {"error": f"Not a file: {file_path}"}
    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return {"error": str(exc)}
    return {"content": content[:LOCAL_FILE_MAX_CHARS], "size": len(content)}


def list_directory_impl(path: str) -> dict[str, Any]:
    try:
        dir_path = resolve_local_tool_path(path)
    except ValueError as exc:
        return {"error": str(exc)}
    if not dir_path.exists():
        return {"error": f"Directory not found: {dir_path}"}
    if not dir_path.is_dir():
        return {"error": f"Not a directory: {dir_path}"}
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


def build_tools(
    tool_permissions: ToolPermissions,
    user_search_context: str = "",
) -> list[Any]:
    tools: list[Any] = []

    if tool_permissions.current_datetime:

        def get_current_datetime() -> dict[str, Any]:
            """Get the exact current local date and time for relative-date questions.

            Use this whenever the user asks about the current date or time,
            what day it is, or relative dates like today, yesterday, and tomorrow.
            If the answer also depends on a public fact for that date, such as a
            holiday, officeholder, news event, score, or schedule, use
            web_search after resolving the date.
            """

            return get_current_datetime_impl()

        tools.append(get_current_datetime)

    if tool_permissions.local_files:

        def file_read(path: str) -> dict[str, Any]:
            """Read a local text file from disk.

            Args:
                path: The file path to read.
            """

            return file_read_impl(sanitize_tool_string(path))

        def list_directory(path: str) -> dict[str, Any]:
            """List files and folders in a local directory.

            Args:
                path: The directory path to inspect.
            """

            return list_directory_impl(sanitize_tool_string(path))

        tools.extend([file_read, list_directory])

    if tool_permissions.web:

        def web_search(query: str, max_results: int = 5) -> dict[str, Any]:
            """Search web snippets to find sources for current or public facts.

            Args:
                query: The search query to run. Use this to verify public facts,
                    especially when the answer depends on today's date or another
                    relative date. Examples include holidays, officeholders,
                    weather, prices, scores, schedules, and breaking news. If
                    the search snippets are not conclusive enough to answer
                    reliably, follow a relevant result with web_fetch before
                    answering.
                max_results: The maximum number of results to return.
            """
            cleaned_query = sanitize_tool_string(query)
            effective_query, rewritten = contextualize_web_search_query(
                cleaned_query,
                user_search_context,
            )
            result = web_search_impl(effective_query, max_results)
            enriched_result = dict(result)
            enriched_result["requested_query"] = cleaned_query or effective_query
            enriched_result["effective_query"] = effective_query
            enriched_result["query_rewrite_applied"] = (
                "recent_user_context" if rewritten else None
            )
            if rewritten:
                enriched_result["original_query"] = cleaned_query
            return enriched_result

        def web_fetch(url: str, max_chars: int = 12000) -> dict[str, Any]:
            """Fetch the full text of a specific result URL for exact verification.

            Args:
                url: The exact URL to fetch. Use this when the user provides a
                    URL or when you need to inspect a specific page from search
                    because the search snippet alone is not definitive.
                max_chars: The maximum number of characters to return.
            """

            return web_fetch_impl(sanitize_tool_string(url), max_chars)

        tools.extend([web_search, web_fetch])

    if tool_permissions.calculate:

        def calculate(expression: str) -> dict[str, Any]:
            """Evaluate a simple math expression.

            Args:
                expression: The expression to evaluate.
            """

            return calculate_impl(sanitize_tool_string(expression))

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
        self._chat_thread: threading.Thread | None = None
        self._state_lock = threading.RLock()

    def _load_litert_module(self):
        if self._litert_lm is None:
            import litert_lm  # pylint: disable=import-outside-toplevel

            litert_lm.set_min_log_severity(litert_lm.LogSeverity.ERROR)
            self._litert_lm = litert_lm
        return self._litert_lm

    def close_engine(self) -> None:
        with self._state_lock:
            active_conversation = self._active_conversation
            self._active_conversation = None
            self._active_request_id = None
            self._cancelled_request_id = None
            engine = self._engine
            self._engine = None
            self._engine_config = None

        if active_conversation is not None:
            try:
                active_conversation.cancel_process()
            except Exception:
                pass
            try:
                active_conversation.__exit__(None, None, None)
            except Exception:
                pass

        if engine is not None:
            try:
                engine.__exit__(None, None, None)
            except Exception:
                pass

    def _clear_chat_thread_if_current(self) -> None:
        current = threading.current_thread()
        with self._state_lock:
            if self._chat_thread is current:
                self._chat_thread = None

    def _run_chat_command(self, command: dict[str, Any]) -> None:
        request_id = str(command.get("request_id") or "")
        try:
            self.handle_chat(command)
        except Exception as exc:
            write_event("error", request_id=request_id or None, message=str(exc))
            traceback.print_exc(file=sys.stderr)
        finally:
            self._clear_chat_thread_if_current()

    def _start_chat_thread(self, command: dict[str, Any]) -> None:
        request_id = str(command.get("request_id") or "")
        with self._state_lock:
            if self._chat_thread is not None and self._chat_thread.is_alive():
                write_event(
                    "error",
                    request_id=request_id or None,
                    message="Another chat request is already running.",
                )
                return
            chat_thread = threading.Thread(
                target=self._run_chat_command,
                args=(command,),
                name=f"friday-chat-{request_id or 'request'}",
                daemon=True,
            )
            self._chat_thread = chat_thread
            chat_thread.start()

    def _join_chat_thread(self, timeout: float | None = None) -> None:
        with self._state_lock:
            chat_thread = self._chat_thread
        if chat_thread is not None and chat_thread.is_alive():
            chat_thread.join(timeout=timeout)

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
        with self._state_lock:
            engine = self._engine
        if engine is None:
            raise RuntimeError("Worker received chat before warm.")

        request_id = str(command["request_id"])
        messages = command.get("messages")
        if not isinstance(messages, list):
            raise ValueError("Chat request messages must be a list.")

        preface, prompt = split_messages_for_conversation(messages)
        generation_config = command.get("generation_config") or {}
        if not isinstance(generation_config, dict):
            raise ValueError("generation_config must be an object.")
        tool_permissions = ToolPermissions.from_command(command)
        thinking_enabled = parse_bool_flag(
            generation_config.get("thinking_enabled"),
            field_name="generation_config.thinking_enabled",
        )
        user_text = extract_text_from_message(prompt)
        user_search_context = build_web_search_context(preface, prompt) if tool_permissions.web else ""
        if tool_permissions.web and user_text.strip():
            web_guidance = build_web_tool_guidance(user_text)
            if web_guidance:
                preface = [*preface, {"role": "system", "content": web_guidance}]

        tools = build_tools(tool_permissions, user_search_context=user_search_context)
        tool_handler = FridayToolEventHandler(request_id) if tools else None

        conversation = engine.create_conversation(
            messages=preface or None,
            tools=tools or None,
            tool_event_handler=tool_handler,
            extra_context={"enable_thinking": thinking_enabled},
        )
        conversation.__enter__()
        with self._state_lock:
            self._active_conversation = conversation
            self._active_request_id = request_id
            self._cancelled_request_id = None
        streamed_answer_text = ""
        streamed_thought_text = ""
        latest_answer_snapshot = ""
        latest_thought_snapshot = ""
        saw_cumulative_answer_growth = False
        saw_cumulative_thought_growth = False
        saw_incremental_answer_updates = False
        saw_incremental_thought_updates = False

        def emit_done() -> None:
            final_text = resolve_final_stream_text(
                streamed_answer_text,
                latest_answer_snapshot,
                saw_cumulative_growth=saw_cumulative_answer_growth,
                saw_incremental_updates=saw_incremental_answer_updates,
            )
            final_thought = resolve_final_stream_text(
                streamed_thought_text,
                latest_thought_snapshot,
                saw_cumulative_growth=saw_cumulative_thought_growth,
                saw_incremental_updates=saw_incremental_thought_updates,
            )
            payload: dict[str, Any] = {"request_id": request_id}
            if final_text:
                payload["final_text"] = final_text
            if final_thought:
                payload["final_thought"] = final_thought
            write_event("done", **payload)

        try:
            for chunk in conversation.send_message_async(prompt):
                answer_snapshot, thought_snapshot = extract_chunk_channel_texts(chunk)
                if answer_snapshot:
                    if snapshot_shows_cumulative_growth(
                        latest_answer_snapshot, answer_snapshot
                    ):
                        saw_cumulative_answer_growth = True
                    elif latest_answer_snapshot:
                        saw_incremental_answer_updates = True
                    latest_answer_snapshot = answer_snapshot
                if thought_snapshot:
                    if snapshot_shows_cumulative_growth(
                        latest_thought_snapshot, thought_snapshot
                    ):
                        saw_cumulative_thought_growth = True
                    elif latest_thought_snapshot:
                        saw_incremental_thought_updates = True
                    latest_thought_snapshot = thought_snapshot

                incremental_events, streamed_answer_text, streamed_thought_text = (
                    chunk_to_incremental_events(
                        request_id,
                        chunk,
                        streamed_answer_text,
                        streamed_thought_text,
                    )
                )
                for event in incremental_events:
                    write_event(event["type"], **{k: v for k, v in event.items() if k != "type"})
        except Exception as exc:
            with self._state_lock:
                was_cancelled = self._cancelled_request_id == request_id
            if was_cancelled:
                emit_done()
            else:
                write_event("error", request_id=request_id, message=str(exc))
                traceback.print_exc(file=sys.stderr)
        else:
            emit_done()
        finally:
            try:
                conversation.__exit__(None, None, None)
            finally:
                with self._state_lock:
                    self._active_conversation = None
                    self._active_request_id = None
                    self._cancelled_request_id = None

    def handle_cancel(self, command: dict[str, Any]) -> None:
        request_id = str(command["request_id"])
        with self._state_lock:
            if request_id != self._active_request_id or self._active_conversation is None:
                return
            self._cancelled_request_id = request_id
            active_conversation = self._active_conversation
        try:
            active_conversation.cancel_process()
        except Exception:
            return

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
                    self._start_chat_thread(command)
                elif command_type == "cancel":
                    self.handle_cancel(command)
                elif command_type == "shutdown":
                    with self._state_lock:
                        active_request_id = self._active_request_id
                    if active_request_id:
                        self.handle_cancel({"request_id": active_request_id})
                    self._join_chat_thread(timeout=5.0)
                    self.close_engine()
                    return 0
                else:
                    raise ValueError(f"Unsupported worker command: {command_type}")
        except Exception as exc:
            write_event("error", request_id=None, message=str(exc))
            traceback.print_exc(file=sys.stderr)
            return 1
        finally:
            self._join_chat_thread(timeout=5.0)
            self.close_engine()

        return 0


def main() -> int:
    return LiteRtWorker().run()


if __name__ == "__main__":
    raise SystemExit(main())
