// 글로벌(표준) 그룹 화면 간 이동 시 필터 URL 파라미터 이월 (2026-08-11 피드백).
//
// 필터 상태의 유일한 저장소는 URL 쿼리다 — 패널은 URL을 파싱해 표시하고, 적용은
// URL에 써넣으며, 서버 조회도 같은 URL을 읽는다. 따라서 "화면 간 필터 유지"는
// 상태 동기화가 아니라 **SNB 링크가 쿼리를 보존해주는 것**만으로 완성된다.
//
// 화면마다 지원 축이 다르므로(예: ACR은 promptContext·depth4 미지원, 전환은
// GA4 축만) 출발·도착 화면 매니페스트의 **교집합만** 이월한다 — 화면에 노출되지
// 않는 축이 데이터만 몰래 좁히는 "유령 필터"를 구조적으로 차단하기 위함이다.
// 값은 원문 그대로 복사한다(다중 선택 인코딩 FILTER_SEP 보존).

// 표준 측정 화면 공통 축 — DimensionGroup 이름 = URL 파라미터 키 (파생 규칙).
const MEASUREMENT_AXES = [
  "time",
  "geography",
  // 2026-09-04: language 누락 수정. 2026-09-03 에 표준 3면(대시보드·언급·인용)에
  // 언어 축이 생겼는데 이 목록에 안 들어와, 언어를 걸고 탭을 옮기면 **그 축만
  // 조용히 풀렸다**. 축을 새로 노출할 때 이 목록을 같이 고쳐야 한다.
  "language",
  "engine",
  "promptContext",
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "depth4",
] as const;

// 화면(로케일 제거 경로) → 이월 허용 축. 등재되지 않은 경로는 이월 없음.
// 각 화면의 DimensionFilterPanel onlyGroups 정의와 1:1로 맞춘다:
//   dashboard  → overview-filters.tsx
//   mention    → mentions-view.tsx STANDARD_MENTION_ONLY_GROUPS
//   citation   → citations-view.tsx STANDARD_CITATION_ONLY_GROUPS (+source)
//   visibility → 패널 기본(ALL_GROUPS) 중 표준 측정 축
//   acr        → acr-live-view.tsx STANDARD_ACR_ONLY_GROUPS (promptContext·depth4 없음)
//   conversion → conversion-view.tsx CONVERSION_GROUPS (GA4 축 — 표준 축은 geography·engine만 겹침)
// 부모 경로(answer-analysis / ai-funnel)는 대표 자식과 동일 축으로 등재한다.
const STANDARD_FILTER_CARRY: Record<string, readonly string[]> = {
  "/dashboard": MEASUREMENT_AXES,
  // Renewal Overview (2026-10-20) reads the same filters as /dashboard.
  "/renewal/dashboard": MEASUREMENT_AXES,
  "/standard/answer-analysis": MEASUREMENT_AXES,
  "/standard/answer-analysis/mention": MEASUREMENT_AXES,
  "/standard/answer-analysis/citation": [...MEASUREMENT_AXES, "source"],
  "/standard/ai-funnel": MEASUREMENT_AXES,
  // visibility 는 language 축을 노출하지 않는다(onlyGroups=ALL_GROUPS_EXCEPT_LANGUAGE)
  // — 이월하면 화면에 안 보이는 채로 데이터만 좁히는 유령 필터가 된다.
  "/standard/ai-funnel/visibility": MEASUREMENT_AXES.filter((a) => a !== "language"),
  "/standard/ai-funnel/acr": [
    "time",
    "geography",
    // ACR 은 language 를 노출한다(acrOnlyGroups) — 2026-09-04 함께 등재.
    "language",
    "engine",
    "brandPresence",
    "listType",
    "depth1",
    "depth2",
    "depth3",
  ],
  "/standard/ai-funnel/conversion": ["geography", "engine"],
};

// ── Website 그룹 (2026-09-04 고객 요청: "Mention 에서 필터 걸었을 때 Citation
  // 에서도 유지되게") ──────────────────────────────────────────────────────────
  // 이월 장치는 2026-08-11 부터 있었지만 **Website 경로가 등재된 적이 없어** 이
  // 그룹만 이월이 0 이었다(등재되지 않은 경로는 대상 경로만 반환하는 안전 기본값).
  // 축은 각 화면의 onlyGroups 와 1:1: 대시보드·언급 = geography·language·engine·time,
  // 인용 = + source. brand 는 admin 전용 동적 축이라 넣지 않는다(비-admin 에서
  // 유령 필터가 된다) — 표준 쪽 매니페스트가 brand 를 빼는 것과 같은 이유다.
//
// ⚠️ **표준 맵과 반드시 분리한다.** 한 맵에 섞으면 Website ↔ 표준 사이에도 이월되는데
// 두 표면의 `geography` 는 **값 공간이 다르다** — Website 는 사이트 국가
// (website_sites.country_code, `worldwide` 같은 가상 코드 포함), 표준은 측정 로케일
// (scope_answers.region, 실 ISO 뿐). `?geography=worldwide` 가 표준으로 넘어가면
// 조용히 0건이 된다. 아래 carryFilterParams 는 **같은 맵 안에서만** 이월한다.
const WEBSITE_FILTER_CARRY: Record<string, readonly string[]> = {
  "/website": ["time", "geography", "language", "engine"],
  "/website/answer-analysis": ["time", "geography", "language", "engine"],
  "/website/answer-analysis/mention": ["time", "geography", "language", "engine"],
  "/website/answer-analysis/citation": ["time", "geography", "language", "engine", "source"],
};

// 이월은 **그룹 안에서만** 일어난다(위 ⚠️ 참조).
const CARRY_GROUPS = [STANDARD_FILTER_CARRY, WEBSITE_FILTER_CARRY];

/**
 * 표준 그룹 내 이동 링크의 href를 만든다 — 현재 화면과 대상 화면이 모두
 * 매니페스트에 있으면 두 화면이 공통으로 지원하는 축의 쿼리만 붙여 반환한다.
 * 그 외(그룹 밖 출발/도착, 미등재 화면)는 대상 경로를 그대로 반환하므로
 * 모든 SNB 링크에 무조건 적용해도 안전하다.
 */
export function carryFilterParams(
  currentPath: string,
  targetPath: string,
  params: { get(name: string): string | null },
): string {
  if (currentPath === targetPath) return targetPath;
  // 출발·도착이 **같은 그룹 맵**에 있을 때만 이월한다. 그룹이 다르면(예: Website →
  // 표준) 축 이름이 같아도 값 공간이 달라 조용한 0건을 만든다.
  const group = CARRY_GROUPS.find((g) => g[currentPath] && g[targetPath]);
  if (!group) return targetPath;
  const from = group[currentPath];
  const to = group[targetPath];
  const qs = new URLSearchParams();
  for (const key of to) {
    if (!from.includes(key)) continue;
    const v = params.get(key);
    if (v) qs.set(key, v);
  }
  const s = qs.toString();
  return s ? `${targetPath}?${s}` : targetPath;
}

// ── 프로젝트 상세 3면(대시보드/언급/인용) 간 이월 (2026-08-12) ────────────────
// 표준과 같은 원리지만, 경로가 /projects/{id}/… 로 id가 동적이라 매니페스트는
// "/projects/{id} 아래 상대경로"로 키를 잡는다. 화면별 지원 축은 각 화면의
// onlyGroups(dashboard=project-dashboard.tsx, mention/citation=STANDARD_*_ONLY_GROUPS)
// 와 맞춘다 — 지원 안 하는 축을 이월해 데이터만 몰래 좁히는 유령 필터를 차단.
const PROJECT_DASH_AXES = ["time", "geography", "engine", "promptContext"] as const;
const PROJECT_ANALYSIS_AXES = [
  ...PROJECT_DASH_AXES,
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "depth4",
] as const;
const PROJECT_FILTER_CARRY: Record<string, readonly string[]> = {
  "": [...PROJECT_DASH_AXES],
  "analysis/mention": [...PROJECT_ANALYSIS_AXES],
  "analysis/citation": [...PROJECT_ANALYSIS_AXES, "source"],
};

/**
 * 프로젝트 상세 SNB 링크의 href를 만든다. 출발·도착 상대경로가 모두 매니페스트에
 * 있으면 공통 축 + 커스텀 태그(cf_*)를 쿼리로 붙인다. 그 외(측정 필터 없는
 * intent/prompt/setting 등)는 대상 경로만 반환하므로 모든 링크에 적용해도 안전하다.
 * 커스텀 태그(cf_*)는 대시보드·언급·인용 3면 모두 동적 축으로 지원하므로 항상 이월.
 */
export function carryProjectFilterParams(
  base: string,
  currentRel: string,
  targetRel: string,
  params: { get(name: string): string | null; keys(): IterableIterator<string> },
): string {
  const targetHref = targetRel ? `${base}/${targetRel}` : base;
  const from = PROJECT_FILTER_CARRY[currentRel];
  const to = PROJECT_FILTER_CARRY[targetRel];
  if (!from || !to || currentRel === targetRel) return targetHref;
  const qs = new URLSearchParams();
  for (const key of to) {
    if (!from.includes(key)) continue;
    const v = params.get(key);
    if (v) qs.set(key, v);
  }
  for (const key of params.keys()) {
    if (!key.startsWith("cf_")) continue;
    const v = params.get(key);
    if (v) qs.set(key, v);
  }
  const s = qs.toString();
  return s ? `${targetHref}?${s}` : targetHref;
}
