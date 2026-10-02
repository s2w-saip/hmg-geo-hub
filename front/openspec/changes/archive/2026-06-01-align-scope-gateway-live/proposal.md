## Why

scope 의 공개 API 표면이 확정·검증됐다(2026-06-01 핸드오프). `scope-gateway` spec 이
"scope 팀과 합의할 계약 초안"이라 적어둔 그 계약이 이제 실재한다. 현 `lib/scope` 는
초안 가정 위에 서 있어 **실제로 호출하면 동작하지 않는다**: 버전 prefix 가 틀렸고
(`/v1` → 실제 `/api/v1`), 내부 전용 엔드포인트(`/query`, `/results`)를 향하며, 실재하는
집계 엔드포인트는 `throw "not yet defined"` 로 비어 있다. 이 change 는 계약을 확정된
공개 표면에 맞춰 재정렬하고, **실제로 돌려볼 수 있는 검증 환경**을 세운다. (UI 는 범위 밖.)

## What Changes

- **BREAKING** `ScopeClient` 계약을 공개 표면 기준으로 재정의. 측정 트리거 메서드
  `query()` 와 내부 `results()` 를 **제거**(scope 내부 전용 — HMG 호출 금지).
- `ScopeClient` 를 **역할-무지(role-blind) 전송 계약**으로 전환: 메서드에서 `ScopeFilter`
  인자를 제거. 공개 읽기는 프로젝트 단위 집계라 행 단위 필터 인자를 받을 자리가 없다.
  역할→접근 게이팅은 강제 레이어(`server.ts`)의 책임으로 남기되, **이번 change 에서는
  설계만 하고 구현은 후속으로 미룬다**(테스트 하베스는 강제 레이어를 거치지 않음).
- 공개 **설정 표면** 추가: projects CRUD, prompts CRUD.
- 공개 **결과 읽기 표면** 추가: overview, brand-scores, brand-mentions(+단건),
  citations(+by-domain), reports(+단건), usage, health.
- `HttpScopeClient` 경로 버그 수정: `/v1/...` → `/api/v1/...`.
- `MockScopeClient` 와 `lib/scope/types.ts` 를 새 계약·공개 응답 shape 에 맞춰 갱신.
- `app/api/scope/{query,results}` BFF route handler 와 대시보드 소비자(`fetchResults`)를
  새 계약에 맞춰 재정렬(옛 계약 기반이라 연쇄 영향).
- **검증 스크립트** 신설(`scripts/scope/verify-public-api.ts` 류) + npm script.
  live 모드로 각 공개 메서드를 호출해 status/응답 shape 를 확인한다(scope 레포의
  `scripts/verify-public-api.ts` 가 known-good 레퍼런스).
- `.env.local` 을 live 로 전환(`SCOPE_MODE=live`, `SCOPE_API_BASE`, `SCOPE_API_KEY`).
  키는 안전 채널로 받아 .env.local 에만 — git 평문 금지(`.env*.local` 이미 gitignore).

## Capabilities

### New Capabilities
<!-- 없음 — 기존 scope-gateway capability 의 요구사항 변경 -->

### Modified Capabilities
- `scope-gateway`: `ScopeClient` 계약을 "draft `query`/`results` + 미정의 집계 자리표시자"
  에서 **확정된 공개 표면**(projects/prompts CRUD + 결과 읽기, 내부 트리거 제외)으로 교체.
  계약을 역할-무지 전송 레이어로 재정의하고, 강제·감사 책임을 `server.ts` 로 명확히 분리.

## Impact

- **코드**: `lib/scope/{client,http,mock,types,server,index}.ts`,
  `app/api/scope/{query,results}/route.ts`, `app/[locale]/(dash)/dashboard/page.tsx`(소비자),
  신규 `scripts/scope/verify-public-api.ts`, `package.json`(npm script).
- **spec**: `openspec/specs/scope-gateway/spec.md` 의 `ScopeClient 계약` 요구사항.
- **환경/설정**: `.env.local`(live 전환 + 키), `.gitignore` 확인.
- **외부 의존**: scope staging(`https://scope-api.example.com/api/v1`). reports 는
  현재 404(scope 재배포 대기) — 우리 버그 아님, 검증 스크립트가 known-failure 로 처리.
- **보안 경계**: #1(server-only BFF), #2(server-derived filter) 유지. #2 의 *구현*은
  값-필터에서 프로젝트-게이팅으로 이동하나, 그 구현은 후속 change 로 분리(open question).
