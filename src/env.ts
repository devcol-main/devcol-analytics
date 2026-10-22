export interface AppEnv {
  DB: D1Database
  /** 쉼표로 구분한 허용 Origin 목록 (wrangler.toml [vars]) */
  ALLOWED_ORIGINS: string
  /** "true"면 localhost / 127.0.0.1 Origin 허용 (로컬 테스트 모드) */
  ALLOW_LOCALHOST: string
  /** Cloudflare Access 팀 도메인, 예: myteam.cloudflareaccess.com (wrangler secret) */
  ACCESS_TEAM_DOMAIN?: string
  /** Cloudflare Access Application AUD 태그 (wrangler secret) */
  ACCESS_AUD?: string
}

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}
