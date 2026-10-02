import { BridgeError } from "./model.ts";

// Local storage RPC only. This client never sends turn/start or model requests.
export async function codexStorage(method: "thread/name/set" | "thread/delete", params: Record<string, string>) {
  const binary = Bun.which("codex");
  if (!binary) throw new BridgeError("CODEX_NOT_INSTALLED", "Codex CLI is required to register or remove native title metadata.");
  const proc = Bun.spawn([binary, "app-server", "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  let sequence = 0, buffer = "";
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  const pump = (async () => {
    for await (const chunk of proc.stdout) {
      buffer += Buffer.from(chunk).toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
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
      const timer = setTimeout(() => { pending.delete(id); reject(new BridgeError("CODEX_METADATA_TIMEOUT", "Codex local storage operation timed out.")); }, 10_000);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n"); proc.stdin.flush();
    });
  }
  try {
    await request("initialize", { clientInfo: { name: "baton", version: "0.4.0" }, capabilities: { experimentalApi: true } });
    proc.stdin.write('{"method":"initialized"}\n'); proc.stdin.flush();
    return await request(method, params);
  } finally { proc.kill(); await proc.exited; await pump; }
}
