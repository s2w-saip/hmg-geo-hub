// Role data-scope hierarchy: 브랜드 > 권역 > 국가 > 차종 (access-control spec).
// `vendor` (GEO 수행사) is execution-partner access — Project menu only,
// no standard/intent dashboards, no admin console (planning page 4981000 v16).
// `website` (웹사이트 열람, 2026-07-22 feedback) — Website group only: sees the
// official-site dashboards for their profile scope (own brand×country site),
// no standard/project/admin menus. Data scope comes from the profile like every
// other role; the role only decides which menus exist.
export type Role = "hq" | "region" | "country" | "admin" | "vendor" | "website" | "local_reader";

// A user's allowed data scope. `all: true` means no restriction (HQ / admin).
// Otherwise the listed dimensions constrain what scope data the user may see.
export interface AllowedScope {
  all: boolean;
  brands?: string[];
  regions?: string[];
  countries?: string[];
}

// Operator (cost-gate) authority — ORTHOGONAL to role. role decides data
// visibility; operator decides whether cost-incurring actions (project create,
// intent collection, prompt run) may be executed (GGMD scenario 3-2).
//   - global   : create + collect + run on any in-scope project (이노션 본사)
//   - assigned : collect + run on assigned (active member) projects only; no create (이노션 법인)
//   - none     : no cost actions, read-only (외부 수행사 영구 / 미지정 그룹사 기본)
export type OperatorScope = "none" | "assigned" | "global";

// GNB 1depth 그룹. route-policy 의 RouteGroup 과 동일 집합(여기 정의를 정본으로
// 두어 types→route-policy 순환 import 를 피한다).
export type MenuGroup = "standard" | "website" | "project" | "admin";

export interface User {
  id: string;
  email: string;
  role: Role;
  scope: AllowedScope;
  operator: OperatorScope;
  // 계정별 메뉴 그룹 화이트리스트(좁히기 전용). null/빈 배열 = 제한 없음(role
  // 기본값). 값이 있으면 role 이 허용한 그룹과 **교집합** — role 보다 넓게는 절대
  // 못 준다(권한 상승 방지). 예: hq 계정에 ["project"] → 프로젝트 메뉴만.
  menuGroups: MenuGroup[] | null;
}

export interface Session {
  user: User;
}
