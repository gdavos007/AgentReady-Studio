/**
 * AgentGrade — declarative & static discovery.
 *
 * Runs in Node (not in the page). Fetches the well-known agent descriptors and
 * mines the raw HTML for declarative WebMCP annotations that never made it into
 * the live DOM (e.g. markup removed by hydration).
 */

import type {
  DeclarativeToolTag,
  DescriptorProbe,
  JsonValue,
  RegisteredTool,
  ToolInputSchema,
  ToolSource,
} from './types.js';
import { MAX_DESCRIPTOR_BYTES } from './types.js';

/** Minimal structural view of Playwright's `APIRequestContext`. */
export interface FetchLike {
  get(
    url: string,
    options?: { timeout?: number; failOnStatusCode?: boolean; maxRedirects?: number; headers?: Record<string, string> },
  ): Promise<{
    status(): number;
    headers(): Record<string, string>;
    text(): Promise<string>;
  }>;
}

/** The descriptors probed on every scan, in a fixed order. */
export const DESCRIPTOR_PATHS: ReadonlyArray<{ kind: DescriptorProbe['kind']; path: string; alternates: string[] }> = [
  { kind: 'well-known-mcp', path: '/.well-known/mcp', alternates: ['/.well-known/mcp.json'] },
  { kind: 'well-known-agent', path: '/.well-known/agent.json', alternates: ['/.well-known/agent-card.json'] },
  { kind: 'llms-txt', path: '/llms.txt', alternates: [] },
];

const truncate = (value: string): string =>
  value.length > MAX_DESCRIPTOR_BYTES ? value.slice(0, MAX_DESCRIPTOR_BYTES) : value;

const safeParseJson = (text: string): JsonValue | null => {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return null;
  }
};

const emptySchema = (): ToolInputSchema => ({
  raw: null,
  type: null,
  propertyNames: [],
  required: [],
  isStructured: false,
});

/** Normalises an arbitrary JSON schema-ish value into {@link ToolInputSchema}. */
export function normaliseInputSchema(raw: unknown): ToolInputSchema {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptySchema();
  const record = raw as Record<string, unknown>;
  const properties =
    record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : null;
  const propertyNames = properties ? Object.keys(properties).slice(0, 100) : [];
  const required = Array.isArray(record.required) ? record.required.map(String).slice(0, 100) : [];
  return {
    raw: raw as JsonValue,
    type: typeof record.type === 'string' ? record.type : null,
    propertyNames,
    required,
    isStructured: propertyNames.length > 0 || typeof record.type === 'string',
  };
}

const collapse = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 400) : '';

const slugify = (value: string, fallback: string): string => {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
  return slug || fallback;
};

/**
 * Fetches one descriptor, trying its alternate paths in order. Never throws:
 * transport failures land in {@link DescriptorProbe.error}.
 */
export async function probeDescriptor(
  request: FetchLike,
  origin: string,
  descriptor: (typeof DESCRIPTOR_PATHS)[number],
  timeoutMs: number,
): Promise<DescriptorProbe> {
  const candidates = [descriptor.path, ...descriptor.alternates];
  let last: DescriptorProbe | null = null;

  for (const path of candidates) {
    const url = new URL(path, origin).toString();
    const probe: DescriptorProbe = {
      url,
      kind: descriptor.kind,
      found: false,
      status: null,
      contentType: null,
      body: null,
      json: null,
      byteLength: 0,
      error: null,
    };
    try {
      const response = await request.get(url, {
        timeout: timeoutMs,
        failOnStatusCode: false,
        maxRedirects: 5,
        headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' },
      });
      probe.status = response.status();
      const headers = response.headers();
      probe.contentType = (headers['content-type'] || '').toLowerCase() || null;
      const text = await response.text();
      probe.byteLength = text.length;
      probe.body = truncate(text);

      // A SPA that answers 200 with its HTML shell is not a descriptor.
      const looksLikeHtml =
        (probe.contentType || '').includes('text/html') || /^\s*<(!doctype|html)\b/i.test(text.slice(0, 200));

      if (probe.status >= 200 && probe.status < 300 && text.trim().length > 0 && !looksLikeHtml) {
        probe.json = safeParseJson(text);
        probe.found = descriptor.kind === 'llms-txt' ? true : probe.json !== null;
        if (!probe.found && descriptor.kind !== 'llms-txt') {
          probe.error = 'Response was not valid JSON';
        }
      } else if (looksLikeHtml && probe.status >= 200 && probe.status < 300) {
        probe.error = 'Received an HTML document instead of a descriptor (soft 404)';
      }
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
    }

    if (probe.found) return probe;
    last = probe;
  }

  return (
    last ?? {
      url: new URL(descriptor.path, origin).toString(),
      kind: descriptor.kind,
      found: false,
      status: null,
      contentType: null,
      body: null,
      json: null,
      byteLength: 0,
      error: 'No candidate path was attempted',
    }
  );
}

/** Fetches every descriptor in {@link DESCRIPTOR_PATHS}. */
export async function probeAllDescriptors(
  request: FetchLike,
  origin: string,
  timeoutMs: number,
): Promise<DescriptorProbe[]> {
  return Promise.all(DESCRIPTOR_PATHS.map((descriptor) => probeDescriptor(request, origin, descriptor, timeoutMs)));
}

/** Pulls a tool array out of the many shapes real manifests use. */
function extractToolArray(payload: JsonValue | null): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const buckets: unknown[] = [
    record.tools,
    record.skills,
    record.capabilities,
    record.functions,
    record.actions,
    (record.server as Record<string, unknown> | undefined)?.tools,
    (record.mcp as Record<string, unknown> | undefined)?.tools,
  ];
  const out: Record<string, unknown>[] = [];
  for (const bucket of buckets) {
    if (Array.isArray(bucket)) {
      for (const entry of bucket.slice(0, 500)) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.push(entry as Record<string, unknown>);
      }
    } else if (bucket && typeof bucket === 'object') {
      for (const [key, entry] of Object.entries(bucket as Record<string, unknown>).slice(0, 500)) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          out.push({ name: key, ...(entry as Record<string, unknown>) });
        }
      }
    }
  }
  return out;
}

/** Converts descriptor payloads into {@link RegisteredTool}s. */
export function toolsFromDescriptors(probes: DescriptorProbe[]): RegisteredTool[] {
  const tools: RegisteredTool[] = [];

  for (const probe of probes) {
    if (!probe.found) continue;

    if (probe.kind === 'llms-txt') {
      tools.push(...toolsFromLlmsTxt(probe));
      continue;
    }

    const source: ToolSource = probe.kind === 'well-known-mcp' ? 'well-known-mcp' : 'well-known-agent';
    extractToolArray(probe.json).forEach((entry, index) => {
      const name = collapse(entry.name ?? entry.id ?? entry.title);
      const description = collapse(entry.description ?? entry.summary ?? entry.purpose) || null;
      const schemaRaw =
        entry.inputSchema ?? entry.input_schema ?? entry.parameters ?? entry.params ?? entry.schema ?? null;
      tools.push({
        id: `${source}:${slugify(name, `anonymous-${index}`)}`,
        name,
        description,
        inputSchema: normaliseInputSchema(schemaRaw),
        outputSchema: (entry.outputSchema ?? entry.output_schema ?? entry.returns ?? null) as JsonValue | null,
        source,
        executable: false,
        annotations:
          entry.annotations && typeof entry.annotations === 'object' && !Array.isArray(entry.annotations)
            ? (entry.annotations as Record<string, JsonValue>)
            : {},
        selector: null,
        manifestUrl: probe.url,
      });
    });
  }

  return tools;
}

/**
 * `/llms.txt` is prose, not a schema. We extract the markdown link list, which
 * is the closest thing the format has to a capability declaration.
 */
function toolsFromLlmsTxt(probe: DescriptorProbe): RegisteredTool[] {
  const body = probe.body ?? '';
  const tools: RegisteredTool[] = [];
  const seen = new Set<string>();
  const linkPattern = /^\s*[-*]\s*\[([^\]]{1,120})\]\(([^)\s]{1,500})\)\s*:?\s*(.*)$/gm;

  let match = linkPattern.exec(body);
  let index = 0;
  while (match !== null && tools.length < 200) {
    const name = collapse(match[1]);
    const id = `llms-txt:${slugify(name, `entry-${index}`)}`;
    if (!seen.has(id)) {
      seen.add(id);
      tools.push({
        id,
        name,
        description: collapse(match[3]) || null,
        inputSchema: emptySchema(),
        outputSchema: null,
        source: 'llms-txt',
        executable: false,
        annotations: { href: match[2].slice(0, 500) },
        selector: null,
        manifestUrl: probe.url,
      });
    }
    index++;
    match = linkPattern.exec(body);
  }

  return tools;
}

/** Converts declarative DOM/HTML tags into {@link RegisteredTool}s. */
export function toolsFromTags(tags: DeclarativeToolTag[]): RegisteredTool[] {
  return tags
    .filter((tag) => tag.name || tag.description || tag.inlineSchema)
    .map((tag, index) => {
      const source: ToolSource = tag.tagName === 'form' ? 'declarative-form' : 'declarative-element';
      const schemaRaw =
        tag.inlineSchema ??
        safeParseJson(tag.attributes['input-schema'] ?? tag.attributes['data-mcp-schema'] ?? '') ??
        null;
      return {
        id: `${source}:${slugify(tag.name, `anonymous-${index}`)}`,
        name: tag.name,
        description: tag.description,
        inputSchema: normaliseInputSchema(schemaRaw),
        outputSchema: null,
        source,
        executable: false,
        annotations: Object.fromEntries(
          Object.entries(tag.attributes)
            .filter(([key]) => key.startsWith('data-mcp-') || key === 'method' || key === 'action')
            .slice(0, 20),
        ) as Record<string, JsonValue>,
        selector: tag.selector,
        manifestUrl: null,
      } satisfies RegisteredTool;
    });
}

/**
 * Scans raw served HTML for declarative WebMCP annotations. This complements
 * the live-DOM pass: markup that hydration removes, or that never executes
 * because a script failed, is still a declaration of intent.
 */
export function scanStaticHtmlForToolTags(html: string): DeclarativeToolTag[] {
  const tags: DeclarativeToolTag[] = [];
  if (!html) return tags;

  const parseAttributes = (source: string): Record<string, string> => {
    const attributes: Record<string, string> = {};
    const pattern = /([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let match = pattern.exec(source);
    while (match !== null && Object.keys(attributes).length < 40) {
      attributes[match[1].toLowerCase()] = (match[3] ?? match[4] ?? match[5] ?? '').slice(0, 1000);
      match = pattern.exec(source);
    }
    return attributes;
  };

  const record = (tagName: string, attributes: Record<string, string>, inner: string | null): void => {
    if (tags.length >= 200) return;
    const name =
      collapse(
        attributes['name'] ??
          attributes['data-mcp-tool'] ??
          attributes['data-tool-name'] ??
          attributes['data-agent-tool'] ??
          attributes['id'] ??
          '',
      ) || '';
    const description =
      collapse(
        attributes['description'] ?? attributes['data-mcp-description'] ?? attributes['data-tool-description'] ?? '',
      ) || null;
    const inlineSchema =
      safeParseJson(attributes['input-schema'] ?? attributes['data-mcp-schema'] ?? attributes['schema'] ?? '') ??
      (inner ? safeParseJson(inner) : null);
    tags.push({
      tagName,
      selector: name ? `${tagName}[name="${name}"]` : tagName,
      name,
      description,
      attributes,
      inlineSchema,
      staticOnly: true,
    });
  };

  const elementPattern =
    /<(tool-definition|mcp-tool|agent-tool|webmcp-tool)\b([^>]*)>([\s\S]{0,20000}?)<\/\1\s*>|<(tool-definition|mcp-tool|agent-tool|webmcp-tool)\b([^>]*?)\/?>/gi;
  let match = elementPattern.exec(html);
  while (match !== null) {
    if (match[1]) record(match[1].toLowerCase(), parseAttributes(match[2] ?? ''), match[3] ?? null);
    else if (match[4]) record(match[4].toLowerCase(), parseAttributes(match[5] ?? ''), null);
    match = elementPattern.exec(html);
  }

  const annotatedPattern = /<([a-zA-Z][-\w]*)\b([^>]*\bdata-(?:mcp-tool|agent-tool|tool-name)\s*=[^>]*)>/gi;
  match = annotatedPattern.exec(html);
  while (match !== null) {
    record(match[1].toLowerCase(), parseAttributes(match[2] ?? ''), null);
    match = annotatedPattern.exec(html);
  }

  return tags;
}

/**
 * Merges the live-DOM tags with static-HTML tags, keeping the DOM version when
 * both describe the same tool (the DOM copy carries a real selector).
 */
export function mergeTags(domTags: DeclarativeToolTag[], staticTags: DeclarativeToolTag[]): DeclarativeToolTag[] {
  const keyOf = (tag: DeclarativeToolTag): string => `${tag.tagName}|${tag.name.toLowerCase()}`;
  const merged = new Map<string, DeclarativeToolTag>();
  for (const tag of domTags) merged.set(keyOf(tag), tag);
  for (const tag of staticTags) {
    const key = keyOf(tag);
    if (!merged.has(key)) merged.set(key, tag);
  }
  return Array.from(merged.values());
}
