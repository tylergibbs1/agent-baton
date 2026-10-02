import type { Block, Message } from './model.ts';

// Presentation changes never replace the blocks kept in the inverse bridge.
export function presentMessage(message: Message): { role: string; blocks: Block[] } {
  const record = message.metadata?.fields.record as Record<string, unknown> | undefined;
  const origin = record?.origin as Record<string, unknown> | undefined;
  if (message.metadata?.provider !== 'claude' || message.role !== 'user') return message;
  if (origin?.kind === 'peer' && message.blocks.length === 1 && message.blocks[0].kind === 'text') {
    const match = message.blocks[0].text.match(/^\s*(?:Another Claude session sent a message:\s*)?<cross-session-message\b([^<>]*)>([\s\S]*?)<\/cross-session-message>([\s\S]*)$/);
    if (match && !match[2].includes('<cross-session-message') && !match[3].includes('<cross-session-message')) {
      const sender = typeof origin.name === 'string' ? origin.name : match[1].match(/\bfrom-name="([^"]*)"/)?.[1];
      const label = (sender ?? 'unknown session').replace(/[\r\n\[\]]/g, ' ');
      const delivery = match[3].trim();
      const suffix = delivery ? `\n\n[Historical Claude delivery context]\n${delivery.split('\n').map(line => `> ${line}`).join('\n')}` : '';
      return { role: 'assistant', blocks: [{ kind: 'text', text: `[Historical Claude peer message from ${label}]\n${match[2].trim()}${suffix}` }] };
    }
  }
  if (!(origin?.kind === 'human' || record?.turnOrigin === 'human' || record?.promptSource === 'typed')) return message;
  return { role: message.role, blocks: message.blocks.map(block => block.kind !== 'text' ? block : {
    ...block, text: block.text.replace(/<pasted_content\s+id="[\w-]+">([\s\S]*?)<\/pasted_content>/g, (raw, body: string) => {
      if (body.includes('<pasted_content')) return raw;
      return `\n\n${body.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
    }),
  }) };
}
