import { describe, expect, it } from "vitest";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import { WEBSITE_PROMPT_SORT_KEYS } from "./website-sites";

// /website/prompts 는 sort/dir/page/q 를 URL 에서 받는다. 정렬 키는 SQL 조각으로
// 바뀌므로 화이트리스트가 클라이언트 입력과 SQL 사이의 전부다 — 목록이 열려도
// 조용히 틀린 순서로 뜰 뿐이라 눈에 안 띈다.
describe("WEBSITE_PROMPT_SORT_KEYS", () => {
  it("행 축과 렌즈 축을 모두 정렬할 수 있다", () => {
    // 사용자가 요구한 디멘션(브랜드·국가·언어)과 렌즈 컬럼(측정 횟수·최근 측정)이
    // 전부 정렬 가능해야 한다.
    expect(WEBSITE_PROMPT_SORT_KEYS).toContain("brand");
    expect(WEBSITE_PROMPT_SORT_KEYS).toContain("country");
    expect(WEBSITE_PROMPT_SORT_KEYS).toContain("lang");
    expect(WEBSITE_PROMPT_SORT_KEYS).toContain("answers");
    expect(WEBSITE_PROMPT_SORT_KEYS).toContain("lastMeasuredAt");
  });

  it("SQL 식별자로 해석될 수 있는 키가 없다 (화이트리스트 자체가 안전한 형태)", () => {
    for (const k of WEBSITE_PROMPT_SORT_KEYS) {
      expect(k).toMatch(/^[a-zA-Z]+$/);
    }
  });
});

// nav 라벨/화면 문구가 한쪽 로케일에만 있으면 그 로케일에서 원시 키가 노출된다.
// check:strings 는 JSX 안의 한글만 잡지 —— 빠진 키는 못 잡는다.
describe("website.prompts i18n", () => {
  // JSON import 는 TS 가 리터럴 타입을 추론한다 — 캐스팅 없이 그대로 쓴다.
  // (키가 사라지면 여기서 타입 에러로도 잡힌다.)
  const koPrompts = ko.website.prompts;
  const enPrompts = en.website.prompts;

  it("ko/en 의 키 집합이 정확히 같다", () => {
    expect(Object.keys(koPrompts).sort()).toEqual(Object.keys(enPrompts).sort());
  });

  it("nav.websitePrompts 가 양쪽 로케일에 있다", () => {
    expect(ko.nav.websitePrompts).toBeTruthy();
    expect(en.nav.websitePrompts).toBeTruthy();
  });

  it("테이블이 쓰는 키가 빠짐없이 있다", () => {
    // prompt-table.tsx 가 실제로 t() 하는 키들 — 하나라도 빠지면 그 셀에 원시
    // 키 문자열이 그대로 렌더된다.
    const used = [
      "promptLabel",
      "brandLabel",
      "countryLabel",
      "langLabel",
      "targetUrlLabel",
      "answersLabel",
      "lastMeasuredLabel",
      "enginesLabel",
      "searchPlaceholder",
      "lensTitle",
      "lensHint",
      "notMeasured",
      "empty",
      "emptyHint",
      "pageOf",
      "prev",
      "next",
      "rangeLabel",
      "title",
      "subtitle",
    ];
    for (const k of used) {
      expect(koPrompts, `ko.website.prompts.${k}`).toHaveProperty(k);
      expect(enPrompts, `en.website.prompts.${k}`).toHaveProperty(k);
    }
    // 위 목록 자체가 낡는 걸 막는다 — 사전에 키를 추가하고 여기 안 넣으면
    // 이 테스트는 통과하면서 아무것도 안 지킨다.
    expect(Object.keys(koPrompts).sort()).toEqual([...used].sort());
  });

  it("렌즈 안내 문구가 '거르지 않는다'는 핵심을 담고 있다", () => {
    // 이 문장이 없거나 뜻이 뒤집히면 엔진·기간을 걸어도 9,569행 그대로인 게
    // 버그로 읽힌다 — 화면 의미의 전제라 문구 자체를 고정한다.
    expect(koPrompts.lensHint).toContain("거르지 않습니다");
    expect(enPrompts.lensHint).toContain("do not filter");
  });
});
