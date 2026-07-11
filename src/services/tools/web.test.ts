import assert from 'node:assert/strict';
import test from 'node:test';
import { createFetchUrlTool, createWebSearchTool, htmlToText, isPrivateHost } from './web.ts';
import { ToolRegistry } from './registry.ts';
import { AgentService } from '../agent.ts';
import type { ForgeConfig, LLMRequest, LLMResponse, SearchConfig, ToolsConfig } from '../../types.ts';

function config(search: Partial<SearchConfig> = {}, tools: Partial<ToolsConfig> = {}): ForgeConfig {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'tester' },
    llm: {
      provider: 'ollama',
      model: 'local-model',
      ollama: { base_url: 'http://localhost:11434', keep_alive: '10m', options: {} },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: { retention_days: 30 },
    search: {
      searxng_url: 'http://localhost:8888',
      results: 3,
      timeout_ms: 8000,
      fetch_max_chars: 200,
      ...search,
    },
    tools: {
      enabled: true,
      max_iterations: 5,
      levels: { safe: false, network: true, filesystem: false, sensitive: false },
      filesystem: { readable_dirs: [], writable_dirs: [] },
      ...tools,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function searxngResults(count: number): unknown {
  return {
    results: Array.from({ length: count }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: `Snippet for result ${i}. ${'padding '.repeat(60)}`,
    })),
  };
}

// --- web_search ------------------------------------------------------------------

test('web_search queries SearXNG with format=json and returns a compact capped list', async () => {
  let requested = '';
  const fetchImpl: typeof fetch = async (url) => {
    requested = String(url);
    return jsonResponse(searxngResults(8));
  };
  const tool = createWebSearchTool(config(), { fetchImpl });

  const result = await tool.handler({ query: 'local ai companions' }) as {
    query: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  };

  assert.equal(requested, 'http://localhost:8888/search?q=local%20ai%20companions&format=json');
  assert.equal(result.results.length, 3); // capped by search.results
  assert.deepEqual(Object.keys(result.results[0]).sort(), ['snippet', 'title', 'url']);
  assert.equal(result.results[0].title, 'Result 0');
  assert.equal(result.results[0].url, 'https://example.com/0');
  assert.ok(result.results[0].snippet.length <= 301); // snippet clipped
});

test('web_search maps failures to clear errors: empty, non-200, 403, timeout, offline', async () => {
  const empty = createWebSearchTool(config(), { fetchImpl: async () => jsonResponse({ results: [] }) });
  await assert.rejects(empty.handler({ query: 'nothing' }) as Promise<unknown>, /No results found/);

  const serverError = createWebSearchTool(config(), { fetchImpl: async () => jsonResponse({}, 502) });
  await assert.rejects(serverError.handler({ query: 'q' }) as Promise<unknown>, /HTTP 502/);

  const forbidden = createWebSearchTool(config(), { fetchImpl: async () => jsonResponse({}, 403) });
  await assert.rejects(forbidden.handler({ query: 'q' }) as Promise<unknown>, /json format/);

  const timeout = createWebSearchTool(config(), {
    fetchImpl: async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    },
  });
  await assert.rejects(timeout.handler({ query: 'q' }) as Promise<unknown>, /timed out after 8000ms/);

  const offline = createWebSearchTool(config(), {
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(offline.handler({ query: 'q' }) as Promise<unknown>, /not reachable/);
});

// --- fetch_url -------------------------------------------------------------------

const PAGE = `<!doctype html><html><head><title> Test &amp; Page </title>
<style>body { color: red }</style><script>alert('injected')</script></head>
<body><h1>Heading</h1><p>First paragraph with &quot;entities&quot;.</p>
<p>${'Body text. '.repeat(60)}</p></body></html>`;

test('fetch_url extracts readable text, strips script/style, and caps the size', async () => {
  const fetchImpl: typeof fetch = async () => new Response(PAGE, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  const tool = createFetchUrlTool(config({ fetch_max_chars: 120 }), { fetchImpl });

  const result = await tool.handler({ url: 'https://example.com/article' }) as {
    url: string; title: string; content: string; truncated: boolean;
  };

  assert.equal(result.title, 'Test & Page');
  assert.ok(result.content.startsWith('Heading'));
  assert.match(result.content, /First paragraph with "entities"/);
  assert.ok(!result.content.includes('alert'), 'script content leaked');
  assert.ok(!result.content.includes('color: red'), 'style content leaked');
  assert.ok(result.content.length <= 121);
  assert.equal(result.truncated, true);
});

test('fetch_url returns plain text and JSON bodies as-is (capped)', async () => {
  const fetchImpl: typeof fetch = async () => new Response('plain text content', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
  const tool = createFetchUrlTool(config(), { fetchImpl });
  const result = await tool.handler({ url: 'https://example.com/raw.txt' }) as { content: string; truncated: boolean };
  assert.equal(result.content, 'plain text content');
  assert.equal(result.truncated, false);
});

test('fetch_url rejects bad schemes, private hosts, non-200s, and binary content', async () => {
  const never: typeof fetch = async () => {
    throw new Error('must not fetch');
  };
  const guarded = createFetchUrlTool(config(), { fetchImpl: never });

  await assert.rejects(guarded.handler({ url: 'not a url' }) as Promise<unknown>, /Invalid URL/);
  await assert.rejects(guarded.handler({ url: 'file:///etc/passwd' }) as Promise<unknown>, /Only http and https/);
  await assert.rejects(guarded.handler({ url: 'ftp://example.com/x' }) as Promise<unknown>, /Only http and https/);
  await assert.rejects(guarded.handler({ url: 'http://localhost:6800/api' }) as Promise<unknown>, /not allowed/);
  await assert.rejects(guarded.handler({ url: 'http://192.168.1.1/admin' }) as Promise<unknown>, /not allowed/);
  await assert.rejects(guarded.handler({ url: 'http://10.0.0.5/' }) as Promise<unknown>, /not allowed/);
  await assert.rejects(guarded.handler({ url: 'http://[::1]:8080/' }) as Promise<unknown>, /not allowed/);

  const notFound = createFetchUrlTool(config(), {
    fetchImpl: async () => new Response('missing', { status: 404 }),
  });
  await assert.rejects(notFound.handler({ url: 'https://example.com/gone' }) as Promise<unknown>, /HTTP 404/);

  const binary = createFetchUrlTool(config(), {
    fetchImpl: async () => new Response(Buffer.from([0, 1, 2]), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
  });
  await assert.rejects(binary.handler({ url: 'https://example.com/blob.bin' }) as Promise<unknown>, /Unsupported content type/);
});

test('isPrivateHost classifies hostnames and IP literals', () => {
  for (const host of ['localhost', 'db.localhost', 'nas.local', 'router.internal', 'printer.home.arpa',
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateHost(host), true, `${host} should be private`);
  }
  for (const host of ['example.com', 'sub.example.org', '8.8.8.8', '172.32.0.1', '193.168.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateHost(host), false, `${host} should be public`);
  }
});

test('htmlToText produces compact readable text with line breaks for block elements', () => {
  const text = htmlToText('<div>One</div><p>Two &gt; three</p><ul><li>a</li><li>b</li></ul>');
  assert.equal(text, 'One\nTwo > three\na\nb');
});

// --- through the agent loop --------------------------------------------------------

test('web_search failure surfaces to the model as a structured envelope, never a throw', async () => {
  const registry = new ToolRegistry();
  registry.register(createWebSearchTool(config(), { fetchImpl: async () => jsonResponse({ results: [] }) }));

  const requests: LLMRequest[] = [];
  const responses: LLMResponse[] = [
    {
      content: '', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1,
      toolCalls: [{ name: 'web_search', arguments: { query: 'anything' } }],
    },
    { content: 'I could not find results.', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 },
  ];
  const llm = {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      requests.push({ ...req, messages: [...req.messages] });
      const next = responses.shift();
      if (!next) throw new Error('out of responses');
      return next;
    },
  };
  const agent = new AgentService({ config: config(), llm, registry });

  const result = await agent.runTurn({ system: 's', messages: [{ role: 'user', content: 'search something' }] });

  assert.equal(result.content, 'I could not find results.');
  const toolMsg = requests[1].messages.at(-1);
  assert.equal(toolMsg?.role, 'tool');
  const envelope = JSON.parse(toolMsg?.content ?? '{}') as { ok: boolean; error: string };
  assert.equal(envelope.ok, false);
  assert.match(envelope.error, /No results found/);
});
