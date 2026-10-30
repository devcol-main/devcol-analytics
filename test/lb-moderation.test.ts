import { describe, expect, it } from 'vitest'
import { parseVerdict } from '../src/lb/ai'
import { checkFormat, checkRules, fallbackName, foldHangul, hitsBlocklist, nameKey } from '../src/lb/moderation'

describe('nickname format', () => {
  it.each(['Kim', 'devcol fan', '김철수', '고양이123', 'Ab', 'abcdefghijkl', '홍길동 KR'])('%s passes', (name) => {
    expect(checkFormat(name)).toBe(name)
  })

  it.each([
    ['too short', 'a'],
    ['too long', 'abcdefghijklm'],
    ['empty', '   '],
    ['standalone jamo', 'ㅅㅂ'],
    ['jamo mixed in', '김ㅋㅋ'],
    ['emoji', 'cat😺'],
    ['symbols', 'kim_lee'],
    ['URL', 'evil.com'],
    ['URL with scheme', 'http://x.io'],
    ['tab-only', '\t\t'],
    ['not a string', 42],
  ])('%s → rejected', (_, name) => {
    expect(checkFormat(name)).toBeNull()
  })

  it('NFKC and spacing are normalized before the check', () => {
    expect(checkFormat('  Ｋｉｍ   Lee ')).toBe('Kim Lee')
    expect(checkFormat('Kim\nLee')).toBe('Kim Lee')
    // 조합형(NFD) 한글 → 완성형
    expect(checkFormat('김철수'.normalize('NFD'))).toBe('김철수')
  })
})

describe('blocklist (Korean)', () => {
  it.each(['씨발', '시발', '시1발', '씨이발', '시이이발', '싀발', '씨빨', '병신', '븅신', '개새끼', '개색기', '존나', '좆밥', '니애미', '지랄', '미친놈', '꺼져', '섹스', '야동', '운영자', '관리자', '일베', '18놈'])(
    '%s → blocked',
    (name) => {
      expect(checkRules(name)).toMatchObject({ ok: false })
    },
  )

  it.each(['김철수', '고양이', '시발점', '시발역', '개발새발', '사과나무', '별빛', '새벽', '병아리'])('%s passes', (name) => {
    expect(checkRules(name)).toEqual({ ok: true, name })
  })

  it('folds 된소리 and similar vowels to one key', () => {
    expect(foldHangul('씨발')).toBe(foldHangul('시발'))
    expect(foldHangul('싀발')).toBe(foldHangul('시발'))
    expect(foldHangul('시이발')).toBe(foldHangul('시발'))
  })
})

describe('blocklist (English)', () => {
  it.each(['fuck', 'FUCK', 'f u c k', 'fuuuck', 'fck you', 'shit', '5h1t', 'sh1t', 'b1tch', 'asshole', 'ass', 'a s s', 'nazi', 'admin', 'Devcol', 'Official', 'www', 'ssibal', 'byungsin', 'kys', 'wtf'])(
    '%s → blocked',
    (name) => {
      expect(checkRules(name)).toMatchObject({ ok: false })
    },
  )

  it.each(['class', 'Assassin', 'Bass', 'Scunthorpe', 'Peacock', 'Dickens', 'Cocktail', 'grass hero', 'Glass', 'Kim', 'Lucky7', 'Model'])('%s passes', (name) => {
    expect(checkRules(name)).toMatchObject({ ok: true })
  })

  it('format failures report reason "format", blocklist hits report "blocklist"', () => {
    expect(checkRules('ㅅㅂ')).toEqual({ ok: false, reason: 'format' })
    expect(checkRules('fuck')).toMatchObject({ ok: false, reason: 'blocklist' })
  })
})

describe('admin-added terms (lb_terms)', () => {
  it('extra terms match as substrings with the same normalization', () => {
    expect(hitsBlocklist('noobking', ['noob'])).toBe(true)
    expect(hitsBlocklist('n00b king', ['noob'])).toBe(true)
    expect(hitsBlocklist('뉴비킹', ['뉴비'])).toBe(true)
    expect(hitsBlocklist('noobking')).toBe(false)
  })
})

describe('fallback name and keys', () => {
  it('Player#### is stable per owner and differs between owners (usually)', async () => {
    const a = await fallbackName('owner-a')
    expect(a).toMatch(/^Player\d{4}$/)
    expect(await fallbackName('owner-a')).toBe(a)
    expect(await fallbackName('owner-b')).not.toBe(a)
  })

  it('nameKey ignores case and spacing differences only', () => {
    expect(nameKey('  Kim  Lee ')).toBe('kim lee')
    expect(nameKey('KIM LEE')).toBe(nameKey('kim lee'))
  })
})

describe('AI verdict parsing', () => {
  it.each([
    ['SAFE', 'safe'],
    ['UNSAFE', 'unsafe'],
    ['unsafe\nS10', 'unsafe'],
    [' Safe. ', 'safe'],
    ['<think>hmm unsafe?</think>SAFE', 'safe'],
    ['', 'unknown'],
    ['maybe', 'unknown'],
    [undefined, 'unknown'],
  ])('%j → %s', (text, verdict) => {
    expect(parseVerdict(text)).toBe(verdict)
  })
})
