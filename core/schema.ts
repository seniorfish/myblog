import { z } from 'zod';

export const ALLOWED_FRONTMATTER_KEYS = [
  'tags',
  'title',
  'extends',
  'description',
  'url',
  'aliases',
  'draft',
] as const;

export const FORBIDDEN_DATE_KEYS = [
  'date',
  'pubDate',
  'publishedAt',
  'createdAt',
  'updatedAt',
  'timestamp',
] as const;

export class FrontmatterError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

export const frontmatterSchema = z.object({
  tags: z.union([z.string(), z.array(z.string())]),
  title: z.string().trim().min(1).optional(),
  extends: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  url: z.url().optional(),
  aliases: z.array(z.string().trim().min(1)).optional(),
  draft: z.boolean().optional(),
});

export type Frontmatter = z.infer<typeof frontmatterSchema>;

/**
 * Validate raw metadata before Zod parsing so date fields and typos get
 * actionable error messages instead of a generic "unrecognized key" error.
 */
export function parseFrontmatter(raw: unknown): Frontmatter {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FrontmatterError('Metadata must be a YAML mapping.');
  }

  const record = raw as Record<string, unknown>;

  for (const key of FORBIDDEN_DATE_KEYS) {
    if (key in record) {
      throw new FrontmatterError(
        `Metadata field "${key}" is not allowed. Dates are derived from Git commits and blockchain anchors; remove it.`,
        key,
      );
    }
  }

  const unknown = Object.keys(record).filter(
    (key) => !(ALLOWED_FRONTMATTER_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new FrontmatterError(
      `Unknown metadata field(s): ${unknown.join(', ')}. Allowed: ${ALLOWED_FRONTMATTER_KEYS.join(', ')}.`,
      unknown[0],
    );
  }

  const result = frontmatterSchema.safeParse(record);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path.join('.') || undefined;
    throw new FrontmatterError(
      first ? `${field ?? 'metadata'}: ${first.message}` : result.error.message,
      field,
    );
  }

  return result.data;
}

export interface NormalizedTags {
  rawTags: string;
  primaryTag: string;
  secondaryTags: string[];
}

/** Tags are whitespace-separated; the first token is the primary tag. */
export function normalizeTags(value: string | string[]): NormalizedTags {
  const tokens = (Array.isArray(value) ? value : [value])
    .flatMap((item) => item.split(/\s+/u))
    .map((item) => item.trim())
    .filter(Boolean);

  const unique = [...new Set(tokens)];
  if (unique.length === 0) {
    throw new FrontmatterError('tags must contain at least one tag.', 'tags');
  }

  const [primaryTag, ...secondaryTags] = unique as [string, ...string[]];
  return {
    rawTags: unique.join(' '),
    primaryTag,
    secondaryTags,
  };
}

export const anchorNoteSchema = z.object({
  schema: z.literal(1),
  chain: z.string().min(1),
  chainId: z.number().int().positive(),
  tx: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  block: z.number().int().nonnegative(),
  blockTimestamp: z.number().int().nonnegative(),
  commit: z.string().regex(/^[0-9a-fA-F]{40,64}$/),
  repo: z.string().min(1),
});

export type AnchorNote = z.infer<typeof anchorNoteSchema>;

export const themeContractSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  model: z.string().min(1),
  description: z.string().min(1),
  author: z.string().min(1),
  isDefault: z.boolean(),
  version: z.string().min(1),
});

export type ThemeContract = z.infer<typeof themeContractSchema>;

const displayRuleSchema = z.object({
  mode: z.enum(['excerpt', 'full', 'full-if-short', 'link']),
  maxChars: z.number().int().positive().optional(),
});

export const siteConfigSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  author: z.string().min(1),
  url: z.url(),
  lang: z.string().min(2),
  timezone: z.string().min(1),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  defaultTheme: z.string().min(1),
  themes: z.array(z.string().min(1)).min(1),
  homeTag: z.string().min(1),
  ui: z
    .object({
      contentDisplay: z.record(z.string(), displayRuleSchema).optional(),
    })
    .optional(),
  chain: z.object({
    enabled: z.boolean(),
    name: z.string().min(1),
    chainId: z.number().int().positive(),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    rpcUrl: z.url(),
    explorerUrl: z.url(),
    confirmations: z.number().int().nonnegative().optional(),
  }),
});
