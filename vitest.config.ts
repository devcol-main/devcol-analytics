import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          ALLOW_LOCALHOST: 'true',
          ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
          ACCESS_AUD: 'test-aud',
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
})
