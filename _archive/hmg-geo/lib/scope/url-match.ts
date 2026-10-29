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
