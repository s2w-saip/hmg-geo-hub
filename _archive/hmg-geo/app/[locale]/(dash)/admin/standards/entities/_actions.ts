"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { UnauthorizedError } from "@/lib/auth/errors";
import { entityRegistryRepository } from "@/lib/db/repositories/entity-registry";
import { MIRROR_AGGREGATE_TAG } from "@/lib/scope/server";
import { auditDataAccess } from "@/lib/audit";

// Admin-only — 엔티티 명부(entity_registry) 역할 편집. 역할이 곧 전 화면 KPI의
// 당사 판정이므로, 변경 즉시 미러 집계 캐시를 태그로 무효화한다 (명부 내용이
// 캐시 키에도 들어가 있어 이 무효화는 이중 안전장치).

export type ActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const PATH = "/admin/standards/entities";

async function requireAdmin() {
  const session = await getSession();
  if (!session || !canAccessAdmin(session.user)) {
    throw new UnauthorizedError("entity registry action requires role=admin");
  }
  return session.user;
}

// 역할 변경 — 'competitor'는 파생 기본값이라 명부에서 행을 제거하는 것으로 구현
// (저장하지 않는다), 'own'/'excluded'는 upsert. entityId는 scope UUID 그대로.
export async function setEntityRole(
  entityId: string,
  name: string,
  role: "own" | "excluded" | "competitor",
): Promise<ActionResult> {
  const user = await requireAdmin();
  const id = entityId.trim();
  const displayName = name.trim();
  if (!id || !displayName) {
    return { ok: false, error: "엔티티 정보가 올바르지 않습니다" };
  }
  if (role === "competitor") {
    await entityRegistryRepository.remove(id);
  } else {
    await entityRegistryRepository.upsert({
      entityId: id,
      name: displayName,
      role,
      updatedBy: user.id,
    });
  }
  auditDataAccess(user, "entity_registry", `set-role:${id}:${role}`);
  // 당사 판정이 바뀌었으므로 모든 미러 집계 캐시를 무효화 — 다음 조회부터
  // 새 명부 기준으로 재집계된다.
  revalidateTag(MIRROR_AGGREGATE_TAG);
  revalidatePath(PATH);
  return { ok: true, value: undefined };
}
