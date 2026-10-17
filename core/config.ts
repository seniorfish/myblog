import config from '../site.config.ts';
import type { SiteConfig } from './contract.ts';
import { siteConfigSchema } from './schema.ts';

export function loadSiteConfig(): SiteConfig {
  const result = siteConfigSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid site.config.ts:\n${details}`);
  }

  const parsed = result.data as SiteConfig;
  parsed.url = parsed.url.replace(/\/+$/u, '');

  if (!parsed.themes.includes(parsed.defaultTheme)) {
    throw new Error(
      `site.config.ts: defaultTheme "${parsed.defaultTheme}" is not listed in themes.`,
    );
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: parsed.timezone }).format(new Date());
  } catch {
    throw new Error(`site.config.ts: invalid timezone "${parsed.timezone}".`);
  }

  return parsed;
}
