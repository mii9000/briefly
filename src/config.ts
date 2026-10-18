import { z } from 'zod';
import { config as loadDotEnv } from 'dotenv';

loadDotEnv({ quiet: true });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_BOT_USER_ID: z.string().min(1),
  SLACK_BOT_ID: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  RENDER_API_KEY: z.string().min(1),
  RENDER_WORKFLOW_SLUG: z.string().default('briefly'),
  BRIEFLY_TIME_ZONE: z
    .string()
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    })
    .default('Europe/Amsterdam'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return envSchema.parse(env);
}
