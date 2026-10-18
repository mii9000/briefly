import { Render } from '@renderinc/sdk';

export type TaskTrigger = {
  startTask(task: string, input: unknown[], key: string): Promise<string>;
};

export function createRenderTrigger(workflowSlug: string): TaskTrigger {
  const render = new Render();
  return {
    async startTask(task, input, key) {
      const taskPath = `${workflowSlug}/${task}`;
      const result = await render.workflows.startTask(taskPath, input, {
        idempotencyKey: key,
        signal: AbortSignal.timeout(2300),
      });
      return result.taskRunId;
    },
  };
}
