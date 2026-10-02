## Why

GGMD 유저 시나리오(3-2)의 클라이맥스는 **프로젝트 레이어에서 프롬프트 단위까지 집중 모니터링**
이다(HQ "프롬프트 단위까지", 권역 "어느 단계에서 빠지는지 진단", 국가 "프롬프트별 인용·답변
확인"). 그러나 `/projects/[id]/analysis/{mention,citation}` 은 `data={null}` 하드코딩으로
**항상 EmptyState** 만 보여준다 — 시나리오의 핵심 화면이 비어 있다.

원인: 표준(root) 답변 분석은 scope_* 미러(루트 전용)에서 오지만, **개별 프로젝트용 read 함수가
없었고**, 미러는 프로젝트별이 아니다. 또한 개발 단계에선 프롬프트 RUN(측정)을 트리거할 수 없어
실데이터가 생성되지 않는다.

해법은 **scope seam**이다(페이지 레벨 fakery 금지 — [[feedback_dev_mirror_live]] 원칙). 개별
프로젝트 read 를 enforce 경유의 server 함수로 추가하고, mock 모드에선 `MockScopeClient` 가 합성
측정을 돌려주어 화면이 채워진다. live 모드는 같은 코드가 프로젝트의 실제 run 을 읽는다 — 페이지
변경 없음.

## What Changes

- **신규 capability `project-answer-analysis`**: 개별 프로젝트의 mention/citation detail 을 표준과
  동일한 컴포넌트·집계로, **enforce 경유 per-project scope seam** 으로 제공.
- **server 함수 추가**: `fetchProjectMentions` / `fetchProjectCitations` (enforce + assertProjectInScope
  + scopeProjectId 해소).
- **공개 read 표면 사용(중요·2026-06-23 수정)**: per-project 데이터는 scope **공개·프로젝트 스코프
  엔드포인트** `/projects/{id}/brand-mentions` · `/projects/{id}/citations` 에서 읽는다. 내부 전용
  `/results`·`/measurements`·`/query` 는 호출하지 않는다(prod 500 원인 — docs/scope-integration-handoff.md).
  공개 행이 prompt_id/prompt_text/query_run_id(멘션)·domain/category/query_run_id(인용)를 이미
  담고 있어 `aggregateMentionsFromPublic` / `aggregateCitationsFromPublic` 로 같은 뷰 shape 를 구성.
- **mock 합성 데이터**: `MockScopeClient.listBrandMentions`/`listCitations` 가 임의 projectId 에 대해
  결정론적 행(멘션 + 인용 + category)을 반환 → mock 모드에서 화면이 채워짐(페이지 fakery 아님).
- **페이지 배선**: 두 분석 페이지가 `data={null}` 대신 seam 호출 결과를 렌더. scope read 실패는
  try/catch 로 null(EmptyState) degrade — 페이지 500 금지.

## Capabilities

### New Capabilities
- `project-answer-analysis`: 개별 프로젝트 답변 분석(mention/citation)을 enforce 경유 per-project
  scope seam 으로 제공.

## Impact

- **scope seam**:
  - `lib/scope/server.ts` — `fetchProjectMentions` / `fetchProjectCitations` + `resolveScopeProjectId`
    + 공개 list 엔드포인트 페이징(pageAll). try/catch → null degrade.
  - `lib/scope/result-adapter.ts` — `aggregateMentionsFromPublic` / `aggregateCitationsFromPublic`
    (공개 BrandMention/Citation 행 → MentionsLive/CitationsLive).
  - `lib/scope/mock.ts` — 합성 공개 행(`listBrandMentions`/`listCitations`).
- **UI**:
  - `projects/[id]/analysis/{mention,citation}/page.tsx` — seam 호출로 데이터 렌더(EmptyState 제거).
- **보안 경계**: server-only BFF 유지. 두 read 모두 `enforce`(auth+audit) + `assertProjectInScope`
  (현재 pass-through seam) 경유 — 표준 read 와 동일 posture. **내부 측정 엔드포인트 미호출**.
- **데이터 원칙**: mock 합성은 scope **client 계층**에만 존재(SCOPE_MODE seam). 페이지·컴포넌트는
  live/dev 동일 코드 경로 — NODE_ENV fixture 없음.
- **한계**: Citation 공개 행은 prompt 링크가 없어 프로젝트 인용의 **프롬프트 드릴다운(promptList)은
  비어 있음**(URL 드릴다운 + category 는 동작). 멘션은 prompt_id 가 있어 드릴다운 완전.
