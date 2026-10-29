// `@/lib/log` shim — 벤더 코드의 구조적 로그를 **lane 로거로 흘려보낸다**.
//
// ── 왜 코어 `lib/log/*` 를 벤더하지 않나
//
//   벤더 그래프를 esbuild 로 뽑으면 `lib/log` 하위 **13 모듈**이 딸려 온다
//   (helpers·sink·spill·ring-buffer·request-context·src-capture·op-p95.json …).
//   그것은 분석 로직이 아니라 **코어 운영 인프라**다 — 파일 스필(`node:fs`)·
//   AsyncLocalStorage 트레이스·링버퍼를 lane 컨테이너에서 돌릴 이유가 없고, lane 은 이미
//   자기 로거(`app/log.ts`, stdout 한 줄 JSON)를 갖고 있다.
//
//   그래서 여기는 **경로 alias 로 받는 얇은 어댑터**다(소스 텍스트 무수정 원칙은 그대로).
//
// ── 이 shim 이 반드시 지켜야 하는 것: 이벤트 이름
//
//   벤더 코드가 내는 이벤트는 둘뿐이고(`llm.ts:265`·`:748`) 둘 다
//   `measurement_analysis.*.catalog_projection` 이다. 이 이름은 운영 대시보드·알람의
//   계약이므로 **한 글자도 바꾸지 않는다**(코어 추출 리팩터 플랜 §5 R-4 와 같은 규율).
//   여기서 접두사를 붙이거나 rename 하면 코어 쪽 메트릭 필터가 조용히 0건이 된다.
//
// ⚠️ 벤더가 아니라 **lane 소유 파일**이다(핀 대상 아님).
// ⚠️ `log.info` 외의 메서드는 벤더 집합이 지금 쓰지 않는다. 그래도 남겨 두는 이유는,
//    재동기 때 코어가 `log.warn` 을 하나 추가하면 **여기가 없어서 typecheck 가 깨지는 것**이
//    "새 로그가 생겼다"의 유일한 신호이기 때문이다 — 조용히 삼키는 no-op 을 두지 않는다.
import { log as laneLog } from "../../../app/log.ts";

type Fields = Record<string, unknown>;

export const log = {
  info: (event: string, fields: Fields = {}): void => laneLog.info(event, fields),
  warn: (event: string, fields: Fields = {}): void => laneLog.warn(event, fields),
  error: (event: string, fields: Fields = {}): void => laneLog.error(event, fields),
  debug: (event: string, fields: Fields = {}): void => laneLog.info(event, { ...fields, level_hint: "debug" }),
};
