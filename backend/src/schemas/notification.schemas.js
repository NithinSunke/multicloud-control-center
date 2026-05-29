import { z } from 'zod';

const optionalString = z.string().optional().default('');
const thresholdPairSchema = z.object({
  warning: z.coerce.number().int().min(1).max(100).optional().default(80),
  critical: z.coerce.number().int().min(1).max(100).optional().default(90),
}).refine((value) => value.critical > value.warning, {
  message: 'Critical threshold must be higher than warning threshold.',
  path: ['critical'],
});

export const notificationReadBodySchema = z.object({
  read: z.boolean().optional().default(true),
});

export const notificationSettingsBodySchema = z.object({
  enabled: z.boolean().optional().default(true),
  minSeverity: z.enum(['info', 'warning', 'critical']).optional().default('warning'),
  resourceAlerts: z.object({
    enabled: z.boolean().optional().default(true),
    cpu: thresholdPairSchema.optional().default({ warning: 80, critical: 90 }),
    memory: thresholdPairSchema.optional().default({ warning: 80, critical: 90 }),
    storage: thresholdPairSchema.optional().default({ warning: 80, critical: 90 }),
  }).optional().default({}),
  email: z.object({
    enabled: z.boolean().optional().default(false),
    to: optionalString,
    from: optionalString,
    host: optionalString,
    port: z.coerce.number().int().min(1).max(65535).optional().default(587),
    secure: z.boolean().optional().default(false),
    username: optionalString,
    password: optionalString,
  }).optional().default({}),
  slack: z.object({
    enabled: z.boolean().optional().default(false),
    webhookUrl: optionalString,
  }).optional().default({}),
  teams: z.object({
    enabled: z.boolean().optional().default(false),
    webhookUrl: optionalString,
  }).optional().default({}),
  genericWebhook: z.object({
    enabled: z.boolean().optional().default(false),
    webhookUrl: optionalString,
  }).optional().default({}),
});
