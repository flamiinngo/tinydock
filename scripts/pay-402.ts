import { x402Client, x402HTTPClient } from '@okxweb3/x402-core/client';
import { registerExactEvmScheme } from '@okxweb3/x402-evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { MCP_ROUTE, NETWORK } from '../src/config.js';

/**
 * Drives the paid path end to end against a live deployment: unpaid call, 402,
 * sign, retry, settle. This spends real USDT0 on X Layer — one call per run.
 *
 *   tsx scripts/pay-402.ts                      # dry run: stops at the challenge
 *   tsx scripts/pay-402.ts --yes                # signs and pays
 *   tsx scripts/pay-402.ts --yes --url=http://localhost:3000
 *
 * Needs TINYDOCK_TEST_KEY: a private key holding USDT0 on X Layer. No native gas
 * token required — `exact` settles by signed EIP-3009 authorization, so the key
 * signs a typed message, never a transaction, and the facilitator broadcasts and
 * pays gas on our behalf. The key never leaves this process.
 *
 * The payer must not be PAY_TO. Paying yourself proves nothing about settlement.
 */

const args = process.argv.slice(2);
const PAY = args.includes('--yes');
const BASE = args.find((a) => a.startsWith('--url='))?.slice('--url='.length) ?? 'https://tinydock.vercel.app';

/**
 * Refuse to sign an authorization larger than this, in USDT0 base units.
 * The server names its own price and we are about to sign for whatever it asks;
 * a typo in TINYDOCK_PRICE should cost a failed script, not a wallet.
 */
const MAX_SPEND_UNITS = BigInt(process.env.TINYDOCK_MAX_SPEND_UNITS ?? '10000'); // $0.01

const KEY = process.env.TINYDOCK_TEST_KEY;
if (!KEY) {
  console.error('TINYDOCK_TEST_KEY is unset. Put the private key in .env.local and run with');
  console.error('  node --env-file=.env.local --import tsx scripts/pay-402.ts');
  process.exit(1);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error('TINYDOCK_TEST_KEY must be a 0x-prefixed 32-byte hex private key.');
  process.exit(1);
}

const url = `${BASE}${MCP_ROUTE}`;

/** `--packages=cowsay` exercises the install-then-cut-network path, not just bare exec. */
const packages = args
  .find((a) => a.startsWith('--packages='))
  ?.slice('--packages='.length)
  .split(',')
  .filter(Boolean);

const source = packages?.length
  ? 'import cowsay\ncowsay.cow("paid and executed")'
  : 'print("paid and executed")';

const body = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'run_code',
    arguments: { language: 'python', source, ...(packages?.length ? { packages } : {}) },
  },
});

/** The MCP transport validates Accept before it will answer. It runs *after*
 *  settlement, so getting this wrong means paying for a 406. */
const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

const account = privateKeyToAccount(KEY as `0x${string}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account, networks: [NETWORK] });
const http = new x402HTTPClient(client);

console.log(`wallet  ${account.address}`);
console.log(`target  ${url}\n`);

// ── 1. Unpaid call. Expect a 402 carrying the challenge.
const unpaid = await fetch(url, { method: 'POST', headers, body });

if (unpaid.status !== 402) {
  console.error(`Expected 402, got ${unpaid.status}. Payment may be disabled on this deployment.`);
  console.error((await unpaid.text()).slice(0, 400));
  process.exit(1);
}

const paymentRequired = http.getPaymentRequiredResponse((n) => unpaid.headers.get(n));
const [accepted] = paymentRequired.accepts;
if (!accepted) {
  console.error('402 carried no payment requirements.');
  process.exit(1);
}

const units = BigInt(accepted.amount);
console.log('402 challenge');
console.log(`  amount   ${accepted.amount} base units  ($${Number(units) / 1e6})`);
console.log(`  asset    ${accepted.asset}`);
console.log(`  payTo    ${accepted.payTo}`);
console.log(`  network  ${accepted.network}\n`);

if (units > MAX_SPEND_UNITS) {
  console.error(`Refusing to sign: ${units} base units exceeds the ${MAX_SPEND_UNITS} ceiling.`);
  console.error('Raise TINYDOCK_MAX_SPEND_UNITS if this is deliberate.');
  process.exit(1);
}

if (account.address.toLowerCase() === accepted.payTo.toLowerCase()) {
  console.error('The test wallet is PAY_TO. A self-transfer would settle without proving');
  console.error('that a stranger can pay. Use a different wallet.');
  process.exit(1);
}

if (!PAY) {
  console.log('Dry run. Re-run with --yes to sign and settle.');
  process.exit(0);
}

// ── 2. Sign the authorization and retry. `syncSettle` holds the response until
//       the transfer confirms on chain, so this fetch is the settlement latency.
const payload = await http.createPaymentPayload(paymentRequired);
const signed = http.encodePaymentSignatureHeader(payload);

const startedAt = performance.now();
const paid = await fetch(url, {
  method: 'POST',
  headers: { ...headers, ...signed },
  body,
});
const latencyMs = Math.round(performance.now() - startedAt);

console.log(`paid retry → ${paid.status} in ${latencyMs}ms`);

if (!paid.ok) {
  console.error(`\n✗ settlement or execution failed`);
  console.error((await paid.text()).slice(0, 600));
  process.exit(1);
}

// ── 3. Read the settlement receipt off the response headers.
try {
  const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n));
  console.log(`  success  ${settle.success}`);
  if (settle.transaction) console.log(`  tx       ${settle.transaction}`);
  if (settle.network) console.log(`  network  ${settle.network}`);
} catch {
  console.log('  (no settlement header on the response)');
}

const text = await paid.text();
console.log('\ntool response');
console.log(text.slice(0, 800));

console.log(`\n✓ end-to-end: 402 → signed → settled → executed (${latencyMs}ms)`);
