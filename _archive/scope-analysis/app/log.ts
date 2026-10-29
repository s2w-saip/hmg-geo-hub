// 구조화 로그 — stdout 한 줄 JSON. CloudWatch 로그 메트릭 필터가 파싱 대상이다.
//
// ⚠️ **시크릿·답변 본문을 필드에 넣지 않는다.** 답변 텍스트는 임의의 사용자 데이터이고,
//    로그에 실리면 그 자체로 유출 표면이 된다. 길이·해시까지만 남긴다.
//    (측정 lane `DeferredInfoV1.detail` 주석의 "시크릿·답변 본문 금지" 와 같은 규율.)
import type { LaneLogger } from "../worker/engine.ts";

export type LogLevel = "info" | "warn" | "error";

function emit(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log: LaneLogger & { emit: typeof emit } = {
  emit,
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
};

/** 예외를 로그 필드로. 스택은 첫 3줄만 — 전체는 노이즈이고 한 줄 JSON 을 깨뜨린다. */
export function errorFields(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    return {
      errorName: e.name,
      errorMessage: e.message.slice(0, 512),
      stack: (e.stack ?? "").split("\n").slice(0, 3).join(" | ").slice(0, 512),
    };
  }
  return { errorName: "unknown", errorMessage: String(e).slice(0, 512) };
}
