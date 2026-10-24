import { describe, expect, it } from 'vitest';
import { loadCronConfig } from '../src/config.js';

describe('cron configuration', () => {
  it('starts with only Render workflow settings', () => {
    expect(loadCronConfig({ RENDER_API_KEY: 'render-key' } as never)).toEqual({
      RENDER_API_KEY: 'render-key',
      RENDER_WORKFLOW_SLUG: 'briefly',
    });
  });
});
