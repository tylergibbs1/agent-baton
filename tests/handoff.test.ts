import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/claude.jsonl", import.meta.url));

test("installed client helpers hand off exact sessions in both directions and protect customized commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baton-commands-"));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex"), CLAUDE_SESSION_ID: "eeeeeeee-0000-4000-8000-000000000001", CODEX_THREAD_ID: "" };
  async function run(binary: string, args: string[], overrides = {}) {
    const proc = Bun.spawn([binary, ...args, "--json"], { cwd: dir, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exit, value: JSON.parse(stdout || stderr) };
  }
  try {
    const binary = join(dir, "baton");
    const build = Bun.spawn([process.execPath, "build", cli, "--compile", "--outfile", binary], { stdout: "ignore", stderr: "pipe" });
    expect(await build.exited).toBe(0);
    const preview = await run(binary, ["setup", "--dry-run"]);
    expect(preview.exit).toBe(0); expect((await readdir(dir)).sort()).toEqual(["baton"]);
    const installed = await run(binary, ["setup"]);
    expect(installed.exit).toBe(0); expect(installed.value.commands).toHaveLength(2);
    const repeated = await run(binary, ["setup"]);
    expect(repeated.value.commands.every((c: { reused: boolean }) => c.reused)).toBe(true);
    const cc = installed.value.commands.find((c: { client: string }) => c.client === "claude"), codex = installed.value.commands.find((c: { client: string }) => c.client === "codex");
    const projects = join(env.CLAUDE_CONFIG_DIR, "projects", "test"); await mkdir(projects, { recursive: true });
    await writeFile(join(projects, `${env.CLAUDE_SESSION_ID}.jsonl`), await readFile(fixture));
    const otherId = "ffffffff-0000-4000-8000-000000000002";
    await writeFile(join(projects, `${otherId}.jsonl`), (await readFile(fixture, "utf8")).replaceAll(env.CLAUDE_SESSION_ID, otherId).replaceAll("Invoice export", "Wrong newer session"));
    // The installed binary works after the setup executable is removed.
    await rm(binary);
    const forward = await run(cc.runner, ["handoff", "--from", "claude", "--cwd", dir]);
    expect(forward.exit).toBe(0); expect(forward.value.sourceId).toBe(env.CLAUDE_SESSION_ID); expect(forward.value.title).toBe("Invoice export"); expect(forward.value.target).toBe("codex");
    const retry = await run(cc.runner, ["handoff", "--from", "claude", "--cwd", dir]);
    expect(retry.exit).toBe(0); expect(retry.value.reused).toBe(true); expect(retry.value.sessionId).toBe(forward.value.sessionId);
    const reverse = await run(codex.runner, ["handoff", "--from", "codex", "--cwd", dir], { CODEX_THREAD_ID: forward.value.sessionId });
    expect(reverse.exit).toBe(0); expect(reverse.value.target).toBe("claude"); expect(reverse.value.title).toBe("Invoice export");
    const original = JSON.parse(await readFile(join(forward.value.output, "session.json"), "utf8"));
    const restored = JSON.parse(await readFile(join(reverse.value.output, "session.json"), "utf8"));
    expect(restored.messages.map((m: { blocks: unknown }) => m.blocks)).toEqual(original.messages.map((m: { blocks: unknown }) => m.blocks));
    const missing = await run(cc.runner, ["handoff", "--from", "claude"], { CLAUDE_SESSION_ID: "" });
    expect(missing.exit).toBe(2); expect(missing.value.code).toBe("CURRENT_SESSION_UNKNOWN");
    const latest = await run(cc.runner, ["handoff", "--from", "claude", "--session", "latest"]);
    expect(latest.exit).toBe(2);
    await writeFile(join(cc.path, "SKILL.md"), "User customized command");
    const conflict = await run(codex.runner, ["setup"]);
    expect(conflict.exit).toBe(2); expect(conflict.value.code).toBe("COMMAND_CONFLICT"); expect(await readFile(join(cc.path, "SKILL.md"), "utf8")).toBe("User customized command");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
