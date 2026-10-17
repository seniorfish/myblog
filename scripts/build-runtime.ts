import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface RuntimePaths {
  sysJs: string;
  swJs: string;
}

export async function buildRuntime(root: string): Promise<RuntimePaths> {
  const outDir = path.join(root, 'build', 'runtime');
  await mkdir(outDir, { recursive: true });

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
  });

  return { sysJs, swJs };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const paths = await buildRuntime(process.cwd());
  console.log(`Built ${paths.sysJs}`);
  console.log(`Built ${paths.swJs}`);
}
