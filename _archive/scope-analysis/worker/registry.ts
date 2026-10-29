// 엔진 선택. `ANALYSIS_ENGINE` 로 고른다 — 측정 lane 의 `MEASURE_EXECUTOR=stub|camoufox` 와 같은 자리.
//
// ⚠️ **조용한 폴백을 두지 않는다.** 미구현·오타를 stub 으로 떨어뜨리면 라이브에서
//    "분석이 도는데 멘션이 0건" 이라는 가장 나쁜 형태로 나타난다(측정 lane 의 Success 위장
//    전례들과 같은 실패 모드). 모르는 값은 **기동 시점에 명시적으로 죽는다**.
//
// G3-2: `core` 가 이제 실제 엔진이다 — `packages/analysis-core/vendor` 의 순수 분석 코드를
// `worker/engines/core-engine.ts` 가 티켓 계약에 물린다.
import { readFileSync } from "node:fs";

import type { AnalysisEngine } from "./engine.ts";
import { createStubAnalysisEngine } from "./engine.ts";
import { createCoreAnalysisEngine } from "./engines/core-engine.ts";

interface PinFileShape {
  coreSha: string;
}

/**
 * 벤더 핀의 코어 SHA. **이것이 곧 `@scope/analysis-core` 의 버전**이다(패키지화 전 단계라
 * 버전 번호 대신 바이트의 출처를 쓴다 — 스펙 §6.1 "런타임 관측(비차단)").
 *
 * 읽기 실패는 **죽는다**. reply 의 `laneRevision` 이 "어느 순수 코드로 돌았나"의 유일한
 * 관측축이고, 그것이 빈 문자열이면 코어의 스큐 경고가 영원히 발화하지 않는다.
 */
function analysisCoreRevision(): string {
  const url = new URL("../packages/analysis-core/ANALYSIS_CORE_PIN.json", import.meta.url);
  const pin = JSON.parse(readFileSync(url, "utf8")) as PinFileShape;
  if (typeof pin.coreSha !== "string" || pin.coreSha.length < 7) {
    throw new Error(`ANALYSIS_CORE_PIN.json has no usable coreSha — 벤더 핀이 깨졌다`);
  }
  return `analysis-core@${pin.coreSha.slice(0, 12)}`;
}

export function resolveEngine(kind: string, revision: string): AnalysisEngine {
  switch (kind) {
    case "stub":
      return createStubAnalysisEngine(revision === "0.0.0-dev" ? "stub-0" : revision);
    case "core": {
      // lane 배포 리비전과 순수 코드 리비전은 **다른 축**이다. 둘 다 실어 보낸다 —
      // 코어가 스큐를 볼 때 필요한 것은 뒤쪽이고, 배포 추적에 필요한 것은 앞쪽이다.
      const core = analysisCoreRevision();
      return createCoreAnalysisEngine({ revision: revision === "0.0.0-dev" ? core : `${revision}+${core}` });
    }
    default:
      throw new Error(`unknown ANALYSIS_ENGINE=${JSON.stringify(kind)} (expected: stub | core)`);
  }
}
