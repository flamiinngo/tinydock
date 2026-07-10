import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type Denied, admit, callerIdOf } from './guards.js';
import { chargeForCall } from './payment.js';
import { createServer } from './mcp-app.js';

const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body !== undefined) return req.body;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Only `tools/call` is billable. Gating the whole path would 402 the MCP handshake. */
function isBillable(body: unknown): boolean {
  const isCall = (m: unknown): boolean =>
    typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'tools/call';
  return Array.isArray(body) ? body.some(isCall) : isCall(body);
}

function sendDenied(res: ServerResponse, denied: Denied): void {
  if (denied.retryAfterSeconds) res.setHeader('Retry-After', String(denied.retryAfterSeconds));
  res.writeHead(denied.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: denied.code, message: denied.message }));
}

/**
 * One server and transport per request: Vercel Functions are stateless, so there
 * is nowhere to keep an MCP session between invocations.
 */
export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Malformed or oversized request body' }));
    return;
  }

  const billable = isBillable(body);
  let release = (): void => {};

  if (billable) {
    // Admission precedes payment: charging for a call we then refuse to run is unforgivable.
    const admission = admit(callerIdOf(req), 'paid');
    if (!admission.ok) {
      sendDenied(res, admission.denied);
      return;
    }
    release = admission.release;
  }

  try {
    if (billable && (await chargeForCall(req, res)) === 'responded') return;

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    release();
  }
}
