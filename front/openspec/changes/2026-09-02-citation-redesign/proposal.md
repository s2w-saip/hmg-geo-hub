# Citation 화면 개편 (GGMD 1차 고도화 · 피그마 571:380)

## Why
2026-09-01 기획 확장으로 답변분석 > 인용 화면이 "카테고리 칩 필터 + 인용 현황 히어로 +
출처 카테고리 구성(현황·추이·엔진별·멘션 유형별) + 답변 우호도별 인용 도메인 + 인용 도메인
(주별 Top10·순위 표·탭 드릴다운)"으로 재구성됐다. 하위 페이지 2개(공식 도메인 인용/미인용
프롬프트 · 긍정/부정 답변에 인용된 URL)가 새로 생긴다.

## What Changes
- 표준 인용 페이지만 새 화면(`CitationsStandardView`). website/project 인용은 종전 `CitationsView` 유지.
- 집계 확장 3종: 멘션 유형별 출처 카테고리(`aggregateCitationTypeCategoriesFromMirror`) ·
  답변 톤별 인용 요약/URL 목록(`…ToneSummary…`/`…ToneUrls…`) · 공식(당사) URL 인용/미인용
  프롬프트 전량 목록(`…OwnedPrompts…`, 페이지·검색). 전부 `withAnswerSet` + `detailAnswerWhere`.
- 하위 라우트 `/standard/answer-analysis/citation/{prompts,tone-urls}` — 부모 접두 매칭으로 권한 통과.
- 도메인 드릴다운을 "인용 URL(개수) | 프롬프트" 탭으로(표준만, `drilldownTabs`).

## Decisions
- 톤 판정 = 답변 안 당사 언급의 P>NG / NG>P (동률 제외). 카테고리 필터와 무관한 전체 인용 기준 — 캡션 명시.
- 유형별 구성은 답변이 가진 유형 신호마다 그 답변의 인용을 귀속(중복 계상) — 유형 5종 신호 합 규약과 동일.
- "경쟁사" 드롭다운 = 공식(경쟁사)로 분류된 도메인 다중 선택(클라이언트, 도메인 표를 좁힘). 브랜드 단위 매핑은 미러에 없다.
- 딜러·마켓 비중은 직전 스냅샷 값이 없어 Δ 를 표시하지 않는다(공식(당사)만 Sub KPI Q4 로 Δ).
