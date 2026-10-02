import { arr, row, str, text, hash, contentBlocks, type Block, type Message, type Row } from './model.ts';

/** Canonical desktop items are conversation evidence when response items are absent. */
export function canonicalMessage(record: Row): Message | undefined {
  const payload = row(record.payload), item = row(payload.item), rawKind = str(item.type), kind = rawKind ? rawKind[0].toUpperCase() + rawKind.slice(1) : undefined;
  const id = str(item.id), timestamp = str(record.timestamp);
  let role = 'assistant', blocks: Block[] = [];
  if (kind === 'UserMessage') {
    role = 'user'; blocks = contentBlocks(arr(item.content).map(v => {
      const b = row(v);
      if (b.type === 'image') return { type: 'input_image', image_url: b.image_url ?? b.imageUrl ?? b.url };
      if (['local_image', 'localImage'].includes(String(b.type))) return { type: 'image', path: b.path };
      return b;
    }));
  } else if (kind === 'AgentMessage') blocks = contentBlocks(arr(item.content).map(v => {
    const b = row(v); return b.type === 'Text' ? { type: 'text', text: b.text } : b;
  }));
  else if (kind === 'Reasoning') blocks = [{ kind: 'reasoning', text: '', format: kind }];
  else if (kind === 'DynamicToolCall' || kind === 'McpToolCall') {
    blocks = [{ kind: 'tool_call', name: kind === 'McpToolCall' ? `${str(item.server) ?? 'mcp'}__${str(item.tool) ?? 'tool'}` : str(item.tool), callId: id, text: text(item.arguments ?? {}) }];
    const parts = contentBlocks(arr(item.content_items ?? item.contentItems ?? row(item.result).content).map(v => {
      const b = row(v);
      if (b.type === 'inputText') return { type: 'text', text: b.text };
      if (b.type === 'inputImage') return { type: 'input_image', image_url: b.imageUrl };
      if (b.type === 'inputAudio') return { type: 'input_audio', audio_url: b.audioUrl };
      return b;
    }));
    const output = parts.map(b => b.kind === 'media' ? '[Attachment]' : b.text).join('\n');
    if (output || item.error || !['in_progress', 'inProgress'].includes(String(item.status))) blocks.push({ kind: 'tool_result', callId: id,
      text: output || (item.error ? text(item.error) : ''), isError: item.status === 'failed' || item.success === false || row(item.result).isError === true });
    blocks.push(...parts.filter(b => b.kind === 'media'));
  } else if (kind === 'CommandExecution') {
    blocks = [{ kind: 'tool_call', name: 'exec_command', callId: id, text: text({ cmd: Array.isArray(item.command) ? item.command.join(' ') : item.command, argv: item.command, cwd: item.cwd }) }];
    if (!['in_progress', 'inProgress'].includes(String(item.status))) blocks.push({ kind: 'tool_result', callId: id, text: str(item.aggregated_output ?? item.aggregatedOutput) ?? str(item.formatted_output ?? item.formattedOutput) ?? [str(item.stdout), str(item.stderr)].filter(Boolean).join('\n'), isError: item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0) });
  } else if (kind === 'CollabAgentToolCall') {
    blocks = [{ kind: 'tool_call', name: str(item.tool) ?? 'agent_event', callId: id, text: text(item) }];
    if (!['in_progress', 'inProgress'].includes(String(item.status))) blocks.push({ kind: 'tool_result', callId: id, text: text(item.agents_states ?? item.agentsStates ?? item), isError: item.status === 'failed' });
  } else if (kind === 'Plan') blocks = [{ kind: 'summary', text: str(item.text) ?? text(item), format: kind }];
  else if (kind) blocks = [{ kind: 'unsupported', text: text(item), format: kind }];
  return blocks.length ? { role, blocks, id, timestamp } : undefined;
}

export function blockSignature(role: string, block: Block): string {
  let value = block.text;
  if (block.kind === 'tool_call') {
    try { value = JSON.stringify(JSON.parse(value), (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v); } catch { /* Custom tools may accept plain text. */ }
  }
  if (block.kind === 'media') {
    const asset = block.asset;
    value = JSON.stringify([asset?.mime, asset?.data ? hash(asset.data) : asset?.path ?? asset?.url ?? asset?.pointer ?? block.text]);
  }
  return JSON.stringify([role, block.kind, block.kind === 'tool_call' ? block.name : undefined, value]);
}
