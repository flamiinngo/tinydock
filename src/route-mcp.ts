import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS } from './execute.js';
import { type Denied, admit, admitLease, callerIdOf } from './guards.js';
import { chargeForCall } from './payment.js';
import { createServer } from './mcp-app.js';
import { settlementContext } from './settlement-context.js';

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

interface ToolCall {
  method?: string;
  params?: { name?: string; arguments?: { leaseSeconds?: number } };
}

/** A `serve` call must clear its lease limits before it is charged, so we need its shape early. */
function serveRequest(body: unknown): { leaseSeconds: number } | undefined {
  const calls: ToolCall[] = Array.isArray(body) ? body : [body as ToolCall];
  const serve = calls.find(
    (m) => m && typeof m === 'object' && m.method === 'tools/call' && m.params?.name === 'serve',
  );
  if (!serve) return undefined;

  const requested = serve.params?.arguments?.leaseSeconds;
  return { leaseSeconds: clampLease(requested ?? DEFAULT_LEASE_SECONDS) };
}

const clampLease = (seconds: number): number =>
  Math.round(Math.min(Math.max(seconds, 10), MAX_LEASE_SECONDS));

const ACCEPT_VALUE = 'application/json, text/event-stream';

/**
 * Force the Accept header to satisfy the MCP transport, for callers that send a
 * minimal or missing Accept (OKX's x402 payer client). @hono/node-server rebuilds the
 * request from `rawHeaders`, so patch that array; also set the parsed `headers` for any
 * other reader.
 */
function forceAcceptHeader(req: IncomingMessage): void {
  const raw = req.rawHeaders;
  let found = false;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === 'accept') {
      raw[i + 1] = ACCEPT_VALUE;
      found = true;
    }
  }
  if (!found) raw.push('Accept', ACCEPT_VALUE);
  req.headers.accept = ACCEPT_VALUE;
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
    const admission = await admit(callerIdOf(req), 'paid');
    if (!admission.ok) {
      sendDenied(res, admission.denied);
      return;
    }
    release = admission.release;
  }

  const serve = serveRequest(body);

  // One settlement slot per request. Concurrent paid calls must not see each other's.
  return settlementContext.run({}, async () => {
    const slot = settlementContext.getStore();

    /**
     * Reserve the lease once we know the payer and before a cent moves. Charging an agent
     * and then telling it the lease limit is full would be exactly the failure `admit`
     * exists to prevent — only this check needs a verified signature to run at all.
     */
    const beforeSettle = serve
      ? async (payer: string) => {
          const admission = await admitLease(payer, serve.leaseSeconds);
          if (admission.ok) {
            if (slot) slot.lease = admission;
            return undefined;
          }
          return {
            status: admission.denied.status,
            body: { error: admission.denied.code, message: admission.denied.message },
          };
        }
      : undefined;

    try {
      if (billable && (await chargeForCall(req, res, beforeSettle)) === 'responded') {
        // Nothing settled, so the reservation must go back.
        await slot?.lease?.release();
        return;
      }

      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      // The MCP StreamableHTTP transport 406s unless the caller's Accept header lists
      // *both* application/json and text/event-stream. x402 payer clients (OKX's
      // task-402-pay, and minimal agents generally) send neither, so the paid replay
      // failed before the tool ran. Force the header — `enableJsonResponse: true` means
      // the reply is a normal JSON body, not SSE, whatever the client actually sent.
      //
      // @hono/node-server (which the transport wraps) rebuilds the Web Request from
      // `req.rawHeaders`, NOT `req.headers`, so both must be patched.
      forceAcceptHeader(req);

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      release();
    }
  });
}
