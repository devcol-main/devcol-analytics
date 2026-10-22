# devcol-analytics — Claude Code 규칙

devcol.net 자체 애널리틱스 (Cloudflare Worker + D1). 구조와 엔드포인트는 README.md 참고.

## 원칙
- 이 리포는 Public일 수 있다. **비밀값, 토큰, 이메일 주소를 코드/커밋에 넣지 않는다.** Access 설정값은 `wrangler secret`으로만.
- 무료 티어 안에서 동작해야 한다 (Workers / D1 / Cron). 이벤트당 D1 쿼리 수를 늘리는 변경은 신중히.
- 개인 식별 금지: IP 원문, 전체 UA, 쿠키를 저장하지 않는다. `/public/summary`는 `daily_stats`만 읽고 5 미만은 `"<5"`.
- **게임 목록을 하드코딩하지 않는다.** 게임 ID는 `/games/<slug>/` 경로에서만 뽑는다. 새 게임 연동 절차는 devcol-site의 `docs/GAME-ANALYTICS.md`.
- 대시보드(admin.html)에 DB 값을 넣을 때는 textContent만 쓴다 (path, referrer, title은 방문자가 조작 가능).
- `/admin*`는 Worker 안에서도 Access JWT를 검증한다. 이 검사를 빼거나 우회하지 않는다.

## 검사
- `npm run check` (tsc + vitest, Workers 런타임). 변경마다 통과해야 한다.
- 클라이언트 `client/t.js`를 바꾸면 `npm run build:client` (2KB 미만 검사 포함) 후 devcol-site에 커밋.

## 배포
- `npm run deploy`. 스키마 변경은 `migrations/`에 새 파일을 추가하고 `npm run db:migrate:remote`.
- 시간대: 날짜 경계는 KST. `src/util.ts`의 `kstDay`/`dayStartMs`를 쓴다.
