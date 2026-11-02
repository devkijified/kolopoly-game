import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/worker/**/*.test.mjs'],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            KP_TEST: '1',
            KP_AFK_FAST: '1',
            KP_ADMIN_TOKEN: 'test-house-key'
          }
        }
      }
    }
  }
});
