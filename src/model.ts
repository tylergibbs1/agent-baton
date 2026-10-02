import { metadataReport, type SessionMetadata, type MessageMetadata, type MetadataReport } from "./metadata.ts";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

export type Provider = "claude" | "codex" | "chatgpt";
export type Target = Provider | "portable";
export type BlockKind = "text" | "tool_call" | "tool_result" | "reasoning" | "media" | "summary" | "unsupported";
export interface Asset { mime?: string; data?: string; path?: string; url?: string; pointer?: string; bundlePath?: string; sha256?: string; status?: "copied" | "missing" | "remote" | "unresolved" }
export interface Branch { id: string; current: boolean; title?: string }
export interface Context { kind: "subagent" | "memory" | "retained" | "communication"; label: string; text?: string; messages?: Message[]; sourcePath?: string; sourceId?: string; parentSourceId?: string; agentRole?: string; agentNickname?: string; spawnCallId?: string; sourceAliases?: string[]; metadata?: SessionMetadata }
export interface Workspace { source?: { cwd: string; git?: Workspace["git"] }; cwd: string; exists: boolean; git?: { root?: string; branch?: string; commit?: string; dirty: { path: string; sha256?: string; status: string }[] }; referenced: { path: string; exists: boolean }[]; mismatches: string[] }
export interface Block { kind: BlockKind; text: string; name?: string; callId?: string; format?: string; isError?: boolean; asset?: Asset }
export interface Message { role: string; blocks: Block[]; timestamp?: string | number | null; id?: string; metadata?: MessageMetadata }
export interface Session {
  format: "session-bridge/v1"; source: Provider; sourceId?: string; sourcePath?: string;
  branches?: Branch[]; selectedBranch?: string; context?: Context[]; workspace?: Workspace; sourceSha256?: string; metadata?: SessionMetadata; historyMode?: "full" | "active"; cwd?: string; title: string; messages: Message[]; warnings: string[];
}
export interface Entry { id: string; source: Provider; path: string; modified: number; cwd?: string; title?: string }
export interface Report {
  source: Provider; sourceId?: string; sourceSha256?: string; target: Target; title: string; cwd?: string;
  continuity: { subagents: number; contextRecords: number; branches: number; selectedBranch?: string; attachments: { total: number; copied: number; unresolved: number }; workspaceMismatches: number }; metadata: MetadataReport; historyMode: "full" | "active"; messages: number; blocks: Partial<Record<BlockKind, number>>; contextBytes: number; warnings: string[];
}
export class BridgeError extends Error {
  constructor(public code: string, message: string, public hint = "") { super(message); }
}
export type Row = Record<string, unknown>;
export const row = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
export const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
export const text = (v: unknown): string => typeof v === "string" ? v : JSON.stringify(v) ?? "";
export const hash = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
export const unique = (items: string[]) => [...new Set(items)];
export const terminal = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export const expand = (p: string) => resolve(p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
export function roots() {
  return { claude: join(expand(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")), "projects"),
    codex: join(expand(process.env.CODEX_HOME ?? join(homedir(), ".codex")), "sessions") };
}

export const isTitleText = (value: string) => Boolean(value.trim()) && !value.trimStart().startsWith("<")
  && !value.trimStart().startsWith("# AGENTS.md instructions");
export function contentBlocks(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  if (content == null) return [];
  if (!Array.isArray(content)) return [{ kind: "unsupported", text: text(content) }];
  return content.flatMap((part): Block[] => {
    if (typeof part === "string") return [{ kind: "text", text: part }];
    const p = row(part), type = str(p.type) ?? "unknown";
    if (["text", "input_text", "output_text"].includes(type)) return [{ kind: "text", text: str(p.text) ?? "" }];
    if (["thinking", "redacted_thinking", "reasoning"].includes(type)) return [{ kind: "reasoning", text: "", format: type }];
    if (type === "tool_use") return [{ kind: "tool_call", text: text(p.input ?? {}), name: str(p.name), callId: str(p.id) }];
    if (type === "tool_result") return [{ kind: "tool_result", text: typeof p.content === "string" ? p.content : renderBlocks(contentBlocks(p.content)), callId: str(p.tool_use_id), isError: p.is_error === true }, ...contentBlocks(p.content).filter(b => b.kind === "media")];
    if (["image", "image_url", "input_image", "audio", "input_audio", "file", "document", "image_asset_pointer", "audio_asset_pointer", "video", "input_file"].includes(type))
      {
      const source = row(p.source), image = row(p.image_url), file = row(p.file);
      const reference = str(p.image_url) ?? str(p.audio_url ?? p.url ?? image.url ?? source.url);
      const dataUrl = reference?.match(/^data:([^;,]+);base64,([\s\S]+)$/);
      return [{ kind: "media", text: str(p.title ?? p.filename ?? p.name) ?? "Attachment", format: type,
        asset: { mime: str(source.media_type ?? p.mime_type ?? p.mimeType) ?? dataUrl?.[1], data: str(source.data ?? p.data) ?? dataUrl?.[2],
          path: str(p.path ?? p.file_path ?? source.path ?? file.path) ?? (reference?.startsWith("file://") ? decodeURIComponent(new URL(reference).pathname) : undefined),
          url: reference && !dataUrl && !reference.startsWith("file://") ? reference : undefined,
          pointer: str(p.asset_pointer ?? p.file_id ?? p.fileId ?? source.file_id) } }];
    }
    return [{ kind: "unsupported", text: text(part), format: type }];
  });
}
export function renderBlocks(blocks: Block[]): string {
  return blocks.filter(b => b.kind !== "reasoning").map(b => {
    if (b.kind === "text") return b.text;
    if (b.kind === "tool_call") return `[Historical tool call: ${b.name ?? "tool"} | ${b.callId ?? ""}]\n${b.text}`;
    if (b.kind === "tool_result") return `[Historical tool result: ${b.callId ?? b.name ?? ""}${b.isError ? " | error" : ""}]\n${b.text}`;
    return `[${b.kind}: ${b.format ?? ""}]\n${b.text}`;
  }).join("\n\n");
}
export function mappedMessages(s: Session) {
  return s.messages.flatMap(m => {
    let value = renderBlocks(m.blocks);
    if (!value) return [];
    let role = m.role;
    if (!["user", "assistant"].includes(role)) {
      value = `[Historical ${role} context from ${s.source}; not destination policy]\n${value}`;
      role = "user";
    }
    return [{ role, text: value, id: m.id, timestamp: m.timestamp, metadata: m.metadata, originalRole: m.role, blocks: m.blocks }];
  });
}
export function report(s: Session, target: Target): Report {
  const counts: Report["blocks"] = {};
  const messages = [...s.messages, ...(s.context ?? []).flatMap(c => c.messages ?? [])];
  for (const m of messages) for (const b of m.blocks) counts[b.kind] = (counts[b.kind] ?? 0) + 1;
  const mapped = mappedMessages(s), warnings = [...s.warnings];
  if (counts.tool_call || counts.tool_result) warnings.push(["claude", "codex"].includes(target) ? "Tool calls/results appear as native imported history; source tools are not registered or replayed." : "Tool calls/results transfer as historical text; destination tools use their own schemas.");
  if (counts.reasoning) warnings.push(`${counts.reasoning} private reasoning blocks excluded from resumed context; original bytes stay archived.`);
  if (counts.media) warnings.push(`${counts.media} attachments: local/inline assets are bundled; unresolved references are reported explicitly.`);
  if (counts.unsupported) warnings.push(`${counts.unsupported} unrecognized content blocks transfer as labeled text.`);
  if (s.messages.some(m => !["user", "assistant"].includes(m.role))) warnings.push("Source policies transfer as labeled history. Destination policies and permissions are not copied.");
  const contextBytes = mapped.reduce((n, m) => n + Buffer.byteLength(m.text), Buffer.byteLength(continuityText(s)));
  if (contextBytes > 400_000) warnings.push("Large conversation: the target may compact or reject this history. No messages were silently truncated.");
  if (target === "chatgpt") warnings.push("ChatGPT output is a Markdown handoff for upload/paste. Native desktop history insertion is unsupported.");
  if (target === "codex") warnings.push("Codex CLI resume is supported. Desktop sidebar discovery of external rollouts is not guaranteed.");
  return { source: s.source, sourceId: s.sourceId, sourceSha256: s.sourceSha256, target, title: s.title, cwd: s.cwd,
    continuity: { subagents: (s.context ?? []).filter(c => c.kind === "subagent").length, contextRecords: s.context?.length ?? 0, branches: s.branches?.length ?? 0, selectedBranch: s.selectedBranch, attachments: { total: counts.media ?? 0, copied: messages.flatMap(m => m.blocks).filter(b => b.asset?.status === "copied").length, unresolved: messages.flatMap(m => m.blocks).filter(b => b.kind === "media" && ["missing", "remote", "unresolved"].includes(b.asset?.status ?? "")).length }, workspaceMismatches: s.workspace?.mismatches.length ?? 0 },
    metadata: metadataReport(target, s.metadata), historyMode: s.historyMode ?? "full", messages: mapped.length, blocks: counts, contextBytes, warnings: unique(warnings) };
}
export function markdown(s: Session) {
  return [`# ${s.title}`, `Transferred from ${s.source}. Project: ${s.cwd ?? "unspecified"}.`,
    "Continue from the final turn below. Tool activity is historical. Workspace contents are checked, not copied. Bundled attachments and supplemental context are listed below.",
    continuityText(s), ...mappedMessages(s).map((m, i) => `## ${i + 1}. ${m.role}\n\n${m.text}`)].join("\n\n") + "\n";
}

export function continuityText(s: Session): string {
  return [
    ...(s.context ?? []).map(c => `[Historical ${c.kind}: ${c.label}]\n${c.text ?? ""}\n${(c.messages ?? []).map(m => `${m.role}: ${renderBlocks(m.blocks)}`).join("\n\n")}`),
    ...(s.workspace ? [`[Workspace check]\n${JSON.stringify(s.workspace, null, 2)}`] : []),
  ].filter(Boolean).join("\n\n");
}
