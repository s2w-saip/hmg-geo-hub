import { describe, it, expect, vi, beforeEach } from "vitest";

// 인용 출처 오버라이드 액션 테스트 — 전면 모킹(실 DB 없음). 검증 대상 둘:
//   3.5 비-admin(그리고 미로그인) 호출은 UnauthorizedError 로 끊긴다.
//   3.6 저장·원복 시 **두 태그**를 함께 revalidateTag 한다. 하나만 버리면
//       (오버라이드 로더는 미러 집계의 중첩 unstable_cache 라) 저장이 화면에
//       안 나타난다 — 그래서 회귀 테스트가 태그 쌍을 고정한다.

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db/repositories/citation-overrides", () => ({
  citationOverrideRepository: { upsert: vi.fn(), remove: vi.fn() },
}));
// 실제 모듈은 unstable_cache 를 쓰므로 태그 상수만 남기고 대체한다.
vi.mock("@/lib/citation-categorizer/overrides-loader", () => ({
  CITATION_OVERRIDES_TAG: "citation-overrides",
  loadCitationOverrides: vi.fn(),
}));
vi.mock("@/lib/scope/server", () => ({ MIRROR_AGGREGATE_TAG: "mirror-aggregates" }));
vi.mock("@/lib/audit", () => ({ auditDataAccess: vi.fn() }));

import { revalidateTag } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { citationOverrideRepository } from "@/lib/db/repositories/citation-overrides";
import { UnauthorizedError } from "@/lib/auth/errors";
import { CITATION_OVERRIDES_TAG } from "@/lib/citation-categorizer/overrides-loader";
import { MIRROR_AGGREGATE_TAG } from "@/lib/scope/server";
import {
  setCitationDomainCategory,
  clearCitationDomainOverride,
} from "./_actions";

const mockSession = vi.mocked(getSession);
const mockTag = vi.mocked(revalidateTag);

function asAdmin() {
  mockSession.mockResolvedValue({
    user: { id: "admin-1", role: "admin" },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
}

function asRole(role: string) {
  mockSession.mockResolvedValue({
    user: { id: "u-1", role },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(citationOverrideRepository.upsert).mockResolvedValue({
    domain: "example.com",
    category: "News & Media",
    note: null,
    updatedBy: "admin-1",
    updatedAt: new Date().toISOString(),
  });
  vi.mocked(citationOverrideRepository.remove).mockResolvedValue(true);
});

describe("citation override actions — 권한 (3.5)", () => {
  for (const role of ["hq", "region", "country", "vendor"]) {
    it(`role=${role} 는 저장·원복 모두 UnauthorizedError`, async () => {
      asRole(role);
      await expect(
        setCitationDomainCategory("example.com", "News & Media"),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(
        clearCitationDomainOverride("example.com"),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      expect(citationOverrideRepository.upsert).not.toHaveBeenCalled();
      expect(citationOverrideRepository.remove).not.toHaveBeenCalled();
      expect(mockTag).not.toHaveBeenCalled();
    });
  }

  it("미로그인도 UnauthorizedError", async () => {
    mockSession.mockResolvedValue(null);
    await expect(
      setCitationDomainCategory("example.com", "News & Media"),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mockTag).not.toHaveBeenCalled();
  });
});

describe("citation override actions — 캐시 무효화 (3.6)", () => {
  it("저장 시 오버라이드 태그와 미러 집계 태그를 둘 다 무효화한다", async () => {
    asAdmin();
    const r = await setCitationDomainCategory("WWW.Example.com ", "News & Media", " 오탐 ");
    expect(r).toEqual({ ok: true, value: undefined });

    const tags = mockTag.mock.calls.map((c) => c[0]);
    expect(tags).toContain(CITATION_OVERRIDES_TAG);
    expect(tags).toContain(MIRROR_AGGREGATE_TAG);
    expect(tags).toHaveLength(2);
  });

  it("원복 시에도 두 태그를 무효화한다", async () => {
    asAdmin();
    const r = await clearCitationDomainOverride("example.com");
    expect(r).toEqual({ ok: true, value: undefined });

    const tags = mockTag.mock.calls.map((c) => c[0]);
    expect(tags).toEqual(
      expect.arrayContaining([CITATION_OVERRIDES_TAG, MIRROR_AGGREGATE_TAG]),
    );
    expect(tags).toHaveLength(2);
  });

  it("정규화는 리포지터리가 맡는다 — 액션은 원문 도메인·actor id 를 그대로 넘긴다", async () => {
    asAdmin();
    await setCitationDomainCategory("WWW.Example.com ", "News & Media", " 오탐 ");
    expect(citationOverrideRepository.upsert).toHaveBeenCalledWith({
      domain: "WWW.Example.com",
      category: "News & Media",
      note: " 오탐 ",
      updatedBy: "admin-1",
    });
  });

  it("택소노미 밖 카테고리는 저장 전에 거부하고 캐시를 건드리지 않는다", async () => {
    asAdmin();
    const r = await setCitationDomainCategory("example.com", "Nope");
    expect(r.ok).toBe(false);
    expect(citationOverrideRepository.upsert).not.toHaveBeenCalled();
    expect(mockTag).not.toHaveBeenCalled();
  });

  it("리포지터리 실패는 ActionResult 로 접히고 캐시는 무효화하지 않는다", async () => {
    asAdmin();
    vi.mocked(citationOverrideRepository.upsert).mockRejectedValue(new Error("db down"));
    const r = await setCitationDomainCategory("example.com", "News & Media");
    expect(r.ok).toBe(false);
    expect(mockTag).not.toHaveBeenCalled();
  });
});
