import { BridgeError } from "./model.ts";

// Native import hydration and storage only. This client never sends turn/start or model requests.
type StorageMethod = "thread/name/set" | "thread/delete" | "thread/resume";
type StorageRequest = (method: StorageMethod, params: Record<string, unknown>) => Promise<unknown>;
export async function codexStorage(method: StorageMethod, params: Record<string, unknown>) {
  return codexStorageSession(request => request(method, params));
}
export async function codexStorageSession<T>(operate: (request: StorageRequest) => Promise<T>): Promise<T> {
  const binary = Bun.which("codex");
  if (!binary) throw new BridgeError("CODEX_NOT_INSTALLED", "Codex CLI is required to register or remove native title metadata.");
  const proc = Bun.spawn([binary, "app-server", "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  let sequence = 0;
  let fragments: string[] = [];
  const decoder = new TextDecoder();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  const pump = (async () => {
    for await (const chunk of proc.stdout) {
      const lines = decoder.decode(chunk, { stream: true }).split("\n");
      for (const [index, part] of lines.entries()) {
        fragments.push(part);
        if (index === lines.length - 1) continue;
        const line = fragments.join(""); fragments = [];
        if (!line.trim()) continue;
        const response = JSON.parse(line), request = pending.get(response.id);
        if (!request) continue;
        pending.delete(response.id);
        if (response.error) request.reject(new BridgeError("CODEX_METADATA_RPC", String(response.error.message ?? "Codex rejected storage operation.")));
        else request.resolve(response.result);
      }
    }
    fail(new BridgeError("CODEX_METADATA_RPC", "Codex storage server exited before responding."));
  })().catch(e => fail(e instanceof Error ? e : new Error(String(e))));
  function request(method: string, params: unknown): Promise<unknown> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new BridgeError("CODEX_METADATA_TIMEOUT", `Codex ${method} operation timed out.`)); }, method === "thread/resume" || method === "initialize" ? 120_000 : 10_000);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n"); proc.stdin.flush();
    });
  }
  try {
    await request("initialize", { clientInfo: { name: "baton", version: "0.7.1" }, capabilities: { experimentalApi: true } });
    proc.stdin.write('{"method":"initialized"}\n'); proc.stdin.flush();
    return await operate(request);
  } finally { proc.kill(); await proc.exited; await pump; }
}
