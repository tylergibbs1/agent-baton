/** Native reads; exclusive, durable writes remain in the store transaction. */
export async function readBytes(path: string): Promise<Buffer> {
  return Buffer.from(await Bun.file(path).arrayBuffer());
}
