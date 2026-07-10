import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DEFAULT_TIMEOUT_MS,
  ExecuteError,
  MAX_PACKAGES,
  MAX_TIMEOUT_MS,
  burnedSandboxTime,
  execute,
} from './execute.js';
import { recordExecution } from './feed.js';
import { recordUsage } from './guards.js';

const DESCRIPTION = [
  'Run a short program in a throwaway, network-isolated Linux microVM and return its output.',
  '',
  'Name any packages you need and they are installed before the network is switched off.',
  'Your program itself always runs with no network and no DNS, so it cannot fetch anything',
  `at runtime. Execution is capped at ${MAX_TIMEOUT_MS / 1000}s and nothing persists between`,
  'calls. Write output to stdout.',
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
        recordUsage('paid', result.durationMs);
        recordExecution({
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
        if (burnedSandboxTime(err)) recordUsage('paid', Date.now() - startedAt);

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
