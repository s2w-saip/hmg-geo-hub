import { describe, expect, it } from "vitest";
import { carryFilterParams, carryProjectFilterParams } from "./filter-carry";

const sp = (init: Record<string, string>) => new URLSearchParams(init);

describe("carryFilterParams", () => {
  it("표준 화면 간 이동 시 공통 축 쿼리를 이월한다", () => {
    const href = carryFilterParams(
      "/dashboard",
      "/standard/answer-analysis/mention",
      sp({ promptContext: "Hyundai", engine: "chatgpt" }),
    );
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/standard/answer-analysis/mention");
    expect(url.searchParams.get("promptContext")).toBe("Hyundai");
    expect(url.searchParams.get("engine")).toBe("chatgpt");
  });

  it("대상 화면이 지원하지 않는 축은 버린다 (유령 필터 방지)", () => {
    // ACR은 promptContext·depth4 미지원 — 지원 축(geography)만 남는다.
    const href = carryFilterParams(
      "/standard/answer-analysis/mention",
      "/standard/ai-funnel/acr",
      sp({ promptContext: "Hyundai", depth4: "EV", geography: "US" }),
    );
    const url = new URL(href, "http://x");
    expect(url.searchParams.get("geography")).toBe("US");
    expect(url.searchParams.get("promptContext")).toBeNull();
    expect(url.searchParams.get("depth4")).toBeNull();
  });

  it("출발 화면 전용 축도 이월하지 않는다 (교집합)", () => {
    // citation 전용 source 축은 mention으로 넘어가지 않는다.
    const href = carryFilterParams(
      "/standard/answer-analysis/citation",
      "/standard/answer-analysis/mention",
      sp({ source: "news", engine: "gemini" }),
    );
    const url = new URL(href, "http://x");
    expect(url.searchParams.get("source")).toBeNull();
    expect(url.searchParams.get("engine")).toBe("gemini");
  });

  it("다중 선택 인코딩 값을 원문 그대로 보존한다", () => {
    const multi = "Hyundai␟Kia"; // FILTER_SEP 인코딩 가정 원문
    const href = carryFilterParams(
      "/dashboard",
      "/standard/ai-funnel/visibility",
      sp({ promptContext: multi }),
    );
    expect(new URL(href, "http://x").searchParams.get("promptContext")).toBe(multi);
  });

  it("표준 그룹 밖 출발/도착은 이월 없이 경로만 반환한다", () => {
    const p = sp({ engine: "chatgpt" });
    expect(carryFilterParams("/projects/abc/prompt", "/dashboard", p)).toBe("/dashboard");
    expect(carryFilterParams("/dashboard", "/projects", p)).toBe("/projects");
    expect(carryFilterParams("/customer-interest/google-keywords", "/dashboard", p)).toBe(
      "/dashboard",
    );
  });

  it("이월할 값이 없으면 쿼리 없는 경로를 반환한다", () => {
    expect(
      carryFilterParams("/dashboard", "/standard/answer-analysis/mention", sp({})),
    ).toBe("/standard/answer-analysis/mention");
  });

  it("같은 화면으로의 링크는 그대로 둔다", () => {
    expect(
      carryFilterParams("/dashboard", "/dashboard", sp({ engine: "chatgpt" })),
    ).toBe("/dashboard");
  });
});

describe("carryProjectFilterParams", () => {
  const B = "/projects/abc";

  it("언급→인용 이동 시 공통 축 + 커스텀 태그(cf_*)를 이월한다", () => {
    const href = carryProjectFilterParams(
      B,
      "analysis/mention",
      "analysis/citation",
      sp({ engine: "chatgpt", listType: "Brand Message", cf_9f1: "높음" }),
    );
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/projects/abc/analysis/citation");
    expect(url.searchParams.get("engine")).toBe("chatgpt");
    expect(url.searchParams.get("listType")).toBe("Brand Message");
    expect(url.searchParams.get("cf_9f1")).toBe("높음");
  });

  it("언급→대시보드는 대시보드 미지원 축(카탈로그)을 버린다 (유령 필터 방지)", () => {
    const href = carryProjectFilterParams(
      B,
      "analysis/mention",
      "",
      sp({ engine: "chatgpt", listType: "Brand Message", cf_9f1: "높음" }),
    );
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/projects/abc");
    expect(url.searchParams.get("engine")).toBe("chatgpt");
    expect(url.searchParams.get("listType")).toBeNull(); // 대시보드 미지원 축
    expect(url.searchParams.get("cf_9f1")).toBe("높음"); // 태그는 3면 공통
  });

  it("측정 필터 없는 화면(prompt 등)은 이월 없이 경로만 반환한다", () => {
    expect(
      carryProjectFilterParams(B, "prompt", "analysis/mention", sp({ engine: "chatgpt" })),
    ).toBe("/projects/abc/analysis/mention");
    expect(
      carryProjectFilterParams(B, "analysis/mention", "prompt", sp({ engine: "chatgpt" })),
    ).toBe("/projects/abc/prompt");
  });
});

// 2026-09-04 고객 요청·결함 2건.
describe("carryFilterParams — 2026-09-04 회귀", () => {
  it("Website: Mention 에서 건 필터가 Citation 으로 이월된다", () => {
    const href = carryFilterParams(
      "/website/answer-analysis/mention",
      "/website/answer-analysis/citation",
      sp({ geography: "KR", language: "ko", engine: "chatgpt" }),
    );
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/website/answer-analysis/citation");
    expect(url.searchParams.get("geography")).toBe("KR");
    expect(url.searchParams.get("language")).toBe("ko");
    expect(url.searchParams.get("engine")).toBe("chatgpt");
  });

  it("Website: 인용 전용 축(source)은 언급으로 되돌아가지 않는다 (유령 필터 방지)", () => {
    const href = carryFilterParams(
      "/website/answer-analysis/citation",
      "/website/answer-analysis/mention",
      sp({ geography: "KR", source: "Owned" }),
    );
    const url = new URL(href, "http://x");
    expect(url.searchParams.get("geography")).toBe("KR");
    expect(url.searchParams.get("source")).toBeNull();
  });

  it("표준: language 축도 이월된다 (2026-09-03 신설 축이 매니페스트에 빠져 있었다)", () => {
    const href = carryFilterParams(
      "/dashboard",
      "/standard/answer-analysis/mention",
      sp({ language: "ko" }),
    );
    expect(new URL(href, "http://x").searchParams.get("language")).toBe("ko");
  });

  it("Website ↔ 표준은 서로 이월하지 않는다 — 지오 축의 값 공간이 다르다", () => {
    // website 는 사이트 국가(worldwide 같은 가상 코드 포함), 표준은 측정 로케일(실 ISO).
    expect(
      carryFilterParams(
        "/website/answer-analysis/mention",
        "/standard/answer-analysis/mention",
        sp({ geography: "worldwide" }),
      ),
    ).toBe("/standard/answer-analysis/mention");
  });
});
