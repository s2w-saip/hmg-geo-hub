import "server-only";
import { and, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { AllowedScope } from "@/lib/auth/types";
import { UnauthorizedError } from "@/lib/auth/errors";

// Scope enforcement for domain tables, used WITHOUT RLS (data-access-security).
//
// This is the single mechanism future repositories use to restrict rows to the
// caller's allowed scope. It is default-deny: a missing scope (no AuthContext)
// throws rather than returning unscoped rows. HQ/admin (scope.all) → no
// restriction. The WHERE it returns mirrors the pure `isInScope` predicate in
// lib/auth/scope-policy (kept in sync; that predicate is unit-tested).
//
// There is intentionally NO "unscoped" query helper — the only path to scoped
// tables passes through here, so a query cannot accidentally skip the filter.
export function scopeWhere(
  scope: AllowedScope | null | undefined,
  cols: { brand?: AnyPgColumn; region?: AnyPgColumn; country?: AnyPgColumn },
): SQL | undefined {
  if (!scope) {
    throw new UnauthorizedError(); // default-deny: no context → no data
  }
  if (scope.all) {
    return undefined; // HQ / admin: no restriction
  }
  const conds: SQL[] = [];
  if (cols.region && scope.regions?.length) {
    conds.push(inArray(cols.region, scope.regions));
  }
  if (cols.country && scope.countries?.length) {
    conds.push(inArray(cols.country, scope.countries));
  }
  if (cols.brand && scope.brands?.length) {
    // 2026-06-10 (D5): brand=null rows count as common (visible to every
    // brand-scoped user). Mirrors the isInScope predicate in scope-policy.ts.
    const brandCond = or(
      inArray(cols.brand, scope.brands),
      isNull(cols.brand),
    );
    if (brandCond) conds.push(brandCond);
  }
  return conds.length ? and(...conds) : undefined;
}
