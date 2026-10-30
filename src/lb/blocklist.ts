// 닉네임 기본 차단어 (한국어 + 영어). 공개 리포라서 목록도 공개된다. 우회 변형(띄어쓰기, 리트, 반복, 된소리/모음 변형)은
// moderation.ts의 정규화가 처리하므로 여기에는 대표형만 적는다. 운영 중 추가는 /admin의 차단어(lb_terms)로 한다.

/** 이름 어디에 들어 있어도 막는다. */
export const SUBSTRING_TERMS: readonly string[] = [
  // 영어
  'fuck', 'fck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'asshole', 'bastard', 'nigger', 'nigga',
  'faggot', 'retard', 'whore', 'slut', 'nazi', 'hitler', 'porn', 'penis', 'vagina', 'boob',
  'tits', 'dildo', 'jizz', 'wank', 'twat', 'molest', 'pedo', 'incest', 'killyou',
  // 한국어 욕설의 로마자 표기
  'ssibal', 'sibal', 'shibal', 'ssival', 'byungsin', 'byeongsin', 'gaesaekki', 'gaesaeki', 'jiral', 'jonna', 'jotna',
  // 한국어
  '시발', '시팔', '씨빨', '개새끼', '개새', '개색', '새끼', '병신', '븅신', '빙신', '좆', '존나', '졸라', '지랄',
  '미친놈', '미친년', '미친새', '닥쳐', '엿먹', '꺼져', '느금', '니애미', '니미', '애미', '애비', '섹스', '보지',
  '자지', '창녀', '걸레년', '한남충', '김치녀', '된장녀', '메갈', '일베', '틀딱', '급식충', '똘추', '호로새끼', '쌍놈', '쌍년',
  '좃', '십새', '씹', '야동', '자살', '살인',
  // 사칭 방지 (운영자처럼 보이는 이름)
  'admin', 'devcol', 'moderator', 'official', '운영자', '관리자', '운영진', '개발자',
  // URL 흔적
  'http', 'www',
]

/** 이름 전체 또는 띄어쓰기로 나뉜 한 단어가 정확히 같을 때만 막는다 (짧아서 다른 단어 안에 자주 나오는 것). */
export const EXACT_TERMS: readonly string[] = [
  'ass', 'fag', 'fuk', 'sex', 'cum', 'rape', 'rapist', 'kys', 'kkk', 'gm', 'staff', 'system', 'mod', 'wtf', 'stfu', 'milf', 'anal', 'hoe',
  '18', '18놈', '18년',
]

/** 정상 단어가 차단어를 포함하는 경우 (Scunthorpe 문제). 검사 전에 이름에서 지운다. */
export const ALLOW_TERMS: readonly string[] = [
  'class', 'bass', 'pass', 'grass', 'glass', 'mass', 'assassin', 'assist', 'scunthorpe', 'cocktail', 'peacock',
  'hancock', 'hitchcock', 'cockpit', 'cockroach', 'dickens', 'shiitake', 'torpedo', 'pedometer',
  '시발점', '시발역', '시발택시',
]
