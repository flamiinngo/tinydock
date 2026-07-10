import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_TIMEOUT_MS,
  ExecuteError,
  MAX_LEASE_SECONDS,
  MAX_PACKAGES,
  MAX_TIMEOUT_MS,
  SERVE_PORT,
  burnedSandboxTime,
  execute,
  serve,
} from './execute.js';
import { recordExecution } from './feed.js';
import { admitLease, recordUsage } from './guards.js';
import { settlementContext } from './settlement-context.js';

const DESCRIPTION = [
  'Run a short program in a throwaway, network-isolated Linux microVM and return its output.',
  '',
  'Name any packages you need and they are installed before the network is switched off.',
  'Your program itself always runs with no network and no DNS, so it cannot fetch anything',
  `at runtime. Execution is capped at ${MAX_TIMEOUT_MS / 1000}s and nothing persists between`,
  'calls. Write output to stdout.',
].join('\n');

const SERVE_DESCRIPTION = [
  'Lease a public HTTPS URL backed by a throwaway Linux microVM, and get the URL back.',
  '',
  `Write an HTTP server that listens on the port in $PORT (${SERVE_PORT}). It is reachable`,
  'from the open internet, but it has no outbound network and no DNS: it can answer',
  'visitors and reach nothing. Name any packages you need and they are installed before',
  'the network is switched off.',
  '',
  `The URL dies after the lease (default ${DEFAULT_LEASE_SECONDS}s, max ${MAX_LEASE_SECONDS}s)`,
  'and nothing persists. One live lease per paying wallet.',
].join('\n');

export function createServer(): McpServer {
  const server = new McpServer({ name: 'tinydock', version: '0.1.0' });

  server.registerTool(
    'run_code',
    {
      title: 'Run code in a sandbox',
      description: DESCRIPTION,
      inputSchema: {
        language: z.enum(['node', 'python']).describe('Runtime: Node.js 24 or Python 3.13.'),
        source: z.string().min(1).describe('Complete program source. Print results to stdout.'),
        packages: z
          .array(z.string())
          .max(MAX_PACKAGES)
          .optional()
          .describe(
            'Plain package names from PyPI or npm, installed before the network is cut. ' +
              'No versions, URLs or flags.',
          ),
        timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(`Wall-clock limit. Defaults to ${DEFAULT_TIMEOUT_MS}ms.`),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ language, source, packages, timeout_ms }) => {
      const startedAt = Date.now();
      try {
        const result = await execute({ language, source, packages, timeoutMs: timeout_ms });
        await recordUsage('paid', result.durationMs);
        await recordExecution({
          language,
          runMs: result.runMs,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          demo: false,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  stdout: result.stdout,
                  stderr: result.stderr,
                  exit_code: result.exitCode,
                  timed_out: result.timedOut,
                  run_ms: result.runMs,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        if (burnedSandboxTime(err)) await recordUsage('paid', Date.now() - startedAt);

        if (err instanceof ExecuteError) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }],
          };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'serve',
    {
      title: 'Lease a public URL',
      description: SERVE_DESCRIPTION,
      inputSchema: {
        language: z.enum(['node', 'python']).describe('Runtime: Node.js 24 or Python 3.13.'),
        source: z
          .string()
          .min(1)
          .describe(`An HTTP server that listens on the port in $PORT (${SERVE_PORT}).`),
        packages: z
          .array(z.string())
          .max(MAX_PACKAGES)
          .optional()
          .describe('Plain package names, installed before the network is cut.'),
        leaseSeconds: z
          .number()
          .int()
          .min(10)
          .max(MAX_LEASE_SECONDS)
          .optional()
          .describe(`How long the URL stays up. Defaults to ${DEFAULT_LEASE_SECONDS}s.`),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ language, source, packages, leaseSeconds }) => {
      const slot = settlementContext.getStore();
      const seconds = leaseSeconds ?? DEFAULT_LEASE_SECONDS;

      /**
       * Paid callers were admitted before settlement, in route-mcp. This path only runs
       * with payment disabled — locally — and must not become a way to skip the limits.
       */
      let reservation = slot?.lease;
      if (!reservation) {
        const admission = await admitLease(slot?.payer ?? 'unpaid', seconds);
        if (!admission.ok) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `${admission.denied.code}: ${admission.denied.message}`,
              },
            ],
          };
        }
        reservation = admission;
      }

      try {
        const lease = await serve({ language, source, packages, leaseSeconds: seconds });

        // Wall clock, and a leased server is mostly idle — so this meter is not `paid`.
        await recordUsage('lease', lease.leaseSeconds * 1000);
        await recordExecution({
          language,
          runMs: lease.bootMs,
          exitCode: 0,
          timedOut: false,
          demo: false,
          kind: 'serve',
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  url: lease.url,
                  expires_at: new Date(lease.expiresAt).toISOString(),
                  lease_seconds: lease.leaseSeconds,
                  boot_ms: lease.bootMs,
                  note: 'The sandbox has no outbound network. It can answer visitors and reach nothing.',
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        // Never served, so give the slot back rather than hold it until it expires.
        await reservation.release();

        if (err instanceof ExecuteError) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }],
          };
        }
        throw err;
      }
    },
  );

  return server;
}
