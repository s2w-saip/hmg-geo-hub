"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { UnauthorizedError } from "@/lib/auth/errors";
import { citationOverrideRepository } from "@/lib/db/repositories/citation-overrides";
import { CITATION_OVERRIDES_TAG } from "@/lib/citation-categorizer/overrides-loader";
import { isCitationCategory } from "@/lib/citation-categorizer";
import { MIRROR_AGGREGATE_TAG } from "@/lib/scope/server";
import { auditDataAccess } from "@/lib/audit";

// Admin-only — 인용 출처 카테고리의 도메인 오버라이드 편집.
//
// 분류는 read-time 파생이라 저장 즉시 전 이력이 재분류된다(백필 없음). 대신
// **두 캐시**를 함께 버려야 화면이 바뀐다:
//   · CITATION_OVERRIDES_TAG — 오버라이드 로더(unstable_cache)
//   · MIRROR_AGGREGATE_TAG   — 이미 접힌 미러 집계 결과
// 미러 경로에서 로더는 중첩 unstable_cache 라 캐시를 우회당하고 결과가 바깥
// 엔트리에 함께 접힌다 — 중첩 호출의 태그는 바깥 엔트리에 **상속되지 않는다**
// (Next 15.5.18 확인, overrides-loader.ts 주석 참조). 하나라도 빠지면 저장이
// 화면에 안 나타난다.

export type ActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const PATH = "/admin/standards/citation-sources";

async function requireAdmin() {
  const session = await getSession();
  if (!session || !canAccessAdmin(session.user)) {
    throw new UnauthorizedError("citation override action requires role=admin");
  }
  return session.user;
}

function invalidate() {
  revalidateTag(CITATION_OVERRIDES_TAG);
  revalidateTag(MIRROR_AGGREGATE_TAG);
  revalidatePath(PATH);
}

/** 도메인 분류 교정 저장(있으면 교체). 도메인 정규화·택소노미 검증은 리포지터리가 정본. */
export async function setCitationDomainCategory(
  domain: string,
  category: string,
  note?: string | null,
): Promise<ActionResult> {
  const user = await requireAdmin();
  const d = domain.trim();
  if (!d) return { ok: false, error: "도메인이 비어 있습니다" };
  if (!isCitationCategory(category)) {
    return { ok: false, error: "지원하지 않는 카테고리입니다" };
  }
  try {
    await citationOverrideRepository.upsert({
      domain: d,
      category,
      note: note ?? null,
      updatedBy: user.id,
    });
  } catch {
    return { ok: false, error: "저장에 실패했습니다" };
  }
  auditDataAccess(user, "citation_domain_overrides", `set:${d}:${category}`);
  invalidate();
  return { ok: true, value: undefined };
}

/** 오버라이드 삭제 = 기본 분류(owned/seed/rule/fallback)로 원복. */
export async function clearCitationDomainOverride(
  domain: string,
): Promise<ActionResult> {
  const user = await requireAdmin();
  const d = domain.trim();
  if (!d) return { ok: false, error: "도메인이 비어 있습니다" };
  try {
    await citationOverrideRepository.remove(d);
  } catch {
    return { ok: false, error: "원복에 실패했습니다" };
  }
  auditDataAccess(user, "citation_domain_overrides", `clear:${d}`);
  invalidate();
  return { ok: true, value: undefined };
}
