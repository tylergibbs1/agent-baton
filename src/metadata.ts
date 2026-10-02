import { arr, row, str, unique, BridgeError, type Provider, type Row, type Target } from "./model.ts";

export interface Usage {
  provider: Provider; method: "cumulative" | "unique-message-sum";
  inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
  cacheCreationInputTokens?: number; reasoningTokens?: number; totalTokens?: number;
}
export interface SessionMetadata {
  createdAt?: string; updatedAt?: string; title?: string; tags: string[];
  git?: { branch?: string; commit?: string; repository?: string };
  models: string[]; reasoningEffort?: string; usage?: Usage;
  settings: Row; records: { provider: Provider; type: string; fields: Row }[];
  provenance: { provider: Provider; sessionId?: string; importedAt?: string }[];
}
export interface MessageMetadata { provider: Provider; model?: string; phase?: string; usage?: Row; fields: Row }
export interface MetadataReport { native: string[]; preserved: string[]; fresh: string[]; notes: string[] }
const omit = (obj: Row, keys: string[]) => Object.fromEntries(Object.entries(obj).filter(([key]) => !keys.includes(key)));
export function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return;
  const millis = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(millis)) return;
  try { return new Date(millis).toISOString(); } catch { return; }
}
export function messageMetadata(provider: Provider, record: Row, payload: Row): MessageMetadata {
  const original = row(row(record.session_bridge).message);
  if (original.metadata) { validateMessageMetadata(original.metadata); return original.metadata as MessageMetadata; }
  const model = str(payload.model ?? row(payload.metadata).model_slug), usage = row(payload.usage ?? row(payload.metadata).usage);
  return { provider, model, phase: str(payload.phase), usage: Object.keys(usage).length ? usage : undefined,
    fields: { record: omit(record, ["message", "payload", "session_bridge"]),
      payload: omit(payload, ["content", "encrypted_content", "summary", "replacement_history", "retained_context", "session_bridge"]) } };
}
export function originalIdentity(record: Row, fallbackId?: string, fallbackTimestamp?: string | number) {
  const original = row(row(record.session_bridge).message);
  return { id: str(original.id) ?? fallbackId,
    timestamp: typeof original.timestamp === "string" || typeof original.timestamp === "number" ? original.timestamp : fallbackTimestamp };
}
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
function tokenFields(v: Row) {
  const fields = { inputTokens: number(v.input_tokens), outputTokens: number(v.output_tokens),
    cachedInputTokens: number(v.cached_input_tokens ?? v.cache_read_input_tokens),
    cacheCreationInputTokens: number(v.cache_creation_input_tokens),
    reasoningTokens: number(v.reasoning_output_tokens ?? row(v.output_tokens_details).thinking_tokens), totalTokens: number(v.total_tokens) };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Omit<Usage, "provider" | "method">;
}
export function extractMetadata(provider: Provider, rows: Row[], conversation?: Row): SessionMetadata {
  const bridge = rows.map(r => row(row(r.session_bridge).session)).find(s => s.metadata);
  const inherited = bridge?.metadata;
  if (inherited) validateSessionMetadata(inherited);
  const base = inherited as SessionMetadata | undefined;
  const result: SessionMetadata = { ...base, tags: [...(base?.tags ?? [])], models: [...(base?.models ?? [])],
    settings: { ...(base?.settings ?? {}) }, records: [...(base?.records ?? [])], provenance: [...(base?.provenance ?? [])] };
  const times: string[] = [], usageByMessage = new Map<string, Row>();
  let cumulative: Row | undefined;
  for (const [index, r] of rows.entries()) {
    const p = provider === "claude" ? row(r.message) : row(r.payload), type = str(r.type) ?? "unknown";
    const time = isoTimestamp(r.timestamp); if (time) times.push(time);
    if (type === "session_meta") {
      const created = isoTimestamp(p.timestamp); if (created) result.createdAt ??= created;
      const git = row(p.git);
      if (!r.session_bridge && Object.keys(git).length) result.git = { branch: str(git.branch), commit: str(git.commit_hash), repository: str(git.repository_url) };
      if (str(p.thread_name ?? p.name)) result.title = String(p.thread_name ?? p.name);
    }
    if (str(r.gitBranch)) result.git = { ...result.git, branch: String(r.gitBranch) };
    if (type === "custom-title") result.title = str(r.customTitle) ?? result.title;
    else if (type === "ai-title" && !rows.some(x => x.type === "custom-title" && str(x.customTitle))) result.title = str(r.aiTitle) ?? result.title;
    if (type === "tag" && str(r.tag)) result.tags = unique([String(r.tag), ...result.tags]);
    const bridgedMessage = Object.keys(row(row(r.session_bridge).message)).length > 0;
    const sourceModel = bridgedMessage ? undefined : str(p.model ?? row(p.metadata).model_slug ?? r.model);
    if (sourceModel && !["baton", "session-bridge"].includes(sourceModel)) result.models = unique([...result.models, sourceModel]);
    const context = type === "turn_context" ? p : r;
    const effort = str(context.effort ?? context.reasoning_effort ?? context.perTurnEffort);
    if (effort) result.reasoningEffort = effort;
    if (type === "turn_context") result.settings = { ...result.settings, [provider]: omit(p, ["turn_id", "root_turn_id"]) };
    if (provider === "claude" && !r.session_bridge) {
      const settings = row(result.settings.claude);
      for (const key of ["permissionMode", "mode", "effort", "perTurnEffort", "entrypoint", "version", "slug"]) if (r[key] !== undefined) settings[key] = r[key];
      if (Object.keys(settings).length) result.settings.claude = settings;
      if (type === "assistant" && Object.keys(row(p.usage)).length) usageByMessage.set(str(p.id) ?? str(r.requestId) ?? str(r.uuid) ?? String(index), row(p.usage));
    } else if (provider === "chatgpt" && Object.keys(row(p.usage ?? row(p.metadata).usage)).length) {
      usageByMessage.set(str(p.id) ?? String(index), row(p.usage ?? row(p.metadata).usage));
    } else if (provider === "codex" && type === "token_usage_record") {
      if (Object.keys(row(p.thread_token_usage)).length) cumulative = row(p.thread_token_usage);
      const usage = row(p.usage); if (Object.keys(usage).length) usageByMessage.set(str(p.response_id) ?? String(index), usage);
    }
    if (!r.session_bridge && !["user", "assistant", "response_item"].includes(type)) {
      const fields = omit(r, ["session_bridge"]);
      // Keep provider metadata opaque; omit conversation text already carried by messages.
      if (type === "event_msg") fields.payload = omit(p, ["message", "last_agent_message", "text", "delta", "content", "output"]);
      if (type === "compacted") fields.payload = omit(p, ["message", "replacement_history", "retained_context"]);
      if (type === "attachment") delete fields.attachment;
      delete fields.content;
      result.records.push({ provider, type, fields });
    }
  }
  if (conversation) {
    result.tags = unique([...result.tags, ...arr(conversation.tags).filter((x): x is string => typeof x === "string")]);
    if (str(conversation.default_model_slug)) result.models = unique([...result.models, String(conversation.default_model_slug)]);
    result.title = str(conversation.title) ?? result.title;
    result.createdAt = isoTimestamp(conversation.create_time) ?? result.createdAt;
    result.updatedAt = isoTimestamp(conversation.update_time) ?? result.updatedAt;
    result.records.push({ provider, type: "conversation", fields: omit(conversation, ["mapping"]) });
  }
  if (times.length) { times.sort(); result.createdAt ??= times[0]; result.updatedAt ??= times.at(-1); }
  if (cumulative) result.usage = { provider, method: "cumulative", ...tokenFields(cumulative) };
  else if (usageByMessage.size) {
    const totals: Omit<Usage, "provider" | "method"> = {};
    for (const usage of usageByMessage.values()) for (const [key, value] of Object.entries(tokenFields(usage))) {
      const k = key as keyof typeof totals; totals[k] = (totals[k] ?? 0) + value!;
    }
    result.usage = { provider, method: "unique-message-sum", ...totals };
  }
  result.tags = unique(result.tags); result.models = unique(result.models);
  return result;
}
export function metadataReport(target: Target, metadata?: SessionMetadata): MetadataReport {
  const native = target === "claude" || target === "codex" ? ["working directory", "message timestamps", "message order"] : [];
  if (metadata) {
    if (metadata.title && target === "claude") native.push("conversation title");
    if (metadata.title && target === "codex") native.push("conversation title via local registration on --install");
    if (metadata.tags.length && target === "claude") native.push("session tag (first tag)");
    if (metadata.git?.branch && ["claude", "codex"].includes(target)) native.push("Git branch");
    if (target === "codex" && (metadata.git?.commit || metadata.git?.repository)) native.push("Git commit/repository");
    if (target === "claude") native.push("historical message model/usage when present");
  }
  return { native, preserved: ["original IDs and ancestry", "creation/update times", "all tags", "historical models and usage", "provider settings and metadata records", "message metadata and provenance"],
    fresh: ["destination session/message/turn IDs", "destination creation time", "destination permissions/model configuration"],
    notes: ["Provider-specific fields are preserved in metadata.json, session.json, and native bridge extensions; they are not all interpreted by destination apps.",
      "Historical usage retains its provider attribution; it does not become destination billing or current-context usage.",
      "Permission policies and credentials are not activated. Model names are not substituted across providers."] };
}
export function validateMessageMetadata(value: unknown): asserts value is MessageMetadata {
  const m = row(value);
  if (!["claude", "codex", "chatgpt"].includes(String(m.provider)) || !m.fields || Array.isArray(m.fields) || typeof m.fields !== "object") throw new BridgeError("INVALID_METADATA", "Invalid message metadata");
  for (const key of ["model", "phase"]) if (m[key] !== undefined && typeof m[key] !== "string") throw new BridgeError("INVALID_METADATA", `Invalid message metadata ${key}`);
  if (m.usage !== undefined && (!m.usage || typeof m.usage !== "object" || Array.isArray(m.usage))) throw new BridgeError("INVALID_METADATA", "Invalid message usage");
}
export function validateSessionMetadata(value: unknown): asserts value is SessionMetadata {
  const m = row(value);
  for (const key of ["tags", "models", "records", "provenance"]) if (!Array.isArray(m[key])) throw new BridgeError("INVALID_METADATA", `Invalid session metadata ${key}`);
  for (const key of ["tags", "models"]) if (arr(m[key]).some(v => typeof v !== "string")) throw new BridgeError("INVALID_METADATA", `Invalid session metadata ${key}`);
  if (!m.settings || typeof m.settings !== "object" || Array.isArray(m.settings)) throw new BridgeError("INVALID_METADATA", "Invalid metadata settings");
  for (const key of ["createdAt", "updatedAt", "title", "reasoningEffort"]) if (m[key] !== undefined && typeof m[key] !== "string") throw new BridgeError("INVALID_METADATA", `Invalid metadata ${key}`);
  if (m.git !== undefined && (!m.git || typeof m.git !== "object" || Array.isArray(m.git))) throw new BridgeError("INVALID_METADATA", "Invalid Git metadata");
  if (m.git !== undefined) for (const key of ["branch", "commit", "repository"]) if (row(m.git)[key] !== undefined && typeof row(m.git)[key] !== "string") throw new BridgeError("INVALID_METADATA", `Invalid metadata Git ${key}`);
  if (m.usage !== undefined) {
    const u = row(m.usage);
    if (!["claude", "codex", "chatgpt"].includes(String(u.provider)) || !["cumulative", "unique-message-sum"].includes(String(u.method))) throw new BridgeError("INVALID_METADATA", "Invalid usage attribution");
    for (const [key, value] of Object.entries(u)) if (!["provider", "method"].includes(key) && number(value) === undefined) throw new BridgeError("INVALID_METADATA", "Invalid usage count");
  }
  for (const r of arr(m.records)) { const v = row(r); if (!["claude", "codex", "chatgpt"].includes(String(v.provider)) || typeof v.type !== "string" || !v.fields || typeof v.fields !== "object" || Array.isArray(v.fields)) throw new BridgeError("INVALID_METADATA", "Invalid metadata record"); }
  for (const p of arr(m.provenance)) { const v = row(p); if (!["claude", "codex", "chatgpt"].includes(String(v.provider)) || (v.sessionId !== undefined && typeof v.sessionId !== "string") || (v.importedAt !== undefined && typeof v.importedAt !== "string")) throw new BridgeError("INVALID_METADATA", "Invalid metadata provenance"); }
}
