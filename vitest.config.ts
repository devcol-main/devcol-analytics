import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      // [ai] 바인딩은 원격 전용이라 테스트에서는 연결하지 않는다. 테스트는 testEnv()의 가짜 AI를 쓴다.
      remoteBindings: false,
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
