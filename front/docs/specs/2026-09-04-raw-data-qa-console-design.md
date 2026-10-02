# Raw Data QA Console (`/raw-data-qa`) — 설계

- 상태: 설계 승인 대기
- 작성일: 2026-09-04
- 대상: GGMD AI Monitoring 측정 데이터의 사람 눈 검수

## 1. 문제

GGMD는 AI 답변 하나(`scope_answers` 1행)를 기계적으로 분석해 멘션·인용·감성·순위
등의 분석 행을 만든다. 이 분석이 실제 답변 원문과 맞는지 확인할 방법이 지금은 없다.

필요한 것은 **답변 원문과 그 답변에 매달린 모든 분석 낱알을 나란히 놓고 사람이
대조하는 화면**이다. KPI 롤업이 아니라 롤업 이전의 DB 행 자체가 검수 대상이다.

검수자는 GGMD 계정이 없는 외부 인력이고, 여러 명이 동시에 작업하며, 같은 PC를
교대로 쓰기도 한다.

## 2. 결정 요약

| 항목 | 결정 |
|---|---|
| 경로 | `/{locale}/raw-data-qa/**` — `(dash)` 그룹 **밖** |
| 인증 | Supabase 로그인 면제. 검수자 이름(평문) + 공유 비밀번호 |
| 세션 | 세션 쿠키(브라우저 종료 시 소멸) + 12시간 하드 만료 |
| 모집단 | 미러 전체 — 표준 + 웹사이트 + 프로젝트 |
| 판정 단위 | 블록(멘션/인용/ACR/메타) OK·이상 + 낱알 행 단위 노트 |
| 일감 분배 | 필터(URL 쿼리) 공유 + 실시간 락 |
| 동시성 | `qa_answer_locks` 단일 SQL upsert, TTL 3분, heartbeat 30초 |
| 데이터 소스 | hmg 미러(`scope_*`)만. scope 원본 대조는 범위 밖 |

## 3. 수용된 리스크

이 콘솔은 저장소의 나머지 전체가 지키는 role 스코프 경계(§docs/development-guide.md 보안 경계 1~3)를
**의도적으로 우회한다**. 공개 라우트 + 공유 비밀번호 하나로 HMG 전 브랜드·전 권역·전
표면의 AI 답변 원문과 분석 행이 열린다. 비밀번호가 유출되면 그 전부가 유출된다.

이 트레이드오프는 2026-09-04에 제품 오너가 명시적으로 선택했다(검수자에게 GGMD 계정을
발급하지 않는다). 아래 완화책을 기본 포함하되, 완화책이 경계를 복원하지는 않는다.

- `RAW_DATA_QA_ENABLED !== "1"` 이면 모든 라우트가 `notFound()` — 상시 킬 스위치
- 비밀번호는 `RAW_DATA_QA_PASSWORD` env (미설정 시 `qa-default-redacted`), 서버 전용
- 비밀번호 시도 rate limit — IP 해시 기준 분당 10회. 서버리스에서는 인스턴스별 in-memory
  카운터라 best-effort다(인스턴스 수만큼 배수로 뚫린다). 무차별 대입을 늦출 뿐 막지는 못한다
- `app/robots.ts` disallow + 페이지 `robots: noindex, nofollow`
- 크롤러 UA는 기존 middleware가 이미 410 처리
- 게이트 통과와 상세 열람을 `qa_review_sessions` / `qa_answer_locks`에 기록

## 4. 라우트와 인증

### 4.1 배치

```
app/[locale]/raw-data-qa/
  layout.tsx            독립 레이아웃 (GNB/SNB 없음, noindex)
  page.tsx              게이트 — 이름 + 비밀번호
  answers/page.tsx      검수 목록
  answers/[jobId]/page.tsx  검수 상세
  notes/page.tsx        노트 모아보기
app/api/qa/
  session/route.ts      게이트 통과(POST) / 종료(DELETE)
  lock/route.ts         락 획득(POST) / heartbeat(PATCH) / 해제(DELETE)
  review/route.ts       검수 판정 저장(PUT)
  note/route.ts         노트 생성(POST) / 수정·해결(PATCH) / 삭제(DELETE)
  answers/route.ts      목록 폴링용 락·상태 델타
```

`(dash)` 밖이므로 `lib/auth/route-policy.ts::ROUTES`에 **넣지 않는다**. `canAccessRoute`는
DashLayout에서만 호출되는 가드라 이 경로와 무관하다. 대신 `middleware.ts`의
`PUBLIC_PATHS`에 `/raw-data-qa`를 추가해 Supabase 로그인 리다이렉트를 면제한다.

### 4.2 게이트

`POST /api/qa/session` — body `{ name, password }`.

1. `RAW_DATA_QA_ENABLED` 확인 → 아니면 404
2. rate limit 확인
3. `password === RAW_DATA_QA_PASSWORD`를 `crypto.timingSafeEqual`로 비교
4. `name` 검증 — 1~40자, 공백만은 거부, 앞뒤 공백 trim
5. `qa_review_sessions` 행 생성 → `sessionId`
6. 쿠키 `raw_data_qa` 발급

쿠키 값 = `base64url({ sessionId, name, issuedAt }) + "." + HMAC-SHA256`.
서명 키는 `RAW_DATA_QA_SECRET`. 미설정 시 프로세스 부팅 때 랜덤 생성(= 재배포 시
모든 세션 무효 — 안전한 기본값이며 경고 로그를 남긴다).

쿠키 속성: `httpOnly`, `secure`(프로덕션), `sameSite: "lax"`, `path: /`,
**`maxAge`/`expires` 없음** → 세션 쿠키.

### 4.3 재입력 강제

요구사항: "브라우저 끄고 다시 접속하면 이름·비번을 다시 입력."

- 1차: 세션 쿠키라 브라우저 종료 시 삭제된다.
- 2차: `issuedAt` 기준 **12시간** 초과 시 서버가 거부한다.
- 3차: 상단에 "검수 종료" 버튼 — 교대 시 명시적으로 끊는다.

**알려진 한계**: 브라우저에 "종료 시 탭 복원"이 켜져 있으면 세션 쿠키가 살아남는다.
이는 브라우저 설정 영역이라 서버가 막을 수 없다. 12시간 하드 만료가 그 구멍의 상한이다.

### 4.4 검증 헬퍼

`lib/qa/auth.ts`

```ts
export type QaReviewer = { sessionId: string; name: string; issuedAt: number };
export function signReviewerCookie(r: QaReviewer): string;
export function verifyReviewerCookie(raw: string | undefined): QaReviewer | null;
export async function requireReviewer(): Promise<QaReviewer>;  // 실패 시 throw
export function qaEnabled(): boolean;
```

모든 `/raw-data-qa/*` 페이지와 `/api/qa/*` 라우트는 첫 줄에서 `requireReviewer()`를
통과해야 한다. 페이지는 실패 시 게이트로 리다이렉트, API는 401.

## 5. 데이터 모델 (migration 0055)

`scope_*` 미러와 **FK로 묶지 않는다**. 미러 싱크의 `replaceRun`이 run 단위 delete+insert
이므로 FK가 있으면 재싱크가 검수 기록을 함께 지운다. `scope_answer_drops`가 같은 이유로
독립 테이블인 것과 동일한 논리다.

```sql
CREATE TABLE qa_review_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_name text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  user_agent    text,
  ip_hash       text                      -- HMAC-SHA256(RAW_DATA_QA_SECRET, ip). 원문 IP 저장 금지
);

CREATE TABLE qa_answer_reviews (
  job_id        uuid PRIMARY KEY,         -- = scope_answers.job_id (FK 없음)
  status        text NOT NULL CHECK (status IN ('ok','issue')),
  section_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewer_name text NOT NULL,
  session_id    uuid,
  reviewed_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qa_answer_reviews_status_idx   ON qa_answer_reviews (status);
CREATE INDEX qa_answer_reviews_reviewer_idx ON qa_answer_reviews (reviewer_name);

CREATE TABLE qa_review_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL,
  target_kind   text NOT NULL CHECK (target_kind IN ('answer','prompt','mention','citation','acr','meta')),
  target_key    text,                     -- entity_id / citation id / null
  target_label  text,                     -- 사람이 읽는 라벨 스냅샷
  severity      text NOT NULL DEFAULT 'issue' CHECK (severity IN ('issue','question','info')),
  body          text NOT NULL,
  reviewer_name text NOT NULL,
  session_id    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   text
);
CREATE INDEX qa_review_notes_job_idx      ON qa_review_notes (job_id);
CREATE INDEX qa_review_notes_created_idx  ON qa_review_notes (created_at DESC);
CREATE INDEX qa_review_notes_unresolved_idx ON qa_review_notes (resolved_at) WHERE resolved_at IS NULL;

CREATE TABLE qa_answer_locks (
  job_id        uuid PRIMARY KEY,
  session_id    uuid NOT NULL,
  reviewer_name text NOT NULL,
  acquired_at   timestamptz NOT NULL DEFAULT now(),
  heartbeat_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qa_answer_locks_heartbeat_idx ON qa_answer_locks (heartbeat_at);
```

`target_label`을 스냅샷으로 저장하는 이유: 미러가 재싱크되면 `scope_citations.id`
(bigserial)가 바뀐다. 라벨이 없으면 노트가 무엇을 지목했는지 영구히 알 수 없게 된다.

`section_flags` 키 집합은 `target_kind`와 동일하다 —
`answer` · `prompt` · `mentions` · `citations` · `acr` · `meta`. 값은 `"ok"` 또는 `"issue"`이며
키가 없으면 미판정. 예:

```json
{"answer":"ok","prompt":"ok","mentions":"issue","citations":"ok","acr":"ok","meta":"ok"}
```

`status`는 **파생값**이다 — 저장 시 `section_flags`에 `"issue"`가 하나라도 있으면 `'issue'`,
아니면 `'ok'`. 검수자가 따로 고르지 않는다. 하단 바의 `[검수 완료]`/`[이상 있음]` 두 버튼은
"판정을 저장한다"는 같은 동작이며, 라벨만 현재 파생 상태를 반영해 바뀐다.

미검수 = `qa_answer_reviews`에 행이 없음.

**고아 행**: 미러 재싱크는 같은 `job_id`로 다시 넣으므로 검수 기록은 살아남는다. 다만
`scope_answer_drops`로 제외된 답변의 검수 행은 고아가 된다 — **지우지 않는다**(검수 이력은
감사 기록이다). 목록은 `scope_answers`와 inner join 이라 화면에는 나타나지 않는다.

## 6. 동시성 — 락

### 6.1 획득 (원자적, 단일 문)

```sql
INSERT INTO qa_answer_locks (job_id, session_id, reviewer_name)
VALUES ($1, $2, $3)
ON CONFLICT (job_id) DO UPDATE SET
  session_id    = EXCLUDED.session_id,
  reviewer_name = EXCLUDED.reviewer_name,
  acquired_at   = now(),
  heartbeat_at  = now()
WHERE qa_answer_locks.session_id = EXCLUDED.session_id
   OR qa_answer_locks.heartbeat_at < now() - interval '3 minutes'
RETURNING session_id, reviewer_name, acquired_at;
```

- 행이 반환되면 획득 성공(신규 / 내 재획득 / 만료 탈취)
- 행이 없으면 남이 점유 중 → `409` + 점유자 이름·시각을 별도 SELECT로 조회해 반환

애플리케이션 레벨 read-then-write가 아니라 한 문장이므로 경쟁 조건이 구조적으로 없다.

### 6.2 수명

- 상세 진입 시 획득
- **30초마다** `PATCH /api/qa/lock` heartbeat
- 이탈(라우트 변경 / `beforeunload`) 시 `DELETE` + `navigator.sendBeacon` 병행
- **TTL 3분** — 브라우저가 죽어도 3분 뒤 다른 사람이 가져갈 수 있다
- 판정 저장 시 락 소유 확인. 소유가 아니면 `409` 후 화면에 "다른 검수자가 가져갔습니다"

### 6.3 락 실패 시 동작

**열람은 허용한다.** 상세는 읽기 전용으로 열리고, 저장·노트 버튼만 비활성화되며 상단에
"OOO 님이 검수 중입니다" 배너가 뜬다. 남의 작업을 못 보게 막는 것은 과잉이며, 검수자가
"저건 뭐지?" 하고 확인하는 것을 방해한다.

### 6.4 목록 표시

목록은 **10초 폴링**으로 `qa_answer_locks`를 다시 읽어 "검수중(홍길동)" 배지를 갱신한다.
WebSocket/Realtime은 도입하지 않는다 — 동시 검수자 수가 10명 내외이고 폴링으로 충분하다.

## 7. 검수 대상 데이터 — 낱알 전수

`job_id`에 매달린 것을 전수 조사한 결과다. 상세 화면은 아래를 **빠짐없이** 펼친다.

| 블록 | 소스 테이블 | 표시할 컬럼 |
|---|---|---|
| 답변 메타 | `scope_answers` | `job_id`, `run_id`, `prompt_id`, `target`(엔진), `region`, `status`, `measured_at`, `model_slug` |
| 프롬프트 | `scope_prompts` | `text`, `funnel_stage`, `lang`, `regions[]`, `is_korean` |
| 프롬프트(카탈로그) | `prompts` (`scope_prompt_id` 조인) | `brand`, `brand_presence`, `list_type`, `depth1~4`, `funnel_stage`, `kind`, `prompt_type`, `category` |
| **멘션 N행** | `scope_mentions` | `entity_id`, `brand`(표시명), `entity_type`, `mention_count`, `sentiment_positive/neutral/negative/mixed`, `avg_position`, `surfaces[]`, `brand_rollup_entity_id`, `type_mention/recommendation/comparison/definition/final_choice` |
| 멘션 보강 | `entity_registry` | `role`(`own`/`excluded`) — 자사 판정, 롤업 부모 표시명 |
| **인용 N행** | `scope_citations` | `ref_index`, `url`, `domain`, `title`, `category`, `url_norm`, `url_host`, `url_base_norm` |
| 인용 보강 | `citation_domain_overrides` | 저장 `category` vs **유효** `category` (오버라이드 적용 여부를 나란히) |
| ACR | `scope_acr_rollups` | `run_id`+`prompt_id`+`target`+`region` 매칭 시. `planned/valid_turn1/valid_acr_iterations`, `appearance_count`, `choice_count`, `conditional/off_shortlist/unresolved/generic_choice_count`, `appearance_rate`, `acr`, `overall_choice_share`, `co_*` 6종 |
| 파생 메타 | `scope_answer_anchors`, `scope_answer_drops` | 이 답변이 회차 접기됐는지 / 미러에서 제외됐는지 + 원본 `measured_at` |

`scope_context_*`는 `job_id`에 연결되지 않는다(소셜 스크래핑 유래 전역 미러) — 범위 밖.

ACR은 `job_id`가 아닌 `prompt_run_id`로 키가 잡혀 있어 직접 조인이 불가능하다.
`(run_id, prompt_id, target, region)` 4축 매칭으로 근사 연결하고, 화면에 "이 프롬프트-런의
ACR 롤업(답변 단위 아님)"이라고 명시한다.

## 8. 목록과 필터

### 8.1 surface 판정

`scope_runs.project_id`(scope project id)를 기준으로 한다.

1. `website_sites.scope_project_id`에 있으면 → **웹사이트** (brand, country_code 획득)
2. `projects.scope_project_id`에 있으면 → **프로젝트** (brand, country 획득)
3. 그 외 → **표준** (brand는 `prompts` where `project_id = STANDARD_ROOT_PROJECT_ID`에서 획득)

`scope_runs.project_id`는 nullable(레거시 행)이므로 NULL이면 3번 경로로 폴백한다.

### 8.2 필터 축

전부 URL 쿼리로 인코딩한다. **필터가 걸린 링크를 복사해 주는 것이 곧 일감 분배**다.

`surface` · `brand` · `country`/`region` · `engine`(target) · `lang` · 기간(`from`/`to`) ·
프롬프트 검색어 · 검수상태(`unreviewed`/`ok`/`issue`) · 검수자 · 노트유무 · 멘션 0건 여부

정렬: `measured_at DESC, job_id` 커서 페이지네이션. 페이지당 50행.

### 8.3 목록 행

프롬프트 텍스트(2줄 말줄임) · surface 배지 · brand · country · engine · lang ·
measured_at · 멘션 수 · 인용 수 · 검수 상태 배지 · 노트 수 · 락 배지 · 검수자

### 8.4 진행률

헤더에 **두 수치를 함께** 낸다.

```
필터 기준  1,204건 중 318건 완료 (26.4%)  · 이상 12 · 노트 27
전체       148,392건 중 1,033건 완료 (0.7%)
```

모집단이 미러 전체이므로 전체 % 자체는 운용 지표로 쓰이지 않는다. 실제로 쓰이는 것은
필터 기준 수치이며, 그래서 두 값을 나란히 둔다.

### 8.5 성능

`scope_answers`는 십수만 행이고 필터 대부분이 조인 너머에 있다(brand는 `prompts`,
country는 `website_sites`/`projects`). 대책:

- 목록은 `scope_answers` 기준 **커서 페이지네이션**(`measured_at DESC, job_id`) — OFFSET 금지
- brand/surface/country 필터는 조인 결과가 아니라 **`run_id` 집합 또는 `prompt_id` 집합으로
  미리 축약**해 `IN`으로 넣는다(기존 `scope-aggregates.ts`가 쓰는 패턴과 동일)
- 멘션 수·인용 수는 행마다 세지 않고 현재 페이지 50건의 `job_id`에 대해 **한 번에 group by**
- 진행률 count는 목록과 별도 쿼리. 필터 기준 count가 비싸면 근사 없이 그대로 두되,
  `unstable_cache` 30초로 감싼다(검수 중 실시간성이 필요한 값이 아니다)
- 마이그레이션에 `scope_answers (measured_at DESC, job_id)` 복합 인덱스를 추가한다 —
  현재 인덱스는 run/target/region 뿐이라 이 정렬을 받쳐주지 못한다

## 9. 검수 상세 화면

2단 구성.

**좌측 — 원문**
프롬프트를 user turn, 답변을 assistant turn으로 렌더한다. 기존
`app/[locale]/(dash)/standard/answer-analysis/_components/markdown-answer.tsx`를 재사용해
멘션 `surfaces`를 마커펜처럼 하이라이트하고, 인용 `[N]` 앵커를 `ref_index`에 연결한다.
우측 인용 행에 hover 하면 좌측 본문의 해당 앵커가 강조된다.

**우측 — 낱알 패널 (아코디언)**
§7의 블록을 순서대로 테이블로 편다. 각 블록 헤더에 `OK / 이상` 토글, 각 행 우측에
`노트` 버튼(그 행을 `target_kind`+`target_key`+`target_label`로 지목).

블록 ↔ `section_flags` 키 대응:

| 화면 블록 | `section_flags` 키 |
|---|---|
| 답변 원문 (좌측) | `answer` |
| 프롬프트 + 카탈로그 | `prompt` |
| 멘션 N행 | `mentions` |
| 인용 N행 | `citations` |
| ACR 롤업 | `acr` |
| 답변 메타 + 파생 메타 | `meta` |

ACR 블록은 매칭되는 롤업이 없으면 렌더하지 않으며, 그 경우 `acr` 키도 쓰지 않는다.

**하단 고정 바**
`[검수 완료]` `[이상 있음]` · `[노트 추가]`(답변 전체 대상) · `← 이전 / 다음 →`
(현재 필터 순서를 따라감) · 락 상태 표시.

키보드: `J`/`K` 이전·다음, `O` 검수 완료, `N` 노트. 대량 검수의 속도가 곧 이 도구의 값이다.

## 10. 노트 모아보기

`/raw-data-qa/notes`. §8.2와 동일한 필터에 `target_kind` · `severity` · `resolved` 축을 더한다.

행 클릭 시 해당 상세로 이동(필터 컨텍스트 유지). `해결` 토글로 `resolved_at`/`resolved_by`
기록. CSV 내보내기 포함 — 개발팀에 넘길 산출물이 이 CSV다.

집계 카드: `target_kind`별 노트 수(멘션 41 · 인용 12 · ACR 3 …). "인용 분류가 유독 많이
틀린다" 같은 축별 오류 편중이 여기서 드러난다.

## 11. 코드 배치

```
lib/qa/auth.ts                        쿠키 서명·검증, requireReviewer, qaEnabled
lib/qa/filters.ts                     URL 쿼리 ↔ QaFilter 인코딩/디코딩 (순수 함수)
lib/db/repositories/qa-review.ts      아래 함수들
  listReviewAnswers(filter, cursor)
  getReviewAnswerDetail(jobId)        §7의 모든 소스를 한 번에
  getProgress(filter)                 필터 기준 + 전체 기준
  upsertReview(jobId, verdict, reviewer)
  listNotes(filter, cursor) / createNote / updateNote / deleteNote
  acquireLock / heartbeatLock / releaseLock / listLocks(jobIds)
  createSession / touchSession
app/[locale]/raw-data-qa/**           §4.1
app/api/qa/**                         §4.1
messages/{ko,en}.json                 qaReview.* 네임스페이스
lib/db/migrations/0055_*.sql          §5
```

`@/lib/db` 직접 import 금지 규칙(eslint `no-restricted-imports`)에 따라 DB 접근은 전부
`lib/db/repositories/qa-review.ts`를 통한다.

`lib/db/scoped.ts::scopeWhere`는 **쓰지 않는다**. 이 표면에는 role 스코프가 존재하지 않고
(공개 게이트), 유일한 방어는 §4의 쿠키 게이트다. 이 예외는 §3의 수용된 리스크의 직접적인
귀결이며, 리포지토리 파일 상단 주석에 명시한다.

i18n: JSX 하드코딩 금지 규칙에 따라 모든 문자열은 `messages/{ko,en}.json`의 `qaReview.*`에
둔다. `npm run check:strings`를 통과해야 한다.

## 12. 테스트

| 대상 | 검증 |
|---|---|
| `lib/qa/auth` | 서명 왕복, 변조 쿠키 거부, 12시간 만료 거부, 시크릿 미설정 시 랜덤 폴백 |
| 락 SQL | 신규 획득 / 동일 세션 재획득 / 타 세션 거부 / TTL 만료 후 탈취 (`*.int.test.ts`) |
| 락 경쟁 | 두 세션이 동시 획득 시도 → 정확히 하나만 성공 (`*.int.test.ts`, `DATABASE_URL` 필요) |
| `getReviewAnswerDetail` | 멘션·인용·ACR·앵커·드롭·카탈로그·엔티티명부·인용오버라이드가 모두 붙는지 |
| surface 판정 | website / project / standard 3분기 + `project_id` NULL 폴백 |
| `getProgress` | 필터 기준·전체 기준 두 수치 |
| `lib/qa/filters` | URL 쿼리 왕복 (순수 함수) |
| 게이트 | 쿠키 없이 `/raw-data-qa/answers` → 게이트 리다이렉트, API → 401 |
| 킬 스위치 | `RAW_DATA_QA_ENABLED` 미설정 시 404 |

## 13. 범위 밖

- scope 원본 API와의 대조 diff (미러만 검수한다)
- 검수 결과를 근거로 한 데이터 수정 — 이 콘솔은 **읽기 + 판정 기록 전용**이다
- 검수자 계정 관리 / 권한 차등 (모든 검수자가 동일 권한)
- 실시간 협업(WebSocket) — 10초 폴링으로 충분
- `scope_context_*` 검수

## 14. 신규 환경변수

| 이름 | 필수 | 기본 | 설명 |
|---|---|---|---|
| `RAW_DATA_QA_ENABLED` | ✔ | 미설정=꺼짐 | `"1"`일 때만 라우트가 존재 |
| `RAW_DATA_QA_PASSWORD` | | `qa-default-redacted` | 공유 비밀번호 |
| `RAW_DATA_QA_SECRET` | 권장 | 부팅 시 랜덤 | 쿠키 HMAC 서명 키 |

전부 서버 전용. `NEXT_PUBLIC_` 접두 금지.
