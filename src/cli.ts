#!/usr/bin/env bun
import { definitions, commands, commandSchema, validate, fieldMask, project, VERSION, type Command } from "./contracts.ts";
import { requestInput, readWindow, writeJson } from "./agent-io.ts";
import { parseArgs } from "node:util";
import { stat, readFile } from "node:fs/promises";
import { BridgeError, terminal, expand, roots, report, type Target, type Entry } from "./model.ts";
import { load, chatgptConversations } from "./adapters.ts";
import { discover, describe, resolveSession, convert, verify, undo, compressedCount } from "./store.ts";

const optionDefinitions = {
  json: { type: "boolean" }, human: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
  request: { type: "string" }, output: { type: "string" }, fields: { type: "string" }, pretty: { type: "boolean" }, "page-all": { type: "boolean" }, "max-pages": { type: "string" }, "max-bytes": { type: "string" }, "idempotency-key": { type: "string" }, "expected-source-sha256": { type: "string" },
  source: { type: "string" }, input: { type: "string" }, limit: { type: "string" }, offset: { type: "string" }, search: { type: "string" },
  branch: { type: "string" }, "workspace-check": { type: "string" }, history: { type: "string" }, cwd: { type: "string" }, to: { type: "string" }, conversation: { type: "string" }, out: { type: "string" }, install: { type: "boolean" }, "dry-run": { type: "boolean" },
} as const;
function help(command?: string) {
  console.log(`baton · carry your conversation to another agent\n`);
  if (command && Object.hasOwn(commands, command)) {
    const c = commands[command as keyof typeof commands];
    console.log(`${c.description}\n\nUsage: baton ${command}${c.min ? " SESSION_OR_BUNDLE" : ""} [options]\n`);
    console.log(c.options.map(o => `  --${o}`).join("\n"));
    if (command === "convert") console.log("\n--to claude|codex|chatgpt|portable (required)\n--history full|active (default full): recover all recorded history, or current post-compaction context.\n--install writes a new native session. --dry-run makes no writes.\n--branch NODE selects a Claude or ChatGPT branch; use branches to list choices.\n--workspace-check warn|strict|off (default warn).\n--out DIRECTORY must be new unless retrying the same --idempotency-key.\n--expected-source-sha256 pins the donor snapshot. --cwd selects the destination project.");
  } else {
    console.log("Usage: baton COMMAND [options]\n");
    for (const [name, c] of Object.entries(commands)) console.log(`  ${name.padEnd(9)} ${c.description}`);
    console.log("\nStart here:\n  baton list\n  baton inspect claude:latest\n  baton convert claude:latest --to codex --install --dry-run\n  baton convert claude:latest --to codex --install\n\nSESSION accepts a path, UUID/prefix, claude:ID, codex:ID, or PROVIDER:latest.");
  }
  console.log("\n--json for agent output (automatic when piped); --output json|ndjson|human.\n--request JSON|@FILE|- for a validated JSON request; --fields PATH,PATH for narrow output.\n--pretty formats JSON. list --page-all --max-pages N streams bounded pages with --output ndjson.\nschema COMMAND exposes JSON Schema; read SESSION exposes a bounded message window.\nConversion is local. Native Codex title registration uses local storage RPC; no model requests.");
}
function schema(command?: Command) {
  if (command) return commandSchema(command);
  return { format: "session-bridge/v1", version: VERSION, contracts: Object.fromEntries(Object.keys(commands).map(c => [c, commandSchema(c as Command)])), commands, options: optionDefinitions,
    targets: ["claude", "codex", "chatgpt", "portable"],
    metadata: { session: ["title", "tags", "createdAt", "updatedAt", "git", "models", "reasoningEffort", "usage", "settings", "records", "provenance"], message: ["provider", "model", "phase", "usage", "fields"], report: ["native", "preserved", "fresh", "notes"] },
    continuity: { context: ["subagent", "memory", "retained", "communication"], assets: "Inline/local bytes copied to assets/; native user images and Claude PDFs restored; other files linked", workspace: "Git commit/branch, dirty-file hashes, referenced-file existence, source comparison", branches: "branches SESSION; convert SESSION --branch NODE" },
    portable: { format: "session-bridge/v1", source: "claude|codex|chatgpt", sourceId: "string?", cwd: "string?", title: "string", warnings: "string[]",
      messages: [{ role: "string", id: "string?", timestamp: "string|number|null?", blocks: [{ kind: "text|tool_call|tool_result|reasoning|media|summary|unsupported", text: "string", name: "string?", callId: "string?" }] }] },
    exitCodes: { 0: "success", 2: "invalid input or I/O error", 3: "integrity mismatch", 130: "interrupted" } };
}
async function doctor() {
  const providers: Record<string, unknown> = {};
  for (const name of ["claude", "codex"] as const) {
    const binary = Bun.which(name); let version: string | undefined;
    if (binary) {
      const proc = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "ignore" });
      const timeout = setTimeout(() => proc.kill(), 5000);
      try { version = (await new Response(proc.stdout).text()).trim(); await proc.exited; }
      finally { clearTimeout(timeout); }
    }
    let storeExists = false; try { storeExists = (await stat(roots()[name])).isDirectory(); } catch { /* Missing stores are normal before the first session. */ }
    providers[name] = { binary, version, store: roots()[name], storeExists, sessions: (await discover(name)).length, compressedSessions: await compressedCount(name) };
  }
  return { version: VERSION, runtime: `Bun ${Bun.version}`, providers,
    capabilities: { claude: "Native transcript → claude --resume ID", codex: "Native rollout → codex resume ID; local Desktop source transcripts accepted",
      chatgpt: "conversations.json input; Markdown upload/paste output. No native desktop/cloud insertion.", portable: "Provider-neutral JSON, original bytes, and SHA-256 integrity manifest" },
    notes: ["No model turns started; native initialization and title registration use local Codex app-server RPC.", "Compressed Codex rollouts are unsupported; decompress a copy first.",
      "Native formats are internal. Tested against Claude Code 2.1.287 and Codex CLI 0.159.2."] };
}
async function* listPages(v: Record<string, string | number | boolean | undefined>) {
  const limit = Number(v.limit ?? 20), offset = Number(v.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) throw new BridgeError("INVALID_PAGINATION", "--limit must be 1–1000 and --offset must be nonnegative integers.");
  const source = v.source ?? "all";
  if (!["all", "claude", "codex"].includes(String(source))) throw new BridgeError("INVALID_SOURCE", "--source accepts all, claude, or codex.");
  let entries: Entry[];
  if (typeof v.input === "string") {
    const path = expand(v.input), data: unknown = JSON.parse(await readFile(path, "utf8"));
    entries = chatgptConversations(data).map(c => ({ id: String(c.id ?? c.conversation_id), source: "chatgpt" as const, path,
      modified: typeof c.update_time === "number" ? c.update_time : 0, title: typeof c.title === "string" ? c.title : "Untitled" })).sort((a, b) => b.modified - a.modified);
  } else entries = await discover(source as "all" | "claude" | "codex");
  let selected: Entry[] = [], pageOffset = offset;
  const filter = typeof v.cwd === "string" ? expand(v.cwd) : undefined;
  let matched = 0;
  for (const item of entries) {
    const e = item.source === "chatgpt" ? item : await describe(item);
    if (filter && e.cwd !== filter) continue;
    if (typeof v.search === "string" && !`${e.title} ${e.id} ${e.cwd}`.toLowerCase().includes(v.search.toLowerCase())) continue;
    if (matched++ < offset) continue;
    if (selected.length === limit) { yield { sessions: selected, limit, offset: pageOffset, nextOffset: pageOffset + selected.length }; pageOffset += selected.length; selected = []; }
    selected.push(e);
  }
  yield { sessions: selected, limit, offset: pageOffset, nextOffset: null };
}
function printHuman(result: unknown, command: string) {
  if (command === "list") {
    const r = result as { sessions: Entry[]; nextOffset: number | null };
    if (!r.sessions.length) { console.log("No sessions found. Run doctor to check local stores."); return; }
    console.log(`${"AGENT".padEnd(8)} ${"SESSION".padEnd(36)}  CONVERSATION`);
    for (const e of r.sessions) {
      console.log(`${e.source.padEnd(8)} ${e.id}  ${terminal(e.title).slice(0, 85)}`);
      if (e.cwd) console.log(`          ${terminal(e.cwd)}`);
    }
    console.log("\nNext: baton inspect AGENT:SESSION");
    if (r.nextOffset !== null) console.log(`More: baton list --offset ${r.nextOffset}`);
  } else if (command === "branches") {
    const r = result as { selected?: string; branches: { id: string; title?: string }[] };
    if (!r.branches.length) { console.log("No alternate branches in this sequential rollout."); return; }
    for (const b of r.branches) console.log(`${b.id === r.selected ? "*" : " "} ${terminal(b.id)}  ${terminal(b.title ?? "")}`);
    console.log("\nSelect: baton convert SESSION --branch NODE --to TARGET");
  } else if (command === "convert" || command === "inspect") {
    const r = result as ReturnType<typeof report> & { dryRun?: boolean; output?: string; resumeCommand?: string; nextStep?: string };
    console.log(`\n${r.dryRun ? "Preview" : "Conversation"} · ${terminal(r.title)}\n${r.source} → ${r.target} · ${r.messages} messages (${r.historyMode} history) · ${r.contextBytes.toLocaleString()} context bytes\nProject: ${terminal(r.cwd ?? "unspecified")}`);
    console.log(`Context: ${r.continuity.subagents} subagents · ${r.continuity.contextRecords} supplemental records · ${r.continuity.attachments.total} attachments · ${r.continuity.workspaceMismatches} workspace mismatches`);
    console.log(`Metadata: ${r.metadata.native.join(", ") || "portable preservation"}; source settings and usage preserved in metadata.json.`);
    for (const warning of r.warnings) console.log(`  • ${terminal(warning)}`);
    if (r.output) console.log(`\n${r.dryRun ? "Would save" : "Saved"}: ${terminal(r.output)}`);
    if (r.resumeCommand) console.log(`\n${r.dryRun ? "After installation" : "Continue"}:\n  ${terminal(r.resumeCommand)}`);
    else if (r.nextStep) console.log(`\n${r.nextStep}`);
  } else console.log(JSON.stringify(result, null, 2));
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let jsonMode = argv.includes("--json") || argv.includes("--request") || (!process.stdout.isTTY && !argv.includes("--human"));
  try {
    const parsed = parseArgs({ args: argv, options: optionDefinitions, allowPositionals: true, strict: true });
    const globals = parsed.values;
    if (globals.output && !["json", "ndjson", "human"].includes(globals.output)) throw new BridgeError("INVALID_ARGUMENT", "--output accepts json, ndjson, or human.");
    if ((globals.json && globals.human) || (globals.output && ((globals.json && globals.output !== "json") || (globals.human && globals.output !== "human")))) throw new BridgeError("INVALID_ARGUMENT", "Choose one output format.");
    const output = globals.output ?? (globals.json || globals.request || (!process.stdout.isTTY && !globals.human) ? "json" : "human");
    jsonMode = output !== "human";
    if (globals.fields && !jsonMode) throw new BridgeError("INVALID_ARGUMENT", "--fields requires JSON or NDJSON output.");
    if (globals.version) { if (globals.json || globals.output === "json") await writeJson({ version: VERSION }, Boolean(globals.pretty)); else console.log(`baton ${VERSION}`); return 0; }
    const [name, ...args] = parsed.positionals;
    if (!name) { if (globals.json || globals.output) await writeJson({ version: VERSION, commands, next: ["doctor", "list", "schema convert"] }, Boolean(globals.pretty)); else help(); return 0; }
    if (!Object.hasOwn(commands, name)) throw new BridgeError("UNKNOWN_COMMAND", `Unknown command ${name}.`, "Run baton --help.");
    const command = name as Command, spec = commands[command], contract = definitions[command];
    if (globals.help) {
      if (jsonMode) await writeJson(commandSchema(command), Boolean(globals.pretty)); else help(command);
      return 0;
    }
    const allowedGlobals = ["json", "human", "output", "fields", "pretty", "request", "help", "version"];
    for (const key of Object.keys(globals)) if (![...allowedGlobals, ...spec.options].includes(key)) throw new BridgeError("INVALID_ARGUMENT", `--${key} is not valid for ${command}.`);
    if (args.length > spec.max || (!globals.request && args.length < spec.min)) throw new BridgeError("INVALID_ARGUMENT", `${command} requires ${spec.min ? "one SESSION_OR_BUNDLE argument" : "at most one optional argument"}.`);
    let params: Record<string, unknown> = {};
    if (globals.request) {
      if (args.length || Object.keys(globals).some(key => !allowedGlobals.includes(key))) throw new BridgeError("INVALID_ARGUMENT", "--request cannot be mixed with positional arguments or command-specific flags.");
      params = await requestInput(globals.request);
    } else {
      if (contract.positional && args[0] !== undefined) params[contract.positional] = args[0];
      for (const key of spec.options) if (globals[key as keyof typeof globals] !== undefined) {
        const value = globals[key as keyof typeof globals];
        params[key] = contract.input.properties?.[key]?.type === "integer" ? Number(value) : value;
      }
    }
    if (command === "list") {
      const limit = Number(params.limit ?? 20), offset = Number(params.offset ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) throw new BridgeError("INVALID_PAGINATION", "--limit must be 1–1000 and --offset must be nonnegative integers.");
    }
    validate(params, contract.input);
    if (params["idempotency-key"] && !params.out) throw new BridgeError("INVALID_ARGUMENT", "--idempotency-key requires --out so retries address the same bundle.");
    if (params["max-pages"] && !params["page-all"]) throw new BridgeError("INVALID_ARGUMENT", "--max-pages requires --page-all.");
    if (params["page-all"] && !jsonMode) throw new BridgeError("INVALID_ARGUMENT", "--page-all requires JSON or NDJSON output.");
    const masks = fieldMask(globals.fields, contract.output);
    if (output === "ndjson" && globals.pretty) throw new BridgeError("INVALID_ARGUMENT", "--pretty cannot be combined with NDJSON.");
    const emit = async (result: unknown) => { if (jsonMode || command === "schema") await writeJson(project(result, masks), Boolean(globals.pretty)); else printHuman(result, command); };
    const v = params as Record<string, string | number | boolean | undefined>;
    if (command === "list") {
      const iterator = listPages(v), maxPages = v["page-all"] ? Number(v["max-pages"] ?? 10) : 1;
      const pages: { sessions: Entry[]; limit: number; offset: number; nextOffset: number | null; complete: boolean }[] = [];
      for (let index = 0; index < maxPages; index++) {
        const next = await iterator.next(); if (next.done) break;
        const page = { ...next.value, complete: next.value.nextOffset === null };
        if (output === "ndjson") await emit(page); else if (!v["page-all"]) await emit(page); else pages.push(page);
        if (page.complete) break;
      }
      await iterator.return();
      if (v["page-all"] && output === "json") { const last = pages.at(-1)!; await emit({ sessions: pages.flatMap(p => p.sessions), limit: last.limit, offset: Number(v.offset ?? 0), nextOffset: last.nextOffset, complete: last.complete, pageCount: pages.length }); }
      return 0;
    }
    let result: unknown;
    if (command === "doctor") result = await doctor();
    else if (command === "schema") result = schema(v.command as Command | undefined);
    else if (command === "verify") result = await verify(String(v.bundle));
    else if (command === "undo") result = await undo(String(v.bundle), Boolean(v["dry-run"]));
    else {
      const input = await load(await resolveSession(String(v.session)), v.conversation as string | undefined, (v.history ?? "full") as "full" | "active", { branch: v.branch as string | undefined, children: command === "convert" || command === "inspect" });
      if (v["expected-source-sha256"] && input.session.sourceSha256 !== String(v["expected-source-sha256"]).toLowerCase()) throw new BridgeError("SOURCE_CHANGED", "Donor session differs from the expected snapshot.", "Inspect the donor again before converting its new turns.");
      const target = (v.to ?? (input.session.source === "claude" ? "codex" : "claude")) as Target;
      result = command === "read" ? readWindow(input.session, Number(v.offset ?? 0), Number(v.limit ?? 10), Number(v["max-bytes"] ?? 65536))
        : command === "branches" ? { source: input.session.source, selected: input.session.selectedBranch, branches: input.session.branches ?? [], note: "Choose --branch NODE on the original source to transfer an alternate branch." }
        : command === "inspect" ? report(input.session, target) : await convert(input, target, {
          out: v.out as string | undefined, cwd: v.cwd as string | undefined, install: Boolean(v.install), dryRun: Boolean(v["dry-run"]), workspaceCheck: v["workspace-check"] as "warn" | "strict" | "off" | undefined,
          idempotencyKey: v["idempotency-key"] as string | undefined });
    }
    await emit(result);
    return command === "verify" && !(result as { ok: boolean }).ok ? 3 : 0;
  } catch (e) {
    const error = e as Error & { code?: string };
    if (error.code === "EPIPE") return 0;
    const code = e instanceof BridgeError ? e.code : error.code?.startsWith("ERR_PARSE_ARGS") ? "INVALID_ARGUMENT" : "IO_ERROR";
    const hint = e instanceof BridgeError ? e.hint : "Check input format, file paths, and permissions.";
    const retryable = ["CONVERSION_IN_PROGRESS", "CODEX_METADATA_TIMEOUT"].includes(code);
    if (jsonMode) console.error(JSON.stringify({ error: true, code, message: error.message, hint, retryable, version: VERSION }));
    else console.error(`Error [${code}]: ${terminal(error.message)}${hint ? `\n${terminal(hint)}` : ""}`);
    return 2;
  }
}
if (import.meta.main) {
  // writeJson handles stream failures; registering a listener prevents an unhandled EPIPE.
  process.stdout.on("error", () => {});
  process.exitCode = await main();
}
