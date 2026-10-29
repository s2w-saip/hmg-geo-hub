"use server";

import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { UnauthorizedError } from "@/lib/auth/errors";
import {
  promptAuditLogRepository,
  type PromptAuditLogView,
} from "@/lib/db/repositories/prompt-audit-logs";

// 열람 전용 액션 (catalog-prompt-audit): 프롬프트별 변경 이력 타임라인.
// 게이트 = `/standard/prompts` 라우트 접근 역할(NON_VENDOR)과 동일 — 편집과
// 달리 admin 전용이 아니다. 반환 형태는 admin _actions.ts의 ActionResult와
// 동일 구조(런타임 값 공유 없이 재선언 — "use server" 파일 간 타입 결합 회피).

export type ViewerActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export async function fetchPromptAuditTimeline(
  promptId: string,
): Promise<ViewerActionResult<PromptAuditLogView[]>> {
  const session = await getSession();
  if (!session || !canAccessRoute(session.user.role, "/standard/prompts")) {
    throw new UnauthorizedError("prompt audit timeline requires standard viewer access");
  }
  const rows = await promptAuditLogRepository.listForPrompt(promptId);
  return { ok: true, value: rows };
}
