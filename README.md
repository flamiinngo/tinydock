<div align="center">
  <img src="public/logo.png" alt="TinyDock" width="120" />
  <h1>TinyDock</h1>
  <p><strong>Compute you can buy without existing.</strong></p>
  <p><a href="https://tinydock.vercel.app">tinydock.vercel.app</a> · OKX agent marketplace ASP <code>#4950</code></p>
</div>

---

Every cloud asks for a credit card. A credit card asks for a human.

An agent has a wallet. TinyDock is an [MCP](https://modelcontextprotocol.io) server that
sells one sandboxed code execution for one cent of USD₮0, paid over
[x402](https://x402.org) on X Layer. No account, no API key, no human in the loop.

```
AGENT  ──▶  POST /api/mcp         run_code
SERVER ──▶  402 PAYMENT REQUIRED  0.01 USD₮0
AGENT  ──▶  signs · pays · retries
SERVER ──▶  200 OK                stdout
```

The agent's code runs in a throwaway Firecracker microVM with no network and no DNS,
and the machine is destroyed when the program exits.

Two tools, both paid the same way:

- **`run_code`** — run a short program, get stdout back. Capped at 5s.
- **`serve`** — lease a live public HTTPS URL for a few minutes, backed by the same
  isolated microVM. Inbound traffic works; outbound stays dead, so the leased box can
  answer visitors and reach nothing. This is the thing an agent cannot do for itself:
  acquiring a URL means signing up for a host, and signing up means being a legal person
  with a card. An agent has a wallet, not a passport.

## It actually settles

Four payments on X Layer mainnet (`eip155:196`), settled through the OKX facilitator:

| Transaction | Paid | What ran |
| --- | --- | --- |
| `0x37eb62d3214f70ec74dc886117e2142c3c4e8f87d5dd1ba913e532300e011803` | 0.005 | bare python |
| `0x1a05dcd6a1fca29a83b6ec7a295bc600ca335aa352aecdf4d91243744dd467d1` | 0.005 | bare python |
| `0xcb749e7308edd7d4c7f4dee6967bac7a20624794180ecb7f42f29a343969cc79` | 0.005 | `pip install cowsay`, then python |
| `0xb1ca83b414873a2a55d5c2ce8b10bbdd1f77f11d1ec9df04ed409dea5421c01d` | 0.01 | bare python, at the current price |

Reproduce it yourself against production with `scripts/pay-402.ts` (dry-run by default).

The payer signs an EIP-3009 `TransferWithAuthorization` — a typed message, not a
transaction — so **a paying agent needs USD₮0 and no gas token at all.** The facilitator
broadcasts and pays the gas.

Settlement completes *before* the sandbox boots. A signed authorization is worthless once
the response is streaming, and a non-zero exit code is a legitimate result the caller
still asked us to produce. Cost: about 2.6 seconds of block confirmation per call.

## The security model

`packages` lets a caller install from npm or PyPI, which means the sandbox needs a network
during install and must not have one afterwards. The ordering in `src/execute.ts` is
load-bearing rather than incidental:

1. Open the microVM with a network policy allowing **only the registry and its CDN**.
2. Install the requested packages.
3. Switch the policy to `deny-all`.
4. **Only then** write the caller's source to disk and run it.

Untrusted code therefore never coexists with a reachable network. Package names are
matched against `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` — a leading `-` would be read as a
flag, and a `/`, `:` or `@git+` would let a caller install from an arbitrary URL, either
of which turns `packages` into arbitrary command execution with egress still up.

Execution is capped at 5s, source at 256 KB, output at 64 KB, and at most 5 packages.

## What it costs to run

Not what you'd guess. A call's floor is set by Vercel Sandbox **provisioned memory**, which
bills a one-minute minimum per `Sandbox.create()` no matter how briefly the program runs.
That is why `execute.ts` asks for one vCPU — each carries 2 GB, and memory, not runtime,
is the bill:

```
2 GB × (1/60) hr × $0.0212/GB-hr  =  $0.000707   per call, before any CPU burns
```

A 200 ms `print(1)` and a 5-second loop cost nearly the same. Active CPU adds ~$0.0002 at
worst. So a bare call costs roughly **$0.0009** against $0.01 collected — better than ten
times coverage. At the default 2 vCPU / 4 GB it would be $0.0016.

These are Vercel's published rates applied to our own configuration, not a reconciled
invoice. Right order of magnitude; not audited.

## State that survives

Vercel Functions are stateless: instances are recycled freely and several run warm at once.
Anything in process memory is per-instance, so the cabinet's counters drifted and the
monthly budget was enforced by each instance against its own private tally — the guard was
weakest under exactly the concurrency it exists to stop, and the rate limit could be evaded
by landing somewhere else.

`src/store.ts` puts the executions, earnings, recent events, monthly usage and rate-limit
windows in Redis. Redis counts a rate-limited call *as* it checks it, so two concurrent
requests cannot both read a count below the limit and both proceed.

It is optional. With no credentials every caller falls back to process memory — that is what
local development and `scripts/test-*.ts` use, and `/api/stats` reports `durable: false` so
the page can label its counters "(this node)" rather than present one instance's takings as
the total. A Redis outage falls back the same way instead of failing the request: a payment
gate that dies because a cache blinked is not commercial-grade. The money is never at risk
in either mode, because settlement lives on chain and not in that counter.

`inFlight` stays per-instance on purpose. It caps how far one process oversubscribes itself,
and a fleet-wide version would need lease expiry to survive a request that dies mid-run.

## Abuse prevention on `serve`

`serve` hands an anonymous, crypto-paying caller a public URL. Treated carelessly that is a
phishing host. It is not treated carelessly. The controls below are enforced in code, not
aspirational, and every one is covered by `scripts/test-leases.ts`.

| Control | Default | Enforced in | Why |
| --- | --- | --- | --- |
| Lease is short-lived | 120s, max 300s | `execute.ts` `MAX_LEASE_SECONDS` | Long enough to demo a page, too short to point a campaign at. The microVM's own `timeout` kills it — a crashed request cannot leave a page up. |
| One live lease per wallet | 1 | `guards.ts` `admitLease` | A second live page from the same payer is refused. One attacker with a funded wallet gets one surface, not a fleet. |
| Per-wallet start rate | 3 / 10 min | `guards.ts` `admitLease` | Caps churn — spin-up-abuse-teardown-repeat — from a single identity. |
| Global concurrency ceiling | 3 | `guards.ts` `admitLease` | Bounds total exposure across all payers at once. |
| No outbound network | always | `execute.ts` `serve` | The leased box answers visitors and reaches **nothing** — no DNS, no fetch. It cannot proxy, exfiltrate, or relay. Verified in `scripts/spike-serve.ts`. |
| URL never published | always | `feed.ts` | The public feed shows a lease happened, never where. No discoverable index of live agent pages. |

Two properties make this stronger than a typical free host, and both matter to a reviewer:

**The identity is the wallet, and it cannot be forged.** The per-wallet limits key on
`authorization.from` — the address that *signed the payment*. A caller cannot rotate it like
an IP without a different funded key, and every lease it ever opened is a transaction on a
public chain. Abuse carries a cost and a permanent pseudonymous trail.

**The limit is checked before the money moves.** `admitLease` runs after signature
verification but before settlement, so a refused caller is turned away for free — the system
never takes payment for a lease it won't grant. Confirmed live: a second lease from the same
wallet returns `429` with no on-chain transfer.

**What this does not do,** stated plainly: it does not inspect the *content* of a served
page. A single short-lived page from a rate-limited, on-chain-identified wallet is a poor
phishing vehicle, but a determined actor within those limits could still serve something
malicious for a few minutes. A commercial deployment adds content scanning and a takedown
path on top of these structural controls; they are complementary, not a substitute.

## Known limitations

**Package-install egress is bounded by time, not bytes.** `INSTALL_TIMEOUT_MS` is 25s and
registry traffic bills at $0.15/GB. A caller on a fast link can still pull more data than
their one cent covers. Metering the sandbox's own `totalEgressBytes` requires a blocking
stop (~3.7s per call), which is the wrong trade until abuse is actually observed.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck
```

Payment is skipped entirely unless `TINYDOCK_PAY_TO`, `OKX_API_KEY`, `OKX_SECRET_KEY` and
`OKX_PASSPHRASE` are all set, so the sandbox works locally with no credentials.

| Variable | Purpose |
| --- | --- |
| `TINYDOCK_PAY_TO` | Wallet that receives settlement |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | OKX settlement broker credentials |
| `TINYDOCK_PRICE` | Price per call in USD. Default `0.01` |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Redis, for shared counters. Absent → process memory |
| `TINYDOCK_TEST_KEY` | Private key for `scripts/pay-402.ts`. Never the `PAY_TO` wallet |

### Scripts

| | |
| --- | --- |
| `scripts/check-402.ts` | Build an unpaid 402 challenge. Exercises credentials, no money moves |
| `scripts/pay-402.ts` | Full paid call against a live deployment. `--yes` to actually spend |
| `scripts/try.ts` | Run the sandbox directly, bypassing payment |
| `scripts/test-guards.ts` | Admission control |
| `scripts/test-feed.ts` | Settlement is attributed to the execution that paid for it |
| `scripts/test-packages.ts` | Install-then-cut-network path |

## Stack

Vercel Sandbox (Firecracker) · `@okxweb3/x402-core` + `@okxweb3/x402-evm` · MCP TypeScript
SDK · X Layer mainnet · USD₮0 (`0x779ded0c9e1022225f8e0630b35a9b54be713736`, 6 decimals)
