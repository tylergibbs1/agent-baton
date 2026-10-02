import { readBytes } from "./io.ts";
import { stat, readdir } from "node:fs/promises";
import { dirname, join, resolve, extname, basename, isAbsolute } from "node:path";
import { BridgeError, hash, row, arr, str, type Session, type Message, type Block, type Workspace } from "./model.ts";

const mimeExtensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf", "text/plain": "txt", "audio/wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a" };
const extensionMimes = Object.fromEntries(Object.entries(mimeExtensions).map(([mime, ext]) => [`.${ext}`, mime]));
extensionMimes[".jpeg"] = "image/jpeg";
export function allMessages(s: Session): Message[] { return [...s.messages, ...(s.context ?? []).flatMap(c => c.messages ?? [])]; }

export async function prepareAssets(session: Session, inputPath: string, output: string) {
  const s: Session = structuredClone(session), artifacts: Record<string, Uint8Array> = {};
  let total = 0;
  for (const m of allMessages(s)) for (const b of m.blocks) {
    if (b.kind !== "media" || !b.asset) continue;
    const a = b.asset;
    let bytes: Buffer | undefined;
    try {
      let bundledExists = false;
      if (a.bundlePath) {
        if (!/^assets\/[a-f\d]{64}\.[a-z0-9]+$/.test(a.bundlePath)) throw new BridgeError("INVALID_ASSET", "Invalid bundled attachment path.");
        try { bundledExists = (await stat(resolve(dirname(inputPath), a.bundlePath))).isFile(); } catch { /* Native installed sessions carry inline media independent of their bundle. */ }
      }
      if (a.data && !bundledExists && !(a.bundlePath && extname(inputPath) === ".json")) {
        if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(a.data) || a.data.length > 90_000_000) throw new BridgeError("INVALID_ASSET", "Invalid or oversized base64 attachment.");
        bytes = Buffer.from(a.data, "base64");
        if (bytes.toString("base64").replace(/=+$/, "") !== a.data.replace(/[\r\n=]/g, "")) throw new BridgeError("INVALID_ASSET", "Malformed base64 attachment.");
      } else if (a.bundlePath || a.path) {
        const path = a.bundlePath ? resolve(dirname(inputPath), a.bundlePath) : resolve(session.cwd ?? dirname(inputPath), a.path!);
        if (a.bundlePath && (!/^assets\/[a-f\d]{64}\.[a-z0-9]+$/.test(a.bundlePath))) throw new BridgeError("INVALID_ASSET", "Invalid bundled attachment path.");
        const info = await stat(path);
        if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new BridgeError("ASSET_TOO_LARGE", "Attachment must be a regular file at most 64 MiB.");
        bytes = await readBytes(path);
        if (a.sha256 && hash(bytes) !== a.sha256) throw new BridgeError("ASSET_CHANGED", "Bundled attachment checksum differs from its reference.");
        a.mime ??= extensionMimes[extname(path).toLowerCase()];
      }
      if (bytes) {
        if (a.sha256 && hash(bytes) !== a.sha256) throw new BridgeError("ASSET_CHANGED", "Attachment checksum differs from its reference.");
        total += bytes.length;
        if (bytes.length > 64 * 1024 * 1024 || total > 256 * 1024 * 1024) throw new BridgeError("ASSET_TOO_LARGE", "Attachment budget exceeded (64 MiB per attachment, 256 MiB total).");
        a.sha256 = hash(bytes); a.bundlePath = `assets/${a.sha256}.${mimeExtensions[a.mime ?? ""] ?? "bin"}`;
        artifacts[a.bundlePath] = bytes; a.path = join(output, a.bundlePath); a.data = bytes.toString("base64"); a.status = "copied";
        b.text = `Attachment: ${a.path} (${a.mime ?? "application/octet-stream"}, ${bytes.length} bytes)`;
      } else {
        a.status = a.url ? "remote" : "unresolved";
        b.text = `Attachment unavailable locally: ${a.url ?? a.pointer ?? b.text}. Supply this asset in the destination.`;
        s.warnings.push(b.text);
      }
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      a.status = "missing"; b.text = `Missing attachment: ${a.path ?? a.bundlePath ?? b.text}`;
      s.warnings.push(b.text);
    }
  }
  return { session: s, artifacts };
}

// Foreign tools remain evidence. Only ordinary user attachments use native media schemas.
export function nativeMedia(blocks: Block[], target: "claude" | "codex"): Record<string, unknown>[] {
  return blocks.flatMap<Record<string, unknown>>(b => {
    const a = b.asset;
    if (b.kind !== "media" || !a?.data || !a.mime) return [];
    if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(a.mime)) return target === "claude"
      ? [{ type: "image", source: { type: "base64", media_type: a.mime, data: a.data } }]
      : [{ type: "input_image", image_url: `data:${a.mime};base64,${a.data}` }];
    if (a.mime === "application/pdf" && target === "claude") return [{ type: "document", source: { type: "base64", media_type: a.mime, data: a.data } }];
    return [];
  });
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const binary = Bun.which("git"); if (!binary) return;
  const proc = Bun.spawn([binary, "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const timeout = setTimeout(() => proc.kill(), 5000);
  try { const text = await new Response(proc.stdout).text(); return await proc.exited === 0 ? text : undefined; }
  finally { clearTimeout(timeout); }
}
async function fileExists(path: string) { try { return (await stat(path)).isFile() || (await stat(path)).isDirectory(); } catch { return false; } }
export async function checkWorkspace(s: Session, cwd: string): Promise<Workspace> {
  const w: Workspace = { cwd, exists: false, referenced: [], mismatches: [] };
  try { w.exists = (await stat(cwd)).isDirectory(); } catch { /* Report absent workspaces even for export-only conversions. */ }
  if (!w.exists) { w.mismatches.push("Destination workspace does not exist."); return w; }
  const [branch, commit, status, repositoryRoot] = await Promise.all([git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), git(cwd, ["rev-parse", "HEAD"]), git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), git(cwd, ["rev-parse", "--show-toplevel"])]);
  if (commit) {
    const dirty: NonNullable<Workspace["git"]>["dirty"] = [];
    const entries = (status ?? "").split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]; if (!entry) continue;
      const path = entry.slice(3), code = entry.slice(0, 2);
      if (code.includes("R") || code.includes("C")) i++;
      let sha256: string | undefined;
      try { const p = join(repositoryRoot?.trim() ?? cwd, path); if ((await stat(p)).isFile() && (await stat(p)).size <= 64 * 1024 * 1024) sha256 = hash(await readBytes(p)); } catch { /* Deleted and unavailable files retain their status. */ }
      dirty.push({ path, status: code, sha256 });
    }
    w.git = { root: repositoryRoot?.trim(), branch: branch?.trim(), commit: commit.trim(), dirty };
    if (s.metadata?.git?.commit && s.metadata.git.commit !== w.git.commit) w.mismatches.push("Destination Git commit differs from the recorded session commit.");
    if (s.metadata?.git?.branch && s.metadata.git.branch !== w.git.branch) w.mismatches.push("Destination Git branch differs from the recorded session branch.");
  } else if (s.metadata?.git) w.mismatches.push("Destination is not a readable Git worktree.");
  const paths = new Set<string>();
  for (const m of allMessages(s)) for (const b of m.blocks) {
    if (b.kind !== "tool_call") continue;
    let input; try { input = row(JSON.parse(b.text)); } catch { continue; }
    for (const key of ["file_path", "path", "filename", "file", "workdir", "cwd"]) if (str(input[key])) paths.add(String(input[key]));
  }
  for (const p of paths) {
    const relative = isAbsolute(p) && s.cwd && p.startsWith(s.cwd + "/") ? p.slice(s.cwd.length + 1) : p;
    const destination = resolve(cwd, relative), exists = await fileExists(destination);
    w.referenced.push({ path: destination, exists });
    if (!exists) w.mismatches.push(`Referenced file is missing: ${destination}`);
  }
  const source = s.workspace?.source ?? s.workspace;
  if (source?.git) for (const file of source.git.dirty) {
    const dest = join(w.git?.root ?? cwd, file.path);
    let digest: string | undefined; try { digest = hash(await readBytes(dest)); } catch { /* Missing destination is a mismatch. */ }
    if ((file.sha256 && digest !== file.sha256) || (!file.sha256 && file.status.includes("D") && digest !== undefined)) w.mismatches.push(`Uncommitted file differs from source workspace: ${file.path}`);
  }
  return w;
}

export async function childFiles(parent: string, source: "claude" | "codex", rows: Record<string, unknown>[], codexRoot: string): Promise<{ paths: string[]; missing: string[] }> {
  if (source === "claude") {
    const dir = join(dirname(parent), basename(parent, ".jsonl"), "subagents");
    try { return { paths: (await readdir(dir)).filter(n => n.endsWith(".jsonl")).sort().map(n => join(dir, n)), missing: [] }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { paths: [], missing: [] }; throw e; }
  }
  const ids = new Set<string>();
  for (const r of rows) {
    const p = row(r.payload);
    if (r.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(String(p.type))) {
      try { const value = row(typeof p.output === "string" ? JSON.parse(p.output) : p.output); if (str(value.agent_id)) ids.add(String(value.agent_id)); } catch { /* Ordinary tool output is not agent discovery data. */ }
    }
    if (p.type === "collab_agent_spawn_end") { const id = str(p.new_thread_id) ?? str(p.receiver_thread_id); if (id) ids.add(id); }
    for (const id of [...arr(p.receiver_thread_ids), ...arr(row(p.item).receiver_thread_ids)]) if (typeof id === "string") ids.add(id);
  }
  if (!ids.size) return { paths: [], missing: [] };
  const files: string[] = [];
  async function scan(dir: string) {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const e of entries) if (e.isDirectory()) await scan(join(dir, e.name)); else if (e.isFile() && [...ids].some(id => (e.name.endsWith(`${id}.jsonl`) || e.name.endsWith(`${id}.jsonl.zst`)))) files.push(join(dir, e.name));
  }
  await scan(codexRoot); await scan(join(codexRoot, "..", "archived_sessions"));
  const preferred = new Map<string, string>();
  for (const path of files) { const id = basename(path).replace(/\.jsonl(?:\.zst)?$/, "").slice(-36), prior = preferred.get(id); if (!prior || prior.endsWith(".zst") && !path.endsWith(".zst")) preferred.set(id, path); }
  return { paths: [...preferred.values()].sort(), missing: [...ids].filter(id => !files.some(path => (path.endsWith(`${id}.jsonl`) || path.endsWith(`${id}.jsonl.zst`)))) };
}
