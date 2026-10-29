// 2026-08-24 커버리지 보강의 회귀 고정.
//
// 세 갈래를 함께 고정한다 — 셋 다 같은 고객 불만("인용 도메인 분류가 이상하다")에서 왔다.
//
//  Ⓐ HMG 자사 판정이 딜러 휴리스틱보다 먼저인가
//     `hyundaimotorgroup.com`(미러 27,640행)은 geo-catalog 정본 108 인벤토리에 없어
//     rules.ts 의 CONTAINED_BRAND 에 걸려 "딜러·마켓플레이스"로 나갔다.
//  Ⓑ 경쟁사 공식이 국가 도메인까지 잡히는가
//     COMPETITOR_OFFICIAL 은 정확일치 Set 이라 .com 만 가질 수 있었다 →
//     bmw.co.kr(1,529행)·lexus.co.kr(2,572)·mercedes-benz.co.kr(1,208)이 전부 Other.
//  Ⓒ KR·중동 매체가 사전에 있는가
//     seed 333개가 US 중심이라 yna.co.kr·danawa.com·syarah.com 등이 Other 였다.
//
// 근거 문서: (내부 설계 문서)
// (workspace KB). 행수는 hmg-geo 미러 scope_citations 실측(2026-08-24).

import { describe, it, expect } from "vitest";
import { categorizeDomain } from "./index";
import { registrableDomainOfHost } from "@/lib/public-suffix";

/** 실제 저장 경로와 같은 순서: 호스트 → registrable domain → 분류. */
function categorizeHost(host: string): string {
  return categorizeDomain(registrableDomainOfHost(host));
}

describe("Ⓐ HMG 공식 판정이 CONTAINED_BRAND 딜러 규칙보다 먼저다", () => {
  it.each([
    ["hyundaimotorgroup.com", "그룹 공식 · 미러 27,640행 · 종전 Dealer & Marketplace"],
    ["genesisnewsusa.com", "제네시스 뉴스룸 US · 종전 Dealer & Marketplace"],
    ["genesisnewseurope.com", "제네시스 뉴스룸 EU · 종전 Dealer & Marketplace"],
    ["genesisnews.ca", "제네시스 뉴스룸 CA · 종전 Dealer & Marketplace"],
    ["genesis-motors.com.au", "제네시스 호주 · 종전 Dealer & Marketplace"],
    ["hmc.co.kr", "현대자동차 · 종전 Other"],
    ["hyundai-rotem.co.kr", "현대로템 · 종전 Dealer & Marketplace"],
  ])("%s → Official (HMG) (%s)", (domain) => {
    expect(categorizeDomain(domain)).toBe("Official (HMG)");
  });

  // 브랜드명이 그대로 라벨인 국가 사이트는 규칙(rules.ts)이 잡는다 — seed 에 없어도.
  // 이 값들은 TWO_LEVEL_TLDS 절단으로 접미사만 남아 있던 바로 그 호스트다.
  it.each([
    "hyundai.com.mx",
    "hyundai.com.sg",
    "hyundai.com.ua",
    "hyundai.com.py",
    "hyundai.com.qa",
    "kia.com.kz",
    "kia.com.eg",
    "kia.co.nz",
    "genesis.com.pr",
    "genesis.com.vn",
  ])("%s → Official (HMG) (브랜드 라벨 정확일치)", (domain) => {
    expect(categorizeDomain(domain)).toBe("Official (HMG)");
  });

  it("딜러/판매사는 브랜드 라벨 규칙에 걸리지 않는다 (정확일치라서)", () => {
    expect(categorizeDomain("kiaofstreetsboro.com")).toBe("Dealer & Marketplace");
    expect(categorizeDomain("kellyhyundaiofhamburg.com")).toBe("Dealer & Marketplace");
    expect(categorizeDomain("wolfchasegenesis.com")).toBe("Dealer & Marketplace");
    // 커뮤니티 신호는 여전히 딜러보다 먼저다.
    expect(categorizeDomain("genesisowners.com")).toBe("Community & Forums");
    expect(categorizeDomain("kiaownersclub.co.uk")).toBe("Community & Forums");
  });

  it("'genesis'는 일반 영어 단어라 단일 라벨 TLD 에서는 자사로 보지 않는다", () => {
    // genesis.com 은 카탈로그 owned 라 별개 경로로 Official (HMG).
    expect(categorizeDomain("genesis.com")).toBe("Official (HMG)");
    // 그 외 제3자 도메인에서는 브랜드 라벨 규칙이 발화하지 않는다 — 자사 인용
    // 비중을 부풀리지 않는 것이 여기서 지켜야 할 불변식이다.
    expect(categorizeDomain("genesis.io")).not.toBe("Official (HMG)");
    expect(categorizeDomain("genesis.xyz")).not.toBe("Official (HMG)");
    // (참고) 이 둘은 여전히 CONTAINED_BRAND 로 Dealer & Marketplace 다 — 이 PR
    // 이전부터 그랬고 여기서 바꾸지 않았다. 오분류이긴 하나 오탐 방향이
    // "자사 과대계상"이 아니고, 교정 수단은 운영자 오버라이드다.
    expect(categorizeDomain("genesis.io")).toBe("Dealer & Marketplace");
  });
});

describe("Ⓑ 경쟁사 공식 — 국가 도메인", () => {
  it.each([
    "bmw.co.kr",
    "mercedes-benz.co.kr",
    "lexus.co.kr",
    "audi.co.kr",
    "toyota.co.kr",
    "toyota.ae",
    "toyota.com.eg",
    "bmw.de",
    "toyota.de",
    "renault.fr",
    "dacia.fr",
    "mazda.com.au",
    "volvocars.com.cn",
  ])("%s → Official (Competitor)", (domain) => {
    expect(categorizeDomain(domain)).toBe("Official (Competitor)");
  });

  it("경쟁사 딜러는 공식으로 승격되지 않는다", () => {
    expect(categorizeDomain("bmwofaustin.com")).toBe("Dealer & Marketplace");
    expect(categorizeDomain("toyotaofseattle.com")).toBe("Dealer & Marketplace");
  });

  it("서브호스트도 registrable domain 으로 접혀 같은 판정을 받는다", () => {
    expect(categorizeHost("certified.lexus.co.kr")).toBe("Official (Competitor)");
    expect(categorizeHost("newsroom.porsche.com")).toBe("Official (Competitor)");
  });
});

describe("Ⓒ KR·중동 매체 커버리지", () => {
  it.each([
    ["yna.co.kr", "News & Media"],
    ["newswire.co.kr", "News & Media"],
    ["hankyung.com", "News & Media"],
    ["mk.co.kr", "News & Media"],
    ["chosun.com", "News & Media"],
    ["donga.com", "News & Media"],
    ["edaily.co.kr", "News & Media"],
    ["daum.net", "News & Media"],
    ["nate.com", "News & Media"],
    ["danawa.com", "Automotive Media"],
    ["naver.com", "Automotive Media"],
    ["autoview.co.kr", "Automotive Media"],
    ["getcha.kr", "Dealer & Marketplace"],
    ["kbchachacha.com", "Dealer & Marketplace"],
    ["encar.com", "Dealer & Marketplace"],
    ["syarah.com", "Dealer & Marketplace"],
    ["dubicars.com", "Dealer & Marketplace"],
  ])("%s → %s", (domain, want) => {
    expect(categorizeDomain(domain)).toBe(want);
  });

  it("서브호스트 인용도 같은 카테고리로 접힌다", () => {
    // 사전은 호스트 단위였고 저장 컬럼은 registrable domain 이다 — 접힘 후에도 맞아야 한다.
    expect(categorizeHost("en.yna.co.kr")).toBe("News & Media");
    expect(categorizeHost("biz.chosun.com")).toBe("News & Media");
    expect(categorizeHost("car.naver.com")).toBe("Automotive Media");
    expect(categorizeHost("auto.danawa.com")).toBe("Automotive Media");
    expect(categorizeHost("v.daum.net")).toBe("News & Media");
  });

  it("정부·공공 접미사는 열거가 아니라 패턴이다", () => {
    expect(categorizeDomain("car365.go.kr")).toBe("Government & Public");
    expect(categorizeDomain("law.go.kr")).toBe("Government & Public");
    expect(categorizeDomain("gov.kr")).toBe("Government & Public");
    expect(categorizeHost("www.gov.br")).toBe("Government & Public");
    expect(categorizeDomain("transport.gov.uk")).toBe("Government & Public");
    expect(categorizeDomain("nhtsa.gov")).toBe("Government & Public");
    // 우연한 부분일치는 걸리지 않는다.
    expect(categorizeDomain("chicago.kr")).toBe("Other");
    expect(categorizeDomain("cargo.jp")).toBe("Other");
  });
});

// ── 교차감사 (2026-08-24) ──────────────────────────────────────────────────
//
// 사람이 만든 사전이 둘이다: 앤서 Quick-Win(513 호스트) · 고객 GGMD(593 호스트).
// 겹치는 252개 중 40건이 불일치했고, 교차하니 **양쪽 다 틀린 곳**이 드러났다.
// 최종 판정과 근거는 scripts/citations/dictionary-rulings.json 에 있다.
// 여기서는 그 판정이 실제 분류 결과로 나오는지를 고정한다.

describe("교차감사 — 고객 사전이 옳아 우리를 고친 것", () => {
  it.each([
    ["kbb.com", "Automotive Media", "시세·리뷰 발행이 본류 · 미러 13,961행"],
    ["thekoreancarblog.com", "Blogs & Reviews", "개인 블로그 · 2,877행"],
    ["topictree.co.kr", "News & Media", "929행"],
    ["adac.de", "Automotive Media", "ADAC 는 민간 자동차 클럽 — 우리가 정부·공공으로 잘못 넣었다 · 5,364행"],
    ["carnoon.co.kr", "Dealer & Marketplace", "인용이 전량 신차 견적·할인 · 699행"],
    ["carmodoo.com", "Automotive Media", "인용이 전량 /board?code=carnews"],
    ["newsmarket.com", "Official (HMG)", "미러 38/38 이 gmem.newsmarket.com"],
  ])("%s → %s (%s)", (domain, want) => {
    expect(categorizeDomain(domain)).toBe(want);
  });
});

describe("교차감사 — 고객 정부·공공 버킷 오분류 차단", () => {
  // 고객 사전의 정부·공공 477 인용 중 다수가 '.org·권위기관 = 공공' 착시였다.
  // 기준은 **소유 주체가 정부·공공기관인가** 하나다.
  it.each([
    ["jdpower.com", "민간 시장조사사 · 미러 18,165행 (최대 차단)"],
    ["red-dot.org", "독일 민간 디자인 어워드 · 842행"],
    ["idsa.org", "미국 산업디자이너협회(민간) · 220행"],
    ["gooddesignawards.org", "Chicago Athenaeum 민간 어워드 · 60행"],
    ["michelin.com", "민간 가이드/타이어 사업 · 128행"],
    ["cuhk.edu.hk", "학술기관"],
    ["hku.hk", "학술기관"],
    ["cityu.edu.hk", "학술기관"],
    ["researchgate.net", "민간 학술 네트워크"],
  ])("%s 는 Government & Public 이 아니다 (%s)", (domain) => {
    expect(categorizeDomain(domain)).not.toBe("Government & Public");
  });

  it("진짜 공공기관은 그대로 Government & Public 이다", () => {
    // 이름에 forum 이 들어갔다고 커뮤니티가 아니다 — 제주포럼은 공공 국제포럼이다.
    expect(categorizeDomain("jejuforum.or.kr")).toBe("Government & Public");
    expect(categorizeDomain("koreana.or.kr")).toBe("Government & Public");
    expect(categorizeDomain("korea.net")).toBe("Government & Public");
    expect(categorizeDomain("car365.go.kr")).toBe("Government & Public");
  });

  it("스토어·통계DB 는 커뮤니티가 아니다", () => {
    expect(categorizeDomain("steampowered.com")).not.toBe("Community & Forums");
    expect(categorizeDomain("steamdb.info")).not.toBe("Community & Forums");
    // 진짜 커뮤니티는 유지
    expect(categorizeDomain("reddit.com")).toBe("Community & Forums");
    expect(categorizeDomain("e34.od.ua")).toBe("Community & Forums");
  });

  it("포털·다품목 매체는 미러 실측 다수 호스트를 따른다", () => {
    // naver.com: car.naver.com 1,309 / 1,421 = 92.1% (고객은 딜러로 봤다)
    expect(categorizeDomain("naver.com")).toBe("Automotive Media");
    // consumerreports.org: 전 품목 소비자 매체 · 19,525행 (고객은 자동차 미디어로 봤다)
    expect(categorizeDomain("consumerreports.org")).toBe("Blogs & Reviews");
    // 언론사 자동차 섹션은 registrable domain 입도에서 표현 불가 —
    // car.chosun.com 78/1,046(7.5%) · evlounge.donga.com 32/425(7.5%) 로 일반 뉴스가 지배한다.
    expect(categorizeDomain("chosun.com")).toBe("News & Media");
    expect(categorizeDomain("donga.com")).toBe("News & Media");
  });
});

describe("교차감사 — 고객이 정확히 분리한 genesisof* 딜러 계열", () => {
  // 고객 사전이 이 계열 딜러를 전량 딜러·마켓플레이스로 정확히 분리했다.
  // 이 PR 이 고친 CONTAINED_BRAND 결함과 정확히 같은 지점이다 — 규칙(브랜드 접두)과
  // seed(고객 판정) 양쪽에서 딜러로 떨어지는지 함께 고정한다.
  it.each([
    "genesisofcolumbus.com",
    "genesisofconshohocken.com",
    "genesisofdowntownchicago.com",
    "genesisofedmond.com",
    "genesisoffairfieldct.com",
    "genesisoflakenorman.com",
    "genesisofwhiteplains.com",
    "genesisofcolumbiasc.com",
  ])("%s → Dealer & Marketplace", (domain) => {
    expect(categorizeDomain(domain)).toBe("Dealer & Marketplace");
  });

  it("같은 계열이지만 자사 자산은 딜러로 떨어지지 않는다", () => {
    expect(categorizeDomain("genesis.com")).toBe("Official (HMG)");
    expect(categorizeDomain("genesisnewsusa.com")).toBe("Official (HMG)");
    expect(categorizeDomain("genesis.com.pr")).toBe("Official (HMG)");
  });
});
