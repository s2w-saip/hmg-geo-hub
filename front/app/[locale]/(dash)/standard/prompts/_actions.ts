"use server";

import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { UnauthorizedError } from "@/lib/auth/errors";
import type { User } from "@/lib/auth/types";
import {
  promptAuditLogRepository,
  type PromptAuditLogView,
} from "@/lib/db/repositories/prompt-audit-logs";
import { listStandardCatalogScoped } from "@/lib/db/repositories/standards";
import { canReadAnalysis, isAnalysisApi } from "@/lib/hgh/analysis-access";
import { fetchAdminPromptTimelineApi, fetchPromptTimelineApi } from "@/lib/hgh/prompt-timeline";
import { hghSource, sourceGroupFor } from "@/lib/hgh/client";
import { errorKindOf, isHghApiError } from "@/lib/hgh/errors";

// 열람 전용 액션 (catalog-prompt-audit): 프롬프트별 변경 이력 타임라인.
// 두 화면이 부른다: /standard/prompts 뷰어(NON_VENDOR)와 admin 카탈로그
// (/admin/standards/prompts, U11 은 import 만). 반환 형태는 admin _actions.ts의
// ActionResult와 동일 구조(런타임 값 공유 없이 재선언: "use server" 파일 간 타입 결합 회피).
//
// 자리 게이트(U8 검증 D1, U4 F1 흉터): 원천을 고르기 전에 두 원천 모두 먼저 건다. 역할과
// 계정 메뉴 그룹을 함께 본다(3인자 canAccessRoute, (dash) 레이아웃과 같은 판정).
//   standard 자리 = /standard/prompts (역할 STANDARD_VIEWERS + 메뉴 그룹 standard)
//   admin 자리    = /admin/standards/prompts (admin + 메뉴 그룹 admin)
// 원천(결정 D8): admin 자리에 닿는 admin 은 관리 카탈로그의 그룹 HGH_SOURCE_G7, 그 밖은
// HGH_SOURCE_G5 (U8 검증 D2: 관리 화면이 G5 데이터를 섞지 않는다, known_diff U8-N21). 액션은
// 호출 화면을 볼 수 없어서 admin 이 /standard/prompts 에서 연 타임라인도 G7 을 따른다.
// 스코프: 계정 스코프 밖 프롬프트의 타임라인은 빈 목록이다(두 원천 모두, U8-N12). 현행 경로는
// 스코프가 전부(scope.all)가 아니면 그 프롬프트가 listStandardCatalogScoped(scope) 안에 있는지
// 먼저 본다(그 화면이 보여 주는 목록과 같은 집합).

export type ViewerActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const ADMIN_CATALOG_PATH = "/admin/standards/prompts";

type TimelinePlace = "standard" | "admin";

function timelinePlace(user: User): TimelinePlace | null {
  const menus = user.menuGroups ?? null;
  // an admin who reaches the admin catalog reads its source (G7), even from /standard/prompts
  if (user.role === "admin" && canAccessRoute(user.role, ADMIN_CATALOG_PATH, menus)) return "admin";
  if (canReadAnalysis(user, "prompts", "global")) return "standard";
  return null;
}

function placeFromApi(place: TimelinePlace): boolean {
  return place === "admin" ? hghSource(sourceGroupFor("admin")) === "api" : isAnalysisApi("prompts", "global");
}

export async function fetchPromptAuditTimeline(
  promptId: string,
): Promise<ViewerActionResult<PromptAuditLogView[]>> {
  const session = await getSession();
  const place = session ? timelinePlace(session.user) : null;
  if (!session || !place) {
    throw new UnauthorizedError("prompt audit timeline requires standard viewer access");
  }
  if (placeFromApi(place)) return timelineFromApi(promptId, place);
  const scope = session.user.scope;
  if (!scope.all) {
    const { rows } = await listStandardCatalogScoped(scope);
    if (!rows.some((r) => r.id === promptId)) return { ok: true, value: [] };
  }
  const rows = await promptAuditLogRepository.listForPrompt(promptId);
  return { ok: true, value: rows };
}

// Backend API source (HGH_SOURCE_G5, or G7 for the admin catalog place, unit U8). Standard place:
// GET /v1/prompts/history?prompt_id with from=2000-01-01..today (the legacy timeline had no window);
// a prompt outside the account scope gives an empty list (U8-N12). Admin place: GET
// /v1/admin/catalog/prompts/{id}/history (admin + admin menu group, no standard menu gate, backend
// request U8-7), so an admin whose menu groups lack standard reads it as legacy did (U8-N21).
// Errors: 401/403 -> UnauthorizedError (legacy gate failure), anything else -> {ok:false} with the
// error kind.
async function timelineFromApi(promptId: string, place: TimelinePlace): Promise<ViewerActionResult<PromptAuditLogView[]>> {
  try {
    const rows = place === "admin" ? await fetchAdminPromptTimelineApi(promptId) : await fetchPromptTimelineApi(promptId);
    return { ok: true, value: rows };
  } catch (e) {
    if (!isHghApiError(e)) throw e;
    const kind = errorKindOf(e.status, e.code);
    if (kind === "session" || kind === "forbidden" || kind === "permission") {
      throw new UnauthorizedError("prompt audit timeline requires standard viewer access");
    }
    return { ok: false, error: kind };
  }
}
