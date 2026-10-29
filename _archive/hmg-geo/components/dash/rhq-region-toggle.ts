// 권역(RHQ) 토글 순수 로직 — DimensionFilterPanel 의 geography 축에서 권역을
// 눌렀을 때 nav(펼쳐 보는 권역)와 geography(실제 선택 국가)가 어떻게 변하는지.
//
// 패널에서 분리한 이유: 클릭 핸들러 안에 있으면 검증할 방법이 없다. 이 리포엔
// interaction 테스트 셋업(@testing-library)이 없고 렌더 테스트는
// renderToStaticMarkup 이라 클릭을 못 만든다 — keyword-selection.ts /
// perspective-filter.ts 와 같은 선례를 따라 순수 함수로 뽑아 고정한다.
//
// 두 상태의 역할이 다르다:
//   nav        = "이 권역을 펼쳐 보는 중" — 국가 드롭다운 목록을 좁히는 표시용.
//   geography  = 실제 데이터 필터로 커밋되는 국가 선택.
// 권역을 누르면 둘 다 움직인다 — 목록만 좁히고 선택은 안 하면, 권역을 골랐는데
// 필터가 비어 전 국가가 그대로 나온다(2026-07-16 수정 전 동작).

export interface RhqToggleState {
  /** 펼쳐 보는 중인 권역 id 목록. */
  nav: string[];
  /** 선택된 국가(ISO). 적용 시 ?geography= 로 커밋된다. */
  geography: string[];
}

/**
 * 권역이 "선택" 상태인가 — 그 권역의 측정 국가가 **하나라도** geography 에 있는가.
 * 권역 체크 표시와 토글 방향 판정이 이 하나를 공유한다.
 *
 * 2026-08-12: 표시·토글을 nav 가 아닌 국가 선택에서 파생시켰다(국가에서 독일을
 * 빼도 권역 체크가 남던 비일관 수정).
 * 2026-09-01: 판정을 "완전 선택"에서 "하나라도 선택"으로 완화 — 이전엔 사용자가
 * 전체선택 → 일부선택(체크 사라짐) → 해제의 3단계를 겪었다. 일부 선택도 선택으로
 * 보이게 해 선택/해제 2단계로 줄인다(운영 요청).
 * 측정 국가가 0개인 권역은 선택으로 보지 않는다.
 */
export function isRegionSelected(
  regionId: string,
  geography: readonly string[],
  countryToRhq: ReadonlyMap<string, string>,
): boolean {
  const selected = new Set(geography);
  for (const [iso, rid] of countryToRhq) {
    if (rid !== regionId) continue;
    if (selected.has(iso)) return true;
  }
  return false;
}

/**
 * 권역 하나를 토글한다. 방향은 nav(펼침 상태)가 아니라 **국가 선택에서 파생**
 * 한다 — 하나라도 선택돼 있으면 끄기(그 권역 국가 전부 제거), 하나도 없으면
 * 켜기(그 권역 국가 전부 선택). 체크 표시(isRegionSelected)와 같은 술어를 쓰므로
 * "체크가 보이면 누르면 꺼진다"가 항상 성립한다 — 선택/해제 2단계.
 *
 * @param regionId     토글할 권역 id
 * @param state        현재 nav / geography
 * @param countryToRhq 측정된 ISO → 권역 id (활성 브랜드 기준). 이 맵에 없는 국가는
 *                     권역에 속하지 않는 것으로 본다.
 */
export function toggleRhqRegion(
  regionId: string,
  state: RhqToggleState,
  countryToRhq: ReadonlyMap<string, string>,
): RhqToggleState {
  // 측정 국가가 없는 권역은 파생 판정이 항상 false 라 nav 토글로만 다룬다 —
  // 아니면 두 번 눌러도 nav 에서 빠지지 않는다(availableRhqRegions 파생상 실제
  // 노출되지 않는 방어적 경로).
  let hasCountries = false;
  for (const rid of countryToRhq.values()) {
    if (rid === regionId) {
      hasCountries = true;
      break;
    }
  }
  const turningOn = hasCountries
    ? !isRegionSelected(regionId, state.geography, countryToRhq)
    : !state.nav.includes(regionId);
  const nav = turningOn
    ? state.nav.includes(regionId)
      ? state.nav
      : [...state.nav, regionId]
    : state.nav.filter((x) => x !== regionId);

  const selected = new Set(state.geography);
  for (const [iso, rid] of countryToRhq) {
    if (rid !== regionId) continue;
    if (turningOn) selected.add(iso);
    else selected.delete(iso);
  }

  // 권역이 하나라도 켜져 있으면 그 권역들 밖의 국가는 남기지 않는다 — 좁혀진 목록
  // 뒤에 숨은 이전 선택이 필터에 계속 남는 걸 막는다.
  if (nav.length > 0) {
    for (const iso of [...selected]) {
      const rid = countryToRhq.get(iso);
      if (!rid || !nav.includes(rid)) selected.delete(iso);
    }
  }

  return { nav, geography: [...selected] };
}
