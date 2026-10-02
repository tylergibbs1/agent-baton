import { join } from "node:path";
import { load } from "./adapters.ts";
import { convert, resolveSession, type ConvertOptions } from "./store.ts";
import { BridgeError, hash, roots } from "./model.ts";

export async function handoff(options: ConvertOptions & { from?: "claude" | "codex"; session?: string; to?: "claude" | "codex"; history?: "full" | "active" }) {
  let from = options.from;
  if (!from) {
    const active = [process.env.CLAUDE_SESSION_ID ? "claude" : undefined, process.env.CODEX_THREAD_ID ? "codex" : undefined].filter(Boolean);
    if (active.length === 1) from = active[0] as "claude" | "codex";
    else throw new BridgeError("CURRENT_SESSION_UNKNOWN", "Specify --from claude|codex.", "Client commands select their own provider; a terminal handoff also accepts --session ID.");
  }
  const session = options.session ?? process.env[from === "claude" ? "CLAUDE_SESSION_ID" : "CODEX_THREAD_ID"];
  if (!session) throw new BridgeError("CURRENT_SESSION_UNKNOWN", "No current session ID is available.", "Use --session ID. Baton never guesses the newest conversation.");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(session)) throw new BridgeError("INVALID_REFERENCE", "A handoff requires the exact current session UUID.", "Use baton list to find an explicit ID; latest and prefix selectors are not accepted here.");
  const reference = `${from}:${session}`;
  const input = await load(await resolveSession(reference), undefined, options.history ?? "full");
  if (input.session.source !== from) throw new BridgeError("SOURCE_MISMATCH", "The selected session belongs to a different client.");
  const to = options.to ?? (from === "claude" ? "codex" : "claude");
  if (to === from) throw new BridgeError("INVALID_TARGET", "A handoff must select the other client.");
  const fingerprint = hash(JSON.stringify({ source: hash(input.raw), related: input.relatedSources.map(s => hash(s.raw)), to, cwd: options.cwd ?? input.session.cwd, history: options.history ?? "full", workspace: options.workspaceCheck ?? "warn", layout: 9 }));
  return convert(input, to, { ...options, install: true, out: options.out ?? join(roots()[from], "..", "baton", "handoffs", fingerprint), idempotencyKey: options.idempotencyKey ?? "handoff-v1" });
}
