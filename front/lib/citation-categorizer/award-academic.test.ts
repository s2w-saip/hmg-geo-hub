import { describe, it, expect } from "vitest";
import { categorizeDomain } from "./index";
import { registrableDomainOfHost } from "@/lib/public-suffix";

/** 실제 저장 경로와 같은 순서: 호스트 → registrable domain → 분류 (coverage.test.ts 와 동일). */
const categorizeHost = (host: string) => categorizeDomain(registrableDomainOfHost(host));

// 2026-08-28 고객(이노션) 확정: 종전 "Government & Public" 하나에 정부기관과
// 수상·인증기관이 섞여 있었다. SCORE 의 "권위 기관(수상·인증·공공 등)" 단일 통합
// 제안은 기각되고 축을 셋으로 나누기로 했다 —
//   Government & Public   소유·운영 주체가 정부·공공 (엄격 기준 유지)
//   Award & Certification 수상·인증
//   Academic & Research   대학·논문·학계

describe("Award & Certification", () => {
  it.each(["red-dot.org", "red-dot.de", "ifdesign.com", "idsa.org", "worldcarawards.com"])(
    "%s → Award & Certification",
    (d) => expect(categorizeDomain(d)).toBe("Award & Certification"),
  );
});

describe("Academic & Research", () => {
  it.each(["mit.edu", "snu.ac.kr", "ox.ac.uk", "arxiv.org", "sciencedirect.com", "riss.kr"])(
    "%s → Academic & Research",
    (d) => expect(categorizeDomain(d)).toBe("Academic & Research"),
  );
  it("서브도메인도 같은 판정 (호스트 입력)", () => {
    expect(categorizeHost("www.arxiv.org")).toBe("Academic & Research");
  });
});

describe("공공 축의 기준은 '소유·운영 주체' — 신설 축이 이를 침범하지 않는다", () => {
  // 정부가 소유한 연구기관은 학술이 아니라 공공이다. 룰 순서(GOV 먼저)로 보장.
  it.each(["nih.gov", "nhtsa.gov", "korea.net", "mois.go.kr"])(
    "%s 는 Government & Public 을 유지한다",
    (d) => expect(categorizeDomain(d)).toBe("Government & Public"),
  );
});

// 분류 단위가 registrable domain 이라는 사실이 만드는 한계 — 룰로 풀 수 없고
// 운영자 오버라이드가 답이다. 고정해 두지 않으면 다음 사람이 룰에 넣는다.
describe("registrable domain 한계 — michelin 은 룰로 나눌 수 없다", () => {
  it("guide.michelin.com 은 michelin.com 으로 접힌다", () => {
    expect(registrableDomainOfHost("guide.michelin.com")).toBe("michelin.com");
  });
  it("그래서 룰이 michelin 을 수상·인증으로 끌고 가지 않는다", () => {
    expect(categorizeDomain("michelin.com")).not.toBe("Award & Certification");
  });
});

describe("고객이 지목한 민간 출처는 더 이상 Government & Public 이 아니다", () => {
  it.each(["red-dot.org", "idsa.org"])("%s", (d) =>
    expect(categorizeDomain(d)).not.toBe("Government & Public"),
  );
});
