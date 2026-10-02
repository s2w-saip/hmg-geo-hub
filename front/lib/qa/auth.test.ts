import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  signReviewerCookie,
  verifyReviewerCookie,
  qaEnabled,
  checkPassword,
  normalizeReviewerName,
  hashIp,
  QA_MAX_AGE_MS,
  readSessionIdUnverified,
} from "./auth";

const ENV = { ...process.env };
beforeEach(() => {
  process.env.RAW_DATA_QA_SECRET = "test-secret";
  process.env.RAW_DATA_QA_ENABLED = "1";
  delete process.env.RAW_DATA_QA_PASSWORD;
});
afterEach(() => {
  process.env = { ...ENV };
});

const reviewer = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  name: "홍길동",
  issuedAt: 1_000_000,
};

describe("검수자 쿠키", () => {
  it("서명 왕복", () => {
    expect(verifyReviewerCookie(signReviewerCookie(reviewer), 1_000_100)).toEqual(reviewer);
  });

  it("서명이 변조되면 거부한다", () => {
    const [payload] = signReviewerCookie(reviewer).split(".");
    expect(verifyReviewerCookie(`${payload}.deadbeef`, 1_000_100)).toBeNull();
  });

  it("페이로드가 변조되면 거부한다 — 이름 위조 방어", () => {
    const [, sig] = signReviewerCookie(reviewer).split(".");
    const forged = Buffer.from(JSON.stringify({ ...reviewer, name: "관리자" })).toString(
      "base64url",
    );
    expect(verifyReviewerCookie(`${forged}.${sig}`, 1_000_100)).toBeNull();
  });

  it("12시간을 넘기면 거부한다", () => {
    const token = signReviewerCookie(reviewer);
    expect(verifyReviewerCookie(token, reviewer.issuedAt + QA_MAX_AGE_MS - 1)).not.toBeNull();
    expect(verifyReviewerCookie(token, reviewer.issuedAt + QA_MAX_AGE_MS + 1)).toBeNull();
  });

  it("빈 쿠키 / 형식 불량은 거부한다", () => {
    expect(verifyReviewerCookie(undefined)).toBeNull();
    expect(verifyReviewerCookie("")).toBeNull();
    expect(verifyReviewerCookie("nodot")).toBeNull();
    expect(verifyReviewerCookie("a.b.c")).toBeNull();
  });

  it("다른 시크릿으로 서명된 쿠키는 거부한다", () => {
    const token = signReviewerCookie(reviewer);
    process.env.RAW_DATA_QA_SECRET = "other-secret";
    expect(verifyReviewerCookie(token, 1_000_100)).toBeNull();
  });
});

describe("비밀번호", () => {
  it("기본값은 qa-default-redacted", () => {
    expect(checkPassword("qa-default-redacted")).toBe(true);
    expect(checkPassword("hmg2025")).toBe(false);
  });

  it("env 로 덮어쓸 수 있다", () => {
    process.env.RAW_DATA_QA_PASSWORD = "다른비번";
    expect(checkPassword("다른비번")).toBe(true);
    expect(checkPassword("qa-default-redacted")).toBe(false);
  });

  it("길이가 달라도 예외를 던지지 않는다 (timingSafeEqual 방어)", () => {
    expect(() => checkPassword("")).not.toThrow();
    expect(checkPassword("")).toBe(false);
    expect(checkPassword("x".repeat(500))).toBe(false);
  });
});

describe("킬 스위치", () => {
  it('RAW_DATA_QA_ENABLED 가 "1" 일 때만 켜진다', () => {
    expect(qaEnabled()).toBe(true);
    process.env.RAW_DATA_QA_ENABLED = "0";
    expect(qaEnabled()).toBe(false);
    delete process.env.RAW_DATA_QA_ENABLED;
    expect(qaEnabled()).toBe(false);
  });
});

describe("검수자 이름", () => {
  it("앞뒤 공백을 제거한다", () => {
    expect(normalizeReviewerName("  홍길동 ")).toBe("홍길동");
  });
  it("빈 값 / 공백만 / 40자 초과 / 비문자열은 거부한다", () => {
    expect(normalizeReviewerName("")).toBeNull();
    expect(normalizeReviewerName("   ")).toBeNull();
    expect(normalizeReviewerName("가".repeat(41))).toBeNull();
    expect(normalizeReviewerName(42)).toBeNull();
    expect(normalizeReviewerName(null)).toBeNull();
  });
  it("제어문자를 제거한다 — 로그·화면에 깨진 이름이 들어가지 않게", () => {
    expect(normalizeReviewerName("홍\u0000길동")).toBe("홍길동");
    expect(normalizeReviewerName("줄\n바꿈")).toBe("줄바꿈");
  });
});

describe("IP 해시", () => {
  it("원문을 담지 않고 같은 입력은 같은 해시", () => {
    const h = hashIp("203.0.113.7");
    expect(h).not.toContain("203.0.113.7");
    expect(h).toBe(hashIp("203.0.113.7"));
    expect(h).not.toBe(hashIp("203.0.113.8"));
  });
  it("null 은 null", () => {
    expect(hashIp(null)).toBeNull();
  });
});

// U12 API 원천 로그아웃: PATCH /v1/qa/sessions/{session_id} 의 id 를 쿠키 payload 에서 읽는다.
// 검증은 백엔드 몫이라 서명은 보지 않지만, UUID 가 아니면 경로에 싣지 않는다.
describe("쿠키 payload 의 sessionId (검증 없이 읽기)", () => {
  it("서명과 무관하게 payload 의 sessionId 를 읽는다", () => {
    const [payload] = signReviewerCookie(reviewer).split(".");
    expect(readSessionIdUnverified(signReviewerCookie(reviewer))).toBe(reviewer.sessionId);
    expect(readSessionIdUnverified(`${payload}.anything`)).toBe(reviewer.sessionId);
  });

  it("UUID 가 아니거나 형식이 깨지면 null", () => {
    const bad = (o: unknown) => `${Buffer.from(JSON.stringify(o)).toString("base64url")}.sig`;
    expect(readSessionIdUnverified(bad({ sessionId: "../x" }))).toBeNull();
    expect(readSessionIdUnverified(bad({ sessionId: 1 }))).toBeNull();
    expect(readSessionIdUnverified("not-base64-json.sig")).toBeNull();
    expect(readSessionIdUnverified("")).toBeNull();
    expect(readSessionIdUnverified(null)).toBeNull();
  });
});
