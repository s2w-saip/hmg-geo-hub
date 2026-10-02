// URL 매칭 정규화 — KPI ⑥ 분모(자사 도메인 프리픽스)·분자(추적 URL) 매칭에
// 공통으로 쓰는 순수 유틸. scheme / 선행 www. / 끝 슬래시를 제거해
// scope_citations.url 의 SQL 정규화 형태(cnorm)와 round-trip 으로 일치시킨다
// (예: 'https://www.kia.com/it/' → 'kia.com/it'). 의미 있는 쿼리(v=, articleId=
// 등)는 의도적으로 다른 URL로 남기되, 트래킹 파라미터만 제거한다 — 아래 참조.
// 빈 값이면 "" → 분모는 글로벌 OWNED 로 fallback, 분자는 해당 항목 제외.
//
// server-only 의존이 없어 tsx 스크립트(verify)와 앱(server component) 양쪽에서
// 같은 함수를 import 해 SQL↔JS 정규화 패리티를 검증할 수 있다.
//
// ⚠ SQL 쪽 동등 표현(lib/db/repositories/scope-aggregates.ts 의 cnorm)을 바꾸면
// 이 함수도 같이 맞춰야 한다. scripts/scope/verify-url-match.ts 가 둘의 일치를
// 강제한다.
// 자원이 아니라 유입 경로를 기록하는 파라미터 — 붙어 있어도 같은 페이지다.
// AI 엔진이 스스로 붙이는 utm_source=chatgpt.com / msockid 가 인용 URL 의
// 대부분을 차지해(전체 인용의 절반 이상) 이걸 남기면 타겟 URL 등호 비교가
// 통째로 어긋난다. 반대로 v=(YouTube)·articleId=·idxno= 같이 자원을 식별하는
// 쿼리는 반드시 보존해야 하므로, 쿼리 전체를 버리지 않고 목록만 걷어낸다.
const TRACKING_PARAM =
  "(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)";
// 3패스로 나눈 이유: '?param=…' 을 통째로 지우면 뒤따르는 파라미터의 구분자가
// '&' 로 남아 URL 이 깨진다. 뒤쪽(&…) → 선두이면서 뒤가 있는 경우(?…&) →
// 선두이면서 유일한 경우(?…$) 순으로 지우면 '?' 자리가 항상 보존된다.
// 경로에 포함된 '&' 는 앞에 '?'/'&' 구분자가 없으므로 어느 패스에도 걸리지 않는다.
const TRACK_MID = new RegExp(`&${TRACKING_PARAM}=[^&]*`, "g");
const TRACK_HEAD = new RegExp(`\\?${TRACKING_PARAM}=[^&]*&`);
const TRACK_ONLY = new RegExp(`\\?${TRACKING_PARAM}=[^&]*$`);

export function normalizeUrlForMatch(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/#.*$/, "") // fragment(#…, incl. #:~:text= 스크롤-투-텍스트) 제거 —
    // 쿼리스트링과 달리 항상 클라이언트 전용이라 같은 자원을 가리킨다.
    .replace(TRACK_MID, "")
    .replace(TRACK_HEAD, "?")
    .replace(TRACK_ONLY, "")
    .replace(/\/+$/, "");
}

// ── 타겟 URL 일치 판정 ──────────────────────────────────────────────────────
// 인용 URL(C)과 그 프롬프트에 지정된 타겟 URL(T)이 **같은 페이지**인지를 본다.
// 입력은 둘 다 **추적 정규화가 끝난 값**이다(normalizeUrlForMatch / SQL 쪽
// citationTrackedNormSql · 저장 컬럼 url_norm). 판정은 그 값들의 **등치 하나**다:
//
//   C = T   (둘 중 하나라도 비면 false)
//
// 발행 리포트(scripts/reports/extract-citation-data.mts:97 `c3.tn = NORM_T(lp.target_url)`)
// 와 **글자 그대로 같은 비교**다. 그 파일의 NORM 은 여기 normalizeUrlForMatch 와
// 단계·순서가 1:1 대응한다(trim → lower → scheme → www → fragment → 트래킹 3패스
// → 끝 슬래시). 리포트가 고객에게 나간 정본이고 대시보드가 거기에 맞춘다
// (2026-09-20 제품 결정: "리포트는 절대 진실이다, 대시보드를 고친다").
//
// 2026-09-17(GGMD-61)에 대시보드만 완화 규칙(인용 쿼리 제거 + `.html`/`.htm` 동치)을
// 썼다가 철회했다. 그 규칙은 리포트보다 분자를 부풀렸다 — 2026-09-20 미러 실측,
// 리포트 '완료' 13개 사이트: 리포트 641/966(66.36%) vs 완화 656/966(67.91%),
// 차이 +15 는 전부 제네시스 6개 사이트(DE·UK·IT·CH·FR·NL). 전 함대로는 Hyundai BR
// 39 → 68(+29)까지 벌어졌다. 완화 이전 규칙(= 이 등치)은 2026-08-26 실측에서
// 리포트 값과 6/6 일치했다(scope-aggregates::aggregateWebsiteTargetHitRate 머리 주석).
//
// ⚠ SQL 쌍둥이 = lib/scope/url-match-sql.ts::targetMatchSql. 한쪽만 고치면 화면과
// 검증 스크립트가 갈라진다 — scripts/scope/verify-url-match.ts §C 가 둘의 일치를 강제한다.

/** 추적 정규화가 끝난 두 값(C, T)의 타겟 일치. 어느 쪽이든 비면 항상 false. */
export function matchesTargetUrlNorm(citedNorm: string, targetNorm: string): boolean {
  if (!targetNorm || !citedNorm) return false;
  return citedNorm === targetNorm;
}

/** 원본 URL 두 개를 받아 정규화 후 타겟 일치를 본다(verify 스크립트·테스트용). */
export function matchesTargetUrl(citedRaw: string, targetRaw: string): boolean {
  return matchesTargetUrlNorm(normalizeUrlForMatch(citedRaw), normalizeUrlForMatch(targetRaw));
}

// 정규화된 도메인에서 호스트만 추출 (경로·쿼리 제거). projects.domain 은
// KPI ⑥ 분모용으로 호스트+경로 프리픽스(kia.com/it)를 담지만, scope 프로젝트
// 미러의 domain 필드는 호스트(kia.com)를 기대한다 → scope-sync 는 이 헬퍼로
// 경로를 잘라 보낸다. 저장은 canonical(경로 포함), 전송은 호스트만 — 소비처별
// 파생. 빈 값이면 "".
export function domainHost(raw: string | null | undefined): string {
  const norm = normalizeUrlForMatch(raw);
  if (!norm) return "";
  const slash = norm.indexOf("/");
  const host = slash === -1 ? norm : norm.slice(0, slash);
  return host.split("?")[0]; // 쿼리 방어 (도메인엔 없어야 하지만)
}
