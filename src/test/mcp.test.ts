import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as os from 'node:os';
import { test } from 'node:test';

import { McpManager, sanitizeMcpServers } from '../core/tools/mcp';

/**
 * End-to-end tests for the MCP client transports against real servers:
 * a Streamable HTTP endpoint (JSON and SSE responses), a legacy HTTP+SSE
 * endpoint that only answers GET, and a stdio child process. No mocking of
 * the wire, because the wire is where the bugs live.
 */

const root = os.tmpdir();
const TIMEOUT = 5000;

/** Run an http server for the lifetime of one test; yields its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Read a whole request body (JSON-RPC messages are small). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function jsonReply(res: http.ServerResponse, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

/* ---------------------------------------------------- streamable http */

test('mcp: streamable HTTP transport lists and calls tools (JSON and SSE responses)', async () => {
  const seenHeaders: http.IncomingHttpHeaders[] = [];

  const handler: http.RequestListener = async (req, res) => {
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    assert.equal(req.method, 'POST');
    seenHeaders.push(req.headers);
    const message = JSON.parse(await readBody(req));
    if (message.id == null) {
      res.writeHead(202).end(); // notification accepted
      return;
    }
    switch (message.method) {
      case 'initialize':
        jsonReply(
          res,
          {
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } },
          },
          { 'mcp-session-id': 'session-123' },
        );
        return;
      case 'tools/list': {
        // Answer with an SSE stream instead of a JSON body: the client must
        // scan the events until it finds our request id.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { text: 'hi' } })}\n\n`);
        res.write(
          `event: message\n` +
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                tools: [{ name: 'greet', description: 'greet someone', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } }],
              },
            })}\n\n`,
        );
        res.end();
        return;
      }
      case 'tools/call': {
        if (req.headers['mcp-session-id'] !== 'session-123') {
          jsonReply(res, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'missing session id' } });
          return;
        }
        if (message.params?.name !== 'greet') {
          jsonReply(res, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown tool ${String(message.params?.name)}` } });
          return;
        }
        jsonReply(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `hello ${(message.params?.arguments?.who as string) ?? '?'}` }] },
        });
        return;
      }
      default:
        jsonReply(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
    }
  };

  await withServer(handler, async (baseUrl) => {
    const manager = new McpManager(root, TIMEOUT);
    const { started, failed } = await manager.startServers({
      remote: { type: 'http', url: `${baseUrl}/mcp` },
    });
    assert.deepEqual(failed, []);
    assert.deepEqual(started, ['remote']);
    assert.equal(manager.toolCount, 1);
    assert.equal(manager.toolsOf('remote'), 1);

    const tool = manager.getTools().find((t) => t.name === 'mcp_remote_greet');
    assert.ok(tool, 'expected the prefixed greet tool');
    const result = await tool!.run({ who: 'world' }, undefined as never);
    assert.equal(result.ok, true);
    assert.match(result.content, /hello world/);

    // Later requests must echo the negotiated protocol version and session id.
    const callSeen = seenHeaders[seenHeaders.length - 1];
    assert.equal(callSeen['mcp-session-id'], 'session-123');
    assert.equal(callSeen['mcp-protocol-version'], '2025-03-26');

    // Unknown tools surface the JSON-RPC error with our prefix.
    await assert.rejects(manager['clients'].get('remote')!.callTool('nope', {}), /MCP remote error -32602/);
    await manager.stopAll();
  });
});

test('mcp: extra headers are sent on every HTTP request', async () => {
  let sawAuth = false;
  const handler: http.RequestListener = async (req, res) => {
    if (req.headers['authorization'] === 'Bearer secret-token') sawAuth = true;
    const message = JSON.parse(await readBody(req));
    if (message.id == null) {
      res.writeHead(202).end();
      return;
    }
    if (message.method === 'initialize') {
      jsonReply(res, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {} } });
    } else if (message.method === 'tools/list') {
      jsonReply(res, { jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    }
  };
  await withServer(handler, async (baseUrl) => {
    const manager = new McpManager(root, TIMEOUT);
    const { failed } = await manager.startServers({
      authed: { url: baseUrl, headers: { Authorization: 'Bearer secret-token' } },
    });
    assert.deepEqual(failed, []);
    assert.ok(sawAuth, 'server never saw the Authorization header');
    await manager.stopAll();
  });
});

test('mcp: a remote server that never replies fails with a timeout error', async () => {
  const handler: http.RequestListener = (req, res) => {
    void req.socket.on('close', () => res.end()); // hold the request open
  };
  await withServer(handler, async (baseUrl) => {
    const manager = new McpManager(root, 300);
    const { started, failed } = await manager.startServers({ slow: { url: baseUrl } });
    assert.deepEqual(started, []);
    assert.equal(failed.length, 1);
    assert.match(failed[0].error, /MCP|timed out|aborted/i);
    assert.match(manager.failureOf('slow') ?? '', /MCP|timed out|aborted/i);
    await manager.stopAll();
  });
});

/* -------------------------------------------------------- legacy http sse */

test('mcp: falls back to legacy HTTP+SSE when POSTs are rejected', async () => {
  const streams = new Set<http.ServerResponse>();

  const handler: http.RequestListener = async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      streams.add(res);
      req.socket.on('close', () => streams.delete(res));
      // Legacy transport: first frame names the POST endpoint.
      res.write('event: endpoint\ndata: /messages\n\n');
      return;
    }
    if (req.method === 'POST' && req.url === '/messages') {
      const message = JSON.parse(await readBody(req));
      res.writeHead(202).end(); // answer goes out on the event stream
      if (message.id != null) {
        let payload: unknown;
        switch (message.method) {
          case 'initialize':
            payload = { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {} } };
            break;
          case 'tools/list':
            payload = {
              jsonrpc: '2.0',
              id: message.id,
              result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] },
            };
            break;
          default:
            payload = { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } };
        }
        for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      }
      return;
    }
    // Legacy servers refuse POSTs to the stream endpoint itself.
    res.writeHead(405, { allow: 'GET' }).end('method not allowed');
  };

  await withServer(handler, async (baseUrl) => {
    const manager = new McpManager(root, TIMEOUT);
    const { started, failed } = await manager.startServers({
      legacy: { url: `${baseUrl}/sse` }, // 'http' by default → must auto-fall back
    });
    assert.deepEqual(failed, []);
    assert.deepEqual(started, ['legacy']);
    const tool = manager.getTools().find((t) => t.name === 'mcp_legacy_ping');
    assert.ok(tool, 'expected mcp_legacy_ping after fallback');
    const result = await tool!.run({}, undefined as never);
    assert.equal(result.ok, true);
    assert.match(result.content, /pong/);
    await manager.stopAll();
  });
});

test('mcp: type "sse" connects straight to a legacy server', async () => {
  const handler: http.RequestListener = async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages\n\n');
      const keepOpen = res; // never end: a legacy stream stays open
      req.socket.on('close', () => keepOpen.end());
      return;
    }
    if (req.method === 'POST' && req.url === '/messages') {
      const message = JSON.parse(await readBody(req));
      res.writeHead(202).end();
      if (message.id == null) return;
      // Reply over the (only) open stream: easiest is to keep one globally.
      if (message.method === 'initialize') {
        sseReply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
      } else if (message.method === 'tools/list') {
        sseReply({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
      }
      return;
    }
    res.writeHead(404).end();
  };
  // The stream written below is captured when the GET arrives.
  let sseReply: (payload: unknown) => void = () => {
    throw new Error('no stream');
  };
  const wrapped: http.RequestListener = (req, res) => {
    if (req.method === 'GET') sseReply = (payload) => res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    handler(req, res);
  };
  await withServer(wrapped, async (baseUrl) => {
    const manager = new McpManager(root, TIMEOUT);
    const { failed } = await manager.startServers({ old: { type: 'sse', url: baseUrl } });
    assert.deepEqual(failed, []);
    await manager.stopAll();
  });
});

/* ------------------------------------------------------------------- stdio */

test('mcp: stdio transport spawns a server and calls its tool', async () => {
  const script = [
    "let buf='';",
    'process.stdin.setEncoding(\'utf8\');',
    "process.stdin.on('data',(d)=>{",
    '  buf+=d;',
    '  let i;',
    "  while((i=buf.indexOf('\\n'))!==-1){",
    '    const line=buf.slice(0,i).trim(); buf=buf.slice(i+1);',
    '    if(!line) continue;',
    '    let msg; try{msg=JSON.parse(line)}catch{continue}',
    '    if(msg.id==null) continue;',
    '    let result=null,error=null;',
    "    if(msg.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{}};",
    "    else if(msg.method==='tools/list') result={tools:[{name:'echo',description:'echo args',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};",
    "    else if(msg.method==='tools/call') result={content:[{type:'text',text:'echo:'+JSON.stringify(msg.params.arguments)}]};",
    "    else error={code:-32601,message:'unknown method'};",
    "    process.stdout.write(JSON.stringify(error?{jsonrpc:'2.0',id:msg.id,error}:{jsonrpc:'2.0',id:msg.id,result})+'\\n');",
    '  }',
    '});',
  ].join('\n');

  const manager = new McpManager(root, TIMEOUT);
  const { started, failed } = await manager.startServers({
    local: { command: process.execPath, args: ['-e', script] },
  });
  assert.deepEqual(failed, []);
  assert.deepEqual(started, ['local']);
  const tool = manager.getTools().find((t) => t.name === 'mcp_local_echo');
  assert.ok(tool, 'expected the prefixed echo tool');
  const result = await tool!.run({ text: 'hi there' }, undefined as never);
  assert.equal(result.ok, true);
  assert.match(result.content, /echo:\{"text":"hi there"\}/);
  await manager.stopAll();
});

test('mcp: invalid server definitions fail with a clear message', async () => {
  const manager = new McpManager(root, 500);
  const { started, failed } = await manager.startServers({
    empty: {},
    badurl: { url: 'not a url' },
    badproto: { url: 'ftp://example.com/mcp' },
    disabled: { url: 'http://127.0.0.1:1/mcp', disabled: true },
  });
  assert.deepEqual(started, []);
  const byId = Object.fromEntries(failed.map((f) => [f.id, f.error]));
  assert.match(byId.empty, /Missing/);
  assert.match(byId.badurl, /invalid url/);
  assert.match(byId.badproto, /http:\/\/ or https:\/\//);
  assert.ok(!('disabled' in byId), 'disabled servers are skipped without failing');
  await manager.stopAll();
});

/* -------------------------------------------------------------- sanitize */

test('sanitizeMcpServers keeps valid fields and drops the rest', () => {
  const cleaned = sanitizeMcpServers({
    a: {
      command: '  node ',
      args: ['server.js', 42, ''],
      env: { KEY: 'value', BAD: 7 },
      cwd: ' ./x ',
      disabled: true,
      timeoutMs: 2500.9,
      unexpected: 'gone',
    },
    ' remote ': {
      type: 'http',
      url: ' https://example.com/mcp ',
      headers: { Authorization: 'Bearer t', '': 'dropped', BAD: 1 },
    },
    junk: 'not an object',
    '': { command: 'node' },
  });

  assert.deepEqual(Object.keys(cleaned), ['a', 'remote']);
  assert.deepEqual(cleaned.a, {
    command: 'node',
    args: ['server.js'],
    env: { KEY: 'value' },
    cwd: './x',
    disabled: true,
    timeoutMs: 2500,
  });
  assert.deepEqual(cleaned.remote, {
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer t' },
  });
  assert.deepEqual(sanitizeMcpServers(undefined), {});
  assert.deepEqual(sanitizeMcpServers('[]'), {});
  assert.deepEqual(sanitizeMcpServers([1, 2]), {});
});
