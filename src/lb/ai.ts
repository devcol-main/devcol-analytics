// Workers AI 닉네임 검사. 무료 할당(하루 10,000 Neurons, 00:00 UTC 초기화) 안에서만 쓴다.
// 비용 안전장치: D1의 하루 호출 상한(AI_DAILY_CAP)을 호출 *전에* 원자적으로 올리고, 상한/오류/시간 초과면
// 'unknown'을 돌려준다. 호출하는 쪽은 그때 규칙 검사 결과만으로 판정한다.
// 2026-10-30 실측 (KO/EN 18개 이름): llama-3.1-8b-instruct-fp8-fast 호출당 ~0.7 Neurons, 300~500ms, 16개 중 15개 적중.
// gemma-4 / qwen3는 추론 토큰 때문에 짧은 max_tokens에서 빈 답, llama-guard-3는 system 역할을 받지 않는다.
// 상한 1000회 ≈ 700 Neurons/일 (무료 할당의 7%).
import type { AppEnv } from '../env'

export type AiVerdict = 'safe' | 'unsafe' | 'unknown'

export const DEFAULT_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast'
export const DEFAULT_AI_DAILY_CAP = 1000
export const AI_TIMEOUT_MS = 2500

const SYSTEM_PROMPT = `You moderate nicknames on a public video game leaderboard. Nicknames may be Korean, English or romanized Korean.
Answer UNSAFE if the nickname is profane, sexual, hateful, a slur, harassing, about self-harm, drugs or violence, impersonates staff, or hides such a word with spacing, numbers, misspelling, or romanization (for example ssibal, byungsin, gaesaekki).
Otherwise answer SAFE. Reply with exactly one word: SAFE or UNSAFE.`

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function aiEnabled(env: Pick<AppEnv, 'AI' | 'AI_MODERATION'>): boolean {
  return !!env.AI && env.AI_MODERATION !== 'off'
}

/** 오늘(UTC) 호출 수를 1 올린다. 상한에 이미 닿았으면 false (올리지 않음). */
export async function takeAiBudget(db: D1Database, cap: number, now: number): Promise<boolean> {
  if (cap <= 0) return false
  const row = await db
    .prepare(
      `INSERT INTO lb_ai_usage (day, calls) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET calls = calls + 1 WHERE calls < ?
       RETURNING calls`,
    )
    .bind(utcDay(now), cap)
    .first<{ calls: number }>()
  return row !== null
}

export function capOf(env: Pick<AppEnv, 'AI_DAILY_CAP'>): number {
  const n = Number(env.AI_DAILY_CAP)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_AI_DAILY_CAP
}

/** 모델 응답 텍스트 → 판정. Llama Guard('safe' / 'unsafe\nS10')와 일반 지시 모델 모두 이 형태로 답한다. */
export function parseVerdict(text: unknown): AiVerdict {
  if (typeof text !== 'string') return 'unknown'
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().toLowerCase()
  if (/\bunsafe\b/.test(t)) return 'unsafe'
  if (/\bsafe\b/.test(t)) return 'safe'
  return 'unknown'
}

function responseText(out: unknown): unknown {
  if (typeof out !== 'object' || out === null) return out
  const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] }
  return o.response ?? o.choices?.[0]?.message?.content
}

/** AI로 이름 하나를 검사한다. 꺼져 있음/상한/오류/시간 초과/알 수 없는 답은 모두 'unknown'. */
export async function aiCheckName(env: AppEnv, name: string, now = Date.now()): Promise<AiVerdict> {
  if (!aiEnabled(env)) return 'unknown'
  try {
    if (!(await takeAiBudget(env.DB, capOf(env), now))) return 'unknown'
    const run = env.AI!.run(
      (env.AI_MODEL || DEFAULT_AI_MODEL) as Parameters<Ai['run']>[0],
      {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Nickname: "${name}"` },
        ],
        max_tokens: 8,
        temperature: 0,
      } as never,
    )
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), AI_TIMEOUT_MS)
    })
    const out = await Promise.race([run, timeout])
    clearTimeout(timer)
    if (out === 'timeout') return 'unknown'
    return parseVerdict(responseText(out))
  } catch {
    return 'unknown'
  }
}
