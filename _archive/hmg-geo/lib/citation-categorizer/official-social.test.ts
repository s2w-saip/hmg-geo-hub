import { describe, it, expect } from "vitest";
import {
  OFFICIAL_SOCIAL_ACCOUNTS,
  citationGroupKey,
  citationPathKeyOf,
  isOfficialSocialKey,
  officialSocialKeyOf,
} from "./official-social";
import { categorizeDomain, resolveCitationCategory } from "./index";

// 공식 HMG 소셜 계정 그룹 키 — 경계 앵커가 이 모듈의 계약이다.
// 고객(SCORE) 매핑 파일의 원래 매칭은 "URL 포함"(부분문자열)이었고, 그대로 쓰면
// `instagram.com/hyundai` 가 hyundaiindia·hyundaicolombia 같은 남의 계정을
// 쓸어간다(2026-08-28 프로덕션 실측: 부분문자열 192건 vs 앵커 26건).

describe("citationPathKeyOf — 정규화 (SQL 쌍둥이와 문자 단위 일치)", () => {
  it("scheme 과 호스트를 버리고 미러의 registrable domain 을 앞에 붙인다", () => {
    expect(citationPathKeyOf("linkedin.com", "https://www.linkedin.com/company/x")).toBe(
      "linkedin.com/company/x",
    );
  });

  it("서브도메인을 접는다 — kr./m./de. 가 www 와 같은 키가 된다", () => {
    const urls = [
      "https://www.linkedin.com/company/hyundai-motor-group",
      "https://kr.linkedin.com/company/hyundai-motor-group",
      "http://de.linkedin.com/company/hyundai-motor-group",
    ];
    const keys = new Set(urls.map((u) => citationPathKeyOf("linkedin.com", u)));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("linkedin.com/company/hyundai-motor-group");
  });

  it("쿼리·프래그먼트를 자른다 (그래서 경계 문자는 '/' 와 끝뿐)", () => {
    expect(citationPathKeyOf("instagram.com", "https://instagram.com/hyundai?hl=ko")).toBe(
      "instagram.com/hyundai",
    );
    expect(citationPathKeyOf("instagram.com", "https://instagram.com/hyundai#feed")).toBe(
      "instagram.com/hyundai",
    );
  });

  it("%40 을 @ 로 되돌린다 (Threads 가 인코딩해 보낸다)", () => {
    expect(citationPathKeyOf("threads.com", "https://www.threads.com/%40genesis_usa/post/A")).toBe(
      "threads.com/@genesis_usa/post/a",
    );
  });

  it("대소문자를 접고, 경로 없는 URL 은 도메인만 남긴다", () => {
    expect(citationPathKeyOf("facebook.com", "HTTPS://WWW.FACEBOOK.COM/HyundaiMotorGroupTV")).toBe(
      "facebook.com/hyundaimotorgrouptv",
    );
    expect(citationPathKeyOf("facebook.com", "https://facebook.com")).toBe("facebook.com");
  });
});

describe("officialSocialKeyOf — 경계 앵커", () => {
  it("정확히 그 계정만 잡는다 (instagram.com/hyundai)", () => {
    expect(officialSocialKeyOf("instagram.com", "https://instagram.com/hyundai")).toBe(
      "instagram.com/hyundai",
    );
    expect(officialSocialKeyOf("instagram.com", "https://instagram.com/hyundai/")).toBe(
      "instagram.com/hyundai",
    );
    expect(officialSocialKeyOf("instagram.com", "https://instagram.com/hyundai/p/ABC")).toBe(
      "instagram.com/hyundai",
    );
    expect(officialSocialKeyOf("instagram.com", "https://instagram.com/hyundai?hl=ko")).toBe(
      "instagram.com/hyundai",
    );
  });

  it("프리픽스를 공유하는 남의 계정은 잡지 않는다 (부분문자열 매칭 금지)", () => {
    for (const handle of [
      "hyundaiindia",
      "hyundaicolombia",
      "hyundaimalaysiaofficial",
      "hyundai_usa",
      "hyundai-worldwide",
    ]) {
      expect(officialSocialKeyOf("instagram.com", `https://instagram.com/${handle}`)).toBeNull();
    }
  });

  it("LinkedIn 은 /company/ 와 /posts/<handle>_ 를 한 계정으로 접는다", () => {
    expect(
      officialSocialKeyOf("linkedin.com", "https://www.linkedin.com/company/hyundai-motor-group"),
    ).toBe("linkedin.com/hyundai-motor-group");
    expect(
      officialSocialKeyOf(
        "linkedin.com",
        "https://www.linkedin.com/posts/hyundai-motor-group_hyundai-x-dave-the-diver-activity-123",
      ),
    ).toBe("linkedin.com/hyundai-motor-group");
  });

  it("/posts/ 는 핸들 뒤 '_' 가 경계다 — 다른 핸들로 새지 않는다", () => {
    expect(
      officialSocialKeyOf("linkedin.com", "https://www.linkedin.com/posts/hyundai-motor-group-x_abc"),
    ).toBeNull();
    expect(
      officialSocialKeyOf("linkedin.com", "https://www.linkedin.com/company/hyundai-motor-group-uk"),
    ).toBeNull();
  });

  it("목록 밖 도메인은 즉시 null (경로를 보지 않는다)", () => {
    expect(officialSocialKeyOf("example.com", "https://example.com/hyundai")).toBeNull();
  });
});

describe("citationGroupKey — 비-공식 인용은 종전 그대로 도메인으로 접힌다", () => {
  // 실데이터에 존재하는 회귀 표본 (2026-08-28 미러 확인).
  const regressions: Array<[string, string]> = [
    ["facebook.com", "https://www.facebook.com/Autoblog/posts/hyundai-ioniq-5-review-123"],
    ["linkedin.com", "https://www.linkedin.com/pulse/hyundai-motor-group-strategy-abc"],
    ["instagram.com", "https://www.instagram.com/popular/hyundai"],
    ["youtube.com", "https://www.youtube.com/watch?v=abc123"],
    ["threads.com", "https://www.threads.com/%40alexandr.chaiko/post/DYjMD2OjRSi"],
  ];

  it("그룹 키가 registrable domain 그대로다", () => {
    for (const [domain, url] of regressions) {
      expect(citationGroupKey(domain, url)).toBe(domain);
    }
  });

  it("분류가 Official (HMG) 로 바뀌지 않는다", () => {
    for (const [domain, url] of regressions) {
      const key = citationGroupKey(domain, url);
      expect(categorizeDomain(key)).not.toBe("Official (HMG)");
    }
  });

  it("소셜 플랫폼 도메인 자체는 Social & Video 를 유지한다", () => {
    for (const d of ["facebook.com", "linkedin.com", "instagram.com", "youtube.com"]) {
      expect(categorizeDomain(d)).toBe("Social & Video");
    }
  });
});

describe("분류기 — 그룹 키가 Official (HMG) 로 판정된다", () => {
  it("모든 공식 계정 키가 Official (HMG)", () => {
    for (const acc of OFFICIAL_SOCIAL_ACCOUNTS) {
      expect(isOfficialSocialKey(acc.key)).toBe(true);
      expect(categorizeDomain(acc.key)).toBe("Official (HMG)");
      expect(resolveCitationCategory(null, acc.key)).toBe("Official (HMG)");
    }
  });

  it("행 단위 engine category 가 있어도 공식 계정 판정이 이긴다", () => {
    // 미러 실데이터에서는 해당 995행의 category 가 전부 NULL 이라 동작 변화가
    // 없지만(2026-08-28 실측), 계약으로 고정해 둔다.
    expect(resolveCitationCategory("Social & Video", "linkedin.com/hyundai-motor-group")).toBe(
      "Official (HMG)",
    );
  });

  it("키 대소문자를 접는다 (SQL 은 표기용 대소문자를 그대로 낸다)", () => {
    expect(categorizeDomain("FACEBOOK.COM/HyundaiMotorGroupNewsroom")).toBe("Official (HMG)");
  });

  it("계정이 아닌 같은 도메인 행은 영향을 받지 않는다", () => {
    expect(isOfficialSocialKey("linkedin.com")).toBe(false);
    expect(categorizeDomain("linkedin.com")).toBe("Social & Video");
  });
});

describe("목록 자체의 위생", () => {
  it("그룹 키가 유일하고 '/' 를 포함한다 (registrable domain 과 충돌 불가)", () => {
    const keys = OFFICIAL_SOCIAL_ACCOUNTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toContain("/");
  });

  it("모든 매처 프리픽스가 소문자이고 자기 도메인으로 시작한다", () => {
    for (const acc of OFFICIAL_SOCIAL_ACCOUNTS) {
      expect(acc.matchers.length).toBeGreaterThan(0);
      for (const m of acc.matchers) {
        expect(m.prefix).toBe(m.prefix.toLowerCase());
        expect(m.prefix.startsWith(`${acc.domain}/`)).toBe(true);
      }
    }
  });
});
