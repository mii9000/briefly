import { loadConfig } from './config.js';
import { createDb } from './db/queries.js';
import { getPool } from './db/pool.js';
import { createRenderTrigger } from './render/trigger.js';
import { createSlackApp } from './slack/app.js';

const config = loadConfig();
const { app } = createSlackApp({
  db: createDb(getPool()),
  trigger: createRenderTrigger(config.RENDER_WORKFLOW_SLUG),
  signingSecret: config.SLACK_SIGNING_SECRET,
  token: config.SLACK_BOT_TOKEN,
  botUserId: config.SLACK_BOT_USER_ID,
  botId: config.SLACK_BOT_ID,
});

await app.start(Number(process.env.PORT ?? 10000));
