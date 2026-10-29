// 순수 분석 계층이 바깥 세계에 요구하는 것 — LLM 태스크 3종과 구조적 로거뿐이다.
//
// 이 파일이 존재하는 이유: `pure/` 가 `../llm` 을 **값으로** import 하면
// `llm.ts:2` → `@/lib/llm/invoke` → `lib/llm/cost.ts` → `@/lib/db` + `@/db/schema`
// 로 이어져(플랜 §1.3 L1·L3) 순수 격리가 한 홉 만에 깨진다. 그래서 여기서는
// `import type` 만 쓰고, 실제 함수는 호출자가 주입한다.
//
// 입력 타입 3종은 `store.ts` 의 `AnalyzeRunOptions`(:128~162) 주입 파라미터를
// 구조 그대로 옮긴 것이다 — 구조가 같아야 코어 어댑터가 기존 기본값
// (`extractMentionsWithLlm` 등)을 무수정으로 꽂을 수 있다.
import type {
  AnswerBrandStanceResult,
  MentionExtractionResult,
  MentionSemanticsResult,
  MentionSemanticsV2Mention,
  MentionSemanticsV2Result,
  PendingMentionResolutionResult,
} from "../llm";
import type { MeasurementMention, OntologyCatalogEntity } from "../schema";

export interface MentionExtractionInput {
  promptText?: string | null;
  answerText: string;
  turnIndex: number;
  catalog: OntologyCatalogEntity[];
  industryName?: string | null;
}

export interface PendingMentionResolutionInput {
  promptText?: string | null;
  answerText: string;
  turnIndex: number;
  catalog: OntologyCatalogEntity[];
  industryName?: string | null;
  pendingMentions: Array<{
    index: number;
    surfaceText: string;
    entityType?: MeasurementMention["entityType"];
    canonicalGuess?: string | null;
    mentionRole?: MeasurementMention["mentionRole"] | null;
    assertion?: MeasurementMention["assertion"] | null;
    sentiment?: MeasurementMention["sentiment"] | null;
    contextSnippet?: string | null;
    confidence?: number | null;
  }>;
}

export interface MentionSemanticsInput {
  promptText?: string | null;
  answerText: string;
  mentions: Array<{
    index: number;
    surfaceText: string;
    mentionPosition: number;
    contextSnippet?: string | null;
  }>;
}

/**
 * 감성 판별 V2 입력 (change mention-semantics-v2). 멘션 **전부**를 원배열 index 와
 * 함께 넘긴다. D1 필터(Brand·Product)·오프셋 줄 파생·중복 제거는 invoker 가 한다.
 */
export interface MentionSemanticsV2Input {
  promptText?: string | null;
  answerText: string;
  mentions: MentionSemanticsV2Mention[];
}

/**
 * 답변 단위 브랜드 스탠스 패스의 입력 (change add-answer-brand-stance).
 *
 * semantics 와 달리 **멘션 배열이 아니라 브랜드 이름 목록**을 넘긴다 — 이 패스의
 * 요점이 "브랜드 표면이 없는 문장까지 읽는 것"이라 절(clause) 경계를 주면 안 된다.
 * 목록은 호출부(`buildStanceTargets`)가 이미 결정적으로 정렬·절단한 것이다.
 */
export interface AnswerBrandStanceInput {
  promptText?: string | null;
  answerText: string;
  brands: string[];
}

/**
 * 턴 분석이 쓰는 LLM 태스크 3종. **기본값을 두지 않는다** — 기본값이 있으면
 * `pure/` 가 `../llm` 을 값으로 import 해야 하고 위 누수가 되살아난다.
 * 기본 배선(`opts.mentionExtraction ?? extractMentionsWithLlm`)은 코어 어댑터가
 * 만든다(`store.ts` analyzeQueryRun).
 */
export interface AnalysisLlmDeps {
  extract: (input: MentionExtractionInput) => Promise<MentionExtractionResult>;
  resolve: (
    input: PendingMentionResolutionInput,
  ) => Promise<PendingMentionResolutionResult>;
  semantics: (input: MentionSemanticsInput) => Promise<MentionSemanticsResult>;
  /**
   * 4번째 태스크 (change add-answer-brand-stance). **optional 이다** — 게이트가
   * 꺼진 호출부(골든 픽스처 13개 포함)가 이 멤버를 주입하지 않아도 컴파일되고,
   * 게이트가 켜졌는데 주입이 없으면 스탠스만 건너뛴다(턴 분석은 계속 성공).
   * 그것이 FR6(실패 격리)의 가장 싼 형태다.
   */
  stance?: (input: AnswerBrandStanceInput) => Promise<AnswerBrandStanceResult>;
  /**
   * 5번째 태스크, 감성 판별 V2 (change mention-semantics-v2). stance 와 같은 이유로
   * optional 이다. 옵션이 켜졌는데 주입이 없으면 현행 semantics 경로로 돌고 경고를 남긴다.
   */
  semanticsV2?: (
    input: MentionSemanticsV2Input,
  ) => Promise<MentionSemanticsV2Result>;
}

/**
 * 구조적 로깅만. 반환값 없음 — 순수 산출물에 영향을 주지 않는다.
 * 이벤트 이름·필드는 운영 대시보드·알람의 계약이라 한 글자도 바꾸지 않는다
 * (플랜 §5 R-4). 코어 어댑터는 `@/lib/log` 의 `log` 를 **래핑 없이 그대로** 넘긴다
 * — 래핑하면 `getCurrentTraceId` 상관이 끊긴다.
 */
export interface AnalysisLogger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
}

export interface AnalysisPureDeps {
  llm: AnalysisLlmDeps;
  log: AnalysisLogger;
}
