# 프로젝트 대시보드 패리티 기획 — project-scoped 집계 (본안)

> 목표: 표준 대시보드가 보여주는 것(특히 **subKPI**)을 프로젝트 대시보드(프로젝트 현황)에도 전부 노출하되,
> **표준 root가 아니라 그 프로젝트의 프롬프트/응답 기준으로 KPI를 집계**한다.
> 원칙: **KPI 정의·산식(분자/분모 공식)은 그대로, 바뀌는 건 집계 모집단(WHERE)** — 표준 전체 답변 →
> 그 프로젝트의 프롬프트가 측정한 답변. 렌더링은 표준 컴포넌트를 그대로 재사용.

---

## 1. 현황 — 프로젝트에 빠진 표준 기능

| 섹션 | 표준 | 프로젝트(현재) | 비고 |
|---|---|---|---|
| KPI 타일(7) | ✅ | ✅ (+⑥) | 단, `getProjectKpis`가 표준 root를 stand-in으로 씀 → **교체 대상** |
| **subKPI(카드 내 #1·2·3·4·7)** | ✅ `applySubKpis` | ❌ | 미적용 |
| **KPI delta(추이칩)** | ✅ `applyTrendDeltas` | ❌ | 미적용 |
| Trend 차트 | ✅ | ❌ | |
| Composition(주제·출처) | ✅ | ❌ | |
| 랭킹(브랜드·도메인) | ✅ | ❌ | |
| GEO 스냅샷/지도 | ✅(HQ+) | ❌ | 프로젝트=단일국 → 보류 권장(§5) |
| 프로젝트 메타·상태바·최근목록·퀵액션 | ❌ | ✅ | 프로젝트 고유(유지) |

---

## 2. 핵심 원칙 — 정의·산식 동일, 모집단만 프로젝트로

집계 모집단은 [`answerWhere`](lib/db/repositories/scope-aggregates.ts#L61)가 `scope_answers`↔`prompts` 조인으로 잡는다.
**프로젝트 한정 = 거기에 `project_id` 조건 1개 추가**:

```sql
scope_answers a
WHERE a.prompt_id IN (
  SELECT scope_prompt_id FROM prompts
  WHERE project_id = :projectId AND scope_prompt_id IS NOT NULL
)
AND <기존 answerWhere 필터(region/engine/funnelStage/…)>
```
스키마 확인됨: [prompts](lib/db/schema.ts)에 `projectId`(필수)+`scopePromptId`(측정 연결). 분자/분모 SELECT식은
표준과 동일 — 모집단(W)만 좁힌다.

### KPI별 적용
| KPI | 모집단/기준 | 비고 |
|---|---|---|
| ① 노출률 ② SOV ③ 우호도 ④ 순위 ⑤ 인용점유율 + subKPI | scope_answers ∩ **프로젝트 프롬프트** | 산식 동일, W에 project_id |
| ⑥ AI 타겟URL 인용률 | **이미 per-project** (`project_tracked_urls` 라벨 기반) | 그대로 |
| ⑦ AI 유입 전환율 | **GA4 속성**(scope_answers 아님) — 프로젝트 (brand,country)→`resolveProperty` | 단일국이라 자연히 단일 속성. 매핑 없으면 "측정 대기" |

---

## 3. 구현

### 3-1. 집계 레이어 — project_id 모집단
- `scope-aggregates.ts`: `answerWhere(filters, projectId?)`에 project 조건 추가(있으면 AND). 또는
  `projectScopeExpr(projectId)`를 만들어 각 집계의 W에 합성.
- per-project 진입점(표준 함수에 projectId 인자 추가 or 변종):
  - `aggregateStandardFromMirror(filters, projectId?)` (KPI·랭킹)
  - `aggregateSubKpisFromMirror(filters, projectId?)` (subKPI 엔진행)
  - `aggregateStandardTrendFromMirror(filters, unit, projectId?)` (추이)
  - `aggregatePromptTopicFromMirror`/`aggregateCitations…`(composition) + projectId
  - `aggregateGeoCompetitionFromMirror(filters, projectId?)` (GEO — §5 결정 시)
  - ※ rootId 가드는 프로젝트 경로에선 projectId 존재로 대체.

### 3-2. 서버 래퍼 (`lib/scope/server.ts`)
- `fetchProjectAggregates/SubKpis/Trend/Composition(projectId, filters)` — `enforce` + (향후)
  `assertProjectInScope(projectId)` 후 위 집계 호출. ⑥는 기존 `fetchProjectCitationAccuracy` 유지.

### 3-3. 조립 함수 (프로젝트 `_data/live.ts`)
`getProjectKpis`의 stand-in(`getLiveDashboard` 재사용) 제거 → `getProjectDashboard(projectId, filters, bucket)`:
```ts
const [agg, sub, trend, comp] = await Promise.all([
  fetchProjectAggregates(projectId, filters),
  fetchProjectSubKpis(projectId, filters),
  fetchProjectTrend(projectId, filters, bucket),
  fetchProjectComposition(projectId, filters),
]);
if (!agg) return null;                       // 측정 답변 0 → "측정 대기"
const accuracy = await fetchProjectCitationAccuracy(filters, urls, project.domain); // ⑥
const ai = resolveProperty(projectScope, filters);  // ⑦ GA4 property
const kpis = applySubKpis(
  applyTrendDeltas([...agg.kpis, citationAccuracyCard(accuracy), trafficConversionCard(ai)], trend),
  sub.rows, sub.promptsWithoutBrand,
);
return { kpis, trend, composition: comp, brandRankings: agg.brandRankings, domainRankings: agg.domainRankings };
```
데모 분기(`DEMO_PROJECT_IDS` → SAMPLE)는 유지.

### 3-4. 렌더링 (`project-dashboard.tsx`) — 표준 컴포넌트 재사용
`SummaryTiles`(subKPI·delta 포함)·`LiveTrendChart`(+필터바 `MeasurementBasisControl`)·`CompositionPanel`·
`VisibilityRankings`를 기존 프로젝트 고유 섹션 사이에 배치. 전부 기존 컴포넌트, 신규 작성 없음.

---

## 4. 재사용 / 신규 매핑
| | |
|---|---|
| **재사용(무변경)** | `SummaryTiles`·`applySubKpis`·`applyTrendDeltas`·`LiveTrendChart`·`CompositionPanel`·`VisibilityRankings`·`DimensionFilterPanel`·`MeasurementBasisControl`·`resolveProperty`·`fetchProjectCitationAccuracy` |
| **신규/수정** | `answerWhere`에 projectId 합성 · `aggregateProject*`/`fetchProject*` · `getProjectDashboard` · project-dashboard.tsx 섹션 배치 |

---

## 5. 주의 / 결정
1. **전제 — 측정**: 프로젝트 프롬프트가 scope에 push되어 `scope_prompt_id`가 채워지고 측정돼야 답변 존재.
   미측정 프로젝트 → KPI "측정 대기"(빈값, 정직). (현재 Kia Italy는 워크스페이스 미매핑 → 데모 SAMPLE 분기)
2. **GEO(지도/스냅샷) 보류 — 확정**: 프로젝트는 단일국(`projects.country`)이라 가치 낮음 → 1차 범위에서
   제외. `aggregateGeoCompetitionFromMirror` projectId 변종·`GeoMap`/`GeoSnapshot` 배치 모두 후속.
   (향후 넣는다면 "국가 내 브랜드별 경쟁" 뷰, RHQ activeBrand=projects.brand로 단일 권역)
3. **필터 세트**: 프로젝트는 단일 브랜드라 brand축 불필요 → 현행 축소 세트(geo/engine/context) 유지.
4. **assertProjectInScope**: 현재 pass-through(scope-gateway 미구현). project_id 모집단 필터는 그와 독립적으로
   바로 동작(데이터가 프로젝트로 좁혀짐). 권역 role-isolation enforce는 별개 후속.

---

## 7. 구현 상세 (옵션 A — projectId 스레딩, 실측 기반)

### 7-1. 스레딩 경로 (한 데이터당 5단)
`answerWhere → aggregate*FromMirror → cached*(server) → fetchStandard*(server) → getLive*(live.ts)`
각 단계에 `projectId?: string` 추가. 표준 경로는 `projectId=undefined`라 무변경.

**정확한 편집 지점 (scope-aggregates.ts):**
- `answerWhere(f, projectId?)` [L61] — 조건 1개 추가:
  ```ts
  if (projectId) conds.push(sql`a.prompt_id IN (
    SELECT scope_prompt_id FROM prompts
    WHERE project_id = ${projectId} AND scope_prompt_id IS NOT NULL)`);
  ```
- 각 집계에 projectId 인자 + `answerWhere(filters, projectId)`로 교체 + rootId 가드 완화
  (`if (!projectId && !rootId) return null`):
  `aggregateStandardFromMirror`[L99/W105] · `aggregateSubKpisFromMirror`[L285/291] ·
  `aggregatePromptTopicFromMirror`[L424/430] · `aggregateStandardTrendFromMirror`[L486/493] ·
  `aggregateCitationsFromMirror`[L741/771]. (mentions/BrandCitations는 프로젝트 대시보드 밖 → 후속)

**server.ts — ⚠️ 캐시 키에 projectId 필수:**
`cached*`는 `unstable_cache`라 인자가 캐시 키. projectId를 인자로 넘기면 자동 키 분리(프로젝트 간
오염 방지). 5개(`cachedStandardAggregates/SubKpis/PromptTopics/Trend/Citations`)에 projectId 인자 추가.
`fetchStandard*` 5개: `projectId?` 파라미터 + cached에 전달. **enforce/assert**: projectId 있으면
`assertProjectInScope(action, projectId)`(현재 pass-through지만 시맨틱 정합), rootId 가드 우회.

**live.ts getLive* (표준):** `getLiveTrend/getLiveSubKpis/getLiveComposition`에 projectId 추가(fetch에 전달).
`getLiveDashboard`는 GA4(⑦)가 session scope 기반이라 **프로젝트용으로 통째 재사용 X** — §7-3 참고.

### 7-2. 조립 (`projects/[id]/_data/live.ts`) — stand-in 제거
`getProjectKpis` → `getProjectDashboard(projectId, filters, bucket)`:
```ts
const project = await projectRepository.getById(projectId);   // brand, country, domain
const projScope = { brands: [project.brand], countries: [project.country] }; // ⑦용
const [agg, sub, trend, comp] = await Promise.all([
  fetchStandardAggregates(filters, projectId),   // ①②④⑤ + 랭킹
  fetchStandardSubKpis(filters, projectId),      // subKPI 엔진행
  getLiveTrend(filters, bucket, projectId),      // 추이 (delta 소스)
  getLiveComposition(filters, projectId),        // 주제·출처
]);
if (!agg) return null;                            // 측정 답변 0 → 측정 대기
const accuracy = await fetchProjectCitationAccuracy(filters, urls, project.domain); // ⑥ 기존
const ai = resolveProperty(projScope, filters);  // ⑦ GA4 property (§7-3)
const kpis = buildKpis(agg) → applyTrendDeltas(…, trend) → applySubKpis(…, sub.rows, sub.promptsWithoutBrand);
return { kpis:[...kpis, ⑥, ⑦], trend, composition: comp, brandRankings: agg…, domainRankings: agg… };
```
`buildKpis(agg)` = getLiveDashboard의 kpi 매핑 부분 추출/재사용(중복 방지 위해 표준 live.ts에서 export).

### 7-3. ⑦ AI 유입 전환율 — 프로젝트 property
scope_answers 모집단이 아니라 **프로젝트 (brand,country)→GA4 property**. `resolveProperty({brands:[project.brand],
countries:[project.country]}, filters)`로 단일 속성 resolve → `getAiTrafficConversionKpi(propertyId)`.
매핑 없으면(Kia IT 외) `null` = 측정 대기. 프로젝트는 단일국이라 rollup 불필요(단일 property).

### 7-4. 렌더 (`project-dashboard.tsx`) — 표준 컴포넌트 배치
`ProjectKpiTiles`(getProjectKpis) → `ProjectDashboardSections`(getProjectDashboard) 로 교체.
KPI 아래에 표준 DashboardBody 구조 이식(§GEO 제외): `SummaryTiles`(subKPI 포함) · `LiveTrendChart`(≥2버킷) ·
`CompositionPanel` · `VisibilityRankings`. i18n은 표준 `dashboard.*` 키 재사용(getTranslations("dashboard")).

### 7-5. 격리 테스트 (#2 직후, 필수)
`scope-aggregates.test.ts`(신규 또는 확장): 프로젝트 A 프롬프트 답변만, B는 안 섞임 —
`answerWhere(f, projectA)` 결과에 B의 prompt_id 미포함. `npm test` green 전제.

### 7-6. 편집 인벤토리 / 순서
| 순서 | 파일 | 규모 |
|---|---|---|
| 1 | `answerWhere` + projectId 조건 | 1곳 |
| 2 | aggregate* 5개 projectId 스레딩 + rootId 가드 완화 | 5곳 (**#2 핵심**) |
| 3 | server.ts cached*/fetchStandard* 5쌍 + 캐시키 | 10곳 |
| 4 | live.ts getLive* 3개 projectId + `buildKpis` export | 4곳 |
| 5 | `getProjectDashboard` 조립 | 신규 1 |
| 6 | project-dashboard.tsx 섹션 배치 | 1 |
| 7 | 격리 테스트 | 신규 1 |

### 7-7. 리스크
- **캐시 키 누락** → 프로젝트 간 KPI 오염(치명). 반드시 projectId를 cached 인자로.
- **scope 격리**: project_id 필터가 안 걸리면 다른 프로젝트/표준 답변 노출 → 격리 테스트로 검증(RLS 없음, 보안 경계).
- **미측정 프로젝트**: 프롬프트 scope 미push → 답변 0 → 측정 대기(정상, 정직).
- **표준 회귀 방지**: 모든 projectId는 optional(undefined=표준 무변경). `npm test` 296+ green 유지.

---

## 6. 1차 범위 (확정)
**①~⑤ + subKPI + delta + trend + composition + 랭킹**을 project-scoped로 구현(⑥는 기존, ⑦은 property resolve).
**GEO(지도/스냅샷) 보류 — 1차 제외.** 데모 프로젝트는 SAMPLE 분기로 시연.
