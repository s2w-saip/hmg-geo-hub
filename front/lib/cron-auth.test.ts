import { afterEach, describe, expect, it } from "vitest";
import { requireCronSecret } from "./cron-auth";

const ORIGINAL = process.env.CRON_SECRET;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

function req(auth?: string) {
  return new Request("http://x/api/cron/x", auth ? { headers: { authorization: auth } } : undefined);
}

describe("requireCronSecret", () => {
  it("secret 미설정이면 503 으로 닫힌다 (fail-closed)", () => {
    delete process.env.CRON_SECRET;
    expect(requireCronSecret(req("Bearer anything"))?.status).toBe(503);
    expect(requireCronSecret(req())?.status).toBe(503);
  });
  it("secret 불일치·헤더 없음이면 401", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(requireCronSecret(req())?.status).toBe(401);
    expect(requireCronSecret(req("Bearer wrong"))?.status).toBe(401);
    expect(requireCronSecret(req("s3cret"))?.status).toBe(401);
  });
  it("일치하면 통과(null)", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(requireCronSecret(req("Bearer s3cret"))).toBeNull();
  });
});
