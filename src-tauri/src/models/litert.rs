use crate::models::{ChatContent, ChatContentPart, ChatMessage};
use crate::settings::GenerationRequestConfig;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::str;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

const GEMMA_THINKING_TRIGGER: &str = "<|think|>";
const GEMMA_THINKING_CHANNEL_START: &str = "<|channel>thought\n";
const GEMMA_THINKING_CHANNEL_END: &str = "<channel|>";
const WEB_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const WEB_FETCH_MAX_BYTES: usize = 1_000_000;
const WEB_FETCH_MAX_CHARS: usize = 20_000;
const WEB_FETCH_MAX_REDIRECTS: usize = 5;

#[derive(Debug)]
pub enum StreamEvent {
    Token(String),
    Thought(String),
    Error(String),
    Done,
    ToolCall {
        name: String,
        args: serde_json::Value,
    },
    ToolResult {
        name: String,
        result: serde_json::Value,
    },
}

pub struct DaemonClient {
    child: Child,
    client: reqwest::Client,
    base_url: String,
    model_id: String,
}

impl DaemonClient {
    pub async fn spawn(
        lit_binary: &Path,
        lit_dir: &Path,
        port: u16,
        backend: Option<&str>,
        model_id: &str,
    ) -> Result<Self, String> {
        let mut command = Command::new(lit_binary);
        command
            .arg("serve")
            .arg("-p")
            .arg(port.to_string())
            .arg("--enable_constrained_decoding")
            .env("LIT_DIR", lit_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(backend) = backend {
            command.arg(format!("--backend={backend}"));
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to start LiteRT-LM server: {e}"))?;

        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        tracing::info!("LiteRT-LM stdout: {}", line);
                    }
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        tracing::warn!("LiteRT-LM stderr: {}", line);
                    }
                }
            });
        }

        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
        {
            Ok(client) => client,
            Err(e) => {
                let _ = child.kill().await;
                return Err(format!("Failed to build LiteRT-LM HTTP client: {}", e));
            }
        };
        let base_url = format!("http://127.0.0.1:{port}");

        if let Err(error) = wait_for_health(&client, &base_url).await {
            let _ = child.kill().await;
            return Err(error);
        }

        Ok(Self {
            child,
            client,
            base_url,
            model_id: model_id.to_string(),
        })
    }

    pub async fn send_chat_with_options(
        &mut self,
        _session_id: &str,
        messages: &[ChatMessage],
        generation_config: GenerationRequestConfig,
        tools_enabled: bool,
        rag_context: Option<serde_json::Value>,
    ) -> Result<mpsc::Receiver<StreamEvent>, String> {
        let client = self.client.clone();
        let request = ChatRoundtripRequest {
            base_url: self.base_url.clone(),
            model_id: self.model_id.clone(),
            generation_config,
            messages: messages.to_vec(),
            tools_enabled,
            rag_context,
        };

        let (tx, rx) = mpsc::channel(128);
        tokio::spawn(async move {
            let result = run_chat_roundtrip(client, request, &tx).await;

            if let Err(error) = result {
                let _ = tx.send(StreamEvent::Error(error)).await;
            }
        });

        Ok(rx)
    }

    pub async fn send_shutdown(&mut self) -> Result<(), String> {
        self.kill().await
    }

    pub fn is_alive(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }

    pub async fn kill(&mut self) -> Result<(), String> {
        self.child
            .kill()
            .await
            .map_err(|e| format!("Failed to kill LiteRT-LM server: {e}"))
    }
}

impl Drop for DaemonClient {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

#[derive(Clone)]
struct ChatRoundtripRequest {
    base_url: String,
    model_id: String,
    generation_config: GenerationRequestConfig,
    messages: Vec<ChatMessage>,
    tools_enabled: bool,
    rag_context: Option<Value>,
}

async fn wait_for_health(client: &reqwest::Client, base_url: &str) -> Result<(), String> {
    for _ in 0..480 {
        if let Ok(response) = client.get(format!("{base_url}/health")).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }

    Err("LiteRT-LM server did not become healthy in time.".to_string())
}

async fn run_chat_roundtrip(
    client: reqwest::Client,
    request: ChatRoundtripRequest,
    tx: &mpsc::Sender<StreamEvent>,
) -> Result<(), String> {
    let tool_permissions = ToolPermissions::web_assist_enabled(request.tools_enabled);
    let mut request_state = build_request_state(request.messages, request.rag_context)?;

    if tool_permissions.web && should_force_web_search(&request_state.user_text) {
        let args = json!({
            "query": request_state.user_text,
            "max_results": 5,
        });
        let _ = tx
            .send(StreamEvent::ToolCall {
                name: "web_search".to_string(),
                args: args.clone(),
            })
            .await;
        let result = execute_tool("web_search", &args, tool_permissions).await;
        let _ = tx
            .send(StreamEvent::ToolResult {
                name: "web_search".to_string(),
                result: result.clone(),
            })
            .await;
        inject_web_search_results(&mut request_state.contents, &result);
    }

    loop {
        let body = build_generate_content_request(
            &request_state.system_instruction,
            &request_state.contents,
            &request.generation_config,
            tool_permissions,
        );
        let stream_url = format!(
            "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
            request.base_url, request.model_id
        );
        let streamed = stream_generate_content(&client, &stream_url, &body, tx).await;
        let StreamedRound {
            function_calls,
            model_content,
        } = match streamed {
            Ok(round) => round,
            Err(stream_error) => {
                tracing::warn!(
                    "LiteRT-LM streaming failed, falling back to generateContent: {}",
                    stream_error
                );
                complete_generate_content_round(
                    &client,
                    &request.base_url,
                    &request.model_id,
                    &body,
                    tx,
                )
                .await?
            }
        };

        if !function_calls.is_empty() {
            request_state
                .contents
                .push(model_content.unwrap_or_else(|| {
                    json!({
                        "role": "model",
                        "parts": function_calls
                            .iter()
                            .map(|function_call| json!({ "functionCall": function_call }))
                            .collect::<Vec<_>>(),
                    })
                }));

            let mut response_parts = Vec::new();
            for function_call in function_calls {
                let name = function_call
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let args = function_call
                    .get("args")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let _ = tx
                    .send(StreamEvent::ToolCall {
                        name: name.clone(),
                        args: args.clone(),
                    })
                    .await;
                let result = execute_tool(&name, &args, tool_permissions).await;
                let _ = tx
                    .send(StreamEvent::ToolResult {
                        name: name.clone(),
                        result: result.clone(),
                    })
                    .await;
                response_parts.push(json!({
                    "functionResponse": {
                        "name": name,
                        "response": result,
                    }
                }));
            }

            request_state.contents.push(json!({
                "role": "user",
                "parts": response_parts,
            }));
            continue;
        }

        let _ = tx.send(StreamEvent::Done).await;
        return Ok(());
    }
}

struct StreamedRound {
    function_calls: Vec<Value>,
    model_content: Option<Value>,
}

async fn stream_generate_content(
    client: &reqwest::Client,
    stream_url: &str,
    body: &Value,
    tx: &mpsc::Sender<StreamEvent>,
) -> Result<StreamedRound, String> {
    let response = client
        .post(stream_url)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("LiteRT-LM stream request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        return Err(format!(
            "LiteRT-LM stream request failed: HTTP {} {}",
            status, error_body
        ));
    }

    let mut bytes_stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut function_calls = Vec::new();
    let mut emitted_answer = String::new();
    let mut emitted_thought = String::new();
    let mut model_content = None;

    while let Some(next) = bytes_stream.next().await {
        let chunk = next.map_err(|e| format!("Failed to read LiteRT-LM stream chunk: {}", e))?;
        buffer.extend_from_slice(&chunk);

        while let Some(data) = pop_next_sse_payload(&mut buffer)? {
            if data == "[DONE]" {
                continue;
            }

            process_stream_payload(
                &data,
                tx,
                &mut function_calls,
                &mut emitted_answer,
                &mut emitted_thought,
                &mut model_content,
            )
            .await?;
        }
    }

    if !buffer.is_empty() {
        let Some(data) = parse_sse_event_data(&buffer)? else {
            let fallback_model_content =
                model_content.or_else(|| function_calls_to_model_content(&function_calls));
            buffer.clear();
            return Ok(StreamedRound {
                function_calls,
                model_content: fallback_model_content,
            });
        };

        if data != "[DONE]" {
            process_stream_payload(
                &data,
                tx,
                &mut function_calls,
                &mut emitted_answer,
                &mut emitted_thought,
                &mut model_content,
            )
            .await?;
        }
        buffer.clear();
    }

    let fallback_model_content =
        model_content.or_else(|| function_calls_to_model_content(&function_calls));
    Ok(StreamedRound {
        function_calls,
        model_content: fallback_model_content,
    })
}

async fn complete_generate_content_round(
    client: &reqwest::Client,
    base_url: &str,
    model_id: &str,
    body: &Value,
    tx: &mpsc::Sender<StreamEvent>,
) -> Result<StreamedRound, String> {
    let response = client
        .post(format!(
            "{base_url}/v1beta/models/{model_id}:generateContent"
        ))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("LiteRT-LM request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        return Err(format!(
            "LiteRT-LM request failed: HTTP {} {}",
            status, error_body
        ));
    }

    let payload: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to decode LiteRT-LM response: {}", e))?;

    let candidate = payload
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .ok_or_else(|| "LiteRT-LM response did not contain a candidate.".to_string())?;

    let raw_content = candidate
        .get("content")
        .cloned()
        .unwrap_or_else(|| json!({"role":"model","parts":[]}));
    let content = sanitize_model_content(&raw_content);
    let parts = raw_content
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut function_calls = Vec::new();
    for part in &parts {
        if let Some(function_call) = part.get("functionCall") {
            function_calls.push(function_call.clone());
        }
    }

    let parsed = extract_parsed_text(&parts, false);
    if !parsed.thought.is_empty() && tx.send(StreamEvent::Thought(parsed.thought)).await.is_err() {
        return Ok(StreamedRound {
            function_calls,
            model_content: Some(content),
        });
    }
    if !parsed.answer.is_empty() && tx.send(StreamEvent::Token(parsed.answer)).await.is_err() {
        return Ok(StreamedRound {
            function_calls,
            model_content: Some(content),
        });
    }

    Ok(StreamedRound {
        function_calls,
        model_content: Some(content),
    })
}

fn pop_next_sse_payload(buffer: &mut Vec<u8>) -> Result<Option<String>, String> {
    if let Some((boundary_index, boundary_len)) = find_sse_event_boundary(buffer) {
        let event = buffer.drain(..boundary_index).collect::<Vec<_>>();
        buffer.drain(..boundary_len);
        return parse_sse_event_data(&event);
    }

    // LiteRT-LM currently emits one `data:` line per chunk terminated with CRLF,
    // without the blank line required by strict SSE framing. Accept that format
    // as a line-delimited fallback so tokens can stream incrementally.
    let Some((line_end, line_ending_len)) = find_line_boundary(buffer) else {
        return Ok(None);
    };

    let line = &buffer[..line_end];
    let Some(data) = parse_sse_event_data(line)? else {
        return Ok(None);
    };

    if data != "[DONE]" && serde_json::from_str::<Value>(&data).is_err() {
        return Ok(None);
    }

    buffer.drain(..line_end + line_ending_len);
    Ok(Some(data))
}

fn find_sse_event_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0usize;
    while index + 1 < buffer.len() {
        if buffer[index] == b'\n' && buffer[index + 1] == b'\n' {
            return Some((index, 2));
        }
        if index + 3 < buffer.len()
            && buffer[index] == b'\r'
            && buffer[index + 1] == b'\n'
            && buffer[index + 2] == b'\r'
            && buffer[index + 3] == b'\n'
        {
            return Some((index, 4));
        }
        index += 1;
    }

    None
}

fn find_line_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0usize;
    while index < buffer.len() {
        if buffer[index] == b'\n' {
            if index > 0 && buffer[index - 1] == b'\r' {
                return Some((index - 1, 2));
            }
            return Some((index, 1));
        }
        index += 1;
    }

    None
}

fn parse_sse_event_data(event_bytes: &[u8]) -> Result<Option<String>, String> {
    if event_bytes.is_empty() {
        return Ok(None);
    }

    let event = str::from_utf8(event_bytes)
        .map_err(|e| format!("LiteRT-LM stream contained invalid UTF-8: {}", e))?;
    let mut data_lines = Vec::new();

    for raw_line in event.lines() {
        let line = raw_line.trim_end_matches('\r');
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start());
        }
    }

    if data_lines.is_empty() {
        Ok(None)
    } else {
        Ok(Some(data_lines.join("\n")))
    }
}

async fn process_stream_payload(
    data: &str,
    tx: &mpsc::Sender<StreamEvent>,
    function_calls: &mut Vec<Value>,
    emitted_answer: &mut String,
    emitted_thought: &mut String,
    model_content: &mut Option<Value>,
) -> Result<(), String> {
    let payload: Value = serde_json::from_str(data)
        .map_err(|e| format!("Failed to decode LiteRT-LM stream event: {}", e))?;

    let Some(content) = payload
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .cloned()
    else {
        return Ok(());
    };

    let content = sanitize_model_content(&content);

    let parts = payload
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for part in parts {
        if let Some(function_call) = part.get("functionCall") {
            function_calls.push(function_call.clone());
        }
    }

    let parsed = extract_parsed_text(
        payload
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first())
            .and_then(|candidate| candidate.get("content"))
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        true,
    );
    let thought_delta = compute_text_delta(emitted_thought, &parsed.thought);
    if !thought_delta.is_empty()
        && tx
            .send(StreamEvent::Thought(thought_delta.clone()))
            .await
            .is_err()
    {
        return Ok(());
    }
    emitted_thought.push_str(&thought_delta);

    let answer_delta = compute_text_delta(emitted_answer, &parsed.answer);
    if !answer_delta.is_empty()
        && tx
            .send(StreamEvent::Token(answer_delta.clone()))
            .await
            .is_err()
    {
        return Ok(());
    }
    emitted_answer.push_str(&answer_delta);

    let sanitized_parts = content
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    *model_content = Some(json!({
        "role": content.get("role").cloned().unwrap_or_else(|| json!("model")),
        "parts": sanitized_parts,
    }));

    Ok(())
}

fn compute_text_delta(emitted_text: &str, next_text: &str) -> String {
    if next_text.is_empty() {
        return String::new();
    }

    if emitted_text.is_empty() {
        return next_text.to_string();
    }

    if let Some(suffix) = next_text.strip_prefix(emitted_text) {
        return suffix.to_string();
    }

    if emitted_text.ends_with(next_text) {
        return String::new();
    }

    let max_overlap = emitted_text.len().min(next_text.len());
    for overlap in (1..=max_overlap).rev() {
        if emitted_text.is_char_boundary(emitted_text.len() - overlap)
            && next_text.is_char_boundary(overlap)
            && emitted_text[emitted_text.len() - overlap..] == next_text[..overlap]
        {
            return next_text[overlap..].to_string();
        }
    }

    next_text.to_string()
}

fn function_calls_to_model_content(function_calls: &[Value]) -> Option<Value> {
    if function_calls.is_empty() {
        return None;
    }

    Some(json!({
        "role": "model",
        "parts": function_calls
            .iter()
            .map(|function_call| json!({ "functionCall": function_call }))
            .collect::<Vec<_>>(),
    }))
}

struct RequestState {
    system_instruction: String,
    contents: Vec<Value>,
    user_text: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ToolPermissions {
    web: bool,
    local_files: bool,
    calculate: bool,
}

impl ToolPermissions {
    fn web_assist_enabled(enabled: bool) -> Self {
        Self {
            web: enabled,
            local_files: false,
            calculate: enabled,
        }
    }

    fn allows(self, name: &str) -> bool {
        match name {
            "web_search" | "web_fetch" => self.web,
            "file_read" | "list_directory" => self.local_files,
            "calculate" => self.calculate,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ThinkingChannelFilter {
    in_thought: bool,
}

impl ThinkingChannelFilter {
    fn split(&mut self, text: &str, suppress_partial_markers: bool) -> ParsedThinkingText {
        let mut parsed = ParsedThinkingText::default();
        let mut cursor = 0usize;

        while cursor < text.len() {
            if self.in_thought {
                if let Some(offset) = text[cursor..].find(GEMMA_THINKING_CHANNEL_END) {
                    parsed.thought.push_str(&text[cursor..cursor + offset]);
                    cursor += offset + GEMMA_THINKING_CHANNEL_END.len();
                    self.in_thought = false;
                    continue;
                }

                let remainder = &text[cursor..];
                if suppress_partial_markers {
                    let partial_len =
                        trailing_partial_marker_len(remainder, GEMMA_THINKING_CHANNEL_END);
                    let visible_len = remainder.len().saturating_sub(partial_len);
                    parsed.thought.push_str(&remainder[..visible_len]);
                } else {
                    parsed.thought.push_str(remainder);
                }
                break;
            }

            if let Some(offset) = text[cursor..].find(GEMMA_THINKING_CHANNEL_START) {
                parsed.answer.push_str(&text[cursor..cursor + offset]);
                cursor += offset + GEMMA_THINKING_CHANNEL_START.len();
                self.in_thought = true;
                continue;
            }

            let remainder = &text[cursor..];
            if suppress_partial_markers {
                let partial_len =
                    trailing_partial_marker_len(remainder, GEMMA_THINKING_CHANNEL_START);
                let visible_len = remainder.len().saturating_sub(partial_len);
                parsed.answer.push_str(&remainder[..visible_len]);
            } else {
                parsed.answer.push_str(remainder);
            }
            break;
        }

        parsed
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct ParsedThinkingText {
    answer: String,
    thought: String,
}

fn trailing_partial_marker_len(text: &str, marker: &str) -> usize {
    let max_len = text.len().min(marker.len().saturating_sub(1));
    for len in (1..=max_len).rev() {
        if text.ends_with(&marker[..len]) {
            return len;
        }
    }
    0
}

fn split_thinking_from_text(text: &str, suppress_partial_markers: bool) -> ParsedThinkingText {
    let mut filter = ThinkingChannelFilter::default();
    filter.split(text, suppress_partial_markers)
}

fn extract_parsed_text(parts: &[Value], suppress_partial_markers: bool) -> ParsedThinkingText {
    let mut parsed = ParsedThinkingText::default();

    for part in parts {
        let Some(text) = part.get("text").and_then(Value::as_str) else {
            continue;
        };

        if part
            .get("thought")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            parsed.thought.push_str(text);
            continue;
        }

        let split = split_thinking_from_text(text, suppress_partial_markers);
        parsed.answer.push_str(&split.answer);
        parsed.thought.push_str(&split.thought);
    }

    parsed
}

fn sanitize_model_content(content: &Value) -> Value {
    let Some(parts) = content.get("parts").and_then(Value::as_array) else {
        return content.clone();
    };

    let mut filter = ThinkingChannelFilter::default();
    let mut sanitized_parts = Vec::new();

    for part in parts {
        if part
            .get("thought")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }

        if let Some(text) = part.get("text").and_then(Value::as_str) {
            let visible = filter.split(text, false).answer;
            if visible.is_empty() {
                continue;
            }

            let mut sanitized = part.clone();
            if let Some(object) = sanitized.as_object_mut() {
                object.insert("text".to_string(), Value::String(visible));
            }
            sanitized_parts.push(sanitized);
            continue;
        }

        sanitized_parts.push(part.clone());
    }

    let mut sanitized = content.clone();
    if let Some(object) = sanitized.as_object_mut() {
        object.insert("parts".to_string(), Value::Array(sanitized_parts));
    }
    sanitized
}

fn build_request_state(
    messages: Vec<ChatMessage>,
    rag_context: Option<Value>,
) -> Result<RequestState, String> {
    let (preface, prompt) = split_preface_and_prompt(&messages)?;
    let mut system_parts = Vec::new();
    let mut contents = Vec::new();

    for message in preface {
        if message.role == "system" {
            if let Some(text) = as_text_block(&message.content) {
                system_parts.push(text);
            }
            continue;
        }
        contents.push(chat_message_to_gemini_content(&message)?);
    }

    let user_text = as_text_block(&prompt.content).unwrap_or_default();
    let prompt = augment_prompt_with_rag(prompt, rag_context);
    contents.push(chat_message_to_gemini_content(&prompt)?);

    Ok(RequestState {
        system_instruction: system_parts.join("\n\n").trim().to_string(),
        contents,
        user_text,
    })
}

fn augment_prompt_with_rag(prompt: ChatMessage, rag_context: Option<Value>) -> ChatMessage {
    let Some(context) = rag_context else {
        return prompt;
    };
    let Some(results) = context.get("results").and_then(Value::as_array) else {
        return prompt;
    };
    if results.is_empty() {
        return prompt;
    }

    let mut rag_lines = Vec::new();
    for result in results.iter().take(5) {
        let file = result
            .get("file_name")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let text = result.get("text").and_then(Value::as_str).unwrap_or("");
        if !text.is_empty() {
            rag_lines.push(format!("[{file}] {text}"));
        }
    }

    if rag_lines.is_empty() {
        return prompt;
    }

    let prefix = format!(
        "Relevant local documents for this turn:\n{}\n\nUse this context when it is relevant to the user's request.",
        rag_lines.join("\n\n")
    );

    match prompt.content {
        ChatContent::Text(text) => ChatMessage {
            role: prompt.role,
            content: ChatContent::Text(format!("{prefix}\n\nUser request:\n{text}")),
        },
        ChatContent::Parts(mut parts) => {
            parts.insert(0, ChatContentPart::Text { text: prefix });
            ChatMessage {
                role: prompt.role,
                content: ChatContent::Parts(parts),
            }
        }
    }
}

fn build_generate_content_request(
    system_instruction: &str,
    contents: &[Value],
    generation_config: &GenerationRequestConfig,
    tool_permissions: ToolPermissions,
) -> Value {
    let system_instruction =
        apply_native_thinking_mode(system_instruction, generation_config.thinking_enabled);
    let mut body = json!({
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": generation_config.max_output_tokens,
        },
    });

    if let Some(temperature) = generation_config.temperature {
        body["generationConfig"]["temperature"] = json!(temperature);
    }

    if let Some(top_p) = generation_config.top_p {
        body["generationConfig"]["topP"] = json!(top_p);
    }

    if generation_config.thinking_enabled.unwrap_or(false) {
        body["generationConfig"]["thinkingConfig"] = json!({
            "includeThoughts": true,
        });
    }

    if !system_instruction.is_empty() {
        body["systemInstruction"] = json!({
            "parts": [{ "text": system_instruction }]
        });
    }

    if tool_permissions != ToolPermissions::default() {
        body["tools"] = json!([{
            "functionDeclarations": tool_declarations(tool_permissions),
        }]);
    }

    body
}

fn apply_native_thinking_mode(system_instruction: &str, thinking_enabled: Option<bool>) -> String {
    if !thinking_enabled.unwrap_or(false) {
        return system_instruction.to_string();
    }

    if system_instruction
        .trim_start()
        .starts_with(GEMMA_THINKING_TRIGGER)
    {
        return system_instruction.to_string();
    }

    if system_instruction.is_empty() {
        return GEMMA_THINKING_TRIGGER.to_string();
    }

    format!("{GEMMA_THINKING_TRIGGER}\n{system_instruction}")
}

fn chat_message_to_gemini_content(message: &ChatMessage) -> Result<Value, String> {
    let role = match message.role.as_str() {
        "assistant" => "model",
        "system" => "user",
        _ => "user",
    };

    let parts = match &message.content {
        ChatContent::Text(text) => vec![json!({ "text": text })],
        ChatContent::Parts(parts) => {
            let mut converted = Vec::new();
            for part in parts {
                match part {
                    ChatContentPart::Text { text } => converted.push(json!({ "text": text })),
                    ChatContentPart::Image { blob } => {
                        let (mime_type, data) = split_data_url(blob)?;
                        converted.push(json!({
                            "inlineData": {
                                "mimeType": mime_type,
                                "data": data,
                            }
                        }));
                    }
                    ChatContentPart::Audio { path } => {
                        let bytes = std::fs::read(path)
                            .map_err(|e| format!("Failed to read audio file {}: {}", path, e))?;
                        let mime_type = guess_audio_mime(Path::new(path));
                        let data = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            bytes,
                        );
                        converted.push(json!({
                            "inlineData": {
                                "mimeType": mime_type,
                                "data": data,
                            }
                        }));
                    }
                }
            }
            converted
        }
    };

    Ok(json!({
        "role": role,
        "parts": parts,
    }))
}

fn split_preface_and_prompt(
    messages: &[ChatMessage],
) -> Result<(Vec<ChatMessage>, ChatMessage), String> {
    let prompt = messages
        .last()
        .cloned()
        .ok_or_else(|| "No prompt was provided to LiteRT-LM".to_string())?;

    if prompt.role != "user" {
        return Err("LiteRT-LM expects the final chat message to be from the user".to_string());
    }

    Ok((messages[..messages.len() - 1].to_vec(), prompt))
}

fn split_data_url(value: &str) -> Result<(String, String), String> {
    let (header, data) = value
        .split_once(',')
        .ok_or_else(|| "Image attachment is not a valid data URL.".to_string())?;
    let mime_type = header
        .strip_prefix("data:")
        .and_then(|rest| rest.split(';').next())
        .filter(|mime| !mime.is_empty())
        .ok_or_else(|| "Image attachment is missing a MIME type.".to_string())?;
    Ok((mime_type.to_string(), data.to_string()))
}

fn guess_audio_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_lowercase()
        .as_str()
    {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

fn as_text_block(content: &ChatContent) -> Option<String> {
    match content {
        ChatContent::Text(text) => Some(text.clone()),
        ChatContent::Parts(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| match part {
                    ChatContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
    }
}

fn should_force_web_search(user_text: &str) -> bool {
    let lowered = user_text.to_lowercase();
    [
        "today", "current", "latest", "now", "live", "news", "weather", "forecast", "price",
        "stock", "score", "schedule",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

fn inject_web_search_results(contents: &mut [Value], search_result: &Value) {
    let Some(last) = contents.last_mut() else {
        return;
    };
    let Some(parts) = last.get_mut("parts").and_then(Value::as_array_mut) else {
        return;
    };
    let Some(results) = search_result.get("results").and_then(Value::as_array) else {
        return;
    };
    if results.is_empty() {
        return;
    }

    let mut lines = Vec::new();
    for result in results.iter().take(5) {
        let title = result.get("title").and_then(Value::as_str).unwrap_or("");
        let url = result.get("url").and_then(Value::as_str).unwrap_or("");
        let snippet = result.get("snippet").and_then(Value::as_str).unwrap_or("");
        let line = [title, url, snippet]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" - ");
        if !line.is_empty() {
            lines.push(line);
        }
    }

    if lines.is_empty() {
        return;
    }

    parts.insert(
        0,
        json!({
            "text": format!(
                "Live web search results for this turn:\n{}\n\nUse these results as current external context when relevant.",
                lines.join("\n")
            )
        }),
    );
}

fn tool_declarations(tool_permissions: ToolPermissions) -> Vec<Value> {
    let mut declarations = Vec::new();

    if tool_permissions.web {
        declarations.push(json!({
            "name": "web_search",
            "description": "Search the web for current information.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "query": { "type": "STRING" },
                    "max_results": { "type": "INTEGER" }
                },
                "required": ["query"]
            }
        }));
        declarations.push(json!({
            "name": "web_fetch",
            "description": "Fetch a URL and extract visible text content.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "url": { "type": "STRING" },
                    "max_chars": { "type": "INTEGER" }
                },
                "required": ["url"]
            }
        }));
    }

    if tool_permissions.local_files {
        declarations.push(json!({
            "name": "file_read",
            "description": "Read a local text file from disk.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "path": { "type": "STRING" }
                },
                "required": ["path"]
            }
        }));
        declarations.push(json!({
            "name": "list_directory",
            "description": "List files and folders in a local directory.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "path": { "type": "STRING" }
                },
                "required": ["path"]
            }
        }));
    }

    if tool_permissions.calculate {
        declarations.push(json!({
            "name": "calculate",
            "description": "Evaluate a simple math expression.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "expression": { "type": "STRING" }
                },
                "required": ["expression"]
            }
        }));
    }

    declarations
}

async fn execute_tool(name: &str, args: &Value, tool_permissions: ToolPermissions) -> Value {
    if !tool_permissions.allows(name) {
        return json!({
            "error": format!("Tool {name} is not enabled for this chat.")
        });
    }

    match name {
        "web_search" => {
            web_search(
                args.get("query").and_then(Value::as_str).unwrap_or(""),
                args.get("max_results")
                    .and_then(Value::as_u64)
                    .map(|v| v as usize)
                    .unwrap_or(5),
            )
            .await
        }
        "web_fetch" => {
            web_fetch(
                args.get("url").and_then(Value::as_str).unwrap_or(""),
                args.get("max_chars")
                    .and_then(Value::as_u64)
                    .map(|v| v as usize)
                    .unwrap_or(5000),
            )
            .await
        }
        "file_read" => file_read(args.get("path").and_then(Value::as_str).unwrap_or("")),
        "list_directory" => list_directory(args.get("path").and_then(Value::as_str).unwrap_or("")),
        "calculate" => calculate(args.get("expression").and_then(Value::as_str).unwrap_or("")),
        _ => json!({ "error": format!("Unknown tool: {}", name) }),
    }
}

async fn web_search(query: &str, max_results: usize) -> Value {
    if query.trim().is_empty() {
        return json!({ "error": "Query is required." });
    }

    let encoded = urlencoding::encode(query);
    let client = match reqwest::Client::builder()
        .user_agent("Friday/0.1")
        .timeout(WEB_FETCH_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => return json!({ "error": error.to_string() }),
    };

    let response = match client
        .get(format!("https://html.duckduckgo.com/html/?q={encoded}"))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return json!({ "error": error.to_string() }),
    };

    let html = match response.text().await {
        Ok(html) => html,
        Err(error) => return json!({ "error": error.to_string() }),
    };

    let mut results = Vec::new();
    for segment in html.split("result__body").skip(1).take(max_results.min(10)) {
        let title = extract_between(segment, "result__a", "</a>")
            .and_then(|value| value.split('>').next_back().map(strip_tags))
            .unwrap_or_default();
        let url = segment
            .split("uddg=")
            .nth(1)
            .and_then(|value| value.split('&').next())
            .map(urlencoding::decode)
            .and_then(Result::ok)
            .map(|value| value.into_owned())
            .unwrap_or_default();
        let snippet = extract_between(segment, "result__snippet", "</a>")
            .map(strip_tags)
            .unwrap_or_default();
        if !title.is_empty() || !url.is_empty() || !snippet.is_empty() {
            results.push(json!({
                "title": title,
                "url": url,
                "snippet": snippet,
            }));
        }
    }

    json!({
        "query": query,
        "results": results,
        "total": results.len(),
    })
}

async fn web_fetch(url: &str, max_chars: usize) -> Value {
    if url.trim().is_empty() {
        return json!({ "error": "URL is required." });
    }

    let validated_url = match validate_remote_web_url(url).await {
        Ok(validated_url) => validated_url,
        Err(error) => return json!({ "error": error }),
    };
    let max_chars = max_chars.clamp(1, WEB_FETCH_MAX_CHARS);

    let client = match reqwest::Client::builder()
        .user_agent("Friday/0.1")
        .timeout(WEB_FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(WEB_FETCH_MAX_REDIRECTS))
        .build()
    {
        Ok(client) => client,
        Err(error) => return json!({ "error": error.to_string() }),
    };

    let response = match client.get(validated_url.clone()).send().await {
        Ok(response) => response,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    if !response.status().is_success() {
        return json!({
            "error": format!("Fetch failed with HTTP {}", response.status())
        });
    }

    if response
        .content_length()
        .is_some_and(|content_length| content_length as usize > WEB_FETCH_MAX_BYTES)
    {
        return json!({
            "error": format!("Response exceeds {} bytes.", WEB_FETCH_MAX_BYTES)
        });
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_supported_web_fetch_content_type(&content_type) {
        return json!({
            "error": format!(
                "Unsupported content type: {}",
                if content_type.is_empty() {
                    "unknown"
                } else {
                    &content_type
                }
            )
        });
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(next_chunk) = stream.next().await {
        let chunk = match next_chunk {
            Ok(chunk) => chunk,
            Err(error) => return json!({ "error": error.to_string() }),
        };
        if body.len().saturating_add(chunk.len()) > WEB_FETCH_MAX_BYTES {
            return json!({
                "error": format!("Response exceeds {} bytes.", WEB_FETCH_MAX_BYTES)
            });
        }
        body.extend_from_slice(&chunk);
    }

    let body_text = match String::from_utf8(body) {
        Ok(body_text) => body_text,
        Err(error) => {
            return json!({
                "error": format!("Response was not valid UTF-8: {}", error)
            });
        }
    };
    let content = strip_tags(&body_text);
    let (snippet, was_truncated) = truncate_to_char_limit(&content, max_chars);
    let truncated = if was_truncated {
        format!("{snippet}... [truncated]")
    } else {
        snippet
    };

    json!({
        "url": validated_url.as_str(),
        "content": truncated,
        "length": truncated.chars().count(),
        "contentType": content_type,
    })
}

async fn validate_remote_web_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https URLs are allowed.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Authenticated URLs are not allowed.".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "A hostname is required.".to_string())?;
    if is_disallowed_web_host(host) {
        return Err("Local and private network hosts are blocked.".to_string());
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_disallowed_ip(ip) {
            return Err("Local and private network hosts are blocked.".to_string());
        }
        return Ok(parsed);
    }

    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "Unable to determine URL port.".to_string())?;
    let mut resolved_any = false;
    let resolved_addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("Failed to resolve host {}: {}", host, e))?;
    for addr in resolved_addrs {
        resolved_any = true;
        if is_disallowed_ip(addr.ip()) {
            return Err("Local and private network hosts are blocked.".to_string());
        }
    }
    if !resolved_any {
        return Err(format!(
            "Host {} did not resolve to a public address.",
            host
        ));
    }

    Ok(parsed)
}

fn is_disallowed_web_host(host: &str) -> bool {
    let lowered = host.trim().to_ascii_lowercase();
    lowered == "localhost"
        || lowered == "local"
        || lowered == "localdomain"
        || lowered.ends_with(".localhost")
        || lowered.ends_with(".local")
}

fn is_disallowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_private()
                || ipv4.is_loopback()
                || ipv4.is_link_local()
                || ipv4.is_multicast()
                || ipv4.is_unspecified()
                || ipv4.is_broadcast()
                || ipv4.is_documentation()
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback()
                || ipv6.is_unique_local()
                || ipv6.is_unicast_link_local()
                || ipv6.is_unspecified()
                || ipv6.is_multicast()
                || matches!(ipv6.segments(), [0x2001, 0x0db8, ..])
        }
    }
}

fn is_supported_web_fetch_content_type(content_type: &str) -> bool {
    let mime = content_type.split(';').next().unwrap_or("").trim();
    matches!(
        mime,
        "text/plain"
            | "text/html"
            | "text/markdown"
            | "text/csv"
            | "application/json"
            | "application/xml"
            | "application/xhtml+xml"
            | "application/rss+xml"
    ) || mime.starts_with("text/")
}

fn file_read(path: &str) -> Value {
    let path = PathBuf::from(path);
    if !path.exists() {
        return json!({ "error": format!("File not found: {}", path.display()) });
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => json!({
            "content": content.chars().take(50_000).collect::<String>(),
            "size": content.len(),
        }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

fn list_directory(path: &str) -> Value {
    let path = PathBuf::from(path);
    let entries = match std::fs::read_dir(&path) {
        Ok(entries) => entries,
        Err(error) => return json!({ "error": error.to_string() }),
    };

    let mut items = Vec::new();
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let metadata = entry.metadata().ok();
        items.push(json!({
            "name": entry.file_name().to_string_lossy().to_string(),
            "type": if entry_path.is_dir() { "dir" } else { "file" },
            "size": metadata.as_ref().map(|m| m.len()),
        }));
    }

    json!({
        "entries": items,
        "total": items.len(),
    })
}

fn calculate(expression: &str) -> Value {
    let cleaned = expression.trim();
    if cleaned.is_empty() {
        return json!({ "error": "Expression is required." });
    }
    if cleaned
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || " +-*/().,_".contains(c)))
    {
        return json!({ "error": "Expression contains unsupported characters." });
    }

    match meval::eval_str(cleaned.replace('_', "")) {
        Ok(result) => json!({ "result": result.to_string() }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

fn extract_between<'a>(haystack: &'a str, start_marker: &str, end_marker: &str) -> Option<&'a str> {
    let start = haystack.find(start_marker)?;
    let rest = &haystack[start..];
    let start_content = rest.find('>')?;
    let rest = &rest[start_content + 1..];
    let end = rest.find(end_marker)?;
    Some(&rest[..end])
}

fn strip_tags(input: &str) -> String {
    let mut output = String::new();
    let mut inside_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => output.push(ch),
            _ => {}
        }
    }
    output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_to_char_limit(text: &str, max_chars: usize) -> (String, bool) {
    let mut truncated = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index >= max_chars {
            return (truncated, true);
        }
        truncated.push(ch);
    }

    (truncated, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pop_next_sse_payload_handles_standard_sse_boundaries() {
        let mut lf_buffer =
            b"data: {\"text\":\"first\"}\n\ndata: {\"text\":\"second\"}\n\n".to_vec();
        let first = pop_next_sse_payload(&mut lf_buffer)
            .unwrap()
            .expect("first LF event");
        let second = pop_next_sse_payload(&mut lf_buffer)
            .unwrap()
            .expect("second LF event");
        assert_eq!(first, "{\"text\":\"first\"}");
        assert_eq!(second, "{\"text\":\"second\"}");
        assert!(lf_buffer.is_empty());

        let mut crlf_buffer =
            b"data: {\"text\":\"one\"}\r\n\r\ndata: {\"text\":\"two\"}\r\n\r\n".to_vec();
        let first = pop_next_sse_payload(&mut crlf_buffer)
            .unwrap()
            .expect("first CRLF event");
        let second = pop_next_sse_payload(&mut crlf_buffer)
            .unwrap()
            .expect("second CRLF event");
        assert_eq!(first, "{\"text\":\"one\"}");
        assert_eq!(second, "{\"text\":\"two\"}");
        assert!(crlf_buffer.is_empty());
    }

    #[test]
    fn parse_sse_event_data_joins_multiple_data_lines() {
        let event = b"event: message\ndata: {\"a\":1}\ndata: {\"b\":2}\n";
        let parsed = parse_sse_event_data(event).unwrap().expect("data payload");

        assert_eq!(parsed, "{\"a\":1}\n{\"b\":2}");
    }

    #[test]
    fn pop_next_sse_payload_handles_line_delimited_litert_chunks() {
        let mut buffer = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hello\"}]}}]}\r\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" there\"}]}}]}\r\n",
            "data: [DONE]\r\n"
        )
        .as_bytes()
        .to_vec();

        let first = pop_next_sse_payload(&mut buffer)
            .unwrap()
            .expect("first line-delimited event");
        let second = pop_next_sse_payload(&mut buffer)
            .unwrap()
            .expect("second line-delimited event");
        let done = pop_next_sse_payload(&mut buffer)
            .unwrap()
            .expect("done event");

        assert_eq!(
            first,
            "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hello\"}]}}]}"
        );
        assert_eq!(
            second,
            "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" there\"}]}}]}"
        );
        assert_eq!(done, "[DONE]");
        assert!(buffer.is_empty());
    }

    #[tokio::test]
    async fn process_stream_payload_emits_text_and_collects_function_calls() {
        let (tx, mut rx) = mpsc::channel(8);
        let mut function_calls = Vec::new();
        let mut emitted_answer = String::new();
        let mut emitted_thought = String::new();
        let mut model_content = None;
        let payload = json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "text": "Hello " },
                        {
                            "functionCall": {
                                "name": "web_search",
                                "args": { "query": "news" }
                            }
                        }
                    ]
                }
            }]
        });

        process_stream_payload(
            &payload.to_string(),
            &tx,
            &mut function_calls,
            &mut emitted_answer,
            &mut emitted_thought,
            &mut model_content,
        )
        .await
        .unwrap();

        assert!(matches!(rx.recv().await, Some(StreamEvent::Token(text)) if text == "Hello "));
        assert_eq!(emitted_answer, "Hello ");
        assert_eq!(emitted_thought, "");
        assert_eq!(function_calls.len(), 1);
        assert_eq!(
            function_calls[0].get("name").and_then(Value::as_str),
            Some("web_search")
        );
    }

    #[tokio::test]
    async fn process_stream_payload_emits_only_new_suffix_for_cumulative_text() {
        let (tx, mut rx) = mpsc::channel(8);
        let mut function_calls = Vec::new();
        let mut emitted_answer = String::new();
        let mut emitted_thought = String::new();
        let mut model_content = None;
        let first = json!({
            "candidates": [{
                "content": {
                    "parts": [{ "text": "Rust" }]
                }
            }]
        });
        let second = json!({
            "candidates": [{
                "content": {
                    "parts": [{ "text": "Rust is" }]
                }
            }]
        });
        let third = json!({
            "candidates": [{
                "content": {
                    "parts": [{ "text": "Rust is a" }]
                }
            }]
        });

        process_stream_payload(
            &first.to_string(),
            &tx,
            &mut function_calls,
            &mut emitted_answer,
            &mut emitted_thought,
            &mut model_content,
        )
        .await
        .unwrap();
        process_stream_payload(
            &second.to_string(),
            &tx,
            &mut function_calls,
            &mut emitted_answer,
            &mut emitted_thought,
            &mut model_content,
        )
        .await
        .unwrap();
        process_stream_payload(
            &third.to_string(),
            &tx,
            &mut function_calls,
            &mut emitted_answer,
            &mut emitted_thought,
            &mut model_content,
        )
        .await
        .unwrap();

        assert!(matches!(rx.recv().await, Some(StreamEvent::Token(text)) if text == "Rust"));
        assert!(matches!(rx.recv().await, Some(StreamEvent::Token(text)) if text == " is"));
        assert!(matches!(rx.recv().await, Some(StreamEvent::Token(text)) if text == " a"));
        assert_eq!(emitted_answer, "Rust is a");
        assert_eq!(emitted_thought, "");
    }

    #[tokio::test]
    async fn process_stream_payload_splits_thoughts_from_visible_answer() {
        let (tx, mut rx) = mpsc::channel(8);
        let mut function_calls = Vec::new();
        let mut emitted_answer = String::new();
        let mut emitted_thought = String::new();
        let mut model_content = None;
        let payload = json!({
            "candidates": [{
                "content": {
                    "parts": [{
                        "text": "<|channel>thought\nPlan step 1.<channel|>Final answer"
                    }]
                }
            }]
        });

        process_stream_payload(
            &payload.to_string(),
            &tx,
            &mut function_calls,
            &mut emitted_answer,
            &mut emitted_thought,
            &mut model_content,
        )
        .await
        .unwrap();

        assert!(
            matches!(rx.recv().await, Some(StreamEvent::Thought(text)) if text == "Plan step 1.")
        );
        assert!(
            matches!(rx.recv().await, Some(StreamEvent::Token(text)) if text == "Final answer")
        );
        assert_eq!(emitted_answer, "Final answer");
        assert_eq!(emitted_thought, "Plan step 1.");
        assert_eq!(
            model_content
                .as_ref()
                .and_then(|content| content.get("parts"))
                .and_then(Value::as_array)
                .and_then(|parts| parts.first())
                .and_then(|part| part.get("text"))
                .and_then(Value::as_str),
            Some("Final answer")
        );
    }

    #[test]
    fn function_calls_to_model_content_builds_model_parts() {
        let calls = vec![json!({
            "name": "calculate",
            "args": { "expression": "2+2" }
        })];

        let content = function_calls_to_model_content(&calls).expect("model content");
        let parts = content
            .get("parts")
            .and_then(Value::as_array)
            .expect("parts");

        assert_eq!(content.get("role").and_then(Value::as_str), Some("model"));
        assert_eq!(
            parts[0]
                .get("functionCall")
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str),
            Some("calculate")
        );
    }

    #[test]
    fn build_generate_content_request_omits_unset_advanced_generation_fields() {
        let request = build_generate_content_request(
            "Be concise.",
            &[json!({
                "role": "user",
                "parts": [{ "text": "Hello" }],
            })],
            &GenerationRequestConfig {
                max_output_tokens: 4096,
                temperature: None,
                top_p: None,
                thinking_enabled: None,
            },
            ToolPermissions::default(),
        );

        assert_eq!(
            request["generationConfig"]["maxOutputTokens"].as_u64(),
            Some(4096)
        );
        assert!(request["generationConfig"].get("temperature").is_none());
        assert!(request["generationConfig"].get("topP").is_none());
    }

    #[test]
    fn tool_declarations_exclude_local_file_tools_for_web_assist() {
        let declarations = tool_declarations(ToolPermissions::web_assist_enabled(true));
        let names = declarations
            .iter()
            .filter_map(|declaration| declaration.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(names.contains(&"web_search"));
        assert!(names.contains(&"web_fetch"));
        assert!(names.contains(&"calculate"));
        assert!(!names.contains(&"file_read"));
        assert!(!names.contains(&"list_directory"));
    }

    #[tokio::test]
    async fn execute_tool_rejects_disallowed_local_file_access() {
        let result = execute_tool(
            "file_read",
            &json!({ "path": "/tmp/secrets.txt" }),
            ToolPermissions::web_assist_enabled(true),
        )
        .await;

        assert_eq!(
            result.get("error").and_then(Value::as_str),
            Some("Tool file_read is not enabled for this chat.")
        );
    }

    #[test]
    fn truncate_to_char_limit_preserves_utf8_boundaries() {
        let (truncated, was_truncated) = truncate_to_char_limit("नमस्ते", 3);

        assert_eq!(truncated.chars().count(), 3);
        assert!(was_truncated);
    }

    #[tokio::test]
    async fn validate_remote_web_url_rejects_localhost_targets() {
        let result = validate_remote_web_url("http://localhost:8080/health").await;

        assert_eq!(
            result.unwrap_err(),
            "Local and private network hosts are blocked."
        );
    }

    #[tokio::test]
    async fn validate_remote_web_url_rejects_private_ip_targets() {
        let result = validate_remote_web_url("http://127.0.0.1:8080/health").await;

        assert_eq!(
            result.unwrap_err(),
            "Local and private network hosts are blocked."
        );
    }

    #[tokio::test]
    async fn validate_remote_web_url_rejects_non_http_schemes() {
        let result = validate_remote_web_url("file:///tmp/secret.txt").await;

        assert_eq!(result.unwrap_err(), "Only http and https URLs are allowed.");
    }

    #[test]
    fn supported_web_fetch_content_types_are_allowlisted() {
        assert!(is_supported_web_fetch_content_type(
            "text/html; charset=utf-8"
        ));
        assert!(is_supported_web_fetch_content_type("application/json"));
        assert!(!is_supported_web_fetch_content_type("image/png"));
    }
}
