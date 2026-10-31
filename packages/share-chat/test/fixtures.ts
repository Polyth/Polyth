// Synthetic share-page builders. Every text here is invented for tests.

/** Encodes a value the way React Router's turbo-stream does: one flat array,
 *  objects as `{"_<keyIndex>": valueIndex}`, shared values deduplicated, so
 *  cyclic references are representable. null → -5, undefined → -7. */
export function flatten(root: unknown): unknown[] {
  const values: unknown[] = [];
  const known = new Map<unknown, number>();
  const visit = (value: unknown): number => {
    if (value === null) return -5;
    if (value === undefined) return -7;
    const identity = typeof value === "object" ? value : `${typeof value}:${String(value)}`;
    const existing = known.get(identity);
    if (existing !== undefined) return existing;
    const index = values.length;
    values.push(null);
    known.set(identity, index);
    if (Array.isArray(value)) values[index] = value.map(visit);
    else if (typeof value === "object") {
      const encoded: Record<string, number> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) encoded[`_${visit(key)}`] = visit(item);
      values[index] = encoded;
    } else values[index] = value;
    return index;
  };
  visit(root);
  return values;
}

export interface MessageOptions {
  id?: string;
  contentType?: string;
  recipient?: string;
  channel?: string;
  hidden?: boolean;
  parts?: unknown[];
}

let sequence = 0;

export function message(role: string, text: string, seconds: number | null, options: MessageOptions = {}): Record<string, unknown> {
  sequence += 1;
  return {
    id: options.id ?? `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    author: { role, name: null, metadata: {} },
    create_time: seconds,
    update_time: null,
    content: { content_type: options.contentType ?? "text", parts: options.parts ?? [text] },
    status: "finished_successfully",
    end_turn: true,
    weight: 1,
    metadata: options.hidden ? { is_visually_hidden_from_conversation: true } : {},
    recipient: options.recipient ?? "all",
    ...(options.channel ? { channel: options.channel } : {}),
  };
}

/** Loader data shaped like a share page: the conversation's `mapping` holds
 *  linked (cyclic) nodes and `linear_conversation` holds separate copies. */
export function shareLoaderData(title: string, messages: Record<string, unknown>[]): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = messages.map((item) => ({ id: item.id, message: item, parent: null, children: [] }));
  nodes.forEach((node, index) => {
    const previous = nodes[index - 1];
    if (previous) {
      node.parent = previous.id;
      node.parentNode = previous;
      (previous.children as unknown[]).push(node.id);
      previous.childNode = node;
    }
  });
  return {
    loaderData: {
      root: { locale: "en" },
      "routes/share.$shareId.($action)": {
        sharedConversationId: "11111111-2222-4333-8444-555555555555",
        serverResponse: {
          type: "data",
          data: {
            title,
            create_time: 1_700_000_000,
            mapping: Object.fromEntries(nodes.map((node) => [node.id, node])),
            linear_conversation: nodes.map((node) => ({ id: node.id, message: structuredClone(node.message), parent: node.parent })),
            is_public: true,
          },
        },
      },
    },
    actionData: null,
    errors: null,
  };
}

/** Wraps a stream payload in `streamController.enqueue("…")` calls, split across chunks. */
export function sharePage(stream: string, chunks = 2): string {
  const size = Math.ceil(stream.length / chunks);
  const scripts: string[] = [];
  for (let start = 0; start < stream.length; start += size) {
    scripts.push(`<script nonce="n">window.__reactRouterContext.streamController.enqueue(${JSON.stringify(stream.slice(start, start + size))});</script>`);
  }
  return `<!DOCTYPE html><html lang="en"><head><title>Shared chat</title></head><body><div id="root"></div>${scripts.join("")}</body></html>`;
}

export function pageFor(title: string, messages: Record<string, unknown>[], extraLines: string[] = []): string {
  return sharePage([JSON.stringify(flatten(shareLoaderData(title, messages))), ...extraLines].join("\n") + "\n");
}
