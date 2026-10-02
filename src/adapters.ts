import { readBytes, transcriptBytes } from "./io.ts";
import { canonicalMessage, blockSignature } from "./canonical.ts";
import { taskNotification, notificationText, notificationState, type NotificationAgent } from "./notifications.ts";
import { extractMetadata, messageMetadata, originalIdentity, isoTimestamp, validateMessageMetadata, validateSessionMetadata } from "./metadata.ts";
import { childFiles, nativeMedia } from "./continuity.ts";
import { stat } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { arr, row, str, text, hash, unique, expand, contentBlocks, mappedMessages, renderBlocks, BridgeError,
  isTitleText, roots, continuityText, type Branch, type Context, type Session, type Message, type Row, type Target, type Block } from "./model.ts";

export function parseJsonl(data: string): Row[] {
  const records: Row[] = [];
  let start = data.charCodeAt(0) === 0xfeff ? 1 : 0, lineNumber = 0;
  while (start < data.length) {
    let end = data.indexOf("\n", start); if (end < 0) end = data.length;
    const line = data.slice(start, end); lineNumber++; start = end + 1;
    if (!line.trim()) continue;
    try {
      const obj: unknown = JSON.parse(line);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("Expected an object");
      records.push(obj as Row);
    } catch { throw new BridgeError("MALFORMED_SESSION", `Invalid JSON object at line ${lineNumber}.`, "If the session is active, wait for its current write and retry."); }
  }
  return records;
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
  restoreOmitted(rows, messages);
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
  const entries: { index: number; record: Row; message: Message }[] = [];
  for (const [index, r] of rows.entries()) {
    const p = row(r.payload), kind = str(p.type);
    let role = "assistant", blocks: Block[] = [];
    if (row(row(r.session_bridge).message).generated === true) continue;
    if (r.type === "response_item") {
      if (kind === "message") { role = str(p.role) ?? role; blocks = contentBlocks(p.content); }
      else if (["function_call", "custom_tool_call", "local_shell_call", "web_search_call"].includes(kind ?? "")) {
        blocks = [{ kind: "tool_call", text: text(p.arguments ?? p.input ?? p), name: str(p.name) ?? kind, callId: str(p.call_id) ?? str(p.id) }];
      } else if (["function_call_output", "custom_tool_call_output", "local_shell_call_output"].includes(kind ?? "")) {
        role = "user"; const output = p.output ?? p, parts = Array.isArray(output) ? contentBlocks(output) : [];
        blocks = [{ kind: "tool_result", text: parts.length ? parts.map(b => b.kind === "media" ? "[Attachment]" : b.text).join("\n") : text(output), callId: str(p.call_id), ...(p.is_error === true ? { isError: true } : {}) }, ...parts.filter(b => b.kind === "media")];
      } else if (kind === "reasoning") blocks = [{ kind: "reasoning", text: "" }];
      else blocks = [{ kind: "unsupported", text: text(p), format: kind }];
    } else if (r.type === "compacted") {
      warnings.push("Codex compaction detected; full recorded history transfers and may exceed the target context window.");
      if (str(p.message)) blocks = [{ kind: "summary", text: String(p.message) }];
    }
    if (blocks.length) entries.push({ index, record: r, message: restoreMessage(r, { role, blocks, ...originalIdentity(r, str(p.id), str(r.timestamp)), metadata: messageMetadata("codex", r, p) }) });
  }
  const identities = new Set(rows.filter(r => r.type === 'response_item' && row(r.payload).type === 'message').map(r => str(row(r.payload).id)).filter(Boolean));
  const importedLinks = new Set(meta.originator === 'baton' ? rows.filter(r => row(r.payload).type === 'collab_agent_spawn_end').map(r => str(row(r.payload).call_id)).filter(Boolean) : []);
  const counts = new Map<string, number>(), toolIds = new Map<string, number>();
  const key = (r: Row, m: Message, b: Block) => {
    const scope = ['tool_call', 'tool_result'].includes(b.kind) ? '' : isoTimestamp(str(r.timestamp)) ?? '';
    return `${scope}:${blockSignature(b.kind === 'tool_call' ? 'assistant' : b.kind === 'tool_result' || b.kind === 'media' ? 'user' : m.role, b)}`;
  };
  for (const e of entries) for (const b of e.message.blocks) {
    const k = key(e.record, e.message, b); counts.set(k, (counts.get(k) ?? 0) + 1);
    if (b.callId && ['tool_call', 'tool_result'].includes(b.kind)) { const identity = `${b.kind}:${b.callId}`; toolIds.set(identity, (toolIds.get(identity) ?? 0) + 1); }
  }
  const latest = new Map<string, number>();
  rows.forEach((r, index) => {
    const p = row(r.payload), id = str(row(p.item).id);
    if (r.type === 'event_msg' && ['item_started', 'item_completed'].includes(String(p.type)) && id) {
      const prior = latest.get(id);
      if (p.type === 'item_completed' || prior === undefined || row(rows[prior].payload).type !== 'item_completed') latest.set(id, index);
    }
  });
  for (const [index, r] of rows.entries()) {
    const p = row(r.payload), item = row(p.item), id = str(item.id);
    if (r.type !== 'event_msg' || !['item_started', 'item_completed'].includes(String(p.type)) || (id && (latest.get(id) !== index || identities.has(id) || importedLinks.has(id))) || row(row(r.session_bridge).message).generated === true) continue;
    const m = canonicalMessage(r); if (!m) continue;
    let matchedCall = false;
    m.blocks = m.blocks.filter(b => {
      const k = key(r, m, b), count = counts.get(k) ?? 0, identity = `${b.kind}:${b.callId}`, byId = b.callId ? toolIds.get(identity) ?? 0 : 0;
      if (count || byId) {
        if (count) counts.set(k, count - 1); if (byId) toolIds.set(identity, byId - 1);
        if (b.kind === 'tool_call') matchedCall = true;
        return false;
      }
      // Older Baton imports closed missing results for display only.
      if (matchedCall && meta.originator === 'baton' && str(item.namespace)?.endsWith('_history') && b.kind === 'tool_result' && ['Source call has no recorded result; imported inactive.', 'Source call ID was reused without a recorded result; imported inactive.'].includes(b.text)) return false;
      return true;
    });
    if (!m.blocks.length) continue;
    if (m.blocks.some(b => b.kind === 'unsupported')) warnings.push(`Codex ${String(item.type)} event preserved as labeled historical context; no native cross-client representation.`);
    if (p.type === 'item_started') warnings.push(`Incomplete Codex ${String(item.type)} event imported as inactive history.`);
    m.metadata = messageMetadata('codex', r, item);
    entries.push({ index, record: r, message: m });
  }
  const generatedMirrors = new Set(rows.filter(r => r.type === 'response_item' && row(row(r.session_bridge).message).generated === true).flatMap(r => contentBlocks(row(r.payload).content).filter(b => b.kind === 'text').map(b => `${str(r.timestamp)}:${b.text}`)));
  const mirrors = new Map<string, number>();
  for (const e of entries) for (const b of e.message.blocks) {
    const k = key(e.record, e.message, b); mirrors.set(k, (mirrors.get(k) ?? 0) + 1);
  }
  for (const [index, r] of rows.entries()) {
    const p = row(r.payload);
    if (r.type !== 'event_msg' || !['user_message', 'agent_message'].includes(String(p.type)) || !str(p.message)) continue;
    if (meta.originator === 'baton' && generatedMirrors.has(`${str(r.timestamp)}:${p.message}`)) continue;
    const m: Message = { role: p.type === 'user_message' ? 'user' : 'assistant', timestamp: str(r.timestamp), blocks: [{ kind: 'text', text: String(p.message) }], metadata: messageMetadata('codex', r, p) };
    const k = key(r, m, m.blocks[0]), count = mirrors.get(k) ?? 0;
    if (count) { mirrors.set(k, count - 1); continue; }
    entries.push({ index, record: r, message: m });
  }
  messages.push(...entries.sort((a, b) => a.index - b.index).map(e => e.message));
  restoreOmitted(rows, messages);
  if (!messages.length) throw new BridgeError("EMPTY_SESSION", "No conversation items in Codex rollout.");
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
      for (const key of ["sourceId", "parentSourceId", "agentRole", "agentNickname", "spawnCallId"]) if (c[key] !== undefined && typeof c[key] !== "string") throw new BridgeError("INVALID_SCHEMA", `Invalid subagent ${key}.`);
      if (c.metadata !== undefined) validateSessionMetadata(c.metadata);
      if (c.sourceAliases !== undefined && (!Array.isArray(c.sourceAliases) || c.sourceAliases.some(value => typeof value !== "string" || !value))) throw new BridgeError("INVALID_SCHEMA", "Invalid subagent source aliases.");
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
  const raw = await readBytes(path), decoded = new TextDecoder("utf-8", { fatal: true }).decode(await transcriptBytes(path, raw));
  let records: Row[] | undefined;
  let session: Session;
  const relatedSources: { path: string; raw: Uint8Array }[] = [];
  if (extname(path) === ".jsonl" || path.endsWith(".jsonl.zst")) {
    const rows = records = parseJsonl(decoded), source = rows.some(r => r.type === "session_meta") ? "codex" : "claude";
    if (source === "codex" && options.branch) throw new BridgeError("UNSUPPORTED_BRANCH", "Codex rollouts are sequential. Select a different rollout instead.");
    const parsed = source === "codex" ? codex(rows, history) : claude(rows, history, options.branch, path.includes(`${sep}subagents${sep}`) || rows.some(r => r.isSidechain === true) && !rows.some(r => ["user", "assistant"].includes(String(r.type)) && r.isSidechain !== true));
    if (source === "codex" && parsed.metadata && !parsed.metadata.title && path.startsWith(roots().codex + sep)) {
      try {
        const index = parseJsonl(await Bun.file(join(roots().codex, "..", "session_index.jsonl")).text());
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
    if (children.paths.length) session.context = session.context.filter(c => c.kind !== "subagent");
    session.warnings.push(...children.missing.map(id => `Subagent transcript unavailable locally: ${id}`));
    for (const child of children.paths) {
      if (visited.has(child)) continue;
      if (visited.size >= 128) { session.warnings.push("Subagent discovery stopped at 128 transcripts; remaining children require separate conversion."); break; }
      try {
        const loaded = await load(child, undefined, history, { visited });
        const childRows = loaded.records ?? parseJsonl(Buffer.from(loaded.raw).toString("utf8"));
        const childMeta = row(childRows.find(r => r.type === "session_meta")?.payload);
        const spawnMeta = row(row(row(childMeta.source).subagent).thread_spawn);
        let agentMeta: Row = {};
        if (source === "claude") {
          try {
            const metadataPath = child.replace(/\.jsonl$/, ".meta.json"), metadataRaw = await readBytes(metadataPath);
            agentMeta = row(JSON.parse(metadataRaw.toString("utf8")));
            relatedSources.push({ path: metadataPath, raw: metadataRaw });
            loaded.session.metadata?.records.push({ provider: "claude", type: "subagent-metadata", fields: agentMeta });
          }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") session.warnings.push(`Subagent metadata unavailable: ${child}`); }
        }
        const childId = source === "claude" ? str(childRows.find(r => str(r.agentId))?.agentId) ?? basename(child, ".jsonl").replace(/^agent-/, "") : loaded.session.sourceId;
        const bridgedId = str(row(row(childRows.find(r => r.type === "session_meta")?.session_bridge).session).sourceId);
        const originalContext = arr(inherited?.context).map(row).find(c => c.sourceId === bridgedId || c.sourceId === childId);
        const parentId = source === "claude" && path.includes(`${sep}subagents${sep}`) ? basename(path, ".jsonl").replace(/^agent-/, "") : session.sourceId;
        session.context.push({ kind: "subagent", label: str(agentMeta.description) ?? loaded.session.title, sourcePath: child, sourceId: childId,
          parentSourceId: str(agentMeta.parentAgentId) ?? str(childMeta.parent_thread_id) ?? str(spawnMeta.parent_thread_id) ?? parentId, agentRole: str(agentMeta.agentType) ?? str(childMeta.agent_role) ?? str(spawnMeta.agent_role),
          agentNickname: str(childMeta.agent_nickname) ?? str(spawnMeta.agent_nickname), spawnCallId: str(agentMeta.toolUseId) ?? str(originalContext?.spawnCallId), sourceAliases: unique([bridgedId, ...arr(originalContext?.sourceAliases).map(str)].filter((value): value is string => Boolean(value) && value !== childId)), metadata: loaded.session.metadata, messages: loaded.session.messages });
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
  // Collaboration references can point to peers whose parents are outside this
  // transcript family. Keep their evidence without inventing child ancestry.
  if (records && session.context && !options.visited) {
    const agents = new Map(session.context.filter(c => c.kind === 'subagent' && c.sourceId).map(c => [c.sourceId!, c]));
    for (const c of agents.values()) {
      let parent = c.parentSourceId; const seen = new Set<string>();
      while (parent && parent !== session.sourceId && agents.has(parent) && !seen.has(parent)) { seen.add(parent); parent = agents.get(parent)!.parentSourceId; }
      if (parent && parent !== session.sourceId && !agents.has(parent)) {
        c.kind = 'communication';
        session.warnings.push(`Referenced agent ${c.sourceId} has an unavailable parent; its transcript is preserved as historical communication.`);
      }
    }
  }
  session = { ...session, warnings: unique(session.warnings), sourcePath: path, sourceSha256: hash(raw) };
  portable(session);
  return { session, raw, path, relatedSources, records };
}
export function native(s: Session, target: Target, id: string, cwd: string, timestamp: string, notificationAgents: Map<string, NotificationAgent> = new Map()): Row[] {
  const mapped: ReturnType<typeof mappedMessages> = [{ role: "user", id: undefined, metadata: undefined, text: `Conversation transferred from ${s.source} by baton. Prior tool activity is historical, not pending actions. Continue from the last turn using this app's current tools and permissions. Workspace files are checked, not copied. Supplemental history follows.\n\n${continuityText(s)}`, timestamp, originalRole: "user", blocks: [] }, ...mappedMessages(s)];
  const sessionBridge = { version: 1, session: { source: s.source, sourceId: s.sourceId, metadata: s.metadata, title: s.title,
    omittedMessages: s.messages.flatMap((m, index) => renderBlocks(m.blocks) ? [] : [{ index, message: { ...m, blocks: m.blocks.map(b => b.kind === 'reasoning' ? { kind: b.kind, text: '', format: b.format } : b) } }]), branches: s.branches?.map(({ id, current }) => ({ id, current })), selectedBranch: s.selectedBranch, context: s.context?.map(c => ({ ...c, messages: c.messages?.map(m => ({ ...m, blocks: m.blocks.map(b => b.kind === "reasoning" ? { kind: b.kind, text: "", format: b.format } : b) })) })), workspace: s.workspace } };
  const messageBridge = (m: (typeof mapped)[number]) => ({ version: 1, message: { id: m.id, timestamp: m.timestamp, metadata: m.metadata, role: m.originalRole, blocks: m.blocks.map(b => b.kind === "reasoning" ? { kind: b.kind, text: "", format: b.format } : b) } });
  if (target === "claude") {
    let parent: string | null = null;
    const records: Row[] = [];
    const pending = new Map<string, string>();
    const generated = { version: 1, message: { generated: true } };
    const append = (role: string, content: unknown, m: (typeof mapped)[number], bridge: Row) => {
      const mid = randomUUID(), msg: Row = { role, content };
      if (role === 'assistant') Object.assign(msg, { id: `msg_${mid.replaceAll('-', '')}`, type: 'message', model: m.metadata?.model ?? 'baton',
        stop_reason: arr(content).some(b => row(b).type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: m.metadata?.provider === 'claude' && m.metadata.usage ? m.metadata.usage : { input_tokens: 0, output_tokens: 0 } });
      records.push({ type: role, uuid: mid, parentUuid: parent, isSidechain: false, sessionId: id, cwd,
        timestamp: isoTimestamp(m.timestamp) ?? timestamp, gitBranch: s.metadata?.git?.branch, userType: 'external', version: '2.1.287', message: msg, session_bridge: bridge });
      parent = mid;
    };
    const close = (callId: string, m: (typeof mapped)[number]) => {
      const destinationId = pending.get(callId); if (!destinationId) return;
      append('user', [{ type: 'tool_result', tool_use_id: destinationId, is_error: true, content: 'Source call has no recorded result; imported inactive.' }], m, generated);
      pending.delete(callId);
    };
    for (const [index, m] of mapped.entries()) {
      const bridge = index === 0 ? { ...sessionBridge, message: { generated: true } } : messageBridge(m);
      if (!m.blocks.some(b => b.kind === 'tool_call' || b.kind === 'tool_result') || !['user', 'assistant'].includes(m.originalRole)) {
        const notice = taskNotification({ role: m.originalRole, blocks: m.blocks, metadata: m.metadata });
        const content = notice ? notificationText(notice) : m.text;
        append(notice ? 'assistant' : m.role, m.role === 'user' && !nativeMedia(m.blocks, 'claude').length ? content : [{ type: 'text', text: content }, ...(m.role === 'user' ? nativeMedia(m.blocks, 'claude') : [])], m, bridge);
        if (index === 0) records.at(-1)!.isMeta = true;
        continue;
      }
      let role = m.role, content: Row[] = [], usedBridge = false;
      const flush = () => { if (!content.length) return; append(role, content, m, usedBridge ? generated : bridge); usedBridge = true; content = []; };
      for (const b of m.blocks) {
        if (b.kind === 'reasoning') continue;
        const nextRole = b.kind === 'tool_call' ? 'assistant' : b.kind === 'tool_result' || b.kind === 'media' ? 'user' : m.role;
        if (role !== nextRole) { flush(); role = nextRole; }
        if (b.kind === 'tool_call') {
          const sourceId = b.callId ?? randomUUID();
          if (pending.has(sourceId)) { flush(); close(sourceId, m); }
          const destinationId = `toolu_${randomUUID().replaceAll('-', '')}`; pending.set(sourceId, destinationId);
          let input: unknown; try { input = JSON.parse(b.text); } catch { input = { historical_input: b.text }; }
          if (!Object.keys(row(input)).length && (input === null || typeof input !== 'object' || Array.isArray(input))) input = { historical_input: input };
          content.push({ type: 'tool_use', id: destinationId, name: (b.name ?? 'source_tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'source_tool', input });
        } else if (b.kind === 'tool_result') {
          const sourceId = b.callId ?? randomUUID();
          if (!pending.has(sourceId)) {
            flush(); const destinationId = `toolu_${randomUUID().replaceAll('-', '')}`; pending.set(sourceId, destinationId);
            append('assistant', [{ type: 'tool_use', id: destinationId, name: (b.name ?? 'source_tool_result').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'source_tool_result', input: { source_call_id: b.callId ?? null, historical_orphan: true } }], m, generated);
          }
          content.push({ type: 'tool_result', tool_use_id: pending.get(sourceId), content: b.text, ...(b.isError ? { is_error: true } : {}) }); pending.delete(sourceId);
        } else if (b.kind === 'media') { const media = nativeMedia([b], 'claude'); content.push(...(media.length ? media : [{ type: 'text', text: renderBlocks([b]) }])); }
        else content.push({ type: 'text', text: renderBlocks([b]) });
      }
      flush();
    }
    for (const callId of [...pending.keys()]) close(callId, mapped.at(-1)!);
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
    originator: "baton", cli_version: "0.159.2", source: "cli", model_provider: "openai", history_mode: "paginated",
    ...(git ? { git: { branch: git.branch, commit_hash: git.commit && /^[a-f0-9]{40,64}$/i.test(git.commit) ? git.commit : undefined, repository_url: repository } } : {}) } }];
  let turnId: string | undefined, lastAnswer: string | null = null, turnStart = timestamp, lastTime = timestamp;
  const event = (payload: Row, stamp = lastTime) => records.push({ timestamp: stamp, type: "event_msg", payload });
  const finish = () => { if (turnId) {
    const start = Date.parse(turnStart), end = Math.max(start, Date.parse(lastTime));
    event({ type: "task_complete", turn_id: turnId, last_agent_message: lastAnswer, started_at: Math.floor(start / 1000), completed_at: Math.floor(end / 1000), duration_ms: end - start });
  } };
  const toolCalls = new Map<string, { id: string; name: string; arguments: unknown; turnId: string; start: string }>();
  const emitTool = (call: { id: string; name: string; arguments: unknown; turnId: string }, output: string | undefined, failed: boolean, stamp: string) => event({ type: "item_completed", thread_id: id, turn_id: call.turnId, completed_at_ms: Date.parse(stamp), item: { type: "DynamicToolCall", id: call.id, namespace: `${s.source}_history`, tool: call.name, arguments: call.arguments, status: failed ? "failed" : "completed", ...(output !== undefined ? { content_items: [{ type: "inputText", text: output }] } : {}), success: !failed, ...(failed ? { error: output ?? "Source call has no recorded result; imported inactive." } : {}) } }, stamp);
  for (const [index, m] of mapped.entries()) {
    const stamp = isoTimestamp(m.timestamp) ?? timestamp;
    if (index === 0) {
      // Context reconstruction reads response items. Paginated desktop history
      // reads canonical items; generated transfer context has no visible item.
      records.push({ timestamp: stamp, type: 'response_item', session_bridge: { version: 1, message: { generated: true } }, payload: {
        type: 'message', id: `msg_${randomUUID().replaceAll('-', '')}`, role: 'user', content: [{ type: 'input_text', text: m.text }],
      } });
      continue;
    }
    const notification = taskNotification({ role: m.originalRole, blocks: m.blocks, metadata: m.metadata });
    const hasTools = m.blocks.some(b => b.kind === "tool_call" || b.kind === "tool_result");
    const chatBlocks = m.blocks.filter(b => b.kind !== "tool_call" && b.kind !== "tool_result");
    const chatText = hasTools ? renderBlocks(chatBlocks) : m.text;
    if ((!notification && m.role === "user" && (!hasTools || chatText)) || !turnId) {
      finish(); turnId = randomUUID(); lastAnswer = null; turnStart = stamp;
      event({ type: "task_started", turn_id: turnId, root_turn_id: turnId, started_at: Math.floor(Date.parse(stamp) / 1000), collaboration_mode_kind: "default" }, stamp);
    }
    lastTime = stamp;
    const mid = `msg_${randomUUID().replaceAll("-", "")}`;
    const phase = m.metadata?.phase === "commentary" ? "commentary" : "final_answer";
    if (notification) {
      const content = notificationText(notification), agent = notificationAgents.get(notification.taskId) ?? notificationAgents.get(notification.toolUseId ?? "");
      // Preserve source identity and complete XML for inverse conversion, while
      // feeding readable historical context and a native event to the destination.
      records.push({ timestamp: stamp, type: "response_item", session_bridge: messageBridge(m), payload: { type: "message", id: mid, role: "assistant", content: [{ type: "output_text", text: content }], phase: "commentary", internal_chat_message_metadata_passthrough: { turn_id: turnId } } });
      event({ type: "item_completed", thread_id: id, turn_id: turnId, completed_at_ms: Date.parse(stamp), item: agent
        ? { type: "CollabAgentToolCall", id: mid, tool: "wait", status: notification.status === "failed" ? "failed" : "completed", sender_thread_id: id, receiver_thread_ids: [agent.sessionId], receiver_agents: [{ thread_id: agent.sessionId, agent_nickname: agent.nickname, agent_role: agent.role }], prompt: content, agents_states: { [agent.sessionId]: notificationState(notification) } }
        : { type: "AgentMessage", id: mid, content: [{ type: "Text", text: content }], phase: "commentary", memory_citation: null } }, stamp);
      continue;
    }

    if (hasTools) {
      // Model context stays labeled history. Canonical items control display;
      // archived source tools are never registered or replayed.
      records.push({ timestamp: stamp, type: "response_item", session_bridge: messageBridge(m), payload: { type: "message", id: mid, role: "assistant", content: [{ type: "output_text", text: `[Imported historical tool activity; no source task is live.]\n${m.text}` }], phase: "commentary", internal_chat_message_metadata_passthrough: { turn_id: turnId } } });
      if (chatText) event({ type: "item_completed", thread_id: id, turn_id: turnId, completed_at_ms: Date.parse(stamp), item: m.role === "user"
        ? { type: "UserMessage", id: mid, content: [{ type: "text", text: chatText, text_elements: [] }, ...nativeMedia(chatBlocks, "codex").map(b => ({ type: "image", image_url: b.image_url }))] }
        : { type: "AgentMessage", id: mid, content: [{ type: "Text", text: chatText }], phase, memory_citation: null } }, stamp);
      for (const b of m.blocks) {
        if (b.kind === "tool_call") {
          const callId = b.callId ?? randomUUID(), previous = toolCalls.get(callId);
          if (previous) emitTool(previous, "Source call ID was reused without a recorded result; imported inactive.", true, stamp);
          let argumentsValue: unknown; try { argumentsValue = JSON.parse(b.text); } catch { argumentsValue = { source_arguments: b.text }; }
          const call = { id: `tool_${randomUUID()}`, name: b.name ?? "source_tool", arguments: argumentsValue, turnId: turnId!, start: stamp };
          toolCalls.set(callId, call);
          event({ type: "item_started", thread_id: id, turn_id: turnId, started_at_ms: Date.parse(stamp), item: { type: "DynamicToolCall", id: call.id, namespace: `${s.source}_history`, tool: call.name, arguments: call.arguments, status: "in_progress" } }, stamp);
        } else if (b.kind === "tool_result") {
          const call = toolCalls.get(b.callId ?? "") ?? { id: `tool_${randomUUID()}`, name: b.name ?? "source_tool_result", arguments: { source_call_id: b.callId ?? null }, turnId: turnId!, start: stamp };
          emitTool(call, b.text, Boolean(b.isError), stamp); toolCalls.delete(b.callId ?? "");
        }
      }
      if (m.role === "assistant" && chatText) lastAnswer = chatText;
      continue;
    }

    records.push({ timestamp: stamp, type: "response_item", session_bridge: index === 0 ? { version: 1, message: { generated: true } } : messageBridge(m), payload: { type: "message", id: mid, role: m.role,
      content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.text }, ...(m.role === "user" ? nativeMedia(m.blocks, "codex") : [])],
      internal_chat_message_metadata_passthrough: { turn_id: turnId }, ...(m.role === "assistant" ? { phase } : {}) },
      metadata: { retained_source: { id: { message_id: mid, turn_id: turnId, role: m.role }, revision: `retained_${randomUUID()}`, complete: true }, client_authored: false } });
    event({ type: "item_completed", thread_id: id, turn_id: turnId, completed_at_ms: Date.parse(stamp), item: m.role === "user"
      ? { type: "UserMessage", id: mid, content: [{ type: "text", text: m.text, text_elements: [] }, ...nativeMedia(m.blocks, "codex").map(b => ({ type: "image", image_url: b.image_url }))] }
      : { type: "AgentMessage", id: mid, content: [{ type: "Text", text: m.text }], phase, memory_citation: null } }, stamp);
    if (m.role === "assistant") {
      event({ type: "agent_message", message: m.text, phase, memory_citation: null });
      lastAnswer = m.text;
    } else event({ type: "user_message", message: m.text, images: nativeMedia(m.blocks, "codex").map(b => b.image_url), local_images: [], text_elements: [] });
  }
  for (const call of toolCalls.values()) emitTool(call, undefined, true, lastTime);
  finish();
  return records.map((r, ordinal) => ({ ...r, ordinal }));
}

function restoreOmitted(records: Row[], messages: Message[]) {
  const omitted = arr(records.map(r => row(row(r.session_bridge).session)).find(s => Array.isArray(s.omittedMessages))?.omittedMessages).map(row);
  const positions = new Set<number>();
  for (const entry of omitted.sort((a, b) => Number(a.index) - Number(b.index))) {
    if (typeof entry.index !== 'number' || !Number.isSafeInteger(entry.index) || entry.index < 0 || positions.has(entry.index)) throw new BridgeError('INVALID_SCHEMA', 'Invalid retained message position.');
    positions.add(entry.index);
    const retained = portable({ format: 'session-bridge/v1', source: 'codex', title: 'retained', warnings: [], messages: [entry.message] }).messages[0];
    if (renderBlocks(retained.blocks)) throw new BridgeError('INVALID_SCHEMA', 'Retained message must have no resumed content.');
    messages.splice(Math.min(entry.index, messages.length), 0, retained);
  }
}

function restoreMessage(record: Row, fallback: Message): Message {
  const original = row(row(record.session_bridge).message);
  if (!original.blocks) return fallback;
  const m = { ...fallback, id: str(original.id), timestamp: original.timestamp as Message['timestamp'], metadata: original.metadata as Message['metadata'], role: str(original.role) ?? fallback.role, blocks: original.blocks };
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
