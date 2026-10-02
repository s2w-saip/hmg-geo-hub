# Scope API — HMG 통합 가이드

> 대상: HMG 프론트(Next.js + Vercel + Supabase)의 **BFF 서버**에서 Scope 공개
> API를 호출하는 개발자. 이 문서만 보고 붙일 수 있게 쓴다.
> 권위 분류는 [api-catalog.md §5](api-catalog.md) (어떤 엔드포인트가 고객에게
> 열리는지). 전수 동작 검증 결과는 change `finalize-public-api-handoff` 의
> `verification-report.md`.

## 1. 기본

| 항목 | 값 |
|---|---|
| Base URL (staging) | `https://scope-api.example.com` |
| 버전 prefix | `/api/v1` (모든 공개 엔드포인트) |
| 인증 | `Authorization: Bearer scope_live_<token>` |
| 참조 문서(브라우저) | `/docs` (Scalar API Reference) |
| OpenAPI 스펙 | `/openapi/v1.yaml` |

> 커스텀 도메인(`api.scope.global` 류)은 후속 단계. 지금은 raw CloudFront 도메인.

## 2. 인증 — 키는 서버에만

- 키는 **워크스페이스 단위** secret. **BFF 서버 환경변수**에만 두고, 브라우저로
  절대 내려보내지 않는다 (단일 workspace key + BFF 서버단 강제).
- 모든 호출은 **서버→서버**. 그래서 CORS 설정이 없다(필요 없음).
- 키 발급은 현재 **운영자(Scope 팀)가 백엔드에서 발급**해 전달한다. 셀프서비스
  발급(로그인 세션 기반)은 후속(Cognito) 단계.
- 키 평문은 발급 시 1회만 전달된다. 분실 시 재발급(rotate). 유출 시 즉시 폐기(revoke).

```bash
curl https://scope-api.example.com/api/v1/health        # 무인증 확인
curl -H "Authorization: Bearer $SCOPE_API_KEY" \
     https://scope-api.example.com/api/v1/projects       # 인증 호출
```

## 3. 공개 엔드포인트

원칙: **설정과 결과는 열고, 측정 메커니즘은 감춘다.** 측정을 *돌리는* 것은
Scope 내부가 하고, HMG는 설정하고 결과를 읽는다.

### 3.1 설정 표면 (HMG가 직접 CRUD)

| M | Path | 목적 |
|---|---|---|
| POST | `/api/v1/projects` | 프로젝트 생성 |
| GET | `/api/v1/projects` | 목록 (커서 페이지네이션) |
| GET | `/api/v1/projects/{id}` | 단건 |
| PATCH | `/api/v1/projects/{id}` | 수정 |
| DELETE | `/api/v1/projects/{id}` | soft-delete |
| POST | `/api/v1/projects/{id}/prompts` | 프롬프트 생성 (`kind: 'single'\|'acr'` 지원) |
| GET | `/api/v1/projects/{id}/prompts` | 목록 (`funnel_stage` 필터, 응답에 `kind` 포함) |
| PATCH | `/api/v1/projects/{id}/prompts/{pid}` | 수정 (`kind` 전환 가능 — 제약 없음) |
| DELETE | `/api/v1/projects/{id}/prompts/{pid}` | soft-delete |

> **ACR (2026-07-07)**: `kind='acr'` 프롬프트는 2턴(후보군 → "하나만 골라") ×
> `projects.acr_iterations`(PATCH로 수정, 기본 10, 1..100) 반복으로 측정된다 —
> 셀당 측정량 ~20배. turn1은 일반 mention/citation 분석도 그대로 받아 기존
> 노출률 KPI에 계속 기여한다. ACR 결과는 jobs 피드의 **`analysis.acr_summary`**
> (`{ prompt_run_id, rows[] }`, rows는 camelCase: `entityId`/`rollupLevel`/
> `appearanceCount`/`choiceCount`/`acr`/`appearanceRate`/`overallChoiceShare`/
> `choiceOutcomeBreakdown` …)로 나온다. 같은 prompt-run의 반복 job들이 동일
> rows를 반복 반환하므로 소비자는 `prompt_run_id`로 dedup해야 한다
> (미러 sync가 `scope_acr_rollups`로 수집 — lib/scope/mirror/sync.ts).
> rows에 엔티티 이름은 없다(`entityId`만) — `resolved_mentions[].entity_id`
> 조인으로 `display_name`/`rollups.brand_entity_id`를 해소한다.
> scope `openapi/v1.yaml`에는 `kind`/`acr_iterations`가 아직 미기재(코드만
> 지원) — 스펙 참조 시 주의.
>
> **⚠️ appearance 의미론 (2026-07-08 실데이터 확정)**: `appearanceCount`는
> "등장한 반복 수"가 아니라 **turn1 언급 횟수 합**(한 반복에서 여러 번 셀 수
> 있음 — 실측 75/10반복). 따라서 scope의 `appearanceRate`(=appearance÷
> validTurn1, 실측 7.5)와 `acr`(=choice÷appearance) 필드는 **비율 지표로
> 부적합**. 비율은 `choiceCount ≤ validAcrIterations`(위반 0건 실측)만 믿고
> 유효 반복 분모로 자체 산출할 것 — hmg-geo 산식은
> `lib/db/repositories/scope-aggregates.ts` ACR 섹션 주석 참조.

### 3.2 결과 읽기 표면 (Scope가 측정으로 채움 → HMG는 읽기)

| M | Path | 목적 |
|---|---|---|
| GET | `/api/v1/projects/{id}/overview` | 대시보드 요약 |
| GET | `/api/v1/projects/{id}/brand-scores` | 일별 점수 시계열 |
| GET | `/api/v1/projects/{id}/brand-mentions` | 멘션 목록 (`co_mentioned_brands` 포함) |
| GET | `/api/v1/projects/{id}/brand-mentions/{mid}` | 멘션 단건 |
| GET | `/api/v1/projects/{id}/citations` | 인용 목록 |
| GET | `/api/v1/projects/{id}/citations/by-domain` | 도메인 집계 |
| GET | `/api/v1/projects/{id}/reports` | 내러티브 리포트 목록 |
| GET | `/api/v1/projects/{id}/reports/{rid}` | 리포트 단건 |
| GET | `/api/v1/usage` | 워크스페이스 사용량 요약 |
| GET | `/api/v1/health` | 헬스체크 (무인증) |

> 측정 데이터가 아직 없으면 결과 엔드포인트는 **빈 배열**을 정상(200)으로 반환한다.
> Scope가 측정을 돌리면 같은 엔드포인트에 데이터가 채워진다.

### 3.3 열리지 않는 것 (호출 금지)

- 측정 트리거: `POST /api/v1/query`, `POST .../measurements` → **내부 전용**.
  고객은 측정을 직접 시키지 않는다. 데이터 신선도는 결과 응답의 필드로 노출된다.
- 키 관리(`/api/v1/api-keys`): 현재 운영자 발급. 셀프서비스는 후속.

## 4. 요청/응답 예제

### 프로젝트 생성

```bash
curl -X POST https://scope-api.example.com/api/v1/projects \
  -H "Authorization: Bearer $SCOPE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "현대차 GEO 모니터링",
    "domain": "hyundai.com",
    "tracked_brands": [{ "brand_name": "현대" }, { "brand_name": "기아" }],
    "regions": ["KR", "US"]
  }'
```

응답 `201`:
```json
{
  "project_id": "uuid",
  "workspace_id": "uuid",
  "name": "현대차 GEO 모니터링",
  "domain": "hyundai.com",
  "tracked_brands": [{ "brand_name": "현대" }, { "brand_name": "기아" }],
  "regions": ["KR", "US"],
  "created_at": "2026-06-01T00:00:00.000Z",
  "updated_at": "2026-06-01T00:00:00.000Z"
}
```

- `name` (필수), `regions` (필수, ISO 3166-1 alpha-2 1개 이상), `tracked_brands[].brand_name` (필수), `domain` (선택).

### 프롬프트 생성

```bash
curl -X POST https://scope-api.example.com/api/v1/projects/$PID/prompts \
  -H "Authorization: Bearer $SCOPE_API_KEY" -H "Content-Type: application/json" \
  -d '{ "text": "전기차 보조금 많이 주는 SUV 추천", "funnel_stage": "consideration", "keywords": ["전기차","SUV"] }'
```

- `text` (필수), `funnel_stage` (선택: `discovery|consideration|evaluation|transactional|loyalty`), `keywords` (선택).

### 목록 + 페이지네이션

```bash
curl -H "Authorization: Bearer $SCOPE_API_KEY" \
  "https://scope-api.example.com/api/v1/projects?limit=20"
```
응답: `{ "data": [...], "next_cursor": "opaque|null" }` — `next_cursor` 가 있으면
`?cursor=<next_cursor>` 로 다음 페이지.

## 5. 공통 규약

| 항목 | 규약 |
|---|---|
| 에러 | `{ "error": { "code", "message", "details"? } }`. code = `invalid_argument \| unauthorized \| forbidden \| not_found \| conflict \| rate_limited \| server_error \| service_unavailable` |
| 인증 실패 | `401` + 위 envelope |
| 교차 워크스페이스 접근 | `404` (403 아님) — 존재를 노출하지 않음 |
| 페이지네이션 | `?limit=1..100&cursor=<opaque>` + 응답 `next_cursor` |
| 멱등성 | `Idempotency-Key: <UUID>` (POST 재시도 안전, 24h dedup) |
| rate limit | 응답 `X-RateLimit-*` 헤더, 초과 시 `429` + `Retry-After` |
| 시간 | ISO 8601 UTC |
| 필드 표기 | snake_case |

## 6. BFF 연동 패턴 (Next.js Route Handler 예)

```ts
// app/api/scope/projects/route.ts (HMG BFF — 서버에서만 키 사용)
const SCOPE = "https://scope-api.example.com/api/v1";
export async function GET() {
  const r = await fetch(`${SCOPE}/projects?limit=50`, {
    headers: { authorization: `Bearer ${process.env.SCOPE_API_KEY}` },
    cache: "no-store",
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}
```

- `SCOPE_API_KEY` 는 Vercel 환경변수(서버 전용). 클라이언트 번들에 노출 금지.
- 브라우저는 HMG BFF(`/api/scope/*`)만 호출하고, BFF가 키를 붙여 Scope로 중계한다.

## 7. 받은 자격 정보 (핸드오프)

- workspace_id + 발급 키(평문)는 별도 안전 채널로 전달됨. 이 문서·저장소에 평문
  미기재.
- 검증 기준 시점에 §3 표면은 외부 호출로 동작 확인됨 (`verification-report.md`).
