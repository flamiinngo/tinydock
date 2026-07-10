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
bills a one-minute minimum per `Sandbox.create()` no matter how briefly the program runs:

```
4 GB × (1/60) hr × $0.0212/GB-hr  =  $0.001413   per call, before any CPU burns
```

A 200 ms `print(1)` and a 5-second loop cost nearly the same. Active CPU adds ~$0.0004 at
worst. So a bare call costs roughly **$0.0016–0.0018** against $0.01 collected — about six
times coverage.

## Known limitations

Stated plainly, because they're real.

**The public feed is not durable.** `src/feed.ts` keeps executions in process memory.
Vercel Functions are stateless, so when an instance recycles the counter resets and past
settlements vanish from `/api/stats`. Money is never lost — every cent lands in `PAY_TO` on
chain — but the displayed total under-reports. A shared counter (Upstash) fixes it.

**The budget ceiling has the same hole,** and it matters more. `src/guards.ts` enforces the
monthly execution budget per instance, so under the concurrency that spawns several warm
instances, the fleet can overshoot a limit that each instance individually respects. The
guard is weakest under exactly the load it exists to stop.

**Package-install egress is bounded by time, not bytes.** `INSTALL_TIMEOUT_MS` is 45s and
registry traffic bills at $0.15/GB. A caller naming five large packages can cost more in
data transfer than the one cent they paid.

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
| `TINYDOCK_TEST_KEY` | Private key for `scripts/pay-402.ts`. Never the `PAY_TO` wallet |

### Scripts

| | |
| --- | --- |
| `scripts/check-402.ts` | Build an unpaid 402 challenge. Exercises credentials, no money moves |
| `scripts/pay-402.ts` | Full paid call against a live deployment. `--yes` to actually spend |
| `scripts/try.ts` | Run the sandbox directly, bypassing payment |
| `scripts/test-guards.ts` | Admission control |
| `scripts/test-packages.ts` | Install-then-cut-network path |

## Stack

Vercel Sandbox (Firecracker) · `@okxweb3/x402-core` + `@okxweb3/x402-evm` · MCP TypeScript
SDK · X Layer mainnet · USD₮0 (`0x779ded0c9e1022225f8e0630b35a9b54be713736`, 6 decimals)
