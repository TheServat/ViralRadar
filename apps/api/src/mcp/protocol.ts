/**
 * The Model Context Protocol, by hand.
 *
 * MCP is JSON-RPC 2.0 over stdio with three methods that matter: `initialize`,
 * `tools/list` and `tools/call`. That is small enough to implement directly,
 * which keeps the promise the rest of this project makes — no runtime
 * dependencies — rather than pulling in an SDK to save fifty lines.
 *
 * Two rules the transport imposes, both easy to get wrong and both silent when
 * you do:
 *
 *   - **stdout carries the protocol.** Nothing else may be written there. A
 *     stray `console.log` corrupts the stream and the client sees a parse
 *     error rather than your message. Logging goes to stderr.
 *   - **Messages are newline-delimited JSON.** One object per line, and a line
 *     can arrive split across two reads, so input is buffered until a newline.
 */
import { createInterface } from 'node:readline';

/** JSON-RPC error codes, from the spec. Only the ones that can happen here. */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  /** Rendered for the model to read. Text, because that is what it reasons over. */
  readonly text: string;
  readonly isError?: boolean;
}

export interface McpServer {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly ToolDefinition[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** Protocol version this speaks. Clients negotiate; unknown versions still work. */
const PROTOCOL_VERSION = '2024-11-05';

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: number | string | null | undefined, result: unknown): void {
  if (id === undefined || id === null) return; // A notification expects no answer.
  send({ jsonrpc: '2.0', id, result });
}

function fail(id: number | string | null | undefined, code: number, message: string): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Runs the server until stdin closes.
 *
 * Every handler failure is reported as a tool result rather than an RPC error:
 * the model can read "no data yet, the radar is not running" and act on it,
 * where a transport-level error just looks like the tool is broken.
 */
export async function serveMcp(server: McpServer): Promise<void> {
  const lines = createInterface({ input: process.stdin });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let request: RpcRequest;
    try {
      request = JSON.parse(trimmed) as RpcRequest;
    } catch {
      // Sent directly rather than through `fail`, which treats a null id as
      // "this was a notification, stay quiet". A parse error is the one case
      // the spec says must be answered with a null id: we could not read the
      // id, so silence would leave the client waiting for ever.
      send({ jsonrpc: '2.0', id: null, error: { code: RPC.parseError, message: 'invalid JSON' } });
      continue;
    }

    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize':
          reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: server.name, version: server.version },
          });
          break;

        // Sent after initialize; acknowledging is enough.
        case 'notifications/initialized':
          break;

        case 'ping':
          reply(id, {});
          break;

        case 'tools/list':
          reply(id, { tools: server.tools });
          break;

        case 'tools/call': {
          const name = typeof params?.['name'] === 'string' ? params['name'] : '';
          const args = (params?.['arguments'] ?? {}) as Record<string, unknown>;
          if (name === '') {
            fail(id, RPC.invalidParams, 'tools/call needs a name');
            break;
          }
          const result = await server.call(name, args);
          reply(id, {
            content: [{ type: 'text', text: result.text }],
            isError: result.isError === true,
          });
          break;
        }

        default:
          fail(id, RPC.methodNotFound, `unknown method: ${method}`);
      }
    } catch (e) {
      // Never let one bad call end the session.
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(`mcp: ${method} failed: ${message}\n`);
      fail(id, RPC.internalError, message);
    }
  }
}
