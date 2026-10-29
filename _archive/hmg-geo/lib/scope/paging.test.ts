import { describe, expect, it, vi } from "vitest";
import { pageAll, PROMPT_MAX_PAGES } from "./paging";

describe("pageAll — 페이지 상한 소진의 표면화 (2026-08-30 regions 5,000 정체)", () => {
  /**
   * `pageAll` 에 물릴 가짜 소스. 총 `total` 개를 `size` 씩 잘라 커서로 넘긴다.
   * 커서는 "다음 오프셋"의 문자열이라, 스텁이 받은 커서 시퀀스를 그대로 검사하면
   * **패스 안에서 커서가 실제로 전진하는지**까지 확인할 수 있다.
   */
  function pagedSource(total: number, size: number) {
    const seen: (string | undefined)[] = [];
    return {
      seen,
      fetch: async (cursor?: string) => {
        seen.push(cursor);
        const offset = cursor ? Number(cursor) : 0;
        const data = Array.from(
          { length: Math.max(0, Math.min(size, total - offset)) },
          (_, i) => offset + i,
        );
        const next = offset + data.length;
        return { data, next_cursor: next < total ? String(next) : null };
      },
    };
  }

  it("상한에 안 걸리면 전량을 가져오고 truncated=false", async () => {
    const src = pagedSource(250, 100);
    const r = await pageAll(src.fetch, { maxPages: 50, label: "t" });
    expect(r.items).toHaveLength(250);
    expect(r.truncated).toBe(false);
    expect(r.pages).toBe(3);
    // 커서가 패스 안에서 전진한다 (첫 호출만 undefined).
    expect(src.seen).toEqual([undefined, "100", "200"]);
  });

  it("상한을 소진하고 커서가 남으면 truncated=true — 조용히 끝나지 않는다", async () => {
    // 사고의 재현: 총 12,012 인데 상한 50페이지 × 100 = 5,000 에서 잘린다.
    const src = pagedSource(12_012, 100);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await pageAll(src.fetch, { maxPages: 50, label: "prompts(project=root)" });
      expect(r.items).toHaveLength(5_000);
      expect(r.pages).toBe(50);
      expect(r.truncated).toBe(true);
      // 로그로도 표면화된다 — 이 결함이 오래 산 이유가 "무음"이었다.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("PAGE CAP HIT");
      expect(String(warn.mock.calls[0][0])).toContain("prompts(project=root)");
    } finally {
      warn.mockRestore();
    }
  });

  // 2026-08-30: 상한을 300 으로 올려 12,012 을 한 패스에 다 가져오려 했다가
  // **라이브 장애를 냈다**(크론 300s 타임아웃 · 미러 싱크 2시간 정지). 시간
  // 예산이 프로젝트 사이에서만 검사되므로 페이징 루프 안에서 멈출 수 없다.
  // 이제 루트는 **의도적으로 절단**되며, 그 절단이 조용하지 않은 것이 계약이다.
  it("루트가 상한을 넘으면 절단되지만 **조용하지 않다**", async () => {
    const src = pagedSource(12_012, 100);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await pageAll(src.fetch, {
        maxPages: PROMPT_MAX_PAGES,
        label: "prompts(project=root)",
      });
      expect(r.pages).toBe(PROMPT_MAX_PAGES);
      expect(r.items).toHaveLength(PROMPT_MAX_PAGES * 100);
      expect(r.truncated).toBe(true);
      // 이 경고가 이 결함이 다시 조용해지는 것을 막는 유일한 장치다.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("PAGE CAP HIT");
    } finally {
      warn.mockRestore();
    }
  });

  it("상한은 크론 시간 예산 안에서 끝날 수 있는 값이어야 한다", () => {
    // 왕복당 2s 를 보수적으로 잡으면 50 페이지 = 100s 로, 미러 싱크의
    // SYNC_BUDGET_MS(250s) 안에서 다른 프로젝트도 처리할 여지가 남는다.
    // 300 페이지 = 600s 는 크론 maxDuration(300s) 자체를 넘긴다 — 실제로 넘겼다.
    expect(PROMPT_MAX_PAGES * 2).toBeLessThan(250);
  });

  it("마지막 페이지가 정확히 상한과 맞아떨어지면 truncated=false (경계)", async () => {
    const src = pagedSource(300, 100);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await pageAll(src.fetch, { maxPages: 3, label: "t" });
      expect(r.items).toHaveLength(300);
      expect(r.pages).toBe(3);
      // 3페이지째에 next_cursor 가 null 이므로 '잘림'이 아니다.
      expect(r.truncated).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("한 페이지 모자라면 truncated=true (경계 반대편)", async () => {
    const src = pagedSource(301, 100);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await pageAll(src.fetch, { maxPages: 3, label: "t" });
      expect(r.items).toHaveLength(300);
      expect(r.truncated).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("PROMPT_MAX_PAGES — 값의 근거를 고정한다", () => {
  // ⚠️ 이 자리에는 원래 "루트 12,012 의 2배 이상 담아야 한다"는 단언이 있었다.
  // **그 전제가 장애의 원인이었다** — 한 패스에 전량을 담으려다 크론 300s 를
  // 넘겨 미러 싱크가 2시간 멈췄다(2026-08-30). 담을 수 있느냐가 아니라
  // **시간 안에 끝나느냐**가 상한의 제약이다. 계약을 뒤집어 다시 고정한다.
  it("한 패스가 크론 시간 예산 안에서 끝날 수 있다", () => {
    // 왕복당 2s(보수적) × 50 페이지 = 100s. 미러 싱크 예산 250s 안이고,
    // 크론 maxDuration 300s 에는 충분히 못 미친다.
    const PESSIMISTIC_SECONDS_PER_ROUNDTRIP = 2;
    const SYNC_BUDGET_SECONDS = 250;
    expect(PROMPT_MAX_PAGES * PESSIMISTIC_SECONDS_PER_ROUNDTRIP).toBeLessThan(
      SYNC_BUDGET_SECONDS,
    );
  });

  it("루트를 다 담지 못한다는 사실을 명시적으로 안다", () => {
    // 이건 결함이 아니라 **의도된 절단**이다. 전량 수집은 상한을 올리는 것이
    // 아니라 증분 커서·워터마크로 풀어야 한다(paging.ts 헤더 참조).
    const MEASURED_ROOT_PROMPTS = 12_012;
    expect(PROMPT_MAX_PAGES * 100).toBeLessThan(MEASURED_ROOT_PROMPTS);
  });
});
