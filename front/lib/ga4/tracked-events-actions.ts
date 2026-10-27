"use server";

import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { resolveProperty, resolveProperties } from "./property-map";
import {
  loadEventsForProperty,
  saveEventsForProperty,
  type Ga4EventRow,
} from "./tracked-events-service";
import type { User } from "@/lib/auth/types";
import { getTranslations } from "next-intl/server";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { canReadAnalysis, isAnalysisApi } from "@/lib/hgh/analysis-access";
import {
  fetchAdminConversionEvents,
  fetchConversionEvents,
  putAdminConversionEvents,
  putConversionEvents,
  toEventRows,
} from "@/lib/hgh/conversion-events";
import { hghSource, sourceGroupFor } from "@/lib/hgh/client";
import { describeHghError, errorKindOf, isHghApiError } from "@/lib/hgh/errors";

// GA4 추적(전환) 이벤트 선택 — 화면 3곳(admin 레지스트리 / project 전환 / website
// 전환)이 공유하는 서버 액션. 대상은 항상 propertyId(=국가별 GA4 속성)이고,
// 접근 권한을 화면 맥락에 맞게 서버에서 검증한다:
//
//   - admin              → 무조건 허용
//   - project(projectId) → 읽기: 활성 멤버 / 쓰기: 활성 Owner, 또한 그 프로젝트가
//                          해석하는 property == 대상 propertyId 여야 함(IDOR 방지)
//   - website/표준(맥락X) → 대상 property가 사용자 scope가 도달하는 property 집합에
//                          포함. 쓰기는 편집 역할(country/region/hq)만 — 열람 전용
//                          website/vendor 역할은 조회만.
//
// 클라이언트가 보낸 propertyId는 신뢰하지 않고 위 규칙으로 매번 검증한다.
//
// 자리 게이트(U8 검증 D1, U4 F1 흉터): 원천을 고르기 전에 두 원천 모두 먼저 건다.
//   project(projectId)   → /projects 자리(역할 + 메뉴 그룹 project, admin 도 메뉴로 좁혀진다). 멤버십은 아래
//                          원천이 본다(현행 authorize / 백엔드 BG-29 project_id 판정).
//   admin 레지스트리       → admin 이고 메뉴가 /admin/ga4 에 닿는다(역할 + 메뉴 그룹 admin).
//   website(맥락X)        → /website/ai-funnel 자리(역할 + 메뉴 그룹 website).
//   어느 자리도 아니면     → UnauthorizedError(원천 호출 없음).
// 원천 스위치(결정 D8, U8): 자리별 그룹 플래그가 "api" 일 때 백엔드로 간다.
//   project → HGH_SOURCE_G6, GET·PUT /v1/funnel/conversion/events?project_id (BG-29)
//   website → HGH_SOURCE_G3, GET·PUT /v1/funnel/conversion/events (BG-29 비관리자 경로)
//   admin   → HGH_SOURCE_G7, GET·PUT /v1/admin/ga4/properties/{id}/events (레지스트리 화면 자기
//             원천, U8 검증 D2: 관리 화면이 G3 데이터를 섞지 않는다. known_diff U8-N9)
// 소속 판정은 백엔드가 같은 내용으로 한다(표면 경로 게이트 → 속성 소속, admin 은 알려진
// 속성 전부). 시그니처와 ActionResult 모양은 그대로다. 오류 대응:
//   401                  → UnauthorizedError (현행 세션 없음과 같다)
//   403, 읽기의 404       → UnauthorizedError (현행 authorize 실패와 같다: 소속 밖은 404 로 숨김)
//   admin 읽기의 404      → {ok:false} "레지스트리 밖 속성"(관리 경로는 레지스트리 속성만 안다)
//   쓰기의 404            → {ok:false} "레지스트리 밖 속성은 저장할 수 없다"(설계 G13, U8-N8)
//   422                  → {ok:false} 형식 오류
//   그 밖(5xx·시간 초과)  → {ok:false} 조회·저장 실패
// 저장은 재판정 큐에 들어가 적재 뒤 반영된다(propagation pending, 설계 G14). 그래서 api 저장은
// 결과 value.notice 에 "다음 적재 뒤 반영" 문구(adminGa4.events.savedPending, messages/units/u8)를
// 싣는다. 현행 저장은 즉시 반영이라 notice = null. 다이얼로그(U8 밖)가 이 문구를 토스트에 쓰도록
// 바꾸는 한 줄은 조정 대상이다(U8-N8, 검증 D4).

export type ActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const WRITE_ROLES = new Set(["country", "region", "hq", "admin"]);

async function requireSession(): Promise<User> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session.user;
}

// 프로젝트가 해석하는 GA4 property (override 우선, 없으면 brand×country 매핑).
async function projectPropertyId(projectId: string): Promise<{
  propertyId: string | null;
  ownerActive: boolean;
  memberActive: boolean;
} | null> {
  const project = await projectRepository.getById(projectId);
  if (!project) return null;
  const propertyId =
    project.ga4PropertyId ??
    (project.brand
      ? await resolveProperty(undefined, {
          brand: [project.brand],
          region: [project.country],
        })
      : null);
  const session = await getSession();
  const membership = session
    ? await projectMemberRepository.findMembership(projectId, session.user.id)
    : null;
  const active = membership?.status === "active";
  return {
    propertyId,
    ownerActive: !!active && membership?.role === "owner",
    memberActive: !!active,
  };
}

// 사용자 scope가 도달하는 property_id 집합(website/표준 맥락 검증용).
async function scopePropertyIds(user: User): Promise<Set<string>> {
  const markets = await resolveProperties(user.scope);
  return new Set(
    markets
      .map((m) => m.propertyId)
      .filter((p): p is string => p !== null),
  );
}

async function authorize(
  user: User,
  propertyId: string,
  projectId: string | undefined,
  write: boolean,
): Promise<boolean> {
  if (user.role === "admin") return true;
  if (projectId) {
    const p = await projectPropertyId(projectId);
    if (!p || p.propertyId !== propertyId) return false;
    return write ? p.ownerActive : p.memberActive;
  }
  // website/표준 맥락 — scope 소속 property 여야 하고, 쓰기는 편집 역할만.
  if (write && !WRITE_ROLES.has(user.role)) return false;
  return (await scopePropertyIds(user)).has(propertyId);
}

/** The calling place of the dialog (header "자리 게이트"). */
type EventsPlace = "project" | "admin" | "website";

const ADMIN_GA4_PATH = "/admin/ga4";

/**
 * The place gate, applied before the source branch on both sources (not exported: every
 * export of a "use server" file is a callable action). null = no place (UnauthorizedError).
 * The menu-group whitelist is part of every check (the third canAccessRoute argument), as the
 * (dash) layout applies it to the pages.
 */
function eventsPlace(user: User, projectId: string | undefined): EventsPlace | null {
  // admin is a PROJECT_VIEWERS role, so the route rule alone decides; only its menu groups can refuse (U8 N1).
  if (projectId) return canReadAnalysis(user, "funnel", "project") ? "project" : null;
  if (user.role === "admin" && canAccessRoute(user.role, ADMIN_GA4_PATH, user.menuGroups ?? null)) return "admin";
  return canReadAnalysis(user, "funnel", "website") ? "website" : null;
}

/** The group flag of the place: project G6, website G3, admin registry G7. */
function placeFromApi(place: EventsPlace): boolean {
  if (place === "admin") return hghSource(sourceGroupFor("admin")) === "api";
  return isAnalysisApi("funnel", place);
}

function requirePlace(user: User, projectId: string | undefined): EventsPlace {
  const place = eventsPlace(user, projectId);
  if (!place) throw new UnauthorizedError();
  return place;
}

type ApiEventsFailure = "invalid" | "notRegistered" | "loadFailed" | "saveFailed";

/** Backend failure -> the legacy action outcome (header table). Throws for the unauthorized cases. */
async function apiEventsFailure(e: unknown, write: boolean, place: EventsPlace): Promise<{ ok: false; error: string }> {
  if (!isHghApiError(e)) throw e;
  const kind = errorKindOf(e.status, e.code);
  if (kind === "session" || kind === "forbidden" || kind === "permission") throw new UnauthorizedError();
  if (kind === "notFound" && !write && place !== "admin") throw new UnauthorizedError();
  let key: ApiEventsFailure;
  if (kind === "notFound") key = "notRegistered";
  else if (kind === "invalid") key = "invalid";
  else key = write ? "saveFailed" : "loadFailed";
  console.warn(describeHghError(e));
  const t = await getTranslations("adminGa4.events.apiErrors");
  return { ok: false, error: t(key) };
}

export async function loadConversionEvents(
  propertyId: string,
  projectId?: string,
): Promise<ActionResult<Ga4EventRow[]>> {
  const user = await requireSession();
  const pid = propertyId.trim();
  if (!/^\d+$/.test(pid)) return { ok: false, error: "속성ID가 없거나 형식이 잘못되었습니다" };
  const place = requirePlace(user, projectId);
  if (placeFromApi(place)) {
    try {
      const data = place === "admin" ? await fetchAdminConversionEvents(pid) : await fetchConversionEvents(pid, projectId);
      return { ok: true, value: toEventRows(data) };
    } catch (e) {
      return apiEventsFailure(e, false, place);
    }
  }
  if (!(await authorize(user, pid, projectId, false))) throw new UnauthorizedError();
  try {
    return { ok: true, value: await loadEventsForProperty(pid) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? `이벤트 조회 실패: ${e.message}` : "이벤트 조회 실패",
    };
  }
}

/**
 * Save outcome. notice = the toast text for a queued save (api source, propagation pending:
 * the conversion numbers move after the next load, U8-N8); null = the plain "saved" toast
 * (legacy saves apply at once; an api save of an unchanged set is propagation none).
 */
export type SaveConversionOutcome = { notice: string | null };

export async function saveConversionEvents(
  propertyId: string,
  eventNames: string[],
  projectId?: string,
): Promise<ActionResult<SaveConversionOutcome>> {
  const user = await requireSession();
  const pid = propertyId.trim();
  if (!/^\d+$/.test(pid)) return { ok: false, error: "속성ID가 없거나 형식이 잘못되었습니다" };
  const place = requirePlace(user, projectId);
  if (placeFromApi(place)) {
    let propagation: "pending" | "none";
    try {
      const written =
        place === "admin" ? await putAdminConversionEvents(pid, eventNames) : await putConversionEvents(pid, eventNames, projectId);
      propagation = written.propagation;
    } catch (e) {
      return apiEventsFailure(e, true, place);
    }
    const notice = propagation === "pending" ? (await getTranslations("adminGa4.events"))("savedPending") : null;
    return { ok: true, value: { notice } };
  }
  if (!(await authorize(user, pid, projectId, true))) throw new UnauthorizedError();
  await saveEventsForProperty(pid, eventNames, user.id);
  return { ok: true, value: { notice: null } };
}
