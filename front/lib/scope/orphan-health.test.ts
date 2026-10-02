import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  scanOrphanProjects,
  buildOrphanIssueBody,
  ORPHAN_GRACE_MINUTES,
} from "@/lib/scope/orphan-health";
import { DEMO_PROJECT_ID } from "@/lib/demo";
import type { UnmirroredProject } from "@/lib/db/repositories/projects";

const listUnmirrored = vi.fn();
const isMockMode = vi.fn();

vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { listUnmirrored: () => listUnmirrored() },
}));
vi.mock("@/lib/scope", () => ({ isMockMode: () => isMockMode() }));

const NOW = new Date("2026-08-20T12:00:00.000Z");
const old = (minutesAgo: number) =>
  new Date(NOW.getTime() - minutesAgo * 60 * 1000);

function row(over: Partial<UnmirroredProject> = {}): UnmirroredProject {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "현대·제네시스 인증중고차 (CPO)",
    country: "KR",
    brand: "Hyundai",
    createdAt: old(60),
    promptCount: 20,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isMockMode.mockReturnValue(false); // default: live
  listUnmirrored.mockResolvedValue([]);
});

describe("mock 모드에서는 재지 않는다", () => {
  // 미러가 없는 것이 설계상 정상(project-sync LIVE-ONLY)이라, 여기서 세면
  // 로컬·프리뷰의 전건이 고아로 잡혀 매번 우는 감시가 된다.
  it("DB 를 아예 조회하지 않고 mode=mock 을 돌려준다", async () => {
    isMockMode.mockReturnValue(true);
    expect(await scanOrphanProjects(NOW)).toEqual({ mode: "mock" });
    expect(listUnmirrored).not.toHaveBeenCalled();
  });
});

describe("scanOrphanProjects (live)", () => {
  it("고아가 없으면 빈 목록", async () => {
    const scan = await scanOrphanProjects(NOW);
    expect(scan).toEqual({ mode: "live", orphans: [], graceHeld: 0 });
  });

  it("유예를 지난 미러 없는 프로젝트를 고아로 집계한다", async () => {
    listUnmirrored.mockResolvedValue([row()]);
    const scan = await scanOrphanProjects(NOW);
    if (scan.mode === "mock") throw new Error("expected live");
    expect(scan.orphans).toHaveLength(1);
    expect(scan.graceHeld).toBe(0);
  });

  it("생성 직후(유예 안)의 행은 고아로 세지 않는다 — INSERT 후 미러 생성 사이의 창", async () => {
    listUnmirrored.mockResolvedValue([
      row({ createdAt: old(ORPHAN_GRACE_MINUTES - 1) }),
    ]);
    const scan = await scanOrphanProjects(NOW);
    if (scan.mode === "mock") throw new Error("expected live");
    expect(scan.orphans).toHaveLength(0);
    // 유예로 눌린 것은 침묵이 아니라 보고된다 — 0건과 구분되어야 한다.
    expect(scan.graceHeld).toBe(1);
  });

  it("경계(정확히 유예 시점)는 고아로 센다", async () => {
    listUnmirrored.mockResolvedValue([
      row({ createdAt: old(ORPHAN_GRACE_MINUTES) }),
    ]);
    const scan = await scanOrphanProjects(NOW);
    if (scan.mode === "mock") throw new Error("expected live");
    expect(scan.orphans).toHaveLength(1);
  });

  it("데모 프로젝트는 제외한다 — 합성 미러라 실패가 아니다", async () => {
    listUnmirrored.mockResolvedValue([row({ id: DEMO_PROJECT_ID })]);
    const scan = await scanOrphanProjects(NOW);
    if (scan.mode === "mock") throw new Error("expected live");
    expect(scan.orphans).toHaveLength(0);
    // 데모는 유예로 눌린 것도 아니다 — 애초에 후보가 아니다.
    expect(scan.graceHeld).toBe(0);
  });
});

describe("buildOrphanIssueBody", () => {
  it("건수·프롬프트 보유 건수·행별 식별자를 싣는다", () => {
    const body = buildOrphanIssueBody(
      [
        row({ id: "aaaa1111-1111-4111-8111-111111111111", promptCount: 20 }),
        row({
          id: "bbbb2222-2222-4222-8222-222222222222",
          name: "Kia Italy",
          brand: "Kia",
          country: "IT",
          promptCount: 0,
        }),
      ],
      NOW,
    );
    expect(body).toContain("고아 프로젝트 2건");
    // 프롬프트가 있는 행 수를 따로 세는 이유: 사용자가 "측정 중"으로 알고 있을
    // 확률이 높은 쪽이라 대응 우선순위가 다르다.
    expect(body).toContain("프롬프트가 이미 있는 것 1건");
    expect(body).toContain("aaaa1111-1111-4111-8111-111111111111");
    expect(body).toContain("bbbb2222-2222-4222-8222-222222222222");
    expect(body).toContain("Kia Italy");
    // 이슈만 보고 처리할 수 있도록 회수 절차가 본문에 있어야 한다.
    expect(body).toContain("저장 + 실행");
  });
});
