"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { UnauthorizedError } from "@/lib/auth/errors";
import { ga4PropertyRepository } from "@/lib/db/repositories/ga4-properties";
import { envPropertyFor } from "@/lib/ga4/property-map";
import { runReport, dateNDaysAgo } from "@/lib/ga4/client";
import * as api from "@/lib/hgh/adapters/admin";

// Admin-only — GA4 연동 레지스트리(ga4_properties) 등록·검증·삭제. 매핑은
// resolveProperty가 즉시 읽으므로 변경 후 대상 화면 revalidate.
// 설계: docs/ga4-connection-permission-design.md.
//
// Source (D8, HGH_SOURCE_G7): after the same gate and local checks, api writes go to
// /v1/admin/ga4/properties/{id} (with a property id; verify=true for 검증) or
// /v1/admin/ga4/markets/{brand}/{country} (property-less market, BG-43). Row ids on that source
// are "p:<property_id>" or "m:<brand>:<country>" (lib/hgh/adapters/admin.ts). A market taken by
// another property is refused (U11-N3); the GA4 read check runs on the backend.

export type ActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const PATH = "/admin/ga4";

async function requireAdmin() {
  const session = await getSession();
  if (!session || !canAccessAdmin(session.user)) {
    throw new UnauthorizedError("ga4 registry action requires role=admin");
  }
  return session.user;
}

export async function upsertGa4Mapping(input: {
  brand: string;
  countryCode: string;
  propertyId: string;
}): Promise<ActionResult> {
  const user = await requireAdmin();
  const brand = input.brand.trim();
  const countryCode = input.countryCode.trim().toUpperCase();
  const propertyId = input.propertyId.trim();
  if (!brand || !countryCode) {
    return { ok: false, error: "브랜드·국가는 필수입니다" };
  }
  if (propertyId && !/^\d+$/.test(propertyId)) {
    return { ok: false, error: "속성ID는 숫자만 허용됩니다" };
  }
  if (api.isAdminApi()) {
    if (propertyId.length > 20) return { ok: false, error: "속성ID는 숫자만 허용됩니다" };
    const r = await api.putGa4Mapping(brand, countryCode, propertyId);
    if (r.ok) revalidatePath(PATH);
    return r;
  }
  await ga4PropertyRepository.upsert({
    brand,
    countryCode,
    propertyId: propertyId || null,
    createdBy: user.id,
  });
  revalidatePath(PATH);
  return { ok: true, value: undefined };
}

// 실제 GA4 Data API로 최소 read를 시도해 접근 권한을 검증 — 성공하면 status를
// active로 승격. runReport가 실패(권한 없음·잘못된 속성ID 등)하면 그대로 오류 반환.
// `market` (api source): the row's brand and country, re-sent because the property PUT replaces
// the mapping (legacy ignores it).
export async function verifyGa4Mapping(
  id: string,
  propertyId: string,
  market?: { brand: string; countryCode: string },
): Promise<ActionResult> {
  await requireAdmin();
  const pid = propertyId.trim();
  if (!pid) return { ok: false, error: "속성ID가 없어 검증할 수 없습니다" };
  if (api.isAdminApi()) {
    if (!/^\d{1,20}$/.test(pid)) return { ok: false, error: "속성ID는 숫자만 허용됩니다" };
    const r = await api.verifyGa4Property(pid, market ?? null);
    if (r.ok) revalidatePath(PATH);
    return r;
  }
  try {
    const { start, end } = dateNDaysAgo(1);
    await runReport(pid, {
      dateRanges: [{ startDate: start, endDate: end }],
      metrics: [{ name: "activeUsers" }],
      limit: 1,
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? `검증 실패: ${e.message}` : "검증 실패",
    };
  }
  await ga4PropertyRepository.setStatus(id, {
    status: "active",
    verifiedAt: new Date(),
  });
  revalidatePath(PATH);
  return { ok: true, value: undefined };
}

// 레거시 env 매핑을 DB 레지스트리로 가져오기(등록). 속성ID는 클라이언트 값을
// 믿지 않고 서버에서 env로 다시 확인한다. 등록 후 admin이 '검증'으로 승격.
export async function importLegacyMapping(
  brand: string,
  countryCode: string,
): Promise<ActionResult> {
  const user = await requireAdmin();
  const b = brand.trim();
  const c = countryCode.trim().toUpperCase();
  const propertyId = envPropertyFor(b, c);
  if (!propertyId) {
    return { ok: false, error: "해당 시장의 env 속성ID를 찾을 수 없습니다" };
  }
  if (api.isAdminApi()) {
    const r = await api.putGa4Mapping(b, c, propertyId);
    if (r.ok) revalidatePath(PATH);
    return r;
  }
  await ga4PropertyRepository.upsert({
    brand: b,
    countryCode: c,
    propertyId,
    createdBy: user.id,
  });
  revalidatePath(PATH);
  return { ok: true, value: undefined };
}

export async function removeGa4Mapping(id: string): Promise<ActionResult> {
  await requireAdmin();
  if (api.isAdminApi()) {
    const r = await api.removeGa4Row(id);
    if (r.ok) revalidatePath(PATH);
    return r;
  }
  await ga4PropertyRepository.remove(id);
  revalidatePath(PATH);
  return { ok: true, value: undefined };
}

// 추적(전환) 이벤트 선택 액션은 세 화면(admin/project/website)이 공유하는
// lib/ga4/tracked-events-actions.ts 로 이관됨(권한 분기 포함).
