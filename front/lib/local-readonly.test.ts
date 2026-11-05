import { describe, expect, it } from "vitest";
import { localAllowedHost } from "./local-readonly";

describe("localAllowedHost — 로컬 조회 모드가 받는 접속 호스트", () => {
  it("설정이 없으면 루프백만 허용", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "::1"]) expect(localAllowedHost(h, {})).toBe(true);
    expect(localAllowedHost("10.0.20.132", {})).toBe(false);
  });

  it("HGH_LOCAL_ALLOWED_HOSTS 에 적은 호스트만 추가로 허용(쉼표·공백·대소문자 무시)", () => {
    const env = { HGH_LOCAL_ALLOWED_HOSTS: " 10.0.20.132 , Hub.Local " };
    expect(localAllowedHost("10.0.20.132", env)).toBe(true);
    expect(localAllowedHost("hub.local", env)).toBe(true);
    expect(localAllowedHost("10.0.20.133", env)).toBe(false);
    expect(localAllowedHost("localhost", env)).toBe(true);
  });

  it("빈 항목은 아무 호스트도 열지 않는다", () => {
    expect(localAllowedHost("", { HGH_LOCAL_ALLOWED_HOSTS: ",," })).toBe(false);
  });
});
