import { test, expect, afterEach } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, stat, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const temps: string[] = [];
afterEach(async () => { for (const path of temps.splice(0)) await rm(path, { recursive: true, force: true }); });
async function sandbox() { const path = await mkdtemp(join(tmpdir(), "baton-test-")); temps.push(path); return path; }
async function run(args: string[], dir: string) {
  const proc = Bun.spawn([process.execPath, cli, ...args, "--json"], { cwd: dir,
    env: { ...process.env, CODEX_HOME: join(dir, "codex-home"), CLAUDE_CONFIG_DIR: join(dir, "claude-home") }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exit, value: JSON.parse(stdout || stderr) };
}

test("Claude active branch transfers latest UUID revision, tool evidence, and user constraints without private reasoning", async () => {
  const dir = await sandbox(), out = join(dir, "bundle");
  const source = await readFile(fixture("claude.jsonl"));
  const result = await run(["convert", fixture("claude.jsonl"), "--to", "codex", "--out", out], dir);
  expect(result.exit).toBe(0); expect(result.value.messages).toBe(4);
  const native = await readFile(join(out, "codex.jsonl"), "utf8");
  expect(native).toContain("Use integer cents."); expect(native).toContain("amount_cents: number");
  expect(native).toContain("CSV export, preserving cents.");
  expect(native).not.toContain("private scratchpad"); expect(native).not.toContain("Discard this alternate branch");
  expect(native).not.toContain('"type":"function_call"');
  expect(await readFile(join(out, "source-original.jsonl"))).toEqual(source);
  expect((await readFile(fixture("claude.jsonl"))).equals(source)).toBe(true);
  expect((await stat(out)).mode & 0o777).toBe(0o700); expect((await stat(join(out, "session.json"))).mode & 0o777).toBe(0o600);
  expect(result.value.warnings.join(" ")).toContain("private reasoning");
  expect(result.value.warnings.join(" ")).toContain("outside the active Claude branch");
});

test("Codex Desktop history imports to Claude without duplicate event mirrors or replacement history", async () => {
  const dir = await sandbox(), out = join(dir, "bundle");
  const result = await run(["convert", fixture("codex.jsonl"), "--to", "claude", "--out", out, "--install", "--cwd", dir], dir);
  expect(result.exit).toBe(0);
  const native = await readFile(result.value.installedPath, "utf8"), rows = native.trim().split("\n").map(line => JSON.parse(line)).filter(r => r.message);
  expect(rows.filter(r => JSON.stringify(r.message).includes("Fix invoice rounding.")).length).toBe(1);
  expect(native).not.toContain("Do not duplicate replacement history"); expect(native).toContain("amount_cents = 1200");
  expect(native).toContain("Remaining task: fix CSV export.");
  expect(rows.every((r, i) => r.parentUuid === (i ? rows[i - 1].uuid : null))).toBe(true);
  expect(rows.every(r => r.sessionId === result.value.sessionId)).toBe(true);
  expect(result.value.resumeArgv).toEqual(["claude", "--resume", result.value.sessionId]);
  const undo = await run(["undo", out], dir); expect(undo.value.removed).toBe(true);
  expect((await run(["verify", out], dir)).value.ok).toBe(true);
});

test("ChatGPT current branch maps both ways through portable JSON, with alternate branches archived", async () => {
  const dir = await sandbox(), portable = join(dir, "portable"), out = join(dir, "claude");
  expect((await run(["convert", fixture("chatgpt.json"), "--to", "portable", "--out", portable], dir)).exit).toBe(0);
  expect((await run(["convert", join(portable, "session.json"), "--to", "claude", "--out", out], dir)).exit).toBe(0);
  const native = await readFile(join(out, "claude.jsonl"), "utf8");
  expect(native).toContain("Export invoices as CSV."); expect(native).toContain("Use integer cents in the CSV."); expect(native).not.toContain("Old branch should not transfer.");
  const markdownOut = join(dir, "handoff");
  const result = await run(["convert", fixture("claude.jsonl"), "--to", "chatgpt", "--out", markdownOut], dir);
  expect(result.value.nextStep).toContain("Upload conversation.md"); expect(result.value.warnings.join(" ")).toContain("unsupported");
  expect(await readFile(join(markdownOut, "conversation.md"), "utf8")).toContain("amount_cents: number");
});

test("dry run makes no files, overwrite fails, and undo refuses a resumed session", async () => {
  const dir = await sandbox(), out = join(dir, "bundle");
  const args = ["convert", fixture("claude.jsonl"), "--to", "codex", "--out", out, "--install", "--cwd", dir];
  expect((await run([...args, "--dry-run"], dir)).value.dryRun).toBe(true);
  expect(await readdir(dir)).toEqual([]);
  const result = await run(args, dir); expect(result.exit).toBe(0);
  expect((await run(args, dir)).value.code).toBe("OUTPUT_EXISTS");
  await writeFile(result.value.installedPath, "\nresumed", { flag: "a" });
  expect((await run(["undo", out], dir)).value.code).toBe("SESSION_CHANGED");
  expect(await readFile(result.value.installedPath, "utf8")).toContain("resumed");
});

test("integrity verification detects damage and machine-readable failures use stable exit codes", async () => {
  const dir = await sandbox(), out = join(dir, "bundle");
  expect((await run(["convert", fixture("claude.jsonl"), "--to", "portable", "--out", out], dir)).exit).toBe(0);
  await writeFile(join(out, "conversation.md"), "damaged");
  const verify = await run(["verify", out], dir); expect(verify.exit).toBe(3); expect(verify.value.checks["conversation.md"]).toBe(false);
  const bad = join(dir, "bad.jsonl"); await writeFile(bad, '{"type":"user"}\n{"broken":');
  const result = await run(["convert", bad, "--to", "codex"], dir); expect(result.exit).toBe(2); expect(result.value.code).toBe("MALFORMED_SESSION");
  expect((await run(["convert", "--unknown-option"], dir)).value.code).toBe("INVALID_ARGUMENT");
  expect((await run(["convert", fixture("claude.jsonl"), "--to", "chatgpt", "--install"], dir)).value.code).toBe("UNSUPPORTED_INSTALL");
});

test("discovery supports unambiguous prefixes, source filtering, and pagination", async () => {
  const dir = await sandbox(), claude = join(dir, "claude-home", "projects", "-project");
  await mkdir(claude, { recursive: true });
  const data = await readFile(fixture("claude.jsonl"));
  const ids = ["eeeeeeee-0000-4000-8000-000000000001", "eeeeeeee-0000-4000-8000-000000000002"];
  for (const id of ids) await writeFile(join(claude, id + ".jsonl"), data);
  const list = await run(["list", "--source", "claude", "--limit", "1"], dir);
  expect(list.value.sessions.length).toBe(1); expect(list.value.nextOffset).toBe(1);
  expect((await run(["list", "--source", "codex"], dir)).value.sessions).toEqual([]);
  expect((await run(["inspect", "claude:eeeeeeee"], dir)).value.code).toBe("AMBIGUOUS_SESSION");
  expect((await run(["inspect", `claude:${ids[0]}`], dir)).exit).toBe(0);
  expect((await run(["list", "--limit=-1"], dir)).value.code).toBe("INVALID_PAGINATION");
});

test("Claude compaction restores original history despite preserved-message parent rewrites", async () => {
  const dir = await sandbox(), out = join(dir, "compacted");
  const result = await run(["convert", fixture("claude-compacted.jsonl"), "--to", "codex", "--out", out], dir);
  expect(result.exit).toBe(0);
  const canonical = JSON.parse(await readFile(join(out, "session.json"), "utf8"));
  const texts = canonical.messages.flatMap((m: { blocks: { text: string }[] }) => m.blocks.map(b => b.text));
  expect(texts).toEqual(["Original constraint: never round money.", "Initial work completed.",
    "Summary: export in progress.", "Now export the data.", "Keep integer cents.", "Next step: write CSV."]);
  expect(result.value.warnings.join(" ")).toContain("recovered through logical parents");
});

test("active context avoids replaying pre-compaction history while retaining original bytes", async () => {
  const dir = await sandbox();
  for (const [name, older, active] of [["claude-compacted.jsonl", "Original constraint: never round money.", "Next step: write CSV."],
    ["codex.jsonl", "Fix invoice rounding.", "Do not duplicate replacement history."]]) {
    const out = join(dir, name);
    const result = await run(["convert", fixture(name), "--to", "portable", "--history", "active", "--out", out], dir);
    expect(result.exit).toBe(0); expect(result.value.historyMode).toBe("active");
    const canonical = await readFile(join(out, "session.json"), "utf8");
    expect(canonical).not.toContain(older); expect(canonical).toContain(active);
    expect(await readFile(join(out, "source-original.jsonl"))).toEqual(await readFile(fixture(name)));
  }
});

test("metadata survives native round trips with original timestamps, IDs, model attribution, and usage", async () => {
  const dir = await sandbox(), codex = join(dir, "codex"), claude = join(dir, "claude"), portable = join(dir, "portable");
  expect((await run(["convert", fixture("claude.jsonl"), "--to", "codex", "--out", codex], dir)).exit).toBe(0);
  const nativeCodex = (await readFile(join(codex, "codex.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
  expect(nativeCodex.find(r => r.type === "session_meta").payload.git.branch).toBe("feature/invoice");
  expect(nativeCodex.filter(r => r.type === "response_item")[1].timestamp).toBe("2026-09-10T10:00:00.000Z");
  expect((await run(["convert", join(codex, "codex.jsonl"), "--to", "claude", "--out", claude], dir)).exit).toBe(0);
  expect((await run(["convert", join(claude, "claude.jsonl"), "--to", "portable", "--out", portable], dir)).exit).toBe(0);
  const restored = JSON.parse(await readFile(join(portable, "session.json"), "utf8"));
  expect(restored.title).toBe("Invoice export"); expect(restored.metadata.tags).toEqual(["finance"]);
  expect(restored.messages.length).toBe(4); expect(restored.messages.map((m: { id: string }) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  expect(restored.messages[0].timestamp).toBe("2026-09-10T10:00:00Z");
  expect(restored.messages[1].metadata.model).toBe("claude-test-model");
  expect(restored.metadata.usage).toEqual({ provider: "claude", method: "unique-message-sum", inputTokens: 112, outputTokens: 22, cachedInputTokens: 8 });
  expect(restored.metadata.createdAt).toBe("2026-09-10T10:00:00.000Z");
  expect(restored.metadata.updatedAt).toBe("2026-09-10T10:00:05.000Z");
  expect(restored.metadata.records.find((r: { type: string }) => r.type === "future-metadata").fields.customField).toEqual({ nested: ["keep", 7] });
  expect(restored.metadata.settings.claude.permissionMode).toBe("bypassPermissions");
  expect(restored.metadata.provenance.map((p: { provider: string }) => p.provider)).toEqual(["claude", "codex", "claude"]);
  const metadataFile = JSON.parse(await readFile(join(portable, "metadata.json"), "utf8"));
  expect(metadataFile.messages[1].metadata.usage.output_tokens).toBe(20);
  expect((await run(["verify", portable], dir)).value.checks["metadata.json"]).toBe(true);
});

test("Codex cumulative usage and runtime settings remain historical instead of granting destination privileges", async () => {
  const dir = await sandbox(), out = join(dir, "bundle");
  const result = await run(["convert", fixture("codex.jsonl"), "--to", "claude", "--out", out], dir);
  expect(result.exit).toBe(0);
  const metadata = JSON.parse(await readFile(join(out, "metadata.json"), "utf8"));
  expect(metadata.session.usage).toEqual({ provider: "codex", method: "cumulative", inputTokens: 350, outputTokens: 45, cachedInputTokens: 25, totalTokens: 395 });
  expect(metadata.session.reasoningEffort).toBe("high"); expect(metadata.session.models).toEqual(["gpt-test-model"]);
  expect(metadata.session.git).toEqual({ branch: "feature/invoice", commit: "a".repeat(40), repository: "https://example.com/invoices.git" });
  expect(metadata.session.settings.codex.approval_policy).toBe("never");
  const native = (await readFile(join(out, "claude.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
  expect(native.some(r => r.type === "permission-mode" || r.permissionMode)).toBe(false);
  expect(native.filter(r => r.type === "assistant").every(r => r.message.usage.input_tokens === 0)).toBe(true);
  expect(result.value.metadata.preserved).toContain("historical models and usage");
  expect(result.value.metadata.notes.join(" ")).toContain("does not become destination billing");
});

test("Codex installation registers its title and undo removes only the unchanged imported thread", async () => {
  const dir = await sandbox(), out = join(dir, "bundle");
  const result = await run(["convert", fixture("claude.jsonl"), "--to", "codex", "--install", "--cwd", dir, "--out", out], dir);
  expect(result.exit).toBe(0); expect(result.value.nativeMetadataRegistered).toBe(true);
  const index = await readFile(join(dir, "codex-home", "session_index.jsonl"), "utf8");
  expect(index).toContain('"thread_name":"Invoice export"');
  expect((await run(["verify", out], dir)).value.ok).toBe(true);
  const removed = await run(["undo", out], dir); expect(removed.exit).toBe(0); expect(removed.value.removed).toBe(true);
  expect((await run(["verify", out], dir)).value.ok).toBe(true);
});

test("ChatGPT metadata retains model, timestamps, cost, and provider-specific fields through handoff", async () => {
  const dir = await sandbox(), out = join(dir, "chatgpt-metadata");
  expect((await run(["convert", fixture("chatgpt.json"), "--to", "chatgpt", "--out", out], dir)).exit).toBe(0);
  const data = JSON.parse(await readFile(join(out, "metadata.json"), "utf8"));
  expect(data.session.models).toEqual(["gpt-test-model"]);
  expect(data.session.usage).toEqual({ provider: "chatgpt", method: "unique-message-sum", inputTokens: 50, outputTokens: 10 });
  expect(data.session.createdAt).toBe("2025-06-15T15:06:40.000Z");
  expect(data.session.updatedAt).toBe("2025-06-15T15:07:40.000Z");
  expect(data.messages[1].timestamp).toBe(1750000030);
  expect(data.messages[1].metadata.fields.payload.metadata.cost_usd).toBe(0.003);
  expect(data.session.records.find((r: { type: string }) => r.type === "conversation").fields.custom_metadata).toEqual({ archive: "keep" });
});

test("portable metadata validation rejects malformed settings before creating output", async () => {
  const dir = await sandbox(), out = join(dir, "validated"), source = join(dir, "malformed.json");
  await writeFile(source, JSON.stringify({ format: "session-bridge/v1", source: "claude", title: "Test", warnings: [],
    messages: [{ role: "user", blocks: [{ kind: "text", text: "Continue" }] }],
    metadata: { tags: [], models: [], settings: {}, records: [], provenance: [], git: { branch: { unexpected: "object" } } } }));
  const result = await run(["convert", source, "--to", "codex", "--out", out], dir);
  expect(result.exit).toBe(2); expect(result.value.code).toBe("INVALID_METADATA");
  expect(await readdir(dir)).toEqual(["malformed.json"]);
});

test("branch selection resumes the chosen Claude and ChatGPT chain and structured tools round-trip", async () => {
  const dir = await sandbox();
  for (const [source, branch, expected, excluded] of [["claude.jsonl", "old-branch", "Discard this alternate branch.", "CSV export, preserving cents."], ["chatgpt.json", "old-answer", "Old branch should not transfer.", "Use integer cents in the CSV."]]) {
    const inventory = await run(["branches", fixture(source)], dir);
    expect(inventory.value.branches.some((b: { id: string }) => b.id === branch)).toBe(true);
    const out = join(dir, source);
    expect((await run(["convert", fixture(source), "--branch", branch, "--to", "portable", "--out", out], dir)).exit).toBe(0);
    const session = JSON.parse(await readFile(join(out, "session.json"), "utf8"));
    expect(JSON.stringify(session.messages)).toContain(expected); expect(JSON.stringify(session.messages)).not.toContain(excluded);
  }
  let input = fixture("codex.jsonl");
  for (const [index, target] of ["claude", "codex", "portable"].entries()) {
    const out = join(dir, `roundtrip-${index}`);
    expect((await run(["convert", input, "--to", target, "--out", out], dir)).exit).toBe(0);
    input = join(out, target === "portable" ? "session.json" : `${target}.jsonl`);
  }
  const restored = JSON.parse(await readFile(input, "utf8"));
  expect(restored.messages.some((m: { role: string }) => m.role === "developer")).toBe(true);
  const blocks = restored.messages.flatMap((m: { blocks: unknown[] }) => m.blocks);
  expect(blocks.find((b: { kind: string }) => b.kind === "tool_call")).toMatchObject({ callId: "t2", name: "exec_command" });
  expect(blocks.find((b: { kind: string }) => b.kind === "tool_result")).toMatchObject({ callId: "t2" });
});

test("attachments copy bytes, rebase after moving a bundle, and verify nested artifact integrity", async () => {
  const dir = await sandbox(), source = join(dir, "source.jsonl");
  const rows = (await readFile(fixture("claude.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
  const bytes = Buffer.from("document contents\n"); await writeFile(join(dir, "notes.txt"), bytes);
  rows[0].cwd = dir; rows[0].message.content = [{ type: "text", text: "Continue using these attachments." }, { type: "document", source: { type: "file", path: "notes.txt" } }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }, { type: "image_asset_pointer", asset_pointer: "cloud-only-id" }];
  await writeFile(source, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const out = join(dir, "bundle");
  const result = await run(["convert", source, "--to", "portable", "--out", out], dir); expect(result.exit).toBe(0);
  const session = JSON.parse(await readFile(join(out, "session.json"), "utf8")), assets = session.messages[0].blocks.filter((b: { kind: string }) => b.kind === "media");
  expect(await readFile(join(out, assets[0].asset.bundlePath))).toEqual(bytes);
  expect(assets[2].asset.status).toBe("unresolved"); expect(result.value.warnings.join(" ")).toContain("cloud-only-id");
  // Strip inline duplication to exercise the portable file reference, then move the bundle.
  for (const b of assets) delete b.asset.data;
  await writeFile(join(out, "session.json"), JSON.stringify(session));
  const moved = join(dir, "moved"); await import("node:fs/promises").then(fs => fs.rename(out, moved)); await rm(join(dir, "notes.txt"));
  const next = join(dir, "next"); expect((await run(["convert", join(moved, "session.json"), "--to", "claude", "--out", next], dir)).exit).toBe(0);
  expect(await readFile(join(next, assets[0].asset.bundlePath))).toEqual(bytes);
  expect((await run(["verify", next], dir)).value.ok).toBe(true);
  await writeFile(join(next, assets[0].asset.bundlePath), "changed");
  expect((await run(["verify", next], dir)).exit).toBe(3);
  expect((await run(["convert", join(next, "session.json"), "--to", "portable", "--out", join(dir, "bad")], dir)).value.code).toBe("ASSET_CHANGED");
});

test("subagent findings, retained compaction context, and source memory reach the resumed conversation", async () => {
  const dir = await sandbox(), source = join(dir, "parent.jsonl"), children = join(dir, "parent", "subagents");
  await mkdir(children, { recursive: true });
  const rows = (await readFile(fixture("claude.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
  rows.push({ type: "attachment", attachment: { type: "nested_memory", content: "CSV must have a UTF-8 BOM.", path: "memory.md" } });
  await writeFile(source, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const childRows = [{ type: "user", uuid: "child-u", parentUuid: null, isSidechain: true, message: { role: "user", content: "Check export encoding." } }, { type: "assistant", uuid: "child-a", parentUuid: "child-u", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "Excel requires the BOM; finish the encoding test." }, { type: "thinking", thinking: "secret child reasoning" }] } }];
  await writeFile(join(children, "agent-one.jsonl"), childRows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const out = join(dir, "claude-to-codex"); expect((await run(["convert", source, "--to", "codex", "--out", out], dir)).exit).toBe(0);
  const native = await readFile(join(out, "codex.jsonl"), "utf8"); expect(native).toContain("finish the encoding test"); expect(native).toContain("UTF-8 BOM"); expect(native).not.toContain("secret child reasoning");
  expect((await readdir(join(out, "sources"))).length).toBe(1);
  const back = join(dir, "back"); expect((await run(["convert", join(out, "codex.jsonl"), "--to", "claude", "--out", back], dir)).exit).toBe(0);
  expect(await readFile(join(back, "conversation.md"), "utf8")).toContain("finish the encoding test");
  const codexRows = (await readFile(fixture("codex.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
  codexRows.find(r => r.type === "compacted").payload.retained_context = { user_messages: [{ message_id: "constraint", text: "Never round stored cents." }], assistant_messages: [{ message_id: "pending", text: "Pending: verify encoding." }], verified_answers: [{ answer: "BOM required" }] };
  codexRows.push({ type: "inter_agent_communication", communication: { author: "encoding-agent", recipient: "root", content: "Encoding test failed on Windows.", encrypted_content: "do not restore ciphertext" } });
  const codex = join(dir, "retained.jsonl"); await writeFile(codex, codexRows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const retained = join(dir, "retained"); expect((await run(["convert", codex, "--history", "active", "--to", "claude", "--out", retained], dir)).exit).toBe(0);
  const handoff = await readFile(join(retained, "conversation.md"), "utf8");
  expect(handoff).toContain("Never round stored cents."); expect(handoff).toContain("Pending: verify encoding."); expect(handoff).toContain("Encoding test failed on Windows."); expect(handoff).not.toContain("do not restore ciphertext");
});

test("workspace reports uncommitted file mismatches and strict checks stop before any output", async () => {
  const dir = await sandbox(), sourceDir = join(dir, "project"), dest = join(dir, "destination"); await mkdir(sourceDir); await mkdir(dest);
  async function git(cwd: string, args: string[]) { const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" }); if (await p.exited) throw new Error(await new Response(p.stderr).text()); }
  await git(sourceDir, ["init", "-b", "main"]); await writeFile(join(sourceDir, "invoice.ts"), "committed"); await git(sourceDir, ["add", "."]);
  await git(sourceDir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
  await git(dir, ["clone", sourceDir, dest]); await writeFile(join(sourceDir, "invoice.ts"), "uncommitted source changes");
  const rows = (await readFile(fixture("claude.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
  for (const r of rows) { r.cwd = sourceDir; delete r.gitBranch; }
  const source = join(dir, "session.jsonl"); await writeFile(source, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const out = join(dir, "strict");
  const rejected = await run(["convert", source, "--to", "portable", "--cwd", dest, "--workspace-check", "strict", "--out", out], dir);
  expect(rejected.value.code).toBe("WORKSPACE_MISMATCH"); expect(await readdir(dir)).not.toContain("strict");
  const warned = join(dir, "warned"); expect((await run(["convert", source, "--to", "portable", "--cwd", dest, "--out", warned], dir)).exit).toBe(0);
  const workspace = JSON.parse(await readFile(join(warned, "workspace.json"), "utf8"));
  expect(workspace.mismatches.join(" ")).toContain("Uncommitted file differs"); expect(workspace.source.git.dirty[0].path).toBe("invoice.ts");
  await writeFile(join(dest, "invoice.ts"), "uncommitted source changes");
  expect((await run(["convert", source, "--to", "portable", "--cwd", dest, "--workspace-check", "strict", "--out", join(dir, "matched")], dir)).exit).toBe(0);
});

test("Codex linked child rollouts transfer their findings and unavailable children are reported", async () => {
  const dir = await sandbox(), root = join(dir, "codex-home", "sessions", "2026", "09", "10"); await mkdir(root, { recursive: true });
  const childId = "aaaaaaaa-0000-4000-8000-000000000001", missing = "aaaaaaaa-0000-4000-8000-000000000002";
  const rows = (await readFile(fixture("codex.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
  rows.push({ type: "event_msg", payload: { type: "collab_agent_spawn_end", receiver_thread_id: childId } }, { type: "response_item", payload: { type: "function_call_output", call_id: "spawn-missing", output: JSON.stringify({ agent_id: missing }) } });
  const parent = join(dir, "parent-codex.jsonl"); await writeFile(parent, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  await writeFile(join(root, `rollout-${childId}.jsonl`), [{ type: "session_meta", payload: { id: childId, cwd: dir } }, { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Child found rounding fails for negative cents." }] } }].map(r => JSON.stringify(r)).join("\n") + "\n");
  const out = join(dir, "bundle"), result = await run(["convert", parent, "--to", "claude", "--out", out], dir);
  expect(result.exit).toBe(0); expect(result.value.warnings.join(" ")).toContain(`Subagent transcript unavailable locally: ${missing}`);
  expect(await readFile(join(out, "conversation.md"), "utf8")).toContain("rounding fails for negative cents");
  expect((await run(["verify", out], dir)).value.ok).toBe(true);
});

test('compressed Codex discovery, conversion, and archive verification preserve original bytes', async () => {
  const dir = await sandbox(), store = join(dir, 'codex-home', 'archived_sessions'); await mkdir(store, { recursive: true });
  const original = await readFile(fixture('codex.jsonl'));
  const compressed = await Bun.zstdCompress(original);
  const source = join(store, 'rollout-dddddddd-0000-4000-8000-000000000001.jsonl.zst'); await writeFile(source, compressed);
  const listed = await run(['list', '--source', 'codex'], dir);
  expect(listed.exit).toBe(0); expect(JSON.stringify(listed.value)).toContain('dddddddd-0000-4000-8000-000000000001');
  const out = join(dir, 'compressed');
  const result = await run(['convert', 'codex:dddddddd-0000-4000-8000-000000000001', '--to', 'claude', '--out', out], dir);
  expect(result.exit).toBe(0); expect((await readFile(join(out, 'source-original.jsonl.zst'))).equals(compressed)).toBe(true);
  expect(await readFile(join(out, 'claude.jsonl'), 'utf8')).toContain('amount_cents = 1200');
  expect((await run(['verify', out], dir)).value.ok).toBe(true);
  await writeFile(source, 'bad compressed input');
  expect((await run(['inspect', source], dir)).value.code).toBe('INVALID_COMPRESSION');
});
