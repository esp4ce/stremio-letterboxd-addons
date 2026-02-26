import { z } from 'zod';

export const loginBodySchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export type LoginBody = z.infer<typeof loginBodySchema>;

export const userPreferencesSchema = z.object({
  catalogs: z.object({
    watchlist: z.boolean(),
    diary: z.boolean(),
    friends: z.boolean(),
    popular: z.boolean().default(false),
    top250: z.boolean().default(true),
    likedFilms: z.boolean().default(false),
  }),
  ownLists: z.array(z.string()),
  externalLists: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      owner: z.string(),
      filmCount: z.number(),
    })
  ),
  externalWatchlists: z.array(
    z.object({
      username: z.string(),
      displayName: z.string(),
    })
  ).optional(),
  showActions: z.boolean().default(true),
  showRatings: z.boolean().default(true),
  catalogNames: z.record(z.string()).optional(),
});

export const loginResponseSchema = z.object({
  userToken: z.string(),
  manifestUrl: z.string(),
  user: z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string().nullable(),
  }),
  lists: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      filmCount: z.number(),
      description: z.string().optional(),
    })
  ),
  preferences: userPreferencesSchema.nullable(),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const preferencesBodySchema = z.object({
  userToken: z.string().min(1, 'User token is required'),
  preferences: userPreferencesSchema,
});

export type PreferencesBody = z.infer<typeof preferencesBodySchema>;
