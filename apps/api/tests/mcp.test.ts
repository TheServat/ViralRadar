/**
 * The MCP transport.
 *
 * The protocol is small, but two of its rules are the kind that fail silently:
 * stdout carries the protocol and nothing else, and a message can arrive split
 * across reads. Both produce "the tool is broken" rather than a useful error,
 * so both are pinned here.
 *
 * The tools themselves are not exercised — they talk to a running radar over
 * HTTP, and a test that needs a live server tests the server, not the
 * transport.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'silent';

const { serveMcp, RPC } = await import('../src/mcp/protocol.ts');
const { createRadarMcpServer } = await import('../src/mcp/tools.ts');
import type { McpServer } from '../src/mcp/protocol.ts';

/**
 * Runs the server against scripted input and collects what it writes.
 *
 * stdin and stdout are swapped for streams, which is the only way to observe
 * the thing the protocol actually cares about: the exact bytes on stdout.
 */
async function converse(server: McpServer, lines: readonly string[]): Promise<Record<string, unknown>[]> {
  const stdin = new PassThrough();
  const written: string[] = [];

  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realWrite = process.stdout.write.bind(process.stdout);

  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;

  const done = serveMcp(server);
  for (const line of lines) stdin.write(line);
  stdin.end();
  await done;

  process.stdout.write = realWrite;
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin);

  return written
    .join('')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A server with one tool, so transport behaviour is isolated from the radar. */
function fakeServer(): McpServer {
  return {
    name: 'test-radar',
    version: '9.9.9',
    tools: [{ name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: {} } }],
    async call(name, args) {
      if (name === 'boom') throw new Error('handler exploded');
      return { text: `echo:${JSON.stringify(args)}` };
    },
  };
}

const rpc = (id: number, method: string, params?: unknown): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

describe('the MCP handshake', () => {
  test('answers initialize with a protocol version and its own name', async () => {
    const [reply] = await converse(fakeServer(), [rpc(1, 'initialize', {})]);
    const result = reply?.['result'] as Record<string, unknown>;
    assert.equal(reply?.['jsonrpc'], '2.0');
    assert.equal(reply?.['id'], 1);
    assert.ok(typeof result['protocolVersion'] === 'string');
    assert.deepEqual(result['serverInfo'], { name: 'test-radar', version: '9.9.9' });
  });

  test('lists its tools', async () => {
    const [reply] = await converse(fakeServer(), [rpc(1, 'tools/list')]);
    const tools = (reply?.['result'] as { tools: { name: string }[] }).tools;
    assert.deepEqual(tools.map((t) => t.name), ['echo']);
  });

  test('a notification gets no reply at all', async () => {
    // No id means no answer is expected; replying would be a protocol error.
    const out = await converse(fakeServer(), [
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    ]);
    assert.deepEqual(out, []);
  });
});

describe('calling a tool', () => {
  test('returns the text as content', async () => {
    const [reply] = await converse(fakeServer(), [
      rpc(1, 'tools/call', { name: 'echo', arguments: { a: 1 } }),
    ]);
    const result = reply?.['result'] as { content: { type: string; text: string }[]; isError: boolean };
    assert.equal(result.content[0]?.type, 'text');
    assert.equal(result.content[0]?.text, 'echo:{"a":1}');
    assert.equal(result.isError, false);
  });

  test('a handler that throws does not end the session', async () => {
    // The next request must still be answered — one bad tool call is not fatal.
    const out = await converse(fakeServer(), [
      rpc(1, 'tools/call', { name: 'boom', arguments: {} }),
      rpc(2, 'tools/list'),
    ]);
    assert.equal(out.length, 2);
    assert.ok((out[0]?.['error'] as { message: string }).message.includes('exploded'));
    assert.ok(out[1]?.['result'] !== undefined, 'the session should have continued');
  });

  test('a missing tool name is refused as bad params', async () => {
    const [reply] = await converse(fakeServer(), [rpc(1, 'tools/call', { arguments: {} })]);
    assert.equal((reply?.['error'] as { code: number }).code, RPC.invalidParams);
  });

  test('an unknown method is refused rather than ignored', async () => {
    const [reply] = await converse(fakeServer(), [rpc(1, 'nonsense/method')]);
    assert.equal((reply?.['error'] as { code: number }).code, RPC.methodNotFound);
  });
});

describe('the transport itself', () => {
  test('a message split across reads is still parsed', async () => {
    // The failure this guards against looks like a hung client, not an error.
    const whole = rpc(1, 'tools/list');
    const cut = Math.floor(whole.length / 2);
    const out = await converse(fakeServer(), [whole.slice(0, cut), whole.slice(cut)]);
    assert.equal(out.length, 1);
    assert.ok(out[0]?.['result'] !== undefined);
  });

  test('several messages in one read are all answered', async () => {
    const out = await converse(fakeServer(), [rpc(1, 'ping') + rpc(2, 'tools/list')]);
    assert.deepEqual(out.map((m) => m['id']), [1, 2]);
  });

  test('malformed JSON is reported without ending the session', async () => {
    const out = await converse(fakeServer(), ['{ not json at all\n', rpc(2, 'ping')]);
    assert.equal((out[0]?.['error'] as { code: number }).code, RPC.parseError);
    assert.equal(out[1]?.['id'], 2);
  });

  test('every line written to stdout is valid JSON', async () => {
    // The rule the whole transport rests on. If anything else reaches stdout,
    // the client sees a parse error instead of an answer.
    const out = await converse(fakeServer(), [rpc(1, 'initialize', {}), rpc(2, 'tools/list')]);
    assert.equal(out.length, 2);
    for (const message of out) assert.equal(message['jsonrpc'], '2.0');
  });
});

describe('the version', () => {
  test('what the code reports matches what is published', async () => {
    // Three places carry it: package.json, the MCP handshake, and the version
    // resource on the Windows executable. The last two are derived from the
    // first two, so this is the join that keeps them from drifting.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const { APP_VERSION } = await import('../src/version.ts');

    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

    assert.equal(
      APP_VERSION,
      pkg.version,
      'apps/api/src/version.ts and package.json disagree about the version',
    );
  });

  test('the MCP server reports it', () => {
    assert.match(createRadarMcpServer().version, /^\d+\.\d+\.\d+$/);
  });
});

describe('the radar tools', () => {
  test('every tool is named for a question, not for a table', async () => {
    const server = createRadarMcpServer();
    assert.ok(server.tools.length >= 8);
    for (const tool of server.tools) {
      assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} is not a usable tool name`);
      assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can act on`);
      assert.equal((tool.inputSchema as { type: string }).type, 'object');
    }
  });

  test('an unknown tool is an error result, not a crash', async () => {
    const result = await createRadarMcpServer().call('not_a_tool', {});
    assert.equal(result.isError, true);
  });
});
