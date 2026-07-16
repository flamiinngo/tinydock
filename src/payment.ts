import type { IncomingMessage, ServerResponse } from 'node:http';
import { OKXFacilitatorClient } from '@okxweb3/x402-core';
import { x402HTTPResourceServer, x402ResourceServer } from '@okxweb3/x402-core/server';
import type {
  HTTPAdapter,
  HTTPRequestContext,
  HTTPResponseInstructions,
} from '@okxweb3/x402-core/server';
import { ExactEvmScheme } from '@okxweb3/x402-evm/exact/server';
import { recordSettlement } from './feed.js';
import { settlementContext } from './settlement-context.js';
import {
  MCP_ROUTE,
  MCP_ROUTE_PATTERN,
  NETWORK,
  OKX_API_KEY,
  OKX_BASE_URL,
  OKX_PASSPHRASE,
  OKX_SECRET_KEY,
  PAY_TO,
  PAYMENT_ENABLED,
  PRICE,
} from './config.js';

const PAYMENT_HEADER = 'PAYMENT-SIGNATURE';

export type PaymentOutcome = 'allowed' | 'responded';

let gate: Promise<x402HTTPResourceServer> | undefined;

/** Cached across invocations: `initialize()` round-trips the facilitator for supported schemes. */
function getGate(): Promise<x402HTTPResourceServer> {
  gate ??= (async () => {
    const facilitator = new OKXFacilitatorClient({
      apiKey: OKX_API_KEY,
      secretKey: OKX_SECRET_KEY,
      passphrase: OKX_PASSPHRASE,
      ...(OKX_BASE_URL ? { baseUrl: OKX_BASE_URL } : {}),
      // Wait for on-chain confirmation so a settled call is really settled before we
      // burn a sandbox on it. Costs a block of latency; avoids polling entirely.
      syncSettle: true,
    });

    const resourceServer = new x402ResourceServer(facilitator).register(
      NETWORK,
      new ExactEvmScheme(),
    );
    await resourceServer.initialize();

    return new x402HTTPResourceServer(resourceServer, {
      [MCP_ROUTE_PATTERN]: {
        accepts: { scheme: 'exact', network: NETWORK, payTo: PAY_TO, price: PRICE },
        description: 'One sandboxed code execution.',
        mimeType: 'application/json',
      },
    });
  })().catch((err) => {
    gate = undefined;
    throw err;
  });
  return gate;
}

/**
 * Builds an unpaid challenge without serving a request. Exercises the credentials,
 * `initialize()` against the OKX broker, and challenge construction in one call.
 */
export async function previewChallenge(): Promise<HTTPResponseInstructions> {
  const adapter: HTTPAdapter = {
    getHeader: () => undefined,
    getMethod: () => 'POST',
    getPath: () => MCP_ROUTE,
    getUrl: () => `https://tinydock.xyz${MCP_ROUTE}`,
    getAcceptHeader: () => 'application/json',
    getUserAgent: () => 'tinydock-selftest',
  };

  const gateway = await getGate();
  const result = await gateway.processHTTPRequest({ adapter, path: MCP_ROUTE, method: 'POST' });

  if (result.type === 'payment-error') return result.response;
  throw new Error(`Expected a 402 challenge for an unpaid request, got "${result.type}".`);
}

function adapterFor(req: IncomingMessage): HTTPAdapter {
  const header = (name: string): string | undefined => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    getHeader: header,
    getMethod: () => req.method ?? 'POST',
    getPath: () => MCP_ROUTE,
    getUrl: () => `https://${req.headers.host ?? 'localhost'}${MCP_ROUTE}`,
    getAcceptHeader: () => header('accept') ?? 'application/json',
    getUserAgent: () => header('user-agent') ?? '',
  };
}

/** What the SDK puts in the PAYMENT-REQUIRED header: base64 JSON, one entry per scheme. */
interface Challenge {
  accepts?: Array<{
    amount?: string;
    asset?: string;
    network?: string;
    payTo?: string;
    extra?: { name?: string };
  }>;
}

/**
 * An x402 client reads the challenge from the PAYMENT-REQUIRED header and never looks at
 * the body, so the SDK leaves it empty. But a human wiring this up sees an MCP tool that
 * fails with a bare `{}` and learns nothing — least of all that a plain MCP client cannot
 * pay at all. Spend the bytes.
 */
function explain(instructions: HTTPResponseInstructions): unknown {
  const encoded = instructions.headers['PAYMENT-REQUIRED'];
  if (typeof encoded !== 'string') return instructions.body ?? {};

  let accepted: NonNullable<Challenge['accepts']>[number] | undefined;
  try {
    accepted = (JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Challenge)
      .accepts?.[0];
  } catch {
    return instructions.body ?? {};
  }
  if (!accepted) return instructions.body ?? {};

  return {
    error: 'payment_required',
    message: `One sandboxed execution costs $${PRICE}, paid in ${accepted.extra?.name ?? 'USDT0'} on X Layer.`,
    price: {
      usd: PRICE,
      amount: accepted.amount,
      asset: accepted.asset,
      decimals: 6,
      symbol: accepted.extra?.name,
    },
    network: accepted.network,
    payTo: accepted.payTo,
    // The single thing a reader most needs to know, and would otherwise learn by guessing.
    hint:
      'A plain MCP client cannot pay this. The caller must speak x402: read the challenge ' +
      'from the PAYMENT-REQUIRED header, sign an EIP-3009 authorization, and replay the ' +
      'request with a PAYMENT-SIGNATURE header. The signature is a typed message, not a ' +
      'transaction — you need USDT0 on X Layer and no gas token.',
    example: 'https://github.com/flamiinngo/tinydock/blob/main/scripts/pay-402.ts',
    spec: 'https://x402.org',
  };
}

function send(res: ServerResponse, instructions: HTTPResponseInstructions): void {
  for (const [name, value] of Object.entries(instructions.headers)) res.setHeader(name, value);
  res.writeHead(instructions.status, {
    'Content-Type': instructions.isHtml ? 'text/html' : 'application/json',
  });

  if (typeof instructions.body === 'string' || instructions.isHtml) {
    res.end(typeof instructions.body === 'string' ? instructions.body : '');
    return;
  }

  const body = instructions.status === 402 ? explain(instructions) : (instructions.body ?? {});
  res.end(JSON.stringify(body));
}

/**
 * Charges for one call, or answers the request itself with a 402 challenge.
 *
 * Settles before the tool runs rather than after: a signed authorization is worthless
 * once the response is streaming, and a non-zero exit code is a legitimate result the
 * caller still asked us to produce.
 */
export async function chargeForCall(
  req: IncomingMessage,
  res: ServerResponse,
  /**
   * Runs once the payer is known and before a single cent moves. Return a rejection to
   * refuse the call for free. A lease is limited per wallet, and the wallet is only
   * knowable from a verified signature — so this is the only place that check can live.
   */
  beforeSettle?: (payer: string) => Promise<{ status: number; body: unknown } | undefined>,
): Promise<PaymentOutcome> {
  if (!PAYMENT_ENABLED) return 'allowed';

  const adapter = adapterFor(req);
  const context: HTTPRequestContext = {
    adapter,
    path: MCP_ROUTE,
    method: req.method ?? 'POST',
    paymentHeader: adapter.getHeader(PAYMENT_HEADER),
  };

  const gateway = await getGate();
  const verified = await gateway.processHTTPRequest(context);

  if (verified.type === 'payment-error') {
    send(res, verified.response);
    return 'responded';
  }
  if (verified.type === 'no-payment-required') return 'allowed';

  // Record who is paying before we settle. The signature authorizes a transfer from this
  // address, so it cannot be forged, and a lease is rate-limited against it.
  const slot = settlementContext.getStore();
  if (slot) {
    const { authorization } = (
      verified.paymentPayload as { payload?: { authorization?: { from?: string } } }
    ).payload ?? {};
    if (authorization?.from) slot.payer = authorization.from.toLowerCase();
  }

  if (beforeSettle) {
    const payer =
      slot?.payer ??
      (
        verified.paymentPayload as { payload?: { authorization?: { from?: string } } }
      ).payload?.authorization?.from?.toLowerCase();

    const rejection = payer ? await beforeSettle(payer) : undefined;
    if (rejection) {
      res.writeHead(rejection.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rejection.body));
      return 'responded';
    }
  }

  const settled = await gateway.processSettlement(
    verified.paymentPayload,
    verified.paymentRequirements,
    verified.declaredExtensions,
  );

  if (!settled.success) {
    send(res, settled.response);
    return 'responded';
  }

  const { transaction } = settled as { transaction?: string };
  await recordSettlement(PRICE, transaction);

  for (const [name, value] of Object.entries(settled.headers)) res.setHeader(name, value);
  return 'allowed';
}
