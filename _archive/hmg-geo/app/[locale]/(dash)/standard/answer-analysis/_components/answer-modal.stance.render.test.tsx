import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import { StanceTags, type AnswerStanceTag } from "./answer-modal";

// 답변 단위 브랜드 스탠스 태그(0072 · WU8 ①)의 렌더 계약.
//
// 고정하는 것 셋:
//   ① **축이 화면에 표기된다** — 밑줄(발생 단위)과 태그(답변 단위)는 같은 4어휘를
//      쓰므로, 축 문구가 없으면 "같은 지표의 다른 값"으로 읽힌다(스펙 R6 · AC4).
//   ② **원문 대조된 인용만 원문으로 연결**한다. 파일럿 실측에서 모델이 낸 인용의
//      79.2% 만 완전일치했고 8.6% 는 불일치였다 — 대조 안 된 인용을 원문인 양 보이면
//      사용자가 답변에서 찾을 수 없는 문장을 읽게 된다(FR4).
//   ③ 기존 밑줄·범례 배선은 **무변경**(AC7) — 소스 대조로 고정한다.
const SRC = readFileSync(
  path.join(process.cwd(), "app/[locale]/(dash)/standard/answer-analysis/_components/answer-modal.tsx"),
  "utf8",
);

const RAW_KEY = /answerAnalysis\.mentions\./;

function render(node: React.ReactNode, locale: "ko" | "en" = "ko") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

const OWN: AnswerStanceTag = {
  turnIndex: 0,
  entityId: "e-hyundai",
  brand: "Hyundai",
  tracked: true,
  stance: "mixed",
  confidence: 0.82,
  evidenceText: "품질 우려가 함께 지적된다",
  evidenceMatch: "verified",
  reason: "장점과 품질 우려가 함께 제시됨",
};
const RIVAL: AnswerStanceTag = {
  turnIndex: 0,
  entityId: "e-toyota",
  brand: "Toyota",
  tracked: false,
  stance: "positive",
  confidence: 0.6,
  evidenceText: "신뢰성이 뛰어나다",
  evidenceMatch: "mismatch",
  reason: "장점만 제시됨",
};

describe("StanceTags — 답변 단위 브랜드 스탠스 태그", () => {
  it.each(["ko", "en"] as const)("브랜드·스탠스·축 문구가 나오고 원시 키가 없다 (%s)", (locale) => {
    const msgs = locale === "ko" ? ko : en;
    const html = render(<StanceTags stances={[OWN, RIVAL]} />, locale);
    expect(html).not.toMatch(RAW_KEY);
    const s = msgs.answerAnalysis.mentions.answerModal.stance;
    expect(html).toContain(s.tagTitle);
    // ① 축 표기 — 밑줄(발생)과 다른 축임을 화면이 말한다.
    expect(html).toContain(s.axisNote);
    expect(html).toContain("Hyundai");
    expect(html).toContain("Toyota");
    expect(html).toContain(s.label.mixed);
    expect(html).toContain(s.label.positive);
    // 당사 배지는 tracked 행에만.
    expect(html).toContain(s.own);
  });

  it("세 상태가 서로 다른 문구다 — 확인됨 / 불일치 / 대조 불가 (F5)", () => {
    const s = ko.answerAnalysis.mentions.answerModal.stance;
    const verified = render(<StanceTags stances={[OWN, RIVAL]} initialOpenId="0:e-hyundai" />);
    expect(verified).toContain(OWN.evidenceText!);
    expect(verified).toContain(s.evidenceVerified);
    expect(verified).not.toContain(s.evidenceMismatch);

    // 불일치 — 인용문은 보여주되 **원문 위치를 주장하지 않는다**.
    const mismatch = render(<StanceTags stances={[OWN, RIVAL]} initialOpenId="0:e-toyota" />);
    expect(mismatch).toContain(RIVAL.evidenceText!);
    expect(mismatch).toContain(s.evidenceMismatch);
    expect(mismatch).not.toContain(s.evidenceVerified);

    // 대조 불가(turn>0 등) — "코어가 환각했다"와 구분되는 별도 문구.
    const na: AnswerStanceTag = { ...RIVAL, turnIndex: 1, evidenceMatch: "unavailable" };
    const unavailable = render(<StanceTags stances={[OWN, na]} initialOpenId="1:e-toyota" />);
    expect(unavailable).toContain(s.evidenceUnavailable);
    expect(unavailable).not.toContain(s.evidenceMismatch);
    expect(unavailable).not.toContain(s.evidenceVerified);
  });

  it("근거 패널은 기본 닫힘 — 태그 줄만 나온다", () => {
    const html = render(<StanceTags stances={[OWN]} />);
    expect(html).not.toContain(ko.answerAnalysis.mentions.answerModal.stance.evidenceTitle);
  });

  it("스탠스가 없으면 모달이 줄 자체를 그리지 않는다 (발생 감성으로 대체하지 않는다)", () => {
    // 조건부 렌더 배선을 소스로 고정한다 — 값이 아니라 **키의 부재**가 판정이다.
    expect(SRC).toMatch(/body\.detail\.stances\?\.length \? \(\s*<StanceTags/);
    // 스탠스 없음을 발생 감성(spans)으로 채우는 경로가 없다.
    expect(SRC).not.toMatch(/stances[^\n]*sentiment\?\.spans/);
  });

  // ── 2턴 답변 (검증자 F1) ────────────────────────────────────────────────
  // 라이브 8.2%(52,698/642,521)가 2턴이다. 브랜드만으로 키를 잡으면 그 답변들에서
  // React key 가 충돌하고 근거 패널이 두 개 동시에 열린다.
  it("같은 브랜드가 두 턴에 있으면 턴 라벨로 구분되고 키가 충돌하지 않는다", () => {
    const t2: AnswerStanceTag = {
      ...OWN, turnIndex: 1, stance: "negative", reason: "후속 선택에서 제외됨",
      evidenceMatch: "unavailable",
    };
    const html = render(<StanceTags stances={[OWN, t2]} />);
    const s = ko.answerAnalysis.mentions.answerModal.stance;
    // 턴이 둘이면 턴 헤더가 붙는다.
    expect(html).toContain(s.turn.replace("{n}", "1"));
    expect(html).toContain(s.turn.replace("{n}", "2"));
    // 같은 브랜드가 두 번 나오되 스탠스가 각자다.
    expect(html.match(/Hyundai/g)?.length).toBe(2);
    expect(html).toContain(s.label.mixed);
    expect(html).toContain(s.label.negative);
  });

  it("턴이 하나면 턴 헤더를 달지 않는다 (대다수 답변)", () => {
    const html = render(<StanceTags stances={[OWN, RIVAL]} />);
    expect(html).not.toContain(ko.answerAnalysis.mentions.answerModal.stance.turn.replace("{n}", "1"));
  });

  it("근거 패널은 (턴, 브랜드) 하나만 열린다", () => {
    const t2: AnswerStanceTag = {
      ...OWN, turnIndex: 1, stance: "negative", evidenceMatch: "unavailable",
      evidenceText: "후속 질문에서는 선택되지 않았다", reason: "후속 선택에서 제외됨",
    };
    const html = render(<StanceTags stances={[OWN, t2]} initialOpenId="1:e-hyundai" />);
    expect(html).toContain(t2.evidenceText!);
    expect(html).not.toContain(OWN.evidenceText!);
  });

  it("AC7 — 기존 밑줄·범례 배선은 무변경", () => {
    expect(SRC).toContain('useState<Set<Sentiment>>(new Set(["positive", "negative", "mixed"]))');
    expect(SRC).toMatch(/sentimentSpans=\{body\.detail\.sentiment\?\.spans/);
    expect(SRC).toContain("onSentimentUnpainted=");
  });
});
