import { createRenderTrigger } from './render/trigger.js';
import { loadCronConfig } from './config.js';

const config = loadCronConfig();
const hour = new Date().toISOString().slice(0, 13);
await createRenderTrigger(config.RENDER_WORKFLOW_SLUG).startTask(
  'runDueWork',
  [new Date().toISOString()],
  `cron:${hour}`,
);
