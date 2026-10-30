// 닉네임 규칙 검사 (형식 → 정규화 → 차단어). 순수 함수만 둔다. AI 검사는 ai.ts.
import { ALLOW_TERMS, EXACT_TERMS, SUBSTRING_TERMS } from './blocklist'
import { sha256Hex } from '../util'

export const NAME_MIN = 2
export const NAME_MAX = 12

/** 라틴 문자, 완성형 한글, 숫자. 단어 사이 공백 하나만. 이모지/기호/URL/낱자모(ㅅㅂ)는 형식에서 걸러진다. */
const NAME_RE = /^[A-Za-z0-9가-힣]+(?: [A-Za-z0-9가-힣]+)*$/

/** NFKC + 앞뒤 공백 제거 + 연속 공백 하나로. 전각 문자(Ａ)와 조합형 한글은 여기서 일반형이 된다. */
export function cleanName(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** 형식 규칙을 통과하면 정리된 이름, 아니면 null. */
export function checkFormat(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null
  const name = cleanName(raw)
  const len = [...name].length
  if (len < NAME_MIN || len > NAME_MAX) return null
  return NAME_RE.test(name) ? name : null
}

// ---------- 한글 접기: 된소리/비슷한 모음/늘여 쓰기를 같은 키로 ----------

const HANGUL_BASE = 0xac00
const HANGUL_END = 0xd7a3
// 초성: ㄲ→ㄱ ㄸ→ㄷ ㅃ→ㅂ ㅆ→ㅅ ㅉ→ㅈ
const CHO_FOLD = [0, 0, 2, 3, 3, 5, 6, 7, 7, 9, 9, 11, 12, 12, 14, 15, 16, 17, 18]
// 중성: ㅐㅒㅔㅖ→ㅔ, ㅑ→ㅏ, ㅕ→ㅓ, ㅛ→ㅗ, ㅠ→ㅜ, ㅙㅚㅞ→ㅞ, ㅟㅢ→ㅣ
const JUNG_FOLD = [0, 5, 0, 5, 4, 5, 4, 5, 8, 9, 15, 15, 8, 13, 14, 15, 20, 13, 18, 20, 20]
// 종성: ㄲ→ㄱ ㅆ→ㅅ
const JONG_FOLD = [0, 1, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 19, 21, 22, 23, 24, 25, 26, 27]
const CHO_IEUNG = 11

/** 음절마다 접고, '시이발'처럼 ㅇ+같은 모음으로 늘인 음절은 지운다. 한글이 아닌 문자는 그대로. */
export function foldHangul(s: string): string {
  let out = ''
  let prevJung = -1
  let prevJong = -1
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < HANGUL_BASE || c > HANGUL_END) {
      out += ch
      prevJung = -1
      continue
    }
    const i = c - HANGUL_BASE
    const cho = CHO_FOLD[Math.floor(i / 588)]
    const jung = JUNG_FOLD[Math.floor((i % 588) / 28)]
    const jong = JONG_FOLD[i % 28]
    if (cho === CHO_IEUNG && jong === 0 && jung === prevJung && prevJong === 0) continue
    out += String.fromCodePoint(HANGUL_BASE + (cho * 21 + jung) * 28 + jong)
    prevJung = jung
    prevJong = jong
  }
  return out
}

// ---------- 라틴 정규화 ----------

const LEET_I: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' }
const LEET_L: Record<string, string> = { ...LEET_I, '1': 'l' }

const mapChars = (s: string, m: Record<string, string>) => s.replace(/[0-9]/g, (d) => m[d] ?? d)
/** 같은 문자 연속을 하나로 (fuuuck → fuck, 시시발 → 시발) */
export const collapse = (s: string) => s.replace(/(.)\1+/gu, '$1')
/** 3번 이상 연속만 두 개로 (asss → ass). 짧은 정확 일치 단어용 */
const squeeze = (s: string) => s.replace(/(.)\1{2,}/gu, '$1$1')

/** 비교용 기본형: 소문자 + 한글 접기 + 허용 단어 제거 */
function base(s: string): string {
  let t = foldHangul(s.toLowerCase())
  for (const a of ALLOW_TERMS) t = t.split(foldHangul(a)).join(' ')
  return t
}

/** 이름을 비교용 변형들로: 원형, 리트(1→i / 1→l), 숫자 제거. 공백은 없앤다. */
export function variants(name: string): string[] {
  const b = base(name).replace(/ /g, '')
  return [...new Set([b, mapChars(b, LEET_I), mapChars(b, LEET_L), b.replace(/[0-9]/g, '')])]
}

/** 띄어쓰기로 나뉜 단어들 (정확 일치 검사용) */
function tokens(name: string): string[] {
  const words = base(name).split(' ').filter(Boolean)
  const out = new Set<string>()
  for (const w of [...words, words.join('')]) {
    out.add(w)
    out.add(mapChars(w, LEET_I))
    out.add(mapChars(w, LEET_L))
  }
  return [...out]
}

export interface RulesResult {
  ok: boolean
  /** 걸린 이유 (관리자 화면/테스트용). 공개 응답에는 넣지 않는다. */
  reason?: 'format' | 'blocklist'
  /** 형식 통과 시 정리된 이름 */
  name?: string
}

/** 차단어에 걸리는지. extraTerms = 관리자가 추가한 lb_terms (부분 일치). */
export function hitsBlocklist(name: string, extraTerms: readonly string[] = []): boolean {
  const vs = variants(name)
  const collapsed = vs.map(collapse)
  for (const raw of [...SUBSTRING_TERMS, ...extraTerms]) {
    const t = foldHangul(raw.toLowerCase().replace(/\s+/g, ''))
    if (!t) continue
    if (vs.some((v) => v.includes(t))) return true
    // 반복 접기는 충분히 긴 단어에만: 짧은 단어끼리는 정상 이름과 너무 자주 겹친다
    const ct = collapse(t)
    if ([...ct].length >= 3 && collapsed.some((v) => v.includes(ct))) return true
  }
  const toks = tokens(name).flatMap((w) => [w, squeeze(w)])
  for (const raw of EXACT_TERMS) {
    if (toks.includes(foldHangul(raw))) return true
  }
  return false
}

/** 형식 + 차단어. AI는 이걸 통과한 이름에만 쓴다. */
export function checkRules(raw: unknown, extraTerms: readonly string[] = []): RulesResult {
  const name = checkFormat(raw)
  if (!name) return { ok: false, reason: 'format' }
  if (hitsBlocklist(name, extraTerms)) return { ok: false, reason: 'blocklist', name }
  return { ok: true, name }
}

/** AI 캐시 키. 대소문자/공백 차이만 같은 이름으로 본다. */
export const nameKey = (name: string) => cleanName(name).toLowerCase()

/** 걸린 이름 대신 공개하는 이름. owner마다 고정된 4자리. */
export async function fallbackName(ownerId: string): Promise<string> {
  const h = await sha256Hex(`lb-name|${ownerId}`)
  return `Player${(parseInt(h.slice(0, 8), 16) % 10000).toString().padStart(4, '0')}`
}
