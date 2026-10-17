import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface RuntimeOptions {
  /** Dev builds use 1000ms; production/CI sets this to 30 minutes. */
  checkIntervalMs?: number;
  /** Changes whenever the worker code is built; defaults to a timestamp. */
  buildId?: string;
}

export interface RuntimePaths {
  sysJs: string;
  swJs: string;
  checkIntervalMs: number;
  buildId: string;
}

export async function buildRuntime(
  root: string,
  options: RuntimeOptions = {},
): Promise<RuntimePaths> {
  const outDir = path.join(root, 'build', 'runtime');
  await mkdir(outDir, { recursive: true });

  const envInterval = Number(process.env.SW_CHECK_INTERVAL_MS);
  const fallbackInterval =
    process.env.CI === 'true' ? 30 * 60 * 1000 : 1000;
  const checkIntervalMs =
    options.checkIntervalMs ??
    (Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : fallbackInterval);
  const buildId =
    options.buildId ?? process.env.SW_BUILD_ID ?? new Date().toISOString();

  const common = {
    bundle: true,
    format: 'iife' as const,
    platform: 'browser' as const,
    target: 'es2022',
    logLevel: 'info' as const,
  };

  const sysJs = path.join(outDir, 'sys.js');
  const swJs = path.join(outDir, 'sw.js');

  await build({
    ...common,
    entryPoints: [path.join(root, 'host', 'sys.ts')],
    outfile: sysJs,
  });

  await build({
    ...common,
    entryPoints: [path.join(root, 'sw', 'sw.ts')],
    outfile: swJs,
    define: {
      __SW_CHECK_INTERVAL_MS__: JSON.stringify(checkIntervalMs),
      __SW_BUILD__: JSON.stringify(buildId),
    },
  });

  return { sysJs, swJs, checkIntervalMs, buildId };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const paths = await buildRuntime(process.cwd());
  console.log(`Built ${paths.sysJs}`);
  console.log(`Built ${paths.swJs}`);
  console.log(`SW build: ${paths.buildId}`);
  console.log(`SW check interval: ${paths.checkIntervalMs}ms`);
}
