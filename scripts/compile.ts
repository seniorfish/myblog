import { compileSite } from '../core/build.ts';

const result = await compileSite({
  root: process.cwd(),
  requireCleanWorktree: process.env.CI === 'true',
});

for (const issue of result.issues) {
  const level = issue.level === 'error' ? 'ERROR' : 'WARN';
  const location = issue.file ? ` ${issue.file}` : '';
  const field = issue.field ? ` [${issue.field}]` : '';
  console.error(`${level}${location}${field}: ${issue.message}`);
  if (issue.suggestion) console.error(`  ${issue.suggestion}`);
}

if (!result.ok) {
  console.error('Compile failed.');
  process.exit(1);
}

console.log(`Compiled ${result.buildMeta?.nodeCount ?? 0} node(s).`);
console.log(`buildId: ${result.buildMeta?.buildId ?? 'unknown'}`);
console.log(`output: ${result.outDir}`);

for (const warning of result.buildMeta?.warnings ?? []) {
  console.warn(`WARN: ${warning}`);
}
