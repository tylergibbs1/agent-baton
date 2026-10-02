import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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
  const path = join(dir, "media.jsonl"); await writeFile(path, rows.map(r => JSON.stringify(r)).join("\n") + "\n"); return path;
}
// This is the native storage contract, not a mocked model response. Never starts a turn.
test("installed Codex app-server hydrates imported user, assistant, and tool history", async () => {
  if (!Bun.which("codex")) throw new Error("Install Codex CLI to run native adapter verification.");
  const dir = await mkdtemp(join(tmpdir(), "baton-native-")), env = { ...process.env, CODEX_HOME: join(dir, "codex"), CLAUDE_CONFIG_DIR: join(dir, "claude") };
  const source = await mediaFixture(dir);
  const exported = Bun.spawn([process.execPath, cli, "convert", source, "--to", "codex", "--install", "--cwd", dir, "--out", join(dir, "bundle"), "--json"], { env, stdout: "pipe", stderr: "pipe" });
  const m = await new Response(exported.stdout).json() as { sessionId: string; installedPath: string };
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
    const hydrated = JSON.stringify([resume, read, turns]);
    expect(hydrated).toContain("Build invoice export. Use integer cents.");
    expect(hydrated).toContain("amount_cents: number");
    expect(hydrated).toContain("Next implement CSV export, preserving cents.");
    expect(hydrated).toContain(`data:image/png;base64,${imageData}`);
    expect(hydrated).not.toContain("private scratchpad");
  } finally { proc.kill(); await proc.exited; await pump; await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("Claude Agent SDK lists the installed transcript and loads its complete parent chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baton-claude-"));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude-home"), CODEX_HOME: join(dir, "codex-home") };
  try {
    const source = await mediaFixture(dir);
    const proc = Bun.spawn([process.execPath, cli, "convert", source, "--to", "claude", "--install", "--cwd", dir, "--out", join(dir, "bundle"), "--json"], { env, stdout: "pipe", stderr: "pipe" });
    const manifest = await new Response(proc.stdout).json() as { sessionId: string };
    expect(await proc.exited).toBe(0);
    const check = `import {listSessions,getSessionMessages} from '@anthropic-ai/claude-agent-sdk';
const id=${JSON.stringify(manifest.sessionId)}, dir=${JSON.stringify(dir)};
const sessions=await listSessions({dir}); const info=sessions.find(s=>s.sessionId===id); const messages=await getSessionMessages(id,{dir});
console.log(JSON.stringify({found:sessions.some(s=>s.sessionId===id),title:info?.customTitle,tag:info?.tag,branch:info?.gitBranch,messages:messages.length,
user:JSON.stringify(messages).includes('Use integer cents.'),tool:JSON.stringify(messages).includes('amount_cents: number'),
pdf:messages.some(m=>Array.isArray(m.message.content)&&m.message.content.some(b=>b.type==='document'&&b.source?.media_type==='application/pdf')),
image:messages.some(m=>Array.isArray(m.message.content)&&m.message.content.some(b=>b.type==='image'&&b.source?.media_type==='image/png')),
last:JSON.stringify(messages).includes('CSV export, preserving cents.'),private:JSON.stringify(messages).includes('private scratchpad')}));`;
    const validation = Bun.spawn([process.execPath, "--eval", check], { env, cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
    const result = await new Response(validation.stdout).json();
    expect(await validation.exited).toBe(0);
    expect(result).toEqual({ found: true, title: "Invoice export", tag: "finance", branch: "feature/invoice", messages: 5, pdf: true, image: true, user: true, tool: true, last: true, private: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
