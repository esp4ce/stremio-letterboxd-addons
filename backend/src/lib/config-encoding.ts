import { z } from 'zod';

export const publicConfigSchema = z.object({
  u: z.string().optional(),
  c: z.object({
    watchlist: z.boolean().optional(),
    popular: z.boolean(),
    top250: z.boolean(),
    likedFilms: z.boolean().optional(),
  }),
  l: z.array(z.string()),
  r: z.boolean(),
  n: z.record(z.string(), z.string()).optional(),
  w: z.array(z.string()).optional(),
  o: z.array(z.string()).optional(),
});

export type PublicConfig = z.infer<typeof publicConfigSchema>;

export function encodeConfig(config: PublicConfig): string {
  const json = JSON.stringify(config);
  return Buffer.from(json, 'utf-8')
    .toString('base64url');
}

export function decodeConfig(encoded: string): PublicConfig | null {
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json);
    const result = publicConfigSchema.safeParse(parsed);
    if (!result.success) return null;

    // Watchlist only valid if username is set
    if (result.data.c.watchlist && !result.data.u) {
      result.data.c.watchlist = false;
    }

    return result.data;
  } catch {
    return null;
  }
}
