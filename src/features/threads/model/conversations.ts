import type {
  ConversationAttachment,
  ConversationItem,
  ConversationRequest,
  ConversationThread,
  RequestReference,
} from '../types';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const json = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
};
const parseJSON = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/** Keep the log's timestamps intact: the backend does not declare their timezone. */
export function extractRequestReferences(lines: string[]): RequestReference[] {
  const requests = new Map<string, RequestReference>();
  for (const [sequence, line] of lines.entries()) {
    const match = line.match(
      /\[([\w-]{6,64})\].*?\b(\d{3})\s*\|\s*([^|]*)\|[^|]*\|\s*POST\s+"?([^"\s]+)/
    );
    if (
      !match ||
      !/\/(responses|chat\/completions|messages|completions|interactions)(?:[/?]|$)|:streamGenerateContent|:generateContent/.test(
        match[4]
      )
    ) {
      continue;
    }
    const timestamp = line.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/)?.[0] ?? '';
    requests.set(match[1], {
      id: match[1],
      timestamp,
      path: match[4],
      status: Number(match[2]),
      duration: match[3].trim(),
      sequence,
    });
  }
  return [...requests.values()];
}

function sections(text: string): Map<string, string> {
  const matches = [...text.matchAll(/^=== ([A-Z][A-Z0-9 _-]*) ===\r?$/gm)];
  const result = new Map<string, string>();
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    result.set(match[1], text.slice(start, matches[index + 1]?.index ?? text.length).trim());
  });
  return result;
}

function headers(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index > 0) result[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return result;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return array(content)
    .map((part) => {
      const item = record(part);
      if (typeof part === 'string') return part;
      return string(item.text) || string(item.refusal);
    })
    .filter(Boolean)
    .join('\n\n');
}

function attachments(content: unknown): ConversationAttachment[] {
  return array(content).flatMap((part): ConversationAttachment[] => {
    const item = record(part);
    const type = string(item.type);
    if (['input_image', 'image_url', 'image'].includes(type)) {
      // Never load a logged remote URL automatically or expose huge data URLs in the DOM.
      return [{ type: 'image', name: string(item.detail) || 'image' }];
    }
    if (['input_file', 'file', 'document'].includes(type)) {
      return [{ type: 'file', name: string(item.filename) || string(item.file_id) || 'file' }];
    }
    return [];
  });
}

export function cleanUserText(text: string): string {
  return text
    .replace(
      /<(environment_context|t3_context|permissions instructions|turn_aborted)\b[^>]*>[\s\S]*?<\/\1>/g,
      ''
    )
    .trim();
}

function normalizeItems(values: unknown[], requestId: string): ConversationItem[] {
  return values.flatMap((value, index): ConversationItem[] => {
    const item = record(value);
    const type = string(item.type);
    const role = string(item.role) || 'assistant';
    const base = { id: string(item.id), requestId };
    if (type === 'reasoning' || type === 'thinking') {
      const text = contentText(item.summary) || string(item.thinking);
      return text ? [{ ...base, kind: 'reasoning', role: 'assistant', text }] : [];
    }
    if (
      type === 'function_call_output' ||
      type === 'custom_tool_call_output' ||
      type === 'tool_result' ||
      role === 'tool'
    ) {
      return [
        {
          ...base,
          kind: 'tool-result',
          role: 'tool',
          callId: string(item.call_id) || string(item.tool_call_id) || string(item.tool_use_id),
          name: string(item.name),
          text: json(item.output ?? item.content),
        },
      ];
    }
    if (
      type === 'function_call' ||
      type === 'custom_tool_call' ||
      type === 'tool_use' ||
      type.endsWith('_call')
    ) {
      return [
        {
          ...base,
          kind: 'tool',
          role: 'assistant',
          callId: string(item.call_id) || string(item.id),
          name:
            [string(item.namespace), string(item.name)].filter(Boolean).join('.') ||
            type.replace(/_call$/, ''),
          arguments: json(item.arguments ?? item.input ?? item.action),
          output: json(item.output ?? item.results),
          text: '',
        },
      ];
    }
    if (type === 'additional_tools' || type === 'tool_search_output') return [];
    const result: ConversationItem[] = [];
    const blocks = array(item.content);
    const text = contentText(item.content) || string(item.text);
    const files = attachments(item.content);
    if (text || files.length) {
      const context =
        role === 'system' ||
        role === 'developer' ||
        (role === 'user' && text.length > 0 && !cleanUserText(text));
      result.push({
        ...base,
        kind: 'message',
        role,
        text: role === 'user' && !context ? cleanUserText(text) : text,
        attachments: files,
        phase: string(item.phase),
        context,
      });
    }
    for (const block of blocks) {
      const blockType = string(record(block).type);
      if (['tool_use', 'tool_result', 'thinking'].includes(blockType)) {
        result.push(...normalizeItems([block], requestId));
      }
    }
    for (const call of array(item.tool_calls)) {
      const tool = record(call);
      const fn = record(tool.function);
      result.push(
        ...normalizeItems(
          [{ ...fn, id: tool.id, call_id: tool.id, type: 'function_call' }],
          requestId
        )
      );
    }
    if (item.function_call) {
      result.push(
        ...normalizeItems(
          [
            {
              ...record(item.function_call),
              type: 'function_call',
              call_id: `${requestId}-${index}`,
            },
          ],
          requestId
        )
      );
    }
    return result;
  });
}

function responsePayload(text: string): {
  output: unknown[];
  responseId?: string;
  usage: RecordValue;
  error?: string;
} {
  const events: RecordValue[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    const event = record(parseJSON(data));
    if (Object.keys(event).length) events.push(event);
  }
  const raw = record(parseJSON(text.slice(text.indexOf('{'))));
  const output = new Map<string, RecordValue>();
  let response = raw;
  let streamedText = '';
  const chatTools = new Map<number, RecordValue>();
  const anthropicBlocks = new Map<number, RecordValue>();
  for (const event of events) {
    const type = string(event.type);
    if (event.response) response = record(event.response);
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = record(event.item);
      output.set(string(item.id) || String(event.output_index), item);
    } else if (type.endsWith('.delta') && event.item_id) {
      const id = string(event.item_id);
      const item = output.get(id) ?? { id, type: 'message', role: 'assistant' };
      if (type === 'response.output_text.delta') {
        const content = array(item.content).map(record);
        const index = number(event.content_index);
        content[index] = {
          type: 'output_text',
          text: string(content[index]?.text) + string(event.delta),
        };
        item.content = content;
      } else if (type === 'response.function_call_arguments.delta') {
        item.arguments = string(item.arguments) + string(event.delta);
      } else if (type === 'response.custom_tool_call_input.delta') {
        item.input = string(item.input) + string(event.delta);
      } else if (type === 'response.reasoning_summary_text.delta') {
        const summary = array(item.summary).map(record);
        const index = number(event.summary_index);
        summary[index] = {
          type: 'summary_text',
          text: string(summary[index]?.text) + string(event.delta),
        };
        item.summary = summary;
      }
      output.set(id, item);
    }
    const choice = record(array(event.choices)[0]);
    const delta = record(choice.delta);
    streamedText += string(delta.content);
    for (const value of array(delta.tool_calls)) {
      const tool = record(value);
      const index = number(tool.index);
      const old = chatTools.get(index) ?? {};
      const fn = record(tool.function);
      chatTools.set(index, {
        type: 'function_call',
        id: string(tool.id) || old.id,
        call_id: string(tool.id) || old.id,
        name: string(fn.name) || old.name,
        arguments: string(old.arguments) + string(fn.arguments),
      });
    }
    if (type === 'content_block_start')
      anthropicBlocks.set(number(event.index), record(event.content_block));
    if (type === 'content_block_delta') {
      const index = number(event.index);
      const block = anthropicBlocks.get(index) ?? {};
      const change = record(event.delta);
      if (change.text) block.text = string(block.text) + string(change.text);
      if (change.thinking) block.thinking = string(block.thinking) + string(change.thinking);
      if (change.partial_json)
        block.arguments = string(block.arguments) + string(change.partial_json);
      anthropicBlocks.set(index, block);
    }
  }
  let values = array(response.output);
  if (!values.length) values = [...output.values()];
  if (!values.length && array(response.choices).length) {
    values = [record(array(response.choices)[0]).message];
  }
  if (!values.length && array(response.content).length)
    values = [{ role: 'assistant', content: response.content }];
  if (!values.length && (streamedText || chatTools.size)) {
    values = [
      ...chatTools.values(),
      ...(streamedText ? [{ role: 'assistant', content: streamedText }] : []),
    ];
  }
  if (!values.length && anthropicBlocks.size) {
    values = [{ role: 'assistant', content: [...anthropicBlocks.values()] }];
  }
  const error = record(response.error);
  return {
    output: values,
    responseId: string(response.id) || undefined,
    usage: record(response.usage),
    error: string(error.message) || undefined,
  };
}

export function parseConversationRequest(
  text: string,
  reference: RequestReference
): ConversationRequest {
  const parts = sections(text);
  const body = record(parseJSON(parts.get('REQUEST BODY') ?? ''));
  if (!Object.keys(body).length) throw new Error('Request body is missing or is not valid JSON');
  const requestHeaders = headers(parts.get('HEADERS') ?? '');
  const metadata = { ...record(body.metadata), ...record(body.client_metadata) };
  const turn = record(
    parseJSON(requestHeaders['x-codex-turn-metadata'] || string(metadata['x-codex-turn-metadata']))
  );
  const threadId =
    requestHeaders['thread-id'] ||
    string(metadata.thread_id) ||
    string(turn.thread_id) ||
    requestHeaders['session-id'] ||
    string(metadata.session_id) ||
    string(turn.session_id) ||
    string(record(body.conversation).id) ||
    string(body.conversation) ||
    (/^[\w-]{24,}$/.test(string(body.prompt_cache_key)) ? string(body.prompt_cache_key) : '');
  let input: unknown[];
  if (typeof body.input === 'string') input = [{ role: 'user', content: body.input }];
  else input = array(body.input ?? body.messages);
  const instruction = string(body.instructions) || contentText(body.system);
  if (instruction) input = [{ role: 'system', content: instruction }, ...input];
  const response = responsePayload(parts.get('RESPONSE') ?? '');
  const info = parts.get('REQUEST INFO') ?? '';
  const items = [
    ...normalizeItems(input, reference.id),
    ...normalizeItems(response.output, reference.id),
  ];
  if (response.error)
    items.push({
      id: '',
      kind: 'error',
      role: 'system',
      text: response.error,
      requestId: reference.id,
    });
  return {
    ...reference,
    timestamp: info.match(/^Timestamp:\s*(.+)$/m)?.[1] || reference.timestamp,
    path: reference.path || info.match(/^URL:\s*(.+)$/m)?.[1] || '',
    model: string(body.model),
    client: requestHeaders.originator || requestHeaders['user-agent']?.split('/')[0] || '',
    threadId: threadId || undefined,
    responseId: response.responseId,
    previousResponseId: string(body.previous_response_id) || undefined,
    items,
    inputTokens: number(response.usage.input_tokens ?? response.usage.prompt_tokens),
    outputTokens: number(response.usage.output_tokens ?? response.usage.completion_tokens),
  };
}

function identity(item: ConversationItem): string {
  if (item.id) return `${item.kind}:${item.id}`;
  if (item.callId) return `${item.kind}:${item.callId}`;
  return JSON.stringify([
    item.kind,
    item.role,
    item.text,
    item.name,
    item.arguments,
    item.attachments,
  ]);
}

/** Stitch snapshots by ordered anchors; repeated short messages retain their multiplicity. */
export function mergeConversation(
  existing: ConversationItem[],
  incoming: ConversationItem[]
): ConversationItem[] {
  if (!existing.length) return [...incoming];
  const incomingKeys = incoming.map(identity);
  const existingKeys = existing.map(identity);
  const commonLength = Math.min(existing.length, incoming.length);
  let sharedPrefix = 0;
  while (sharedPrefix < commonLength && existingKeys[sharedPrefix] === incomingKeys[sharedPrefix]) {
    sharedPrefix++;
  }
  // Full-history replays normally share a prefix. Avoid building an index in that common case.
  if (sharedPrefix === commonLength) {
    return existing
      .map((item, index) =>
        index < incoming.length ? { ...item, ...incoming[index], requestId: item.requestId } : item
      )
      .concat(incoming.slice(existing.length));
  }
  const positions = new Map<string, number[]>();
  existingKeys.forEach((key, index) => {
    const indices = positions.get(key);
    if (indices) indices.push(index);
    else positions.set(key, [index]);
  });
  const firstAnchor = incomingKeys.find((key) => positions.has(key));
  if (firstAnchor === undefined) return [...existing, ...incoming];
  let cursor = positions.get(firstAnchor)![0];
  const result = existing.slice(0, cursor);
  incoming.forEach((item, itemIndex) => {
    const indices = positions.get(incomingKeys[itemIndex]) ?? [];
    // Find the next unused occurrence without scanning the whole conversation.
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (indices[middle] < cursor) low = middle + 1;
      else high = middle;
    }
    const index = indices[low];
    if (index !== undefined) {
      while (cursor < index) result.push(existing[cursor++]);
      result.push({ ...existing[index], ...item, requestId: existing[index].requestId });
      cursor = index + 1;
    } else result.push(item);
  });
  while (cursor < existing.length) result.push(existing[cursor++]);
  return result;
}

function pairTools(items: ConversationItem[]): ConversationItem[] {
  const results = new Map<string, string>();
  const calls = new Set(
    items
      .filter((item) => item.kind === 'tool')
      .map((item) => item.callId)
      .filter(Boolean)
  );
  for (const item of items) {
    if (item.kind === 'tool-result' && item.callId) results.set(item.callId, item.text);
  }
  return items.flatMap((item) => {
    if (item.kind === 'tool-result' && item.callId && calls.has(item.callId)) return [];
    if (item.kind === 'tool' && item.callId && results.has(item.callId))
      return [{ ...item, output: results.get(item.callId) }];
    return [item];
  });
}

export function groupConversationRequests(requests: ConversationRequest[]) {
  const ordered = [...requests].sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) ||
      (a.sequence ?? 0) - (b.sequence ?? 0) ||
      a.id.localeCompare(b.id)
  );
  const byResponse = new Map(ordered.filter((r) => r.responseId).map((r) => [r.responseId, r]));
  function group(request: ConversationRequest, seen = new Set<string>()): string {
    if (request.threadId) return request.threadId;
    if (seen.has(request.id)) return `request:${request.id}`;
    seen.add(request.id);
    const parent = byResponse.get(request.previousResponseId);
    return parent ? group(parent, seen) : `request:${request.id}`;
  }
  const groups = new Map<string, ConversationRequest[]>();
  for (const request of ordered) {
    const id = group(request);
    const entries = groups.get(id);
    if (entries) entries.push(request);
    else groups.set(id, [request]);
  }
  return groups;
}

export function mergeConversationRequestItems(
  all: ConversationItem[],
  request: ConversationRequest
) {
  if (request.previousResponseId) {
    const ids = new Set(all.filter((item) => item.id).map(identity));
    return [...all, ...request.items.filter((item) => !item.id || !ids.has(identity(item)))];
  }
  return mergeConversation(all, request.items);
}

export function buildConversationThreads(requests: ConversationRequest[]): ConversationThread[] {
  const groups = groupConversationRequests(requests);
  return [...groups]
    .map(([id, entries]): ConversationThread => {
      const items = pairTools(
        entries.reduce(mergeConversationRequestItems, [] as ConversationItem[])
      );
      const users = items.filter(
        (item) => item.kind === 'message' && item.role === 'user' && !item.context
      );
      const visible = items.filter((item) => item.kind === 'message' && !item.context);
      const title = (users.find((item) => item.text.trim())?.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
      return {
        id,
        title,
        preview: visible[visible.length - 1]?.text.replace(/\s+/g, ' ').slice(0, 180) ?? '',
        timestamp: entries[entries.length - 1]?.timestamp ?? '',
        client: entries.find((r) => r.client)?.client ?? '',
        models: [...new Set(entries.map((r) => r.model).filter(Boolean))],
        requests: entries,
        items,
        inputTokens: entries.reduce((n, r) => n + r.inputTokens, 0),
        outputTokens: entries.reduce((n, r) => n + r.outputTokens, 0),
        ungrouped: id.startsWith('request:'),
        hasErrors: entries.some(
          (r) => (r.status ?? 0) >= 400 || r.items.some((item) => item.kind === 'error')
        ),
      };
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
}

export function threadMatches(thread: ConversationThread, query: string): boolean {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = [
    thread.title,
    thread.id,
    thread.client,
    ...thread.models,
    ...thread.items.flatMap((i) => [i.text, i.name ?? '', i.arguments ?? '', i.output ?? '']),
  ]
    .join('\n')
    .toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}

export function exportConversation(thread: ConversationThread): string {
  return (
    `# ${thread.title || thread.id}\n\n` +
    thread.items
      .filter((item) => !item.context)
      .map((item) => {
        if (item.kind === 'tool')
          return `### ${item.name}\n\n\`\`\`json\n${item.arguments || ''}\n\`\`\`\n\n\`\`\`text\n${item.output || ''}\n\`\`\``;
        return `### ${item.kind === 'message' ? item.role : item.kind}\n\n${item.text}`;
      })
      .join('\n\n')
  );
}
