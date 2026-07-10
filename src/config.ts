import type { Network } from '@okxweb3/x402-core/types';

/** X Layer mainnet. The OKX facilitator supports no other chain. */
export const NETWORK = 'eip155:196' as Network;

/** Path the ASP is registered under. Written on-chain at registration — do not change casually. */
export const MCP_ROUTE = '/api/mcp';

/** Route keys in x402 RoutesConfig are "METHOD /path". */
export const MCP_ROUTE_PATTERN = `POST ${MCP_ROUTE}`;

/**
 * Price per run_code call, in USD. Settles in USDT0 (6 decimals).
 *
 * Floor is set by Vercel Sandbox provisioned memory, which bills a 1-minute minimum
 * per `Sandbox.create()` regardless of how briefly the program runs: at the default
 * 2 vCPU / 4 GB that is $0.0014 a call before any CPU burns. A package install adds
 * registry egress at $0.15/GB on top.
 */
export const PRICE = Number(process.env.TINYDOCK_PRICE ?? '0.01');

/** Wallet that receives settlement. */
export const PAY_TO = process.env.TINYDOCK_PAY_TO ?? '';

/** HMAC-SHA256 signing credentials for the OKX settlement broker. */
export const OKX_API_KEY = process.env.OKX_API_KEY ?? '';
export const OKX_SECRET_KEY = process.env.OKX_SECRET_KEY ?? '';
export const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE ?? '';

/** Unset falls through to the SDK default, https://web3.okx.com */
export const OKX_BASE_URL = process.env.OKX_BASE_URL;

/** Payment is skipped entirely unless every credential is present. */
export const PAYMENT_ENABLED =
  PAY_TO.length > 0 &&
  OKX_API_KEY.length > 0 &&
  OKX_SECRET_KEY.length > 0 &&
  OKX_PASSPHRASE.length > 0;
