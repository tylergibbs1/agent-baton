import { type NotificationAgent } from "./notifications.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { native } from "./adapters.ts";
import { BridgeError, row, type Context, type Session, type Row } from "./model.ts";

export interface NativeChild {
  sourceId: string; sessionId: string; parentSessionId: string; depth: number;
  title: string; artifact: string; installedPath?: string; metadataArtifact?: string;
  nativeMetadataRegistered?: boolean;
}
export function planChildren(s: Session, target: "claude" | "codex", rootId: string): NativeChild[] {
  const contexts = (s.context ?? []).filter(c => c.kind === "subagent" && c.messages?.length);
  const plans = contexts.map((c, index) => ({ sourceId: c.sourceId && c.sourceId !== s.sourceId ? c.sourceId : c.sourcePath?.match(/(?:^|[\\/])agent-([^\\/]+)\.jsonl$/)?.[1] ?? `legacy-${index}`, sessionId: target === "claude" ? randomUUID().replaceAll("-", "").slice(0, 16) : randomUUID(), parentSessionId: rootId, depth: 1, title: c.label, artifact: `children/${index}.jsonl`, ...(target === "claude" ? { metadataArtifact: `children/${index}.meta.json` } : {}) }));
  const bySource = new Map(plans.map(p => [p.sourceId, p]));
  if (bySource.size !== plans.length) throw new BridgeError("INVALID_SUBAGENTS", "Subagent identities are not unique.");
  const visiting = new Set<string>(), done = new Set<string>();
  function resolve(index: number) {
    const p = plans[index]; if (done.has(p.sourceId)) return;
    if (visiting.has(p.sourceId)) throw new BridgeError("INVALID_SUBAGENTS", "Subagent ancestry contains a cycle.");
    visiting.add(p.sourceId);
    const parent = bySource.get(contexts[index].parentSourceId ?? "");
    if (parent) { resolve(plans.indexOf(parent)); p.parentSessionId = parent.sessionId; p.depth = parent.depth + 1; }
    else if (contexts[index].parentSourceId && contexts[index].parentSourceId !== s.sourceId) throw new BridgeError("INVALID_SUBAGENTS", "A subagent refers to an unavailable parent.");
    visiting.delete(p.sourceId); done.add(p.sourceId);
  }
  plans.forEach((_, i) => resolve(i)); return plans;
}
export function claudeChildPath(rootPath: string, rootId: string, agentId: string) {
  return join(rootPath, "..", rootId, "subagents", `agent-${agentId}.jsonl`);
}
export function renderFamily(s: Session, target: "claude" | "codex", id: string, cwd: string, stamp: string, plans: NativeChild[], resume?: Session): Record<string, Uint8Array> {
  const contexts = (s.context ?? []).filter(c => c.kind === "subagent" && c.messages?.length);
  const codexRole = (c: Context) => c.agentRole === "explorer" || c.agentRole === "Explore" ? "explorer" : c.agentRole === "worker" ? "worker" : "default";
  const claudeRole = (c: Context) => c.agentRole === "explorer" || c.agentRole === "Explore" ? "Explore" : "general-purpose";
  const notificationAgents = new Map<string, NotificationAgent>();
  contexts.forEach((c, i) => {
    const agent = { sessionId: plans[i].sessionId, nickname: c.agentNickname ?? c.label.slice(0, 80), role: codexRole(c) };
    notificationAgents.set(plans[i].sourceId, agent);
    for (const alias of c.sourceAliases ?? []) notificationAgents.set(alias, agent);
    if (c.spawnCallId) notificationAgents.set(c.spawnCallId, agent);
  });
  const references = contexts.map((c, i) => ({ ...c, messages: undefined, text: `Native child session ${plans[i].sessionId} (historical import).\nLast recorded assistant response:\n${c.messages?.findLast(m => m.role === "assistant")?.blocks.filter(b => b.kind !== "reasoning").map(b => b.text).join("\n") ?? "No assistant response recorded."}` }));
  const parent = { ...s, context: [...(s.context ?? []).filter(c => c.kind !== "subagent"), ...references] };
  const artifacts: Record<string, Uint8Array> = {};
  const encode = (rows: Row[]) => Buffer.from(rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  function links(rows: Row[], ownerId: string) {
    const direct = plans.filter(p => p.parentSessionId === ownerId);
    if (!direct.length) return rows;
    if (target === "codex") {
      const events: Row[] = [];
      for (const p of direct) {
        const c = contexts[plans.indexOf(p)], callId = randomUUID();
        const common = { call_id: callId, sender_thread_id: ownerId, prompt: c.label, model: c.metadata?.models[0] ?? "baton-import", reasoning_effort: "medium" };
        events.push({ timestamp: stamp, type: "event_msg", payload: { type: "collab_agent_spawn_begin", ...common } },
          { timestamp: stamp, type: "event_msg", payload: { type: "collab_agent_spawn_end", ...common, new_thread_id: p.sessionId, new_agent_nickname: c.agentNickname ?? c.label.slice(0, 80), new_agent_role: codexRole(c), status: "interrupted" } },
          { timestamp: stamp, type: "event_msg", session_bridge: { version: 1, message: { generated: true } }, payload: { type: "item_completed", thread_id: ownerId, turn_id: row(rows.find(r => row(r.payload).type === "task_started")?.payload).turn_id, completed_at_ms: Date.parse(stamp), item: { type: "CollabAgentToolCall", id: callId, tool: "spawn_agent", status: "completed", sender_thread_id: ownerId, receiver_thread_ids: [p.sessionId], receiver_agents: [{ thread_id: p.sessionId, agent_nickname: c.agentNickname ?? c.label.slice(0, 80), agent_role: codexRole(c) }], prompt: c.label, model: common.model, reasoning_effort: "medium", agents_states: { [p.sessionId]: "interrupted" } } } });
      }
      const insertion = rows.findIndex(r => row(r.payload).type === "task_started") + 1;
      rows.splice(insertion, 0, ...events);
      return rows.map((r, ordinal) => ({ ...r, ordinal }));
    }
    // Completed historical Agent call/result pairs expose native agent transcript links.
    const first = rows[0], aId = randomUUID(), uId = randomUUID();
    const calls = direct.map(p => ({ type: "tool_use", id: `toolu_${p.sessionId}`, name: "Agent", input: { description: p.title, prompt: p.title, subagent_type: claudeRole(contexts[plans.indexOf(p)]) } }));
    const results = direct.map(p => ({ type: "tool_result", tool_use_id: `toolu_${p.sessionId}`, content: `Historical imported agent transcript. agentId: ${p.sessionId}. No task was started by this import.` }));
    const common = { sessionId: id, cwd, timestamp: stamp, isSidechain: ownerId !== id, ...(ownerId !== id ? { agentId: ownerId } : {}) };
    const generated = { version: 1, message: { generated: true } };
    const added = [{ ...common, type: "assistant", uuid: aId, parentUuid: first.uuid, message: { role: "assistant", id: `msg_${aId}`, type: "message", model: "baton", content: calls, stop_reason: "tool_use", usage: { input_tokens: 0, output_tokens: 0 } }, session_bridge: generated },
      { ...common, type: "user", uuid: uId, parentUuid: aId, message: { role: "user", content: results }, session_bridge: generated }];
    if (rows[1]?.parentUuid === first.uuid) rows[1].parentUuid = uId;
    rows.splice(1, 0, ...added); return rows;
  }
  const parentRows: Row[] = links(native(parent, target, id, cwd, stamp, notificationAgents), id);
  if (target === 'codex' && resume) {
    const replacement = native(resume, target, id, cwd, stamp, notificationAgents).filter(r => r.type === 'response_item').map(r => r.payload);
    if (Buffer.byteLength(JSON.stringify(replacement)) > 400_000) throw new BridgeError('RESUME_CONTEXT_TOO_LARGE', 'Latest source compaction still exceeds the conservative resume budget.', 'Compact the source session again before transferring. Full history has not been truncated.');
    parentRows.push({ ordinal: parentRows.length, timestamp: stamp, type: 'compacted', session_bridge: { version: 1, message: { generated: true } }, payload: { message: 'Baton resumed from the latest recorded source compaction; full visible history remains available.', replacement_history: replacement } });
  }
  artifacts[`${target}.jsonl`] = encode(parentRows);
  for (const [index, p] of plans.entries()) {
    const c = contexts[index];
    const child: Session = { format: s.format, source: s.source, sourceId: c.sourceId, title: c.label, cwd, messages: c.messages!, warnings: [], metadata: c.metadata };
    const rows = native(child, target, target === "claude" ? id : p.sessionId, cwd, stamp, notificationAgents);
    if (target === "codex") {
      Object.assign(row(rows[0].payload), { session_id: id, parent_thread_id: p.parentSessionId, agent_nickname: c.agentNickname ?? c.label.slice(0, 80), agent_role: codexRole(c), source: { subagent: { thread_spawn: { parent_thread_id: p.parentSessionId, depth: p.depth, agent_nickname: c.agentNickname ?? c.label.slice(0, 80), agent_role: codexRole(c) } } } });
    } else {
      for (const r of rows) if (r.message) Object.assign(r, { isSidechain: true, agentId: p.sessionId });
      artifacts[p.metadataArtifact!] = Buffer.from(JSON.stringify({ agentType: claudeRole(c), description: c.label, toolUseId: `toolu_${p.sessionId}`, spawnDepth: p.depth, parentAgentId: p.parentSessionId === id ? undefined : p.parentSessionId, requestShape: "background", requestNonInteractive: true }) + "\n");
    }
    artifacts[p.artifact] = encode(links(rows, p.sessionId));
  }
  return artifacts;
}
