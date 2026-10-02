import type { Session, Row } from "../src/model.ts";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/claude.jsonl", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const pdfData = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF").toString("base64");
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
async function mediaFixture(dir: string) {
  const rows = (await readFile(fixture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  await writeFile(join(dir, "pixel.png"), Buffer.from(imageData, "base64"));
  rows[0].message.content = [{ type: "text", text: rows[0].message.content }, { type: "image", source: { type: "file", path: join(dir, "pixel.png") } }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfData } }];
  const subdir = join(dir, "media", "subagents"); await mkdir(subdir, { recursive: true });
  const children = [
    { type: "user", uuid: "child-u", parentUuid: null, sessionId: rows[0].sessionId, agentId: "source-worker", isSidechain: true, message: { role: "user", content: "Audit integer cents." } },
    { type: "assistant", uuid: "child-a", parentUuid: "child-u", sessionId: rows[0].sessionId, agentId: "source-worker", isSidechain: true, message: { role: "assistant", content: "Child confirmed cents are integers." } }
  ];
  await writeFile(join(subdir, "agent-source-worker.jsonl"), children.map(r => JSON.stringify(r)).join("\n") + "\n");
  await writeFile(join(subdir, "agent-source-worker.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Audit worker", toolUseId: "original-spawn" }));
  const nestedDir = join(subdir, "agent-source-worker", "subagents"); await mkdir(nestedDir, { recursive: true });
  const nested = children.map(r => ({ ...r, agentId: "nested-worker", message: { ...r.message, content: r.type === "user" ? "Inspect cents bounds." : "Nested audit checked cents bounds." } }));
  await writeFile(join(nestedDir, "agent-nested-worker.jsonl"), nested.map(r => JSON.stringify(r)).join("\n") + "\n");
  const path = join(dir, "media.jsonl"); await writeFile(path, rows.map(r => JSON.stringify(r)).join("\n") + "\n"); return path;
}
// This is the native storage contract, not a mocked model response. Never starts a turn.
test("installed Codex app-server hydrates imported user, assistant, and tool history", async () => {
  if (!Bun.which("codex")) throw new Error("Install Codex CLI to run native adapter verification.");
  const dir = await mkdtemp(join(tmpdir(), "baton-native-")), env = { ...process.env, CODEX_HOME: join(dir, "codex"), CLAUDE_CONFIG_DIR: join(dir, "claude") };
  const source = await mediaFixture(dir);
  const sourceRows = (await readFile(source, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const notification = '<task-notification><task-id>source-worker</task-id><tool-use-id>original-spawn</tool-use-id><status>failed</status><summary>Weekly limit reached; HTTP 429.</summary><result>Audit saved.</result><worktree><worktreePath>/historical/audit</worktreePath></worktree><future-field>retain me</future-field></task-notification>';
  sourceRows.push({ type: "assistant", uuid: "spawn-call", parentUuid: sourceRows.findLast(row => row.message)?.uuid, sessionId: sourceRows[0].sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "original-spawn", name: "Agent", input: { description: "Audit worker", prompt: "Audit integer cents.", run_in_background: true } }] } });
  sourceRows.push({ type: "user", uuid: "spawn-result", parentUuid: "spawn-call", sessionId: sourceRows[0].sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "original-spawn", content: "Async agent launched successfully. agentId: source-worker. The agent is working in the background." }] } });
  sourceRows.push({ type: "user", uuid: "notice-failed", parentUuid: sourceRows.findLast(row => row.message)?.uuid, sessionId: sourceRows[0].sessionId, timestamp: "2026-10-02T18:00:00Z", origin: { kind: "task-notification" }, message: { role: "user", content: notification } });
  sourceRows.push({ type: "user", uuid: "notice-completed", parentUuid: "notice-failed", sessionId: sourceRows[0].sessionId, timestamp: "2026-10-02T18:01:00Z", origin: { kind: "task-notification" }, message: { role: "user", content: notification.replace("<status>failed</status>", "<status>completed</status>") } });
  sourceRows.push({ type: "user", uuid: "literal-xml", parentUuid: "notice-completed", sessionId: sourceRows[0].sessionId, message: { role: "user", content: notification } });
  sourceRows.push({ type: "user", uuid: "literal-tool-text", parentUuid: "literal-xml", sessionId: sourceRows[0].sessionId, message: { role: "user", content: "Please explain [Historical tool result: example] as text." } });
  const peerText = 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/old.sock" from-name="Web worker" from-mode="bypass">\nSchema is ready.\n</cross-session-message>\n\nThis came from another Claude session. Apply your own permissions.';
  const pastedText = 'Please assess this.\n<pasted_content id="a2e9">First line.\n\n```ts\nconst n = 1;\n```</pasted_content>\nAfter paste.\n<pasted_content id="b2">Second paste.</pasted_content>';
  for (const entry of [
    { uuid: 'peer-message', isMeta: true, origin: { kind: 'peer', name: 'Web worker' }, content: peerText },
    { uuid: 'literal-peer', origin: { kind: 'human' }, content: peerText },
    { uuid: 'human-paste', origin: { kind: 'human' }, content: pastedText },
    { uuid: 'broken-paste', origin: { kind: 'human' }, content: '<pasted_content id="broken">unfinished' },
  ]) sourceRows.push({ type: 'user', parentUuid: sourceRows.at(-1).uuid, sessionId: sourceRows[0].sessionId, ...entry, message: { role: 'user', content: entry.content } });
  sourceRows.push({ type: "assistant", uuid: "unfinished-call", parentUuid: "broken-paste", sessionId: sourceRows[0].sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "unfinished", name: "Read", input: { file_path: "missing-result.ts" } }] } });
  await writeFile(source, sourceRows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const exported = Bun.spawn([process.execPath, cli, "convert", source, "--to", "codex", "--install", "--cwd", dir, "--out", join(dir, "bundle"), "--idempotency-key", "native-family", "--json"], { env, stdout: "pipe", stderr: "pipe" });
  const m = await new Response(exported.stdout).json() as { sessionId: string; installedPath: string; subagents: { sessionId: string; installedPath: string }[] };
  expect(await exported.exited).toBe(0);
  const proc = Bun.spawn(["codex", "app-server", "--stdio"], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let buffer = "";
  const pump = (async () => {
    for await (const chunk of proc.stdout) {
      buffer += Buffer.from(chunk).toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const data = JSON.parse(line), p = pending.get(data.id);
        if (p) { pending.delete(data.id); if (data.error) p.reject(new Error(JSON.stringify(data.error))); else p.resolve(data.result); }
      }
    }
  })();
  let seq = 0;
  async function rpc(method: string, params: unknown): Promise<unknown> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15_000);
      pending.set(id, { resolve: v => { clearTimeout(timeout); resolve(v); }, reject: e => { clearTimeout(timeout); reject(e); } });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n"); proc.stdin.flush();
    });
  }
  try {
    await rpc("initialize", { clientInfo: { name: "baton-verification", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    proc.stdin.write('{"method":"initialized"}\n'); proc.stdin.flush();
    const resume = await rpc("thread/resume", { threadId: m.sessionId, path: m.installedPath, cwd: dir });
    const read = await rpc("thread/read", { threadId: m.sessionId, includeTurns: true });
    const turns = await rpc("thread/turns/list", { threadId: m.sessionId, itemsView: "full" });
    const native = resume as { approvalPolicy: string; sandbox: { type: string }; thread: { name: string; gitInfo: { branch: string } } };
    expect(native.thread.name).toBe("Invoice export");
    expect(native.thread.gitInfo.branch).toBe("feature/invoice");
    expect(native.approvalPolicy).not.toBe("never");
    expect(native.sandbox.type).not.toBe("dangerFullAccess");
    const itemPage = await rpc("thread/items/list", { threadId: m.sessionId, limit: 100 }) as { data: { item: { type: string; receiverThreadIds?: string[] } }[] };
    const hydrated = JSON.stringify([resume, read, turns, itemPage]);
    expect(hydrated).toContain("Build invoice export. Use integer cents.");
    expect(hydrated).toContain("amount_cents: number");
    expect(hydrated).toContain("Next implement CSV export, preserving cents.");
    expect(hydrated).toContain(`data:image/png;base64,${imageData}`);
    expect(hydrated).not.toContain("private scratchpad");
    expect(m.subagents).toHaveLength(2);
    const child = await rpc("thread/read", { threadId: m.subagents[0].sessionId, includeTurns: true }) as { thread: { parentThreadId: string; agentRole: string; agentNickname: string } };
    expect(child.thread.parentThreadId).toBe(m.sessionId);
    expect(child.thread.agentRole).toBe("default");
    expect(child.thread.agentNickname).toBe("Audit worker");
    const childItems = await rpc("thread/items/list", { threadId: m.subagents[0].sessionId, limit: 100 });
    expect(JSON.stringify(childItems)).toContain("Child confirmed cents are integers.");
    expect(hydrated).toContain(m.subagents[0].sessionId);
    const parentItems = itemPage.data.map(entry => entry.item);
    expect(parentItems.some(item => JSON.stringify(item).includes('Conversation transferred from'))).toBe(false);
    expect(parentItems.some(item => JSON.stringify(item).includes('[Workspace check]'))).toBe(false);

    expect(parentItems.some(item => item.type === "collabAgentToolCall" && item.receiverThreadIds?.includes(m.subagents[0].sessionId))).toBe(true);
    const toolItems = parentItems.filter(item => item.type === "dynamicToolCall") as unknown as { tool: string; arguments: unknown; contentItems: { text: string }[]; status: string }[];
    expect(toolItems.find(item => item.tool === "Read")?.arguments).toEqual({ file_path: "invoice.ts" });
    expect(toolItems.find(item => item.tool === "Read")?.contentItems[0].text).toBe("amount_cents: number");
    expect(toolItems.find(item => item.tool === "Agent")?.contentItems[0].text).toContain("Async agent launched successfully.");
    expect(toolItems.find(item => JSON.stringify(item.arguments).includes("missing-result.ts"))?.status).toBe("failed");
    expect(parentItems.filter(item => item.type === "userMessage" && JSON.stringify(item).includes("Historical tool result"))).toHaveLength(1);
    const taskEvents = parentItems.filter(item => item.type === "collabAgentToolCall" && JSON.stringify(item).includes("Weekly limit reached"));
    expect(taskEvents).toHaveLength(2);
    expect(JSON.stringify(taskEvents[0])).toContain("errored");
    expect(JSON.stringify(taskEvents[1])).toContain("Audit saved.");
    expect(parentItems.filter(item => item.type === "userMessage" && JSON.stringify(item).includes("<task-notification>"))).toHaveLength(1);
    const visibleText = (type: string) => parentItems.filter(i => i.type === type).map(i => JSON.stringify(i)).join('\n');
    expect(visibleText('agentMessage')).toContain('[Historical Claude peer message from Web worker]');
    expect(visibleText('agentMessage')).toContain('Schema is ready.');
    expect(visibleText('agentMessage')).not.toContain('<cross-session-message');
    expect(parentItems.filter(i => i.type === 'userMessage' && JSON.stringify(i).includes('<cross-session-message'))).toHaveLength(1);
    expect(visibleText('userMessage')).toContain('> First line.');
    expect(visibleText('userMessage')).toContain('> Second paste.');
    expect(visibleText('userMessage')).toContain('After paste.');
    expect(visibleText('userMessage')).not.toContain('id=\\"a2e9');
    expect(visibleText('userMessage')).toContain('<pasted_content id=\\"broken');
    const nested = await rpc("thread/read", { threadId: m.subagents[1].sessionId, includeTurns: true }) as { thread: { parentThreadId: string } };
    expect(nested.thread.parentThreadId).toBe(m.subagents[0].sessionId);
    expect(JSON.stringify(await rpc("thread/items/list", { threadId: m.subagents[1].sessionId, limit: 100 }))).toContain("Nested audit checked cents bounds.");
    const listed = await rpc("thread/list", { parentThreadId: m.sessionId, sourceKinds: ["subAgentThreadSpawn"] });
    expect(JSON.stringify(listed)).toContain(m.subagents[0].sessionId);
    const canonicalSource = join(dir, "canonical-codex.jsonl");
    const canonicalRows = (await readFile(m.installedPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(r => !["collab_agent_spawn_begin", "collab_agent_spawn_end"].includes(r.payload?.type));
    await writeFile(canonicalSource, canonicalRows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const roundtrip = Bun.spawn([process.execPath, cli, "convert", canonicalSource, "--to", "claude", "--install", "--cwd", dir, "--out", join(dir, "roundtrip"), "--json"], { env, stdout: "pipe", stderr: "pipe" });
    const family = await new Response(roundtrip.stdout).json() as { sessionId: string; subagents: { sessionId: string }[] };
    expect(await roundtrip.exited).toBe(0);
    expect(family.subagents).toHaveLength(2);
    const restored = JSON.parse(await readFile(join(dir, "roundtrip", "session.json"), "utf8"));
    expect(restored.messages.find((message: { id: string }) => message.id === "notice-failed").blocks[0].text).toBe(notification);
    expect(restored.messages.find((m: { id: string }) => m.id === 'peer-message').blocks[0].text).toBe(peerText);
    expect(restored.messages.find((m: { id: string }) => m.id === 'peer-message').role).toBe('user');
    expect(restored.messages.find((m: { id: string }) => m.id === 'human-paste').blocks[0].text).toBe(pastedText);
    const sdkUrl = new URL("../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", import.meta.url).href;
    const check = Bun.spawn([process.execPath, "--eval", `import{listSubagents,getSubagentMessages,getSessionMessages}from ${JSON.stringify(sdkUrl)};const ids=await listSubagents(${JSON.stringify(family.sessionId)},{dir:${JSON.stringify(dir)}});console.log(JSON.stringify({history:await getSessionMessages(${JSON.stringify(family.sessionId)},{dir:${JSON.stringify(dir)}}),ids,messages:await Promise.all(ids.map(id=>getSubagentMessages(${JSON.stringify(family.sessionId)},id,{dir:${JSON.stringify(dir)}})))}));`], { env, stdout: "pipe", stderr: "pipe" });
    const cc = await new Response(check.stdout).json();
    expect(await check.exited).toBe(0);
    expect(JSON.stringify(cc.history)).toContain('[Historical Claude peer message from Web worker]');
    expect(JSON.stringify(cc.history)).toContain('> First line.');
    expect(cc.ids.sort()).toEqual(family.subagents.map(c => c.sessionId).sort());
    expect(JSON.stringify(cc.messages)).toContain("Child confirmed cents are integers.");
    await writeFile(join(dir, "media", "subagents", "agent-source-worker.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Changed child metadata" }));
    const retry = Bun.spawn([process.execPath, cli, "convert", source, "--to", "codex", "--install", "--cwd", dir, "--out", join(dir, "bundle"), "--idempotency-key", "native-family", "--json"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await retry.exited).toBe(2);
    expect(await new Response(retry.stderr).text()).toContain("IDEMPOTENCY_CONFLICT");
    // A changed child must block undo of the entire family before removing its parent.
    await writeFile(m.subagents[0].installedPath, "\n", { flag: "a" });
    const undo = Bun.spawn([process.execPath, cli, "undo", join(dir, "bundle"), "--json"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await undo.exited).toBe(2);
    expect(await new Response(undo.stderr).text()).toContain("SESSION_CHANGED");
    expect((await readFile(m.installedPath, "utf8")).length).toBeGreaterThan(0);
  } finally { proc.kill(); await proc.exited; await pump; await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("Claude Agent SDK lists the installed transcript and loads its complete parent chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baton-claude-"));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude-home"), CODEX_HOME: join(dir, "codex-home") };
  try {
    const source = await mediaFixture(dir);
    const proc = Bun.spawn([process.execPath, cli, "convert", source, "--to", "claude", "--install", "--cwd", dir, "--out", join(dir, "bundle"), "--json"], { env, stdout: "pipe", stderr: "pipe" });
    const manifest = await new Response(proc.stdout).json() as { sessionId: string; installedPath: string; subagents: { installedPath: string }[] };
    expect(await proc.exited).toBe(0);
    const check = `import {listSessions,getSessionMessages} from '@anthropic-ai/claude-agent-sdk';
const id=${JSON.stringify(manifest.sessionId)}, dir=${JSON.stringify(dir)};
const sessions=await listSessions({dir}); const info=sessions.find(s=>s.sessionId===id); const messages=await getSessionMessages(id,{dir});
console.log(JSON.stringify({found:sessions.some(s=>s.sessionId===id),title:info?.customTitle,tag:info?.tag,branch:info?.gitBranch,messages:messages.length,
user:JSON.stringify(messages).includes('Use integer cents.'),tool:JSON.stringify(messages).includes('amount_cents: number'),
pdf:messages.some(m=>Array.isArray(m.message.content)&&m.message.content.some(b=>b.type==='document'&&b.source?.media_type==='application/pdf')),
image:messages.some(m=>Array.isArray(m.message.content)&&m.message.content.some(b=>b.type==='image'&&b.source?.media_type==='image/png')),
last:JSON.stringify(messages).includes('CSV export, preserving cents.'),transferBubble:JSON.stringify(messages).includes('Conversation transferred from'),private:JSON.stringify(messages).includes('private scratchpad')}));`;
    const validation = Bun.spawn([process.execPath, "--eval", check], { env, cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
    const result = await new Response(validation.stdout).json();
    expect(await validation.exited).toBe(0);
    expect(result).toEqual({ found: true, title: "Invoice export", tag: "finance", branch: "feature/invoice", messages: 6, pdf: true, image: true, user: true, tool: true, last: true, transferBubble: false, private: false });
    const undo = Bun.spawn([process.execPath, cli, "undo", join(dir, "bundle"), "--json"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await undo.exited).toBe(0);
    for (const path of [manifest.installedPath, ...manifest.subagents.map(c => c.installedPath)]) expect(await access(path).then(() => true, () => false)).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test('event-only Codex history becomes balanced native Claude tools and round-trips without mirrored duplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-events-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex') };
  const meta = { type: 'session_meta', payload: { id: 'cccccccc-0000-4000-8000-000000000001', cwd: dir } };
  const event = (id: string, item: object, second: number, type = 'item_completed') => ({ timestamp: `2026-10-02T10:00:${String(second).padStart(2, '0')}Z`, type: 'event_msg', payload: { type, turn_id: 'turn', item: { id, ...item } } });
  try {
    const source = join(dir, 'events.jsonl');
    const rows: Row[] = [meta,
      event('u1', { type: 'UserMessage', content: [{ type: 'text', text: 'Repeat this request.' }] }, 1),
      event('u2', { type: 'UserMessage', content: [{ type: 'text', text: 'Repeat this request.' }] }, 2),
      event('tool', { type: 'DynamicToolCall', tool: 'lookup', arguments: { key: 'invoice' }, status: 'in_progress' }, 3, 'item_started'),
      event('tool', { type: 'DynamicToolCall', tool: 'lookup', arguments: { key: 'invoice' }, status: 'completed', success: true, content_items: [{ type: 'inputText', text: 'Invoice found.' }, { type: 'inputImage', imageUrl: `data:image/png;base64,${imageData}` }] }, 4),
      { timestamp: '2026-10-02T10:00:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'orphan', output: 'Orphan evidence.' } },
      event('pending', { type: 'DynamicToolCall', tool: 'unfinished', arguments: {}, status: 'in_progress' }, 6, 'item_started'),
      event('mcp', { type: 'McpToolCall', server: 'example.invalid', tool: 'lookup', arguments: { key: 'receipt' }, status: 'failed', result: { content: [{ type: 'text', text: 'MCP failure evidence.' }], isError: true } }, 7),
      event('command', { type: 'CommandExecution', command: ['bun', 'test'], cwd: dir, status: 'failed', stdout: 'Command failure evidence.', exit_code: 1 }, 7),
      event('patch', { type: 'FileChange', changes: { 'invoice.ts': { diff: '+amount_cents' } }, status: 'completed' }, 7),
      event('thought', { type: 'Reasoning', content: ['private scratchpad'] }, 8),
      event('answer', { type: 'AgentMessage', content: [{ type: 'Text', text: 'Continue CSV export.' }] }, 9),
      { timestamp: '2026-10-02T10:00:09Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Continue CSV export.' } }
    ];
    const invoke = async (args: string[]) => {
      const proc = Bun.spawn([process.execPath, cli, ...args, '--json'], { env, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(exit).toBe(0); return JSON.parse(stdout || stderr);
    };
    await writeFile(source, rows.filter(r => r.type !== 'response_item').map(r => JSON.stringify(r)).join('\n') + '\n');
    const pure = join(dir, 'pure'); await invoke(['convert', source, '--to', 'portable', '--out', pure]);
    const pureSession = JSON.parse(await readFile(join(pure, 'session.json'), 'utf8')) as Session;
    expect(pureSession.messages.flatMap(m => m.blocks).filter(b => b.text === 'Repeat this request.').length).toBe(2);
    await writeFile(source, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const bundle = join(dir, 'claude-bundle');
    const manifest = await invoke(['convert', source, '--to', 'claude', '--install', '--cwd', dir, '--out', bundle]);
    const original = JSON.parse(await readFile(join(bundle, 'session.json'), 'utf8')) as Session;
    expect(original.messages.filter(m => m.blocks.some(b => b.text === 'Repeat this request.')).length).toBe(2);
    expect(original.messages.filter(m => m.blocks.some(b => b.text === 'Continue CSV export.')).length).toBe(1);
    expect(original.messages.flatMap(m => m.blocks).filter(b => b.kind === 'tool_call').length).toBe(4);
    expect(manifest.warnings.join(' ')).toContain('FileChange');
    const check = `import {getSessionMessages} from '@anthropic-ai/claude-agent-sdk';
const messages=await getSessionMessages(${JSON.stringify(manifest.sessionId)},{dir:${JSON.stringify(dir)}});
console.log(JSON.stringify(messages.flatMap(m=>Array.isArray(m.message.content)?m.message.content:[])));`;
    const sdk = Bun.spawn([process.execPath, '--eval', check], { env, cwd: fileURLToPath(new URL('..', import.meta.url)), stdout: 'pipe', stderr: 'pipe' });
    const blocks = await new Response(sdk.stdout).json() as { type: string; id: string; tool_use_id: string; name: string; input: unknown; content: string; is_error?: boolean }[]; expect(await sdk.exited).toBe(0);
    const calls = blocks.filter(b => b.type === 'tool_use'), results = blocks.filter(b => b.type === 'tool_result');
    expect(calls.length).toBe(5); expect(results.length).toBe(5);
    expect(calls.every(b => /^[a-zA-Z0-9_-]{1,128}$/.test(b.name))).toBe(true);
    expect(new Set(calls.map(b => b.id))).toEqual(new Set(results.map(b => b.tool_use_id)));
    expect(calls.find(b => b.name === 'lookup')!.input).toEqual({ key: 'invoice' });
    expect(results.some(b => b.content.includes('Invoice found.'))).toBe(true);
    expect(results.some(b => b.is_error && b.content === 'MCP failure evidence.')).toBe(true);
    expect(results.some(b => b.is_error && b.content === 'Command failure evidence.')).toBe(true);
    expect(blocks.some(b => b.type === 'image')).toBe(true);
    expect(results.some(b => b.content === 'Orphan evidence.')).toBe(true);
    expect(results.some(b => b.is_error && b.content.includes('imported inactive'))).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain('private scratchpad');
    const inverse = join(dir, 'inverse');
    await invoke(['convert', manifest.installedPath, '--to', 'portable', '--out', inverse]);
    const roundtrip = JSON.parse(await readFile(join(inverse, 'session.json'), 'utf8')) as Session;
    // Asset bytes and metadata survive; each bundle owns a fresh local path.
    for (const m of roundtrip.messages) for (const b of m.blocks) if (b.kind === 'media' && b.asset?.path) {
      expect((await readFile(b.asset.path)).equals(Buffer.from(imageData, 'base64'))).toBe(true);
      b.asset.path = b.asset.path.replace(inverse, bundle); b.text = b.text.replace(inverse, bundle);
    }
    expect(roundtrip.messages).toEqual(original.messages);
    // Mixed formats represent the same user/tool evidence only once.
    const mixed = [...rows];
    mixed.splice(1, 0, { timestamp: '2026-10-02T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Repeat this request.' }] } });
    mixed.push({ timestamp: '2026-10-02T10:00:03Z', type: 'response_item', payload: { type: 'function_call', call_id: 'tool', name: 'lookup', arguments: '{"key":"invoice"}' } }, { timestamp: '2026-10-02T10:00:04Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool', output: [{ type: 'input_text', text: 'Invoice found.' }, { type: 'input_image', image_url: `data:image/png;base64,${imageData}` }] } });
    await writeFile(source, mixed.map(r => JSON.stringify(r)).join('\n') + '\n');
    const mixedOut = join(dir, 'mixed'); await invoke(['convert', source, '--to', 'portable', '--out', mixedOut]);
    const mixedSession = JSON.parse(await readFile(join(mixedOut, 'session.json'), 'utf8')) as Session;
    expect(mixedSession.messages.flatMap(m => m.blocks).filter(b => b.kind === 'tool_call').length).toBe(4);
    expect(mixedSession.messages.flatMap(m => m.blocks).filter(b => b.text === 'Repeat this request.').length).toBe(2);
    expect(mixedSession.messages.flatMap(m => m.blocks).filter(b => b.kind === 'media').length).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
