import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required.').max(128, 'Username is too long.'),
  password: z.string().min(1, 'Password is required.').max(512, 'Password is too long.'),
});
