import { extractMetadata, messageMetadata, originalIdentity, isoTimestamp, validateMessageMetadata, validateSessionMetadata } from "./metadata.ts";
import { childFiles, nativeMedia } from "./continuity.ts";
import { readFile, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { arr, row, str, text, hash, unique, expand, contentBlocks, mappedMessages, BridgeError,
  isTitleText, roots, continuityText, type Branch, type Context, type Session, type Message, type Row, type Target, type Block } from "./model.ts";

export function parseJsonl(data: string): Row[] {
  return data.replace(/^\uFEFF/, "").split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      const obj: unknown = JSON.parse(line);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("Expected an object");
      return [obj as Row];
    } catch { throw new BridgeError("MALFORMED_SESSION", `Invalid JSON object at line ${i + 1}.`, "If the session is active, wait for its current write and retry."); }
  });
}
function claude(rows: Row[], history: "full" | "active" = "full", branch?: string, sidechain = false): Omit<Session, "format" | "source" | "sourcePath" | "sourceSha256" | "title"> {
  const nodes = new Map<string, { record: Row; index: number }[]>();
  rows.forEach((r, index) => {
    if (!str(r.uuid) || (r.isSidechain && !sidechain)) return;
    const versions = nodes.get(String(r.uuid)) ?? [];
    versions.push({ record: r, index }); nodes.set(String(r.uuid), versions);
  });
  const candidates = rows.filter(r => ["user", "assistant"].includes(String(r.type)) && str(r.uuid) && (!r.isSidechain || sidechain));
  if (!candidates.length) throw new BridgeError("EMPTY_SESSION", "No main Claude conversation found.");
  if (branch && !candidates.some(r => r.uuid === branch)) throw new BridgeError("BRANCH_NOT_FOUND", `Claude branch node not found: ${branch}`);
  let leaf = branch ?? str(candidates.at(-1)?.uuid), cutoff = rows.length;
  const visited = new Set<string>(), included = new Set<string>(), chain: Row[] = [], warnings: string[] = [];
  while (leaf) {
    const versions = (nodes.get(leaf) ?? []).filter(v => v.index < cutoff);
    const version = versions.at(-1);
    if (!version) break;
    const key = `${leaf}:${version.index}`;
    if (visited.has(key)) throw new BridgeError("INVALID_CHAIN", "Claude transcript contains a parent cycle.");
    visited.add(key); included.add(leaf);
    const node = version.record; chain.push(node);
    if (history === "full" && node.type === "system" && node.subtype === "compact_boundary" && str(node.logicalParentUuid)) {
      // Before compaction, preserved messages may have different parents. Use the
      // snapshot preceding this boundary to recover history without following a rewrite cycle.
      cutoff = versions[0].index;
      leaf = str(node.logicalParentUuid);
      if (!(nodes.get(leaf!) ?? []).some(v => v.index < cutoff)) {
        // Claude can re-root preserved records after the boundary and omit their
        // old parent links. The final pre-boundary main message is the prior leaf.
        const previous = rows.slice(0, cutoff).findLast(r =>
          ["user", "assistant"].includes(String(r.type)) && str(r.uuid) && (!r.isSidechain || sidechain));
        leaf = str(previous?.uuid);
        warnings.push("A rewritten Claude compaction parent was recovered from the last pre-boundary main message.");
      }
      warnings.push("Claude compaction detected; earlier recorded history is recovered through logical parents.");
    } else leaf = str(node.parentUuid);
  }
  if (history === "active") warnings.push("Active Claude context selected; older recorded messages remain in the source archive.");
  if (leaf) warnings.push("Claude parent chain ends at a missing ancestor; only available history transfers.");
  const excluded = new Set(candidates.map(r => String(r.uuid)).filter(id => !included.has(id))).size;
  if (excluded) warnings.push(`${excluded} records outside the active Claude branch are archived, not resumed.`);
  const messages: Message[] = [];
  let cwd: string | undefined;
  const deduplicated = new Map<string, Row>();
  for (const r of chain.reverse()) {
    if (deduplicated.has(String(r.uuid))) deduplicated.delete(String(r.uuid));
    deduplicated.set(String(r.uuid), r);
  }
  for (const r of deduplicated.values()) {
    cwd = str(r.cwd) ?? cwd;
    if (row(row(r.session_bridge).message).generated === true) continue;
    if (["user", "assistant"].includes(String(r.type))) {
      const m = row(r.message);
      if (!Object.keys(m).length) throw new BridgeError("INVALID_MESSAGE", "Claude message must be an object.");
      messages.push(restoreMessage(r, { role: str(m.role) ?? String(r.type), blocks: contentBlocks(m.content), ...originalIdentity(r, str(r.uuid), str(r.timestamp)), metadata: messageMetadata("claude", r, m) }));
    } else if (r.type === "system" && r.subtype === "compact_boundary" && !str(r.logicalParentUuid)) warnings.push("Claude compaction boundary has no logical parent; earlier context may exist only in its summary.");
  }
  return { sourceId: str(candidates.findLast(r => str(r.sessionId))?.sessionId), cwd, messages, warnings, metadata: extractMetadata("claude", rows) };
}
function codex(rows: Row[], history: "full" | "active" = "full"): ReturnType<typeof claude> {
  const originalRows = rows;
  const meta = row(rows.find(r => r.type === "session_meta")?.payload);
  if (!Object.keys(meta).length) throw new BridgeError("INVALID_SCHEMA", "Codex rollout has no session_meta.");
  const messages: Message[] = [], warnings: string[] = [];
  if (history === "active") {
    const index = rows.findLastIndex(r => r.type === "compacted");
    if (index >= 0) {
      const boundary = rows[index], p = row(boundary.payload), replacement = arr(p.replacement_history);
      const prefix: Row[] = replacement.length ? replacement.map(payload => ({ type: "response_item", payload }))
        : str(p.message) ? [{ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: p.message }] } }] : [];
      if (!prefix.length) throw new BridgeError("MISSING_COMPACTION_CONTEXT", "Cannot reconstruct active context from this Codex compaction.", "Use --history full.");
      rows = [...prefix, ...rows.slice(index + 1)];
      warnings.push("Active Codex context selected from its last compaction; older recorded messages remain in the source archive.");
    }
  }
  for (const r of rows) {
    const p = row(r.payload), kind = str(p.type);
    let role = "assistant", blocks: Block[] = [];
    if (row(row(r.session_bridge).message).generated === true) continue;
    if (r.type === "response_item") {
      if (kind === "message") { role = str(p.role) ?? role; blocks = contentBlocks(p.content); }
      else if (["function_call", "custom_tool_call", "local_shell_call", "web_search_call"].includes(kind ?? "")) {
        blocks = [{ kind: "tool_call", text: text(p.arguments ?? p.input ?? p), name: str(p.name) ?? kind, callId: str(p.call_id) ?? str(p.id) }];
      } else if (["function_call_output", "custom_tool_call_output", "local_shell_call_output"].includes(kind ?? "")) {
        role = "user"; const output = p.output ?? p, parts = Array.isArray(output) ? contentBlocks(output) : [];
        blocks = [{ kind: "tool_result", text: parts.length ? parts.map(b => b.kind === "media" ? "[Attachment]" : b.text).join("\n") : text(output), callId: str(p.call_id) }, ...parts.filter(b => b.kind === "media")];
      } else if (kind === "reasoning") blocks = [{ kind: "reasoning", text: "" }];
      else blocks = [{ kind: "unsupported", text: text(p), format: kind }];
    } else if (r.type === "compacted") {
      warnings.push("Codex compaction detected; full recorded history transfers and may exceed the target context window.");
      if (str(p.message)) blocks = [{ kind: "summary", text: String(p.message) }];
    }
    if (blocks.length) messages.push(restoreMessage(r, { role, blocks, ...originalIdentity(r, str(p.id), str(r.timestamp)), metadata: messageMetadata("codex", r, p) }));
  }
  if (!messages.length) throw new BridgeError("EMPTY_SESSION", "No response items in Codex rollout.");
  return { sourceId: str(meta.id) ?? str(meta.session_id), cwd: str(meta.cwd), messages, warnings, metadata: extractMetadata("codex", originalRows) };
}
export function chatgptConversations(data: unknown): Row[] {
  const choices = Array.isArray(data) ? data : [data];
  if (!choices.length || choices.some(c => !Object.keys(row(row(c).mapping)).length))
    throw new BridgeError("INVALID_SCHEMA", "Expected a ChatGPT conversations.json export with mapping trees.");
  return choices.map(row);
}
function chatgpt(data: unknown, id?: string, branch?: string): ReturnType<typeof claude> & { title: string } {
  let choices = chatgptConversations(data);
  if (id) choices = choices.filter(c => (c.id ?? c.conversation_id) === id);
  if (choices.length !== 1) throw new BridgeError("SELECT_CONVERSATION", `Found ${choices.length} matching ChatGPT conversations.`, "Use list --input conversations.json, then --conversation ID.");
  const c = choices[0], mapping = row(c.mapping), chain: Row[] = [], seen = new Set<string>();
  let leaf = branch ?? str(c.current_node);
  if (!leaf) throw new BridgeError("INVALID_SCHEMA", "ChatGPT export has no current_node.");
  while (leaf) {
    if (seen.has(leaf) || !mapping[leaf]) throw new BridgeError("INVALID_CHAIN", "ChatGPT branch contains a cycle or missing node.");
    seen.add(leaf); const node = row(mapping[leaf]); chain.push(node); leaf = str(node.parent);
  }
  const messages: Message[] = [];
  for (const node of chain.reverse()) {
    if (!node.message) continue;
    const m = row(node.message), content = row(m.content), author = row(m.author), role = str(author.role) ?? "user";
    let blocks = contentBlocks(arr(content.parts));
    blocks.push(...arr(row(m.metadata).attachments).flatMap(a => { const asset = row(a); return contentBlocks([{ type: "file", filename: asset.name ?? asset.filename, file_id: asset.id ?? asset.file_id, mime_type: asset.mime_type, path: asset.path }]); }));
    if (!blocks.length && Object.keys(content).length) blocks = [{ kind: "unsupported", text: text(content), format: str(content.content_type) }];
    if (role === "tool") blocks = [{ kind: "tool_result", text: blocks.map(b => b.text).join("\n"), name: str(author.name) }];
    messages.push({ role, blocks, id: str(m.id), timestamp: typeof m.create_time === "number" ? m.create_time : undefined, metadata: messageMetadata("chatgpt", node, m) });
  }
  return { sourceId: str(c.id) ?? str(c.conversation_id), title: str(c.title) ?? "ChatGPT conversation", messages, metadata: extractMetadata("chatgpt", chain.map(n => ({ type: "message", payload: n.message })), c),
    warnings: Object.keys(mapping).length > chain.length ? ["Alternate ChatGPT branches are archived; the current branch transfers."] : [] };
}
function portable(data: unknown): Session {
  const s = row(data), kinds = ["text", "tool_call", "tool_result", "reasoning", "media", "summary", "unsupported"];
  if (s.format !== "session-bridge/v1" || !["claude", "codex", "chatgpt"].includes(String(s.source)) || !Array.isArray(s.messages)
      || typeof s.title !== "string" || !Array.isArray(s.warnings) || s.warnings.some(x => typeof x !== "string"))
    throw new BridgeError("INVALID_SCHEMA", "Invalid portable session header.");
  for (const m of s.messages) {
    const v = row(m);
    if (typeof v.role !== "string" || !Array.isArray(v.blocks)) throw new BridgeError("INVALID_SCHEMA", "Invalid portable message.");
    if (v.metadata !== undefined) validateMessageMetadata(v.metadata);
    for (const b of v.blocks) {
      const p = row(b);
      if (!kinds.includes(String(p.kind)) || typeof p.text !== "string") throw new BridgeError("INVALID_SCHEMA", "Invalid portable content block.");
      if (p.asset !== undefined) {
        const a = row(p.asset);
        if (!Object.keys(a).length) throw new BridgeError("INVALID_ASSET", "Invalid asset object.");
        for (const key of ["mime", "data", "path", "url", "pointer", "bundlePath", "sha256", "status"]) if (a[key] !== undefined && typeof a[key] !== "string") throw new BridgeError("INVALID_ASSET", `Invalid asset ${key}.`);
      }
      for (const key of ["name", "callId", "format"]) if (p[key] !== undefined && typeof p[key] !== "string") throw new BridgeError("INVALID_SCHEMA", `Invalid block ${key}.`);
    }
  }
  if (s.context !== undefined) {
    if (!Array.isArray(s.context)) throw new BridgeError("INVALID_SCHEMA", "Context must be an array.");
    for (const item of s.context) {
      const c = row(item);
      if (!["subagent", "memory", "retained", "communication"].includes(String(c.kind)) || typeof c.label !== "string" || (c.text !== undefined && typeof c.text !== "string")) throw new BridgeError("INVALID_SCHEMA", "Invalid supplemental context.");
      if (c.messages !== undefined) portable({ format: "session-bridge/v1", source: s.source, title: "context", warnings: [], messages: c.messages });
    }
  }
  if (s.branches !== undefined && (!Array.isArray(s.branches) || s.branches.some(b => typeof row(b).id !== "string" || typeof row(b).current !== "boolean"))) throw new BridgeError("INVALID_SCHEMA", "Invalid branches.");
  if (s.workspace !== undefined) {
    const w = row(s.workspace);
    if (typeof w.cwd !== "string" || typeof w.exists !== "boolean" || !Array.isArray(w.referenced) || !Array.isArray(w.mismatches) || w.mismatches.some(x => typeof x !== "string")) throw new BridgeError("INVALID_SCHEMA", "Invalid workspace report.");
    if (w.git !== undefined && (!Array.isArray(row(w.git).dirty) || arr(row(w.git).dirty).some(x => typeof row(x).path !== "string" || typeof row(x).status !== "string"))) throw new BridgeError("INVALID_SCHEMA", "Invalid workspace Git state.");
  }
  if (s.metadata !== undefined) validateSessionMetadata(s.metadata);
  if (s.historyMode !== undefined && s.historyMode !== "active" && s.historyMode !== "full") throw new BridgeError("INVALID_SCHEMA", "Invalid portable historyMode.");
  if (s.cwd !== undefined && typeof s.cwd !== "string") throw new BridgeError("INVALID_SCHEMA", "Portable cwd must be a string.");
  return s as unknown as Session;
}
export async function load(path: string, conversation?: string, history: "full" | "active" = "full", options: { branch?: string; children?: boolean; visited?: Set<string> } = {}) {
  path = expand(path);
  if ((await stat(path)).size > 512 * 1024 * 1024) throw new BridgeError("SESSION_TOO_LARGE", "Session exceeds 512 MiB.");
  const raw = await readFile(path), decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  let session: Session;
  const relatedSources: { path: string; raw: Uint8Array }[] = [];
  if (extname(path) === ".jsonl") {
    const rows = parseJsonl(decoded), source = rows.some(r => r.type === "session_meta") ? "codex" : "claude";
    if (source === "codex" && options.branch) throw new BridgeError("UNSUPPORTED_BRANCH", "Codex rollouts are sequential. Select a different rollout instead.");
    const parsed = source === "codex" ? codex(rows, history) : claude(rows, history, options.branch, path.includes(`${sep}subagents${sep}`));
    if (source === "codex" && parsed.metadata && !parsed.metadata.title && path.startsWith(roots().codex + sep)) {
      try {
        const index = parseJsonl(await readFile(join(roots().codex, "..", "session_index.jsonl"), "utf8"));
        const named = index.findLast(r => r.id === parsed.sourceId && str(r.thread_name));
        if (named) parsed.metadata.title = String(named.thread_name);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") parsed.warnings.push("Codex title index could not be read; using transcript title."); }
    }
    const title = parsed.metadata?.title ?? parsed.messages.filter(m => m.role === "user").flatMap(m => m.blocks)
      .find(b => b.kind === "text" && isTitleText(b.text))?.text.slice(0, 100) ?? "Untitled conversation";
    session = { format: "session-bridge/v1", source, historyMode: history, ...parsed, title };
    const inherited = rows.map(r => row(row(r.session_bridge).session)).find(r => r.context || r.branches || r.workspace);
    session.branches = inherited?.branches as Branch[] | undefined ?? branchInventory(rows, source);
    session.selectedBranch = options.branch ?? str(inherited?.selectedBranch) ?? session.branches.find(b => b.current)?.id;
    session.context = inherited?.context as Context[] | undefined ?? supplemental(rows, source);
    session.workspace = inherited?.workspace as Session["workspace"];
    const visited = options.visited ?? new Set<string>(); visited.add(path);
    const children = options.children !== false ? await childFiles(path, source, rows, roots().codex) : { paths: [], missing: [] };
    session.warnings.push(...children.missing.map(id => `Subagent transcript unavailable locally: ${id}`));
    for (const child of children.paths) {
      if (visited.has(child)) continue;
      if (visited.size >= 128) { session.warnings.push("Subagent discovery stopped at 128 transcripts; remaining children require separate conversion."); break; }
      try {
        const loaded = await load(child, undefined, history, { visited });
        session.context.push({ kind: "subagent", label: loaded.session.title, sourcePath: child, sourceId: loaded.session.sourceId, messages: loaded.session.messages });
        session.context.push(...(loaded.session.context ?? []));
        relatedSources.push({ path: child, raw: loaded.raw }, ...loaded.relatedSources);
        session.warnings.push(...loaded.session.warnings.map(w => `Subagent: ${w}`));
      } catch (e) { session.warnings.push(`Subagent could not be loaded: ${child}: ${(e as Error).message}`); }
    }
  } else {
    let data: unknown;
    try { data = JSON.parse(decoded); } catch { throw new BridgeError("INVALID_JSON", "Input is not valid JSON."); }
    if (row(data).format === "session-bridge/v1") { session = portable(data); if (options.branch && options.branch !== session.selectedBranch) throw new BridgeError("UNSUPPORTED_BRANCH", "Select alternate branches from source-original.json or source-original.jsonl."); }
    else session = { format: "session-bridge/v1", source: "chatgpt", ...chatgpt(data, conversation, options.branch), branches: chatgptBranches(data, conversation), selectedBranch: options.branch ?? chatgptBranches(data, conversation).find(b => b.current)?.id };
  }
  session = { ...session, warnings: unique(session.warnings), sourcePath: path, sourceSha256: hash(raw) };
  portable(session);
  return { session, raw, path, relatedSources };
}
export function native(s: Session, target: Target, id: string, cwd: string, timestamp: string): Row[] {
  const mapped: ReturnType<typeof mappedMessages> = [{ role: "user", id: undefined, metadata: undefined, text: `Conversation transferred from ${s.source} by baton. Prior tool activity is historical, not pending actions. Continue from the last turn using this app's current tools and permissions. Workspace files are checked, not copied. Supplemental history follows.\n\n${continuityText(s)}`, timestamp, originalRole: "user", blocks: [] }, ...mappedMessages(s)];
  const sessionBridge = { version: 1, session: { source: s.source, sourceId: s.sourceId, metadata: s.metadata, title: s.title, branches: s.branches?.map(({ id, current }) => ({ id, current })), selectedBranch: s.selectedBranch, context: s.context?.map(c => ({ ...c, messages: c.messages?.map(m => ({ ...m, blocks: m.blocks.map(b => b.kind === "reasoning" ? { kind: b.kind, text: "", format: b.format } : b) })) })), workspace: s.workspace } };
  const messageBridge = (m: (typeof mapped)[number]) => ({ version: 1, message: { id: m.id, timestamp: m.timestamp, metadata: m.metadata, role: m.originalRole, blocks: m.blocks.map(b => b.kind === "reasoning" ? { kind: b.kind, text: "", format: b.format } : b) } });
  if (target === "claude") {
    let parent: string | null = null;
    const records: Row[] = mapped.map((m, index) => {
      const mid = randomUUID(), msg: Row = { role: m.role, content: m.role === "user" && !nativeMedia(m.blocks, "claude").length ? m.text : [{ type: "text", text: m.text }, ...(m.role === "user" ? nativeMedia(m.blocks, "claude") : [])] };
      if (m.role === "assistant") Object.assign(msg, { id: `msg_${mid.replaceAll("-", "")}`, type: "message", model: m.metadata?.model ?? "baton", stop_reason: "end_turn", stop_sequence: null,
        usage: m.metadata?.provider === "claude" && m.metadata.usage ? m.metadata.usage : { input_tokens: 0, output_tokens: 0 } });
      const record = { type: m.role, uuid: mid, parentUuid: parent, isSidechain: false, sessionId: id, cwd,
        timestamp: isoTimestamp(m.timestamp) ?? timestamp, gitBranch: s.metadata?.git?.branch,
        userType: "external", version: "2.1.287", message: msg,
        session_bridge: index === 0 ? { ...sessionBridge, message: { generated: true } } : messageBridge(m) };
      parent = mid; return record;
    });
    records.push({ type: "custom-title", customTitle: s.title, sessionId: id });
    if (s.metadata?.tags[0]) records.push({ type: "tag", tag: s.metadata.tags[0], sessionId: id });
    return records;
  }
  if (target !== "codex") throw new BridgeError("INVALID_TARGET", "Target has no native session format.");
  const git = s.metadata?.git;
  let repository: string | undefined;
  if (git?.repository) {
    try { const url = new URL(git.repository); url.username = ""; url.password = ""; repository = url.href; }
    catch { if (!git.repository.includes("@") || git.repository.startsWith("git@")) repository = git.repository; }
  }
  const records: Row[] = [{ timestamp, type: "session_meta", session_bridge: sessionBridge, payload: { id, session_id: id, timestamp, cwd,
    originator: "baton", cli_version: "0.159.2", source: "cli", model_provider: "openai", history_mode: "legacy",
    ...(git ? { git: { branch: git.branch, commit_hash: git.commit && /^[a-f0-9]{40,64}$/i.test(git.commit) ? git.commit : undefined, repository_url: repository } } : {}) } }];
  let turnId: string | undefined, lastAnswer: string | null = null, turnStart = timestamp, lastTime = timestamp;
  const event = (payload: Row, stamp = lastTime) => records.push({ timestamp: stamp, type: "event_msg", payload });
  const finish = () => { if (turnId) {
    const start = Date.parse(turnStart), end = Math.max(start, Date.parse(lastTime));
    event({ type: "task_complete", turn_id: turnId, last_agent_message: lastAnswer, started_at: Math.floor(start / 1000), completed_at: Math.floor(end / 1000), duration_ms: end - start });
  } };
  for (const [index, m] of mapped.entries()) {
    const stamp = isoTimestamp(m.timestamp) ?? timestamp;
    if (m.role === "user" || !turnId) {
      finish(); turnId = randomUUID(); lastAnswer = null; turnStart = stamp;
      event({ type: "task_started", turn_id: turnId, root_turn_id: turnId, started_at: Math.floor(Date.parse(stamp) / 1000), collaboration_mode_kind: "default" }, stamp);
    }
    lastTime = stamp;
    const mid = `msg_${randomUUID().replaceAll("-", "")}`;
    const phase = m.metadata?.phase === "commentary" ? "commentary" : "final_answer";
    records.push({ timestamp: stamp, type: "response_item", session_bridge: index === 0 ? { version: 1, message: { generated: true } } : messageBridge(m), payload: { type: "message", id: mid, role: m.role,
      content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.text }, ...(m.role === "user" ? nativeMedia(m.blocks, "codex") : [])],
      internal_chat_message_metadata_passthrough: { turn_id: turnId }, ...(m.role === "assistant" ? { phase } : {}) },
      metadata: { retained_source: { id: { message_id: mid, turn_id: turnId, role: m.role }, revision: `retained_${randomUUID()}`, complete: true }, client_authored: false } });
    if (m.role === "assistant") {
      event({ type: "agent_message", message: m.text, phase, memory_citation: null });
      lastAnswer = m.text;
    } else event({ type: "user_message", message: m.text, images: nativeMedia(m.blocks, "codex").map(b => b.image_url), local_images: [], text_elements: [] });
  }
  finish();
  return records.map((r, ordinal) => ({ ...r, ordinal }));
}

function restoreMessage(record: Row, fallback: Message): Message {
  const original = row(row(record.session_bridge).message);
  if (!original.blocks) return fallback;
  const m = { ...fallback, role: str(original.role) ?? fallback.role, blocks: original.blocks };
  return portable({ format: "session-bridge/v1", source: "claude", title: "message", warnings: [], messages: [m] }).messages[0];
}
export function branchInventory(rows: Row[], source: "claude" | "codex"): Branch[] {
  if (source === "codex") return [];
  const candidates = rows.filter(r => ["user", "assistant"].includes(String(r.type)) && str(r.uuid) && !r.isSidechain);
  const parents = new Set(rows.map(r => str(r.parentUuid)).filter(Boolean));
  const current = str(candidates.at(-1)?.uuid), leaves = new Map<string, Row>();
  for (const r of candidates) if (!parents.has(String(r.uuid)) || r.uuid === current) leaves.set(String(r.uuid), r);
  return [...leaves].map(([id, r]) => ({ id, current: id === current, title: contentBlocks(row(r.message).content).find(b => b.kind === "text")?.text.slice(0, 100) }));
}
function chatgptBranches(data: unknown, id?: string): Branch[] {
  const c = chatgptConversations(data).find(c => !id || (c.id ?? c.conversation_id) === id);
  if (!c) return [];
  const mapping = row(c.mapping), parents = new Set(Object.values(mapping).map(n => str(row(n).parent)).filter(Boolean));
  return Object.entries(mapping).filter(([id]) => !parents.has(id) || id === c.current_node).map(([id, n]) => ({ id, current: id === c.current_node,
    title: contentBlocks(arr(row(row(row(n).message).content).parts)).find(b => b.kind === "text")?.text.slice(0, 100) }));
}
function supplemental(rows: Row[], source: "claude" | "codex"): Context[] {
  const result: Context[] = [];
  for (const r of rows) {
    const p = row(r.payload);
    if (r.type === "compacted" && p.retained_context && r === rows.findLast(x => x.type === "compacted" && row(x.payload).retained_context)) {
      const retained = row(p.retained_context);
      const values = arr(p.retained_context);
      const messages = values.flatMap(v => {
        const item = row(row(v).item ?? v);
        return item.type === "message" ? [{ role: str(item.role) ?? "user", blocks: contentBlocks(item.content), id: str(item.id) }] : [];
      });
      for (const [key, role] of [["user_messages", "user"], ["assistant_messages", "assistant"]] as const) for (const value of arr(retained[key])) {
        const item = row(value); if (str(item.text)) messages.push({ role, blocks: [{ kind: "text", text: String(item.text) }], id: str(item.message_id) });
      }
      if (arr(retained.verified_answers).length) result.push({ kind: "retained", label: "Verified answers", text: safeContext(retained.verified_answers) });
      result.push({ kind: "retained", label: "Compaction retained context", ...(messages.length ? { messages } : { text: safeContext(p.retained_context) }) });
    }
    if (r.type === "inter_agent_communication" || p.type === "inter_agent_communication") {
      const communication = row(r.communication ?? p.communication ?? p);
      if (str(communication.content)) result.push({ kind: "communication", label: `${text(communication.author)} → ${text(communication.recipient)}`, text: String(communication.content) });
    }
    if (source === "claude" && r.type === "attachment") {
      const attachment = row(r.attachment), type = str(attachment.type) ?? "attachment";
      if (/memory|summary|context|todo|task|plan/.test(type) || ["instructions", "edited_text_file", "queued_command", "read_truncation_notice"].includes(type)) result.push({ kind: "memory", label: type, text: safeContext(attachment) });
    }
    if (source === "claude" && r.type === "system" && (/summary|memory|context/.test(String(r.subtype)) || r.hookAdditionalContext)) result.push({ kind: "memory", label: String(r.subtype), text: safeContext(r.content ?? r.message ?? r) });
  }
  return result;
}
function safeContext(value: unknown): string {
  function clean(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(clean);
    if (!v || typeof v !== "object") return v;
    const r = row(v);
    if (["reasoning", "thinking", "redacted_thinking"].includes(String(r.type))) return { type: r.type, omitted: true };
    return Object.fromEntries(Object.entries(r).filter(([key]) => !["encrypted_content", "thinking", "signature"].includes(key)).map(([key, x]) => [key, clean(x)]));
  }
  return typeof value === "string" ? value : text(clean(value));
}
