import type { User } from "./types";
import type { ProjectMemberRow } from "@/lib/db/schema";

// Operator (cost-gate) policy — the SINGLE source of truth for which users may
// perform cost-incurring actions. Cost is incurred only at execution (RUN), so
// per GGMD scenario 3-2 exactly three actions are gated: project create, intent
// collection, prompt run. Everything else (read / dashboards / drilldown) is
// ungated.
//
// This module is deliberately separate from scope-policy (data *values*) and
// route-policy (URL *places*): operator is a third, orthogonal axis — *cost
// actions*. A single function per decision keeps UI visibility and server-action
// enforcement in lockstep ("보이는 것 = 할 수 있는 것").
//
// admin = developer superuser (resolved 2026-06-02): bypasses every gate.

// Project creation is reserved for `global` operators (이노션 본사) + admin.
// `assigned` operators (이노션 법인) work only within projects they were added
// to ("배정 프로젝트 한정"); they cannot originate new projects. The creator
// becomes the project Owner (= assigned to it).
export function canCreateProject(user: Pick<User, "role" | "operator">): boolean {
  if (user.role === "admin") return true;
  return user.operator === "global";
}

// Intent collection + prompt execution gate. `none` never operates (외부 수행사,
// 미지정 그룹사). `global` operates on any in-scope project. `assigned` operates
// only where it is an ACTIVE member — membership is the "배정" signal (reusing
// project_members; no separate assignment table).
export function canOperateProject(
  user: Pick<User, "role" | "operator">,
  membership: ProjectMemberRow | null,
): boolean {
  if (user.role === "admin") return true;
  if (user.operator === "none") return false;
  if (user.operator === "global") return true;
  // assigned:
  return membership?.status === "active";
}

// Whether a user can perform ANY cost action — drives high-level UI affordances
// (e.g. whether to surface operate controls at all). Not a substitute for the
// per-action checks above.
export function isOperator(user: Pick<User, "role" | "operator">): boolean {
  if (user.role === "admin") return true;
  return user.operator !== "none";
}
