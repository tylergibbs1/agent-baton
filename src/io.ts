/** Native reads; exclusive, durable writes remain in the store transaction. */
import { zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { BridgeError } from "./model.ts";
const decompress = promisify(zstdDecompress);
export async function readBytes(path: string): Promise<Buffer> {
  return Buffer.from(await Bun.file(path).arrayBuffer());
}
export async function transcriptBytes(path: string, raw: Buffer): Promise<Buffer> {
  const limit = 512 * 1024 * 1024;
  if (raw.length > limit) throw new BridgeError("SESSION_TOO_LARGE", "Session exceeds 512 MiB.");
  if (!path.endsWith('.jsonl.zst')) return raw;
  try { return await decompress(raw, { maxOutputLength: limit }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new BridgeError('SESSION_TOO_LARGE', 'Decompressed session exceeds 512 MiB.');
    throw new BridgeError('INVALID_COMPRESSION', 'Invalid Zstandard session.');
  }
}
