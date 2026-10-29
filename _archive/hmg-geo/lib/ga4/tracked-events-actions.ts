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

export async function loadConversionEvents(
  propertyId: string,
  projectId?: string,
): Promise<ActionResult<Ga4EventRow[]>> {
  const user = await requireSession();
  const pid = propertyId.trim();
  if (!/^\d+$/.test(pid)) return { ok: false, error: "속성ID가 없거나 형식이 잘못되었습니다" };
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

export async function saveConversionEvents(
  propertyId: string,
  eventNames: string[],
  projectId?: string,
): Promise<ActionResult> {
  const user = await requireSession();
  const pid = propertyId.trim();
  if (!/^\d+$/.test(pid)) return { ok: false, error: "속성ID가 없거나 형식이 잘못되었습니다" };
  if (!(await authorize(user, pid, projectId, true))) throw new UnauthorizedError();
  await saveEventsForProperty(pid, eventNames, user.id);
  return { ok: true, value: undefined };
}
