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
  /** Workers AI (닉네임 검사). 없으면 규칙 검사만 한다. */
  AI?: Ai
  /** "off"면 AI 검사를 끈다 */
  AI_MODERATION?: string
  /** Workers AI 모델 id */
  AI_MODEL?: string
  /** AI 하루(UTC) 호출 상한. 무료 10,000 Neurons/일보다 한참 낮게 */
  AI_DAILY_CAP?: string
  /** 게임 slug 확인용 사이트 주소 (첫 제출 때 /games/<slug>/가 있는지 본다) */
  SITE_ORIGIN?: string
}

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}
