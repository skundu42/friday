export interface SetupStatus {
  modelId: string;
  modelDisplayName: string;
  modelDownloaded: boolean;
  modelSizeGb: number;
  minRamGb: number;
  totalRamGb: number;
  meetsRamMinimum: boolean;
  runtimeInstalled: boolean;
  readyToChat: boolean;
  partialDownloadBytes: number;
}

export interface DownloadProgress {
  state: "downloading" | "complete" | "error" | "verifying";
  displayName: string;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number;
  percentage: number;
  error?: string;
}

export type ChatRole = "user" | "assistant" | "system";

export interface FileAttachment {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  content?: { text?: string; dataUrl?: string; path?: string } | null;
  isTemp?: boolean;
  status: "loading" | "ready" | "error";
  error?: string;
}

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  content_parts?: unknown | null;
  model_used?: string | null;
  tokens_used?: number | null;
  latency_ms?: number | null;
  created_at: string;
}

export interface BackendStatus {
  backend: "LiteRtLm" | "None";
  connected: boolean;
  models: string[];
  base_url: string;
  total_ram_gb: number;
  state: string;
  message: string;
  supports_native_tools: boolean;
  supports_audio_input: boolean;
  supports_image_input: boolean;
  supports_video_input: boolean;
  supports_thinking: boolean;
  max_context_tokens: number;
  recommended_max_output_tokens: number;
}

export type ReplyLanguage =
  | "english"
  | "hindi"
  | "bengali"
  | "marathi"
  | "tamil"
  | "punjabi";

export interface ChatSettings {
  reply_language: ReplyLanguage;
  max_tokens: number;
  web_assist_enabled: boolean;
  generation: GenerationSettings;
}

export interface AppSettings {
  auto_start_backend: boolean;
  user_display_name: string;
  chat: ChatSettings;
}

export interface GenerationSettings {
  temperature?: number | null;
  top_p?: number | null;
  thinking_enabled?: boolean | null;
}

export interface AppSettingsInput {
  auto_start_backend: boolean;
  user_display_name: string;
  chat: {
    reply_language: ReplyLanguage;
    max_tokens: number;
    web_assist_enabled: boolean;
    generation: GenerationSettings;
  };
}

export interface BootstrapPayload {
  sessions: Session[];
  currentSession: Session;
  messages: Message[];
  settings: AppSettings;
  backendStatus: BackendStatus;
}

export interface SessionSelectionResult {
  session: Session;
  messages: Message[];
}

export interface ChatErrorPayload {
  sessionId?: string | null;
  message: string;
}

export interface ChatTokenPayload {
  sessionId?: string | null;
  token: string;
  kind?: "answer" | "thought";
}

export interface ChatDonePayload {
  sessionId?: string | null;
  model: string;
  cancelled?: boolean;
  hasContent?: boolean;
}

// Tool calling types
export interface ToolCallEvent {
  sessionId?: string | null;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  sessionId?: string | null;
  name: string;
  result: Record<string, unknown>;
}

// RAG types
export interface SearchResult {
  text: string;
  source_file: string;
  file_name: string;
  chunk_index: number;
  doc_id: string;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
}

export interface IngestResult {
  doc_id?: string;
  file_name?: string;
  chunks?: number;
  ingested?: number;
  errors?: number;
  status?: string;
  error?: string;
}

export interface DocumentInfo {
  doc_id: string;
  file_name: string;
  source_file: string;
  total_chunks: number;
}

export interface RagStats {
  total_chunks: number;
  storage_dir: string;
}

// Model types
export interface ModelInfo {
  id: string;
  repo: string;
  filename: string;
  display_name: string;
  size_bytes: number;
  size_gb: number;
  min_ram_gb: number;
  supports_image_input: boolean;
  supports_audio_input: boolean;
  supports_video_input: boolean;
  supports_thinking: boolean;
  max_context_tokens: number;
  recommended_max_output_tokens: number;
}
