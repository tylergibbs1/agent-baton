import { readBytes } from "./io.ts";
import { planChildren, renderFamily, claudeChildPath, type NativeChild } from "./subagents.ts";
import { checkWorkspace, prepareAssets } from "./continuity.ts";
import { codexStorage, codexStorageSession } from "./codex-client.ts";
import { readdir, stat, open, mkdir, rm, lstat, realpath, rename } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError, expand, roots, row, str, contentBlocks, report, hash, markdown,
  isTitleText, type Entry, type Session, type Target, type Report } from "./model.ts";
import { canonicalMessage } from "./canonical.ts";
import { load, parseJsonl } from "./adapters.ts";

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
async function exists(path: string) {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
async function* walk(path: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== "subagents") yield* walk(join(path, e.name));
    else if (e.isFile()) yield join(path, e.name);
  }
}
export async function discover(provider: "all" | "claude" | "codex" = "all") {
  const results: Entry[] = [];
  for (const [source, root] of Object.entries(roots())) {
    if (provider !== "all" && provider !== source) continue;
    const titles = new Map<string, string>();
    if (source === "codex") {
      try { for (const entry of parseJsonl(await Bun.file(join(root, "..", "session_index.jsonl")).text()))
        if (str(entry.id) && str(entry.thread_name)) titles.set(String(entry.id), String(entry.thread_name)); }
      catch { /* The optional title index does not determine whether a session exists. */ }
    }
    for (const directory of source === "codex" ? [root, join(root, "..", "archived_sessions")] : [root]) for await (const path of walk(directory)) {
      if (!path.endsWith(".jsonl") && !path.endsWith(".jsonl.zst")) continue;
      const stem = basename(path.replace(/\.zst$/, ""), ".jsonl"), id = source === "claude" ? stem : stem.slice(-36);
      if (!uuidPattern.test(id)) continue;
      results.push({ id, source: source as Entry["source"], path, title: titles.get(id), modified: (await stat(path)).mtimeMs / 1000 });
    }
  }
  const preferred = new Map<string, Entry>();
  for (const entry of results) {
    const key = `${entry.source}:${entry.id}`, prior = preferred.get(key);
    if (!prior || prior.path.endsWith('.zst') && !entry.path.endsWith('.zst') || prior.path.endsWith('.zst') === entry.path.endsWith('.zst') && entry.modified > prior.modified) preferred.set(key, entry);
  }
  return [...preferred.values()].sort((a, b) => b.modified - a.modified);
}
export async function describe(e: Entry): Promise<Entry> {
  if (e.path.endsWith(".jsonl.zst")) { const { session } = await load(e.path, undefined, "full", { children: false }); return { ...e, cwd: session.cwd, title: e.title ?? session.title }; }
  const file = await open(e.path, "r"), buffer = Buffer.alloc(256 * 1024);
  let data: string, tail: string;
  try {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); data = buffer.subarray(0, bytesRead).toString("utf8");
    const size = (await file.stat()).size;
    if (size > buffer.length) {
      const start = Math.max(buffer.length, size - 128 * 1024);
      const last = Buffer.alloc(size - start); await file.read(last, 0, last.length, start);
      const chunk = last.toString("utf8"); tail = chunk.slice(chunk.indexOf("\n") + 1);
    } else tail = "";
  }
  finally { await file.close(); }
  let cwd: string | undefined, title = "Untitled conversation", customTitle = e.title, automaticTitle: string | undefined, bridgeTitle: string | undefined;
  const lines = data.split("\n");
  // Last line can be cut by the bounded read. Never attempt to parse it if incomplete.
  if (!data.endsWith("\n")) lines.pop();
  for (const line of [...lines, ...tail.split("\n")]) {
    let r;
    try { r = row(JSON.parse(line)); } catch { continue; }
    bridgeTitle = str(row(row(r.session_bridge).session).title) ?? bridgeTitle;
    if (r.type === "custom-title") customTitle = str(r.customTitle) ?? customTitle;
    if (r.type === "ai-title") automaticTitle = str(r.aiTitle) ?? automaticTitle;
    if (r.type === "session_meta") cwd = str(row(r.payload).cwd);
    cwd ??= str(r.cwd);
    if (e.source === 'codex' && r.type === 'event_msg' && title === 'Untitled conversation') {
      const p = row(r.payload), canonical = canonicalMessage(r);
      const value = canonical?.role === 'user' ? canonical.blocks.find(b => b.kind === 'text' && isTitleText(b.text))?.text : p.type === 'user_message' && str(p.message) && isTitleText(String(p.message)) ? String(p.message) : undefined;
      if (value) title = value.slice(0, 100);
    }
    const m = row(e.source === "claude" ? r.message : r.payload);
    if (["user", "response_item"].includes(String(r.type)) && m.role === "user" && !r.isMeta) {
      const b = contentBlocks(m.content).find(b => b.kind === "text" && isTitleText(b.text));
      if (b && title === "Untitled conversation") title = b.text.slice(0, 100);
    }
  }
  return { ...e, cwd, title: customTitle ?? automaticTitle ?? bridgeTitle ?? title };
}
export async function resolveSession(reference: string) {
  const path = expand(reference);
  if (await exists(path)) {
    if (!(await stat(path)).isFile()) throw new BridgeError("INVALID_SOURCE", "Session path must be a file.");
    return path;
  }
  const parts = reference.split(":"), provider = parts.length === 1 ? "all" : parts[0], id = parts.length === 1 ? parts[0] : parts[1];
  if (!["all", "claude", "codex"].includes(provider) || parts.length > 2) throw new BridgeError("INVALID_SOURCE", "Use a file, UUID/prefix, claude:ID, or codex:latest.");
  if (id !== "latest" && (id.length < 6 || !/^[\da-f-]+$/i.test(id))) throw new BridgeError("INVALID_REFERENCE", "Session IDs must be UUIDs or prefixes of at least six characters.");
  const entries = await discover(provider as "all" | "claude" | "codex");
  const matches = id === "latest" ? entries.slice(0, 1) : entries.filter(e => e.id.startsWith(id.toLowerCase()));
  if (matches.length !== 1) throw new BridgeError(matches.length ? "AMBIGUOUS_SESSION" : "SESSION_NOT_FOUND", `Found ${matches.length} matching sessions.`, "Run baton list and use the full ID.");
  return matches[0].path;
}
export function destination(target: "claude" | "codex", id: string, cwd: string, stamp: string) {
  if (target === "claude") return join(roots().claude, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  return join(roots().codex, ...stamp.slice(0, 10).split("-"), `rollout-${stamp.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`);
}
async function privateWrite(path: string, data: Uint8Array) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); }
  catch (e) { await file.close(); await rm(path); throw e; }
  await file.close();
}
async function writeReceipt(bundle: string, manifest: Manifest) {
  const temporary = join(bundle, `.manifest-${randomUUID()}.tmp`);
  try { await privateWrite(temporary, encode(manifest)); await rename(temporary, join(bundle, "manifest.json")); }
  finally { await rm(temporary, { force: true }); }
}
const encode = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + "\n");
const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
export interface Manifest extends Report {
  format: "session-bridge-manifest/v1"; dryRun: boolean; sessionId: string; output: string;
  subagents?: NativeChild[]; installedPath?: string; resumeCommand?: string; resumeArgv?: string[]; nextStep?: string;
  idempotencyKey?: string; requestSha256?: string; reused?: boolean; installedSessionChanged?: boolean; completed?: boolean; nativeMetadataRegistered?: boolean; sha256?: Record<string, string>; createdAt: string;
}
export interface ConvertOptions { idempotencyKey?: string; out?: string; cwd?: string; install?: boolean; dryRun?: boolean; workspaceCheck?: "warn" | "strict" | "off" }
export async function convert(input: { session: Session; raw: Uint8Array; path: string; relatedSources?: { path: string; raw: Uint8Array }[] }, target: Target, options: ConvertOptions = {}): Promise<Manifest> {
  if (options.idempotencyKey && (!options.out || !/^[A-Za-z0-9._-]{1,128}$/.test(options.idempotencyKey))) throw new BridgeError("INVALID_ARGUMENT", "Idempotency requires a valid key and explicit --out.");
  if (options.install && !["claude", "codex"].includes(target)) throw new BridgeError("UNSUPPORTED_INSTALL", "Only Claude and Codex support native local installation.");
  if (options.install && !options.dryRun && target === "codex" && !Bun.which("codex")) throw new BridgeError("CODEX_NOT_INSTALLED", "Codex CLI is required to initialize native imports.");
  let cwd = expand(options.cwd ?? input.session.cwd ?? process.cwd());
  if (await exists(cwd) && (await stat(cwd)).isDirectory()) cwd = await realpath(cwd);
  let session: Session = { ...input.session, cwd,
    metadata: input.session.metadata ? { ...input.session.metadata, title: input.session.title,
      provenance: [...input.session.metadata.provenance, { provider: input.session.source, sessionId: input.session.sourceId, importedAt: new Date().toISOString() }] } : undefined };
  if (options.install && (!await exists(cwd) || !(await stat(cwd)).isDirectory())) throw new BridgeError("MISSING_WORKSPACE", `Project directory does not exist: ${cwd}`, "Pass --cwd with an existing project directory.");
  const sessionId = randomUUID(), stamp = new Date().toISOString(), output = expand(options.out ?? join(process.cwd(), "bridge-exports", sessionId));
  const outputExists = await exists(output);
  if (outputExists && !options.idempotencyKey) throw new BridgeError("OUTPUT_EXISTS", `Output already exists: ${output}`, "Choose a new --out directory; existing exports are never overwritten.");
  if (options.workspaceCheck !== "off") {
    const source = input.session.workspace ?? (input.session.cwd ? await checkWorkspace(input.session, expand(input.session.cwd)) : undefined);
    session.workspace = await checkWorkspace({ ...input.session, workspace: source }, cwd);
    if (source) session.workspace.source = source.source ?? { cwd: source.cwd, git: source.git };
    session.warnings = [...session.warnings, ...session.workspace.mismatches];
    if (options.workspaceCheck === "strict" && session.workspace.mismatches.length) throw new BridgeError("WORKSPACE_MISMATCH", "Workspace check failed.", session.workspace.mismatches.join(" "));
  }
  else session.workspace = undefined;
  const prepared = await prepareAssets(session, input.path, output); session = prepared.session;
  const requestSha256 = options.idempotencyKey ? hash(encode({ nativeFamilyLayout: 7, source: hash(input.raw), related: (input.relatedSources ?? []).map(s => hash(s.raw)), target, cwd,
    history: session.historyMode ?? "full", branch: session.selectedBranch, install: Boolean(options.install), workspaceCheck: options.workspaceCheck ?? "warn",
    assets: Object.fromEntries(Object.entries(prepared.artifacts).map(([name, bytes]) => [name, hash(bytes)])) })) : undefined;
  if (outputExists && options.idempotencyKey) {
    if (!await exists(join(output, "manifest.json"))) throw new BridgeError("CONVERSION_IN_PROGRESS", "Output exists without a completed receipt.", "Retry only if another conversion is still running; otherwise choose a new output directory.");
    const previous = await readManifest(output);
    if (previous.idempotencyKey !== options.idempotencyKey || previous.requestSha256 !== requestSha256) throw new BridgeError("IDEMPOTENCY_CONFLICT", "Output belongs to a different key or donor/request snapshot.", "Use a new key and output for changed source turns or options.");
    if (!previous.completed) throw new BridgeError("CONVERSION_IN_PROGRESS", "Conversion receipt is not complete yet.");
    if (!(await verify(output)).ok) throw new BridgeError("BUNDLE_CHANGED", "Idempotent retry refused because bundle artifacts changed.");
    let installedSessionChanged = false;
    if (previous.installedPath) {
      if (!uuidPattern.test(previous.sessionId) || typeof previous.cwd !== "string" || typeof previous.createdAt !== "string" || previous.installedPath !== destination(target as "claude" | "codex", previous.sessionId, previous.cwd, previous.createdAt)) throw new BridgeError("INVALID_MANIFEST", "Idempotent receipt contains an invalid installed path.");
      if (!await exists(previous.installedPath)) throw new BridgeError("INSTALLED_SESSION_MISSING", "The previous imported session was removed.", "Create a new conversion with a new key and output.");
      if ((await lstat(previous.installedPath)).isSymbolicLink()) throw new BridgeError("INVALID_MANIFEST", "Installed session is a symbolic link.");
      installedSessionChanged = hash(await readBytes(previous.installedPath)) !== previous.sha256?.[`${target}.jsonl`];
    }
    for (const child of previous.subagents ?? []) {
      for (const file of childFilesForReceipt(previous, child)) {
        if (!await exists(file.path)) throw new BridgeError("INSTALLED_SESSION_MISSING", "An imported child session was removed.");
        if ((await lstat(file.path)).isSymbolicLink()) throw new BridgeError("INVALID_MANIFEST", "Installed child is a symbolic link.");
        installedSessionChanged ||= hash(await readBytes(file.path)) !== previous.sha256?.[file.artifact];
      }
    }
    return { ...previous, reused: true, dryRun: Boolean(options.dryRun), installedSessionChanged };
  }
  const preview = report(session, target);
  if (!preview.messages) throw new BridgeError("EMPTY_SESSION", "No transferable messages remain after filtering.");
  const installedPath = options.install ? destination(target as "claude" | "codex", sessionId, cwd, stamp) : undefined;
  const resumeArgv = installedPath ? target === "claude" ? ["claude", "--resume", sessionId] : ["codex", "resume", sessionId, "-C", cwd] : undefined;
  const resumeCommand = resumeArgv ? (target === "claude" ? `cd ${quote(cwd)} && ` : "") + resumeArgv.map(quote).join(" ") : undefined;
  const children = target === "claude" || target === "codex" ? planChildren(session, target, sessionId) : [];
  if (installedPath) for (const child of children) child.installedPath = target === "claude" ? claudeChildPath(installedPath, sessionId, child.sessionId) : destination("codex", child.sessionId, cwd, stamp);
  const result: Manifest = { ...preview, format: "session-bridge-manifest/v1", dryRun: Boolean(options.dryRun), sessionId, output,
    subagents: children, installedPath, resumeArgv, resumeCommand, createdAt: stamp, completed: false, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey, requestSha256 } : {}),
    nextStep: target === "chatgpt" ? "Upload conversation.md to a new ChatGPT chat and ask it to continue from the final turn."
      : !options.install && ["claude", "codex"].includes(target) ? "Repeat the conversion with --install to create a resumable local session." : undefined };
  if (options.dryRun) return result;
  const artifacts: Record<string, Uint8Array> = { ...prepared.artifacts, "session.json": encode(session),
    "workspace.json": encode(session.workspace ?? { checked: false }),
    "context.json": encode(session.context ?? []),
    "branches.json": encode({ selected: session.selectedBranch, branches: session.branches ?? [] }),
    "metadata.json": encode({ session: session.metadata, messages: session.messages.map(m => ({ id: m.id, timestamp: m.timestamp, metadata: m.metadata })) }),
    ["source-original" + (input.path.endsWith(".jsonl.zst") ? ".jsonl.zst" : extname(input.path) === ".jsonl" ? ".jsonl" : ".json")]: input.raw,
    "conversation.md": Buffer.from(markdown(session)) };
  for (const [index, source] of (input.relatedSources ?? []).entries()) artifacts[`sources/${index}-${hash(source.raw)}${source.path.endsWith(".jsonl.zst") ? ".jsonl.zst" : extname(source.path) === ".json" ? ".json" : ".jsonl"}`] = source.raw;
  if (target === "claude" || target === "codex") Object.assign(artifacts, renderFamily(session, target, sessionId, cwd, stamp, children));
  result.sha256 = Object.fromEntries(Object.entries(artifacts).map(([name, data]) => [name, hash(data)]));
  // Create parents separately so the final output directory always has exclusive ownership.
  const parent = join(output, ".."); await mkdir(parent, { recursive: true, mode: 0o700 });
  try { await mkdir(output, { mode: 0o700 }); }
  catch (e) { if (options.idempotencyKey && (e as NodeJS.ErrnoException).code === "EEXIST") throw new BridgeError("CONVERSION_IN_PROGRESS", "Another conversion claimed this output directory.", "Retry the same key after it completes."); throw e; }
  let installed = false;
  const installedChildren: NativeChild[] = [];
  try {
    for (const [name, data] of Object.entries(artifacts)) { await mkdir(join(output, name, ".."), { recursive: true, mode: 0o700 }); await privateWrite(join(output, name), data); }
    await writeReceipt(output, result);
    if (installedPath) {
      await mkdir(join(installedPath, ".."), { recursive: true, mode: 0o700 });
      const installFamily = async (storage: typeof codexStorage) => {
        for (const child of children) {
          for (const file of childFilesForReceipt(result, child)) {
            await mkdir(join(file.path, ".."), { recursive: true, mode: 0o700 });
            await privateWrite(file.path, artifacts[file.artifact]);
            if (!installedChildren.includes(child)) installedChildren.push(child);
          }
          if (target === "codex") {
            await storage("thread/resume", { threadId: child.sessionId, path: child.installedPath!, cwd, excludeTurns: true });
            await captureHydrated(result, child.artifact, child.installedPath!, artifacts[child.artifact]);
            await storage("thread/name/set", { threadId: child.sessionId, name: child.title }); child.nativeMetadataRegistered = true;
          }
        }
        await privateWrite(installedPath, artifacts[`${target}.jsonl`]); installed = true;
        if (target === "codex") {
          await storage("thread/resume", { threadId: sessionId, path: installedPath, cwd, excludeTurns: true });
          await captureHydrated(result, `${target}.jsonl`, installedPath, artifacts[`${target}.jsonl`]);
          try { await storage("thread/name/set", { threadId: sessionId, name: session.title }); result.nativeMetadataRegistered = true; }
          catch (e) { result.nativeMetadataRegistered = false; result.metadata.native = result.metadata.native.filter(field => !field.startsWith("conversation title")); result.warnings.push(`Codex title registration failed; title remains preserved in the bundle: ${(e as Error).message}`); }
        }
      };
      if (target === "codex") {
        await codexStorageSession(installFamily);
        for (const child of children) await captureHydrated(result, child.artifact, child.installedPath!, artifacts[child.artifact]);
        await captureHydrated(result, `${target}.jsonl`, installedPath, artifacts[`${target}.jsonl`]);
      } else await installFamily(codexStorage);
    }
    result.completed = true;
    await writeReceipt(output, result);
  } catch (e) {
    try {
      for (const child of [...installedChildren].reverse()) await removeChild(result, child);
    } catch { throw new BridgeError("CLEANUP_FAILED", "Conversion failed; an owned child session could not be cleaned up.", `Preserved recovery bundle: ${output}`); }
    if (installed && installedPath && await exists(installedPath)) {
      if ((await lstat(installedPath)).isSymbolicLink() || hash(await readBytes(installedPath)) !== result.sha256?.[`${target}.jsonl`]) throw new BridgeError("CLEANUP_FAILED", "Conversion failed; its parent session changed during native initialization.", `Preserved recovery bundle: ${output}`);
      if (target === "codex") {
        try { await codexStorage("thread/delete", { threadId: sessionId }); }
        catch { throw new BridgeError("CLEANUP_FAILED", `Conversion failed; its owned session could not be cleaned up: ${installedPath}`, `Preserved recovery bundle: ${output}`); }
      } else await rm(installedPath);
    }
    await rm(output, { recursive: true, force: true }); throw e;
  }
  return result;
}
function validArtifact(name: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || /^(assets|sources|children)\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}
async function readManifest(bundle: string): Promise<Manifest> {
  const value: unknown = JSON.parse(await Bun.file(join(expand(bundle), "manifest.json")).text()), m = row(value);
  if (m.format !== "session-bridge-manifest/v1" || !Object.keys(row(m.sha256)).length) throw new BridgeError("INVALID_MANIFEST", "Not a baton bundle manifest.");
  for (const [name, digest] of Object.entries(row(m.sha256))) {
    if (!validArtifact(name) || !/^[a-f\d]{64}$/.test(String(digest))) throw new BridgeError("INVALID_MANIFEST", "Invalid artifact name or checksum.");
  }
  return value as Manifest;
}
export async function verify(bundle: string) {
  bundle = expand(bundle); const m = await readManifest(bundle), checks: Record<string, boolean> = {};
  for (const [name, expected] of Object.entries(m.sha256!)) {
    const path = join(bundle, name);
    checks[name] = await exists(path) && !(await lstat(path)).isSymbolicLink() && (!name.includes("/") || !(await lstat(join(bundle, name.split("/")[0]))).isSymbolicLink()) && hash(await readBytes(path)) === expected;
  }
  return { ok: Object.values(checks).every(Boolean), checks, bundle };
}
export async function undo(bundle: string, dryRun = false) {
  const m = await readManifest(bundle);
  if (!m.installedPath || !["claude", "codex"].includes(m.target)) throw new BridgeError("NOT_INSTALLED", "Bundle has no native installed session.");
  if (!uuidPattern.test(m.sessionId) || typeof m.cwd !== "string" || typeof m.createdAt !== "string") throw new BridgeError("INVALID_MANIFEST", "Invalid installed-session metadata.");
  const expected = destination(m.target as "claude" | "codex", m.sessionId, m.cwd, m.createdAt);
  if (m.installedPath !== expected) throw new BridgeError("INVALID_MANIFEST", "Installed path differs from the expected session location.");
  const owned = [{ path: expected, artifact: `${m.target}.jsonl` }, ...(m.subagents ?? []).flatMap(c => childFilesForReceipt(m, c))];
  for (const file of owned) {
    if (!await exists(file.path)) continue;
    if ((await lstat(file.path)).isSymbolicLink()) throw new BridgeError("INVALID_MANIFEST", "Installed session is a symbolic link.");
    if (hash(await readBytes(file.path)) !== m.sha256![file.artifact]) throw new BridgeError("SESSION_CHANGED", "Imported session or child has changed since installation.", "It may have been resumed. Remove it using the destination app if no longer needed.");
  }
  if (!dryRun) {
    const removeFamily = async (storage: typeof codexStorage) => {
      for (const child of [...(m.subagents ?? [])].reverse()) await removeChild(m, child, storage);
      if (await exists(expected)) {
        if (m.target === "codex") await storage("thread/delete", { threadId: m.sessionId });
        else await rm(expected);
      }
    };
    if (m.target === "codex") await codexStorageSession(removeFamily);
    else await removeFamily(codexStorage);
  }

  return { removed: !dryRun, dryRun, path: expected, bundlePreserved: expand(bundle) };
}
export async function compressedCount(provider: "claude" | "codex") {
  let count = 0; for (const directory of provider === "codex" ? [roots()[provider], join(roots()[provider], "..", "archived_sessions")] : [roots()[provider]]) for await (const p of walk(directory)) if (p.endsWith(".jsonl.zst")) count++;
  return count;
}

function childFilesForReceipt(m: Manifest, child: NativeChild): { path: string; artifact: string }[] {
  if (!m.installedPath || !child.installedPath) return [];
  if (!m.cwd || !/^(?:[a-f0-9]{16}|[a-f0-9-]{36})$/.test(child.sessionId) || !/^children\/\d+\.jsonl$/.test(child.artifact)) throw new BridgeError("INVALID_MANIFEST", "Invalid installed child identity.");
  const expected = m.target === "claude" ? claudeChildPath(m.installedPath, m.sessionId, child.sessionId) : destination("codex", child.sessionId, m.cwd, m.createdAt);
  if (child.installedPath !== expected) throw new BridgeError("INVALID_MANIFEST", "Child path differs from expected native location.");
  const files = [{ path: expected, artifact: child.artifact }];
  if (m.target === "claude") {
    if (child.metadataArtifact !== child.artifact.replace(/\.jsonl$/, ".meta.json")) throw new BridgeError("INVALID_MANIFEST", "Invalid child metadata artifact.");
    files.push({ path: expected.replace(/\.jsonl$/, ".meta.json"), artifact: child.metadataArtifact });
  }
  return files;
}
async function removeChild(m: Manifest, child: NativeChild, storage = codexStorage) {
  for (const file of childFilesForReceipt(m, child)) {
    if (!await exists(file.path)) continue;
    if ((await lstat(file.path)).isSymbolicLink() || hash(await readBytes(file.path)) !== m.sha256?.[file.artifact]) throw new BridgeError("SESSION_CHANGED", "Imported child changed; cleanup refused.");
    if (m.target === "codex") await storage("thread/delete", { threadId: child.sessionId });
    else await rm(file.path);
  }
}

async function captureHydrated(m: Manifest, artifact: string, path: string, original: Uint8Array) {
  if ((await lstat(path)).isSymbolicLink()) throw new BridgeError("SESSION_CHANGED", "Native hydration produced an unexpected session path.");
  const bytes = await readBytes(path);
  if (!bytes.subarray(0, original.length).equals(Buffer.from(original))) throw new BridgeError("SESSION_CHANGED", "Native hydration rewrote imported history; preserving recovery files.");
  if (hash(bytes) === m.sha256?.[artifact]) return;
  const temporary = join(m.output, `.hydrated-${randomUUID()}.tmp`);
  try { await privateWrite(temporary, bytes); await rename(temporary, join(m.output, artifact)); }
  finally { await rm(temporary, { force: true }); }
  m.sha256![artifact] = hash(bytes);
}
