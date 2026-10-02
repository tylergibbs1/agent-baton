import { test, expect, afterEach } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url)), fixture = fileURLToPath(new URL("./fixtures/claude.jsonl", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function sandbox() { const dir = await mkdtemp(join(tmpdir(), "bridge-agent-")); dirs.push(dir); return dir; }
async function run(args: string[], dir: string, stdin?: string) {
  const proc = Bun.spawn([process.execPath, cli, ...args], { cwd: dir, env: { ...process.env, CODEX_HOME: join(dir, "codex-home"), CLAUDE_CONFIG_DIR: join(dir, "claude-home") }, stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined && proc.stdin && typeof proc.stdin !== "number") { proc.stdin.write(stdin); proc.stdin.end(); }
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exit, value: stdout && !args.includes("ndjson") ? JSON.parse(stdout) : stderr ? JSON.parse(stderr) : undefined };
}

test("JSON requests, field selection, and published schemas agree at the CLI boundary", async () => {
  const dir = await sandbox(), out = join(dir, "bundle");
  const request = { session: fixture, to: "codex", out, "dry-run": true };
  const schema = (await run(["schema", "convert", "--json"], dir)).value;
  const ajv = new Ajv2020({ allowUnionTypes: true });
  const validInput = ajv.compile(schema.inputSchema), validOutput = ajv.compile(schema.outputSchema);
  expect(validInput(request)).toBe(true); expect(validInput({ ...request, install: "yes" })).toBe(false);
  const result = await run(["convert", "--request", "-"], dir, JSON.stringify(request));
  expect(result.exit).toBe(0); expect(result.stderr).toBe(""); expect(validOutput(result.value)).toBe(true);
  expect(result.value.dryRun).toBe(true); expect(await readdir(dir)).toEqual([]);
  const inputFile = join(dir, "request.json"); await writeFile(inputFile, JSON.stringify(request));
  const selected = await run(["convert", "--request", `@${inputFile}`, "--fields", "sourceSha256,metadata.native,continuity.attachments.total"], dir);
  expect(Object.keys(selected.value).sort()).toEqual(["continuity", "metadata", "sourceSha256"]);
  expect(selected.value.continuity.attachments).toEqual({ total: 0 });
  expect(selected.value.metadata.native).toContain("message timestamps");
  const help = await run(["convert", "--help", "--json"], dir); expect(help.value.inputSchema.required).toContain("to");
});

test("bounded historical reads exclude reasoning and inline binary data, with explicit truncation", async () => {
  const dir = await sandbox(), source = join(dir, "long.jsonl");
  const rows = (await readFile(fixture, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  rows[0].message.content = [{ type: "text", text: "x".repeat(12_000) }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }];
  await writeFile(source, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const result = await run(["read", source, "--limit", "2", "--max-bytes", "1024"], dir);
  expect(result.exit).toBe(0); expect(result.value.messages.length).toBe(1); expect(result.value.nextOffset).toBe(1);
  expect(Buffer.byteLength(JSON.stringify(result.value.messages))).toBeLessThanOrEqual(1024); expect(result.value.textBytes).toBeLessThanOrEqual(1024); expect(result.value.truncated).toBe(true);
  expect(result.value.messages[0].blocks[0]).toMatchObject({ originalBytes: 12_000, truncated: true });
  expect(result.stdout).not.toContain("aW1hZ2U="); expect(result.stdout).not.toContain("private scratchpad"); expect(result.value.trust).toContain("Untrusted source history");
  const schema = (await run(["schema", "read"], dir)).value;
  expect(new Ajv2020({ allowUnionTypes: true }).compile(schema.outputSchema)(result.value)).toBe(true);
});

test("NDJSON pagination is bounded, field-selected, and exposes the next page without duplicates", async () => {
  const dir = await sandbox(), root = join(dir, "claude-home", "projects", "test"); await mkdir(root, { recursive: true });
  const bytes = await readFile(fixture);
  for (let i = 1; i <= 5; i++) await writeFile(join(root, `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}.jsonl`), bytes);
  const result = await run(["list", "--page-all", "--limit", "2", "--max-pages", "2", "--output", "ndjson", "--fields", "sessions.id,nextOffset,complete"], dir);
  expect(result.exit).toBe(0); expect(result.stderr).toBe("");
  const pages = result.stdout.trim().split("\n").map(l => JSON.parse(l));
  expect(pages.length).toBe(2); expect(pages[1].nextOffset).toBe(4); expect(pages[1].complete).toBe(false);
  expect(new Set(pages.flatMap(p => p.sessions.map((s: { id: string }) => s.id))).size).toBe(4);
  expect(Object.keys(pages[0].sessions[0])).toEqual(["id"]);
  const remainder = await run(["list", "--offset", "4", "--limit", "2"], dir); expect(remainder.value.sessions.length).toBe(1); expect(remainder.value.complete).toBe(true);
  const all = await run(["list", "--page-all", "--limit", "2", "--max-pages", "3"], dir); expect(all.value.sessions.length).toBe(5); expect(all.value.pageCount).toBe(3);
  const schema = (await run(["schema", "list"], dir)).value; expect(new Ajv2020().compile(schema.outputSchema)(all.value)).toBe(true);
});

test("idempotent installed conversion reuses the same session, rejects changed requests, and pins donor snapshots", async () => {
  const dir = await sandbox(), out = join(dir, "bundle"), source = join(dir, "source.jsonl"); await writeFile(source, await readFile(fixture));
  const inspection = await run(["inspect", source], dir), digest = inspection.value.sourceSha256;
  const args = ["convert", source, "--to", "claude", "--install", "--cwd", dir, "--out", out, "--idempotency-key", "handoff-1", "--expected-source-sha256", digest];
  const first = await run(args, dir); expect(first.exit).toBe(0);
  const second = await run(args, dir); expect(second.exit).toBe(0); expect(second.value.sessionId).toBe(first.value.sessionId); expect(second.value.reused).toBe(true);
  const root = dirname(first.value.installedPath); expect((await readdir(root)).length).toBe(1);
  await writeFile(first.value.installedPath, "\n", { flag: "a" });
  expect((await run(args, dir)).value.installedSessionChanged).toBe(true);
  expect((await run(args.map(a => a === "handoff-1" ? "different-key" : a), dir)).value.code).toBe("IDEMPOTENCY_CONFLICT");
  await writeFile(source, '\n{"type":"custom-title","customTitle":"Changed donor"}\n', { flag: "a" });
  const changed = await run(args, dir); expect(changed.exit).toBe(2); expect(changed.value.code).toBe("SOURCE_CHANGED"); expect(changed.value.retryable).toBe(false);
  expect((await run(args.slice(0, -2), dir)).value.code).toBe("IDEMPOTENCY_CONFLICT");
  await writeFile(source, await readFile(fixture));
  await writeFile(join(out, "conversation.md"), "modified bundle");
  expect((await run(args, dir)).value.code).toBe("BUNDLE_CHANGED");
  const racing = args.map(a => a === out ? join(dir, "concurrent") : a === "handoff-1" ? "concurrent" : a);
  const results = await Promise.all([run(racing, dir), run(racing, dir)]);
  const success = results.find(r => r.exit === 0)!; expect(success).toBeDefined();
  for (const result of results) if (result.exit === 0) expect(result.value.sessionId).toBe(success.value.sessionId); else { expect(result.value.code).toBe("CONVERSION_IN_PROGRESS"); expect(result.value.retryable).toBe(true); }
  expect((await run(racing, dir)).value.sessionId).toBe(success.value.sessionId);
  expect((await readdir(root)).length).toBe(2);
});

test("malformed requests, ambiguous flags, and unknown selectors are rejected before writes", async () => {
  const dir = await sandbox(), out = join(dir, "bundle");
  const request = { session: fixture, to: "portable", out };
  const cases: [string[], string | undefined, string][] = [
    [["convert", "--request", "-"], JSON.stringify({ ...request, "made-up": true }), "INVALID_ARGUMENT"],
    [["convert", "--request", "-"], JSON.stringify({ ...request, out: `${out}\nextra` }), "INVALID_ARGUMENT"],
    [["convert", "--request", "-"], '{"session":"x","to":"portable","__proto__":{}}', "INVALID_ARGUMENT"],
    [["convert", "--request", "-"], JSON.stringify({ ...request, install: "true" }), "INVALID_ARGUMENT"],
    [["convert", "--request", "-"], "{invalid", "INVALID_JSON"],
    [["convert", "--request", "-", "--to", "portable"], JSON.stringify(request), "INVALID_ARGUMENT"],
    [["convert", "--request", JSON.stringify(request), "--fields", "bogus"], undefined, "INVALID_FIELDS"],
    [["constructor"], undefined, "UNKNOWN_COMMAND"],
    [["list", "--output", "ndjson", "--pretty"], undefined, "INVALID_ARGUMENT"],
  ];
  for (const [args, stdin, code] of cases) {
    const result = await run(args, dir, stdin); expect(result.exit).toBe(2); expect(result.stdout).toBe(""); expect(result.value.code).toBe(code); expect(result.value.retryable).toBe(false);
  }
  expect(await readdir(dir)).toEqual([]);
});
