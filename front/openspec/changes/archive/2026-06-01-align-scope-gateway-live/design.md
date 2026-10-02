## Context

scope 의 공개 API 표면이 2026-06-01 핸드오프로 확정·검증됐다(`docs/scope-integration-handoff.md`,
`docs/scope-api-integration.md`). 현 `lib/scope` 는 그 이전의 "초안 계약" 위에 있어 실제로
호출하면 깨진다:

- `HttpScopeClient` 가 `/v1/...` 를 사용 — 실제 prefix 는 `/api/v1/...`.
- `query()`/`results()` 가 scope **내부 전용** 엔드포인트(`/query`, `/results`)를 향함 — HMG
  공개 표면 아님(측정 트리거는 scope 내부가 함).
- `promptKpis()`/`projectStatus()` 가 `throw "not yet defined"` — 이제 `brand-scores`/
  `overview` 로 실재.

확정된 공개 표면은 **프로젝트 중심**이다(`/api/v1/projects/{id}/...`). 설정(projects/prompts
CRUD)과 결과 읽기(overview, brand-scores, brand-mentions, citations, reports, usage)는 열려
있고, 측정 메커니즘은 감춰진다. 결과 읽기는 **프로젝트 단위 집계**라 brand/region/country
행 필터 인자를 받지 않는다.

이 change 의 목표는 핸드오프 브리프대로 **BFF 호출 로직 재정렬 + 돌려볼 수 있는 검증 환경**
까지다. 화면(UI)·역할 게이팅 구현은 범위 밖.

## Goals / Non-Goals

**Goals:**
- `ScopeClient` 계약을 확정된 공개 표면의 충실한 거울로 재정의.
- `HttpScopeClient` 가 staging 에 대해 실제로 2xx/200 을 받아오게 수정(경로·인증·메서드).
- `MockScopeClient`·`types.ts` 를 새 계약·공개 응답 shape 에 맞춤(mock 기본값 유지).
- live 모드에서 각 공개 메서드를 호출해 status/shape 를 확인하는 **검증 스크립트** 제공.
- 옛 계약에 의존하던 BFF route handler·소비자를 깨지지 않게 재정렬.

**Non-Goals:**
- 역할→프로젝트 게이팅의 **구현**(Open Questions 로 분리, 후속 change).
- 분류체계 매핑(권역 버킷 ↔ ISO 국가, 브랜드명 한↔영) 구현.
- 어떤 화면도 그리지 않음. 대시보드는 새 계약에 맞춰 호출만 정정(최소 변경).
- 측정 트리거(`query`) 기능 — HMG 표면 아님, 영구 제거.

## Decisions

### D1. `ScopeClient` 를 역할-무지(role-blind) 전송 계약으로 전환
**결정**: 모든 메서드에서 `ScopeFilter` 인자를 제거하고, 공개 표면을 그대로 미러링하는
메서드 집합으로 재정의. 메서드는 projectId(및 페이지네이션/필터 쿼리) 만 받는다.

- 설정: `listProjects`, `getProject`, `createProject`, `updateProject`, `deleteProject`,
  `listPrompts`, `createPrompt`, `updatePrompt`, `deletePrompt`
- 결과: `getOverview`, `getBrandScores`, `listBrandMentions`, `getBrandMention`,
  `listCitations`, `getCitationsByDomain`, `listReports`, `getReport`
- 워크스페이스: `getUsage`, `health`

**근거**: 공개 읽기 엔드포인트는 brand/region/country 필터를 받을 자리가 없다(프로젝트
단위 집계). 현 계약은 `filterParams`/`scopeBody` 로 필터를 쿼리 파라미터로 내려보내려
하지만 scope 가 받지 않는다 — 거짓 인터페이스. 정책(역할→접근)을 전송 계약에서 빼내
강제 레이어(`server.ts`)로 올리면, 클라이언트는 "충실한 전송"만, 정책은 한 곳에서만
산다. 이는 경계 #2(server-derived filter, 단일 출처) 를 약화가 아니라 **강화**한다.

**대안**: `ScopeFilter` 를 대칭성 위해 계약에 유지 → 거부. http 구현이 인자를 버려야 해
거짓 계약이 되고, 검증 스크립트도 쓰지 않는 인자를 채워야 한다.

### D2. 정책은 `server.ts`, 게이팅 구현은 이번에 미룬다
**결정**: 강제 레이어 `lib/scope/server.ts` 가 세션 인증·감사·역할→프로젝트 인가의 유일한
자리로 남는다. 단, 역할→허용 프로젝트 매핑의 **구현**은 이번 change 에서 하지 않고
이음새(seam)만 정의한다. 테스트 하베스는 워크스페이스 키로 직접 호출하므로 강제 레이어를
거치지 않아, 게이팅 없이도 "API 동작 증명" 목표를 달성한다.

**근거**: 핸드오프 브리프 = "호출 로직 + 돌려볼 환경". 게이팅은 화면이 세션 기반으로
데이터를 보여줄 때 필요. 지금 묶으면 분류체계 매핑·레지스트리 설계까지 끌려와 범위 폭증.

**대안**: 이번에 게이팅까지 → 거부. 범위 폭증 + UI 없는 지금은 검증 불가(죽은 코드).

### D3. 검증 스크립트로 "돌려볼 환경" 구현
**결정**: `scripts/scope/verify-public-api.ts`(tsx 실행) 를 추가하고 npm script 로 노출.
scope 레포의 `scripts/verify-public-api.ts` 를 레퍼런스로, `HttpScopeClient` 를 직접
인스턴스화해 각 공개 메서드를 호출하고 기대 status/shape 를 단언. 흐름:
project 생성(2xx) → prompt 생성(2xx) → 결과 읽기 7종(200, 빈 배열 허용) → usage(200)
→ (정리) project soft-delete. reports 404 는 known-failure 로 표시(scope 재배포 대기).

**근거**: vitest 유닛 테스트는 네트워크·실키를 끌어들이면 안 됨(role/scope 격리 테스트와
성격 다름). 외부 라이브 검증은 옵트인 스크립트가 맞다.

**대안**: vitest 통합 테스트 → 거부. 키·네트워크 의존, CI 불안정.

### D4. Base URL 규약: `SCOPE_API_BASE` 는 호스트까지, 코드가 `/api/v1` 부착
**결정**: `SCOPE_API_BASE=https://scope-api.example.com` (prefix 없음), `http.ts` 가
`/api/v1` 를 상수로 부착. 핸드오프 §6 예제와 일치.

**근거**: 핸드오프가 `SCOPE_API_BASE` 값으로 호스트만 제시. prefix 를 코드 상수로 두면
버전 업(`/api/v2`) 시 한 곳만 바뀐다.

## Risks / Trade-offs

- **[reports 404]** → 우리 버그 아님(scope main 빌드 깨짐, 재배포 대기). 검증 스크립트가
  reports 를 known-failure 로 분류해 전체 실패로 오인하지 않게 한다. 재배포 후 200 기대.
- **[키 평문 유출]** → `.env.local`(이미 `.env*.local` gitignore)에만. 스크립트·로그·커밋에
  키 평문 금지. `NEXT_PUBLIC_` 접두 금지(브라우저 노출).
- **[게이팅 부재로 인한 오해]** → 이번 결과물은 워크스페이스 전체에 접근 가능한 상태.
  실제 역할 격리는 후속 change 전까지 미완임을 spec/문서에 명시(open question).
- **[BREAKING 계약 변경]** → `query()`/`results()`/`ScopeFilter` 인자 제거로 소비자 연쇄.
  영향 면이 작다(route handler 2개 + 대시보드 1곳). 같은 change 에서 함께 정정.
- **[분류체계 footgun]** → scope 의 `regions` 필드 == HMG 의 `countries`(국가코드). 타입에
  명시적 주석으로 선 교차 방지.

## Migration Plan

1. 계약·타입·http·mock 재정렬(코드).
2. 소비자(route handler·대시보드) 새 계약에 맞춰 정정.
3. `.env.local` live 전환 + 키 주입(로컬).
4. 검증 스크립트 실행 → 기대값 대조. mock 으로 되돌리면(`SCOPE_MODE=mock`) 앱은 그대로 동작.

롤백: `SCOPE_MODE=mock` 으로 환원하면 live 경로는 비활성, 앱 정상. 코드 롤백은 단일 change revert.

## Open Questions

- **역할→프로젝트 게이팅의 집**: 옵션1(scope 프로젝트 메타데이터 `regions`/`tracked_brands`
  교집합) vs 옵션2(로컬 `scope_projects` 레지스트리 + `scopeWhere`, 경계 #3 재사용). 후속
  change 에서 결정. 현 lean = 옵션2(누출 회피 + 기존 보상통제 재사용).
- **분류체계 매핑**: 권역 버킷(APAC/EU/NA) ↔ scope 국가코드 목록, 브랜드명 한↔영 정준 맵의
  소유 위치. 게이팅 구현과 함께.
- **projects/prompts CRUD 의 실제 소비자**: 사용자 기능 vs admin/HQ 세팅 전용. 쓰기 경로
  설계 깊이에 영향(이번엔 계약·검증만, 화면 후속).
- **국가(country) 역할 스코프**: 기존 open question 그대로(권역과 동일 가정, 확인 필요).
