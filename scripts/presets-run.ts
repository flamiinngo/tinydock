import { execute } from '../src/execute.js';
import { PRESETS } from '../src/presets.js';

for (const preset of PRESETS) {
  const result = await execute({ language: preset.language, source: preset.source, timeoutMs: 2000 });
  console.log(
    JSON.stringify({
      id: preset.id,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      spawnMs: result.spawnMs,
      runMs: result.runMs,
      durationMs: result.durationMs,
    }),
  );
}
