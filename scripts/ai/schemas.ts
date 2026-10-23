import { z } from 'zod';

export const FRONTMATTER_FIELDS = ['tags', 'title', 'description', 'extends', 'url'] as const;
export type FrontmatterField = (typeof FRONTMATTER_FIELDS)[number];

export const frontmatterProposalSchema = z.object({
  tags: z.union([z.array(z.string()), z.string()]).nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  extends: z
    .object({
      id: z.string().min(1),
      confidence: z.number().min(0).max(1).default(0.5),
      reason: z.string().default(''),
    })
    .nullable()
    .optional(),
  url: z.string().nullable().optional(),
  reasons: z.record(z.string(), z.string()).optional(),
});

export type FrontmatterProposal = z.infer<typeof frontmatterProposalSchema>;

export const languageProposalSchema = z.object({
  suggestions: z
    .array(
      z.object({
        quote: z.string(),
        replacement: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
  rewritten: z.string().nullable().optional(),
});

export type LanguageProposal = z.infer<typeof languageProposalSchema>;

export const LANGUAGE_MODES = ['proofread', 'concise', 'formal', 'casual'] as const;
export type LanguageMode = (typeof LANGUAGE_MODES)[number];

export const LANGUAGE_OUTPUTS = ['advice', 'rewrite'] as const;
export type LanguageOutput = (typeof LANGUAGE_OUTPUTS)[number];

export const slugProposalSchema = z.object({
  id: z.string().nullable().optional(),
  alternatives: z.array(z.string()).default([]),
  reason: z.string().default(''),
});

export type SlugProposal = z.infer<typeof slugProposalSchema>;
