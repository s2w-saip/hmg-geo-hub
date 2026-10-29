import { describe, it, expect } from "vitest";
import { canCreateProject, canOperateProject, isOperator } from "./operator-policy";
import type { User, OperatorScope, Role } from "./types";
import type { ProjectMemberRow } from "@/lib/db/schema";

function user(role: Role, operator: OperatorScope): Pick<User, "role" | "operator"> {
  return { role, operator };
}

function activeMember(): ProjectMemberRow {
  return {
    id: "m1",
    projectId: "p1",
    userId: "u1",
    role: "viewer",
    status: "active",
    invitedBy: "u0",
    invitedAt: new Date(),
    acceptedAt: new Date(),
  };
}

function pendingMember(): ProjectMemberRow {
  return { ...activeMember(), status: "pending", acceptedAt: null };
}

describe("canCreateProject", () => {
  it("global operator can create", () => {
    expect(canCreateProject(user("hq", "global"))).toBe(true);
  });
  it("admin can always create (dev superuser)", () => {
    expect(canCreateProject(user("admin", "none"))).toBe(true);
  });
  it("assigned operator cannot create (배정 한정)", () => {
    expect(canCreateProject(user("region", "assigned"))).toBe(false);
  });
  it("non-operator cannot create", () => {
    expect(canCreateProject(user("country", "none"))).toBe(false);
  });
  it("vendor cannot create (operator forced none upstream)", () => {
    expect(canCreateProject(user("vendor", "none"))).toBe(false);
  });
});

describe("canOperateProject", () => {
  it("admin operates regardless of membership", () => {
    expect(canOperateProject(user("admin", "none"), null)).toBe(true);
  });
  it("none never operates, even as active member", () => {
    expect(canOperateProject(user("country", "none"), activeMember())).toBe(false);
  });
  it("global operates on any project (no membership needed)", () => {
    expect(canOperateProject(user("hq", "global"), null)).toBe(true);
  });
  it("assigned operates only when an ACTIVE member", () => {
    expect(canOperateProject(user("region", "assigned"), activeMember())).toBe(true);
  });
  it("assigned cannot operate without membership", () => {
    expect(canOperateProject(user("region", "assigned"), null)).toBe(false);
  });
  it("assigned cannot operate on a pending (un-accepted) membership", () => {
    expect(canOperateProject(user("region", "assigned"), pendingMember())).toBe(false);
  });
  it("vendor never operates", () => {
    expect(canOperateProject(user("vendor", "none"), activeMember())).toBe(false);
  });
});

describe("isOperator", () => {
  it("true for admin / global / assigned", () => {
    expect(isOperator(user("admin", "none"))).toBe(true);
    expect(isOperator(user("hq", "global"))).toBe(true);
    expect(isOperator(user("region", "assigned"))).toBe(true);
  });
  it("false for none", () => {
    expect(isOperator(user("country", "none"))).toBe(false);
    expect(isOperator(user("vendor", "none"))).toBe(false);
  });
});
