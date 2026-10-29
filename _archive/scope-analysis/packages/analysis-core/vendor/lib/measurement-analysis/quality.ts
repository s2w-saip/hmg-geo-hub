import type { AnswerQualityResult } from "./schema";

const TRASH_PATTERNS = [
  /log in to/i,
  /sign up for free/i,
  /captcha/i,
  /unusual traffic/i,
  /enable javascript/i,
  /cookie preferences/i,
  /privacy policy\s+terms/i,
  /new chat\s+explore/i,
  /browser not supported/i,
  /dry-run:/i,
];

const FAILED_PATTERNS = [
  /something went wrong/i,
  /connection interrupted/i,
  /waiting for the complete answer/i,
  /network error/i,
  /failed to generate/i,
  /try again later/i,
  /provider_status:/i,
  /rate[_ -]?limited/i,
  /오류가 발생/i,
  /응답을 생성하지 못/i,
];

const REFUSAL_PATTERNS = [
  /\bi can'?t assist\b/i,
  /\bi cannot assist\b/i,
  /\bi'?m unable to\b/i,
  /cannot provide/i,
  /(?:죄송하지만|미안하지만|저는|제가).{0,40}(?:도와드릴|답변할|제공할) 수 없/i,
  /(?:도와드릴|답변할) 수 없/i,
];

export function classifyAnswerQuality(answerText: string | null | undefined): AnswerQualityResult {
  const raw = answerText ?? "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { qualityState: "empty_answer", reason: "answer text is empty", answerChars: 0 };
  }

  for (const re of FAILED_PATTERNS) {
    if (re.test(trimmed)) {
      return {
        qualityState: "failed_answer",
        reason: `matched failed pattern ${re.source}`,
        answerChars: trimmed.length,
      };
    }
  }

  for (const re of TRASH_PATTERNS) {
    if (re.test(trimmed)) {
      return {
        qualityState: "trash_answer",
        reason: `matched trash pattern ${re.source}`,
        answerChars: trimmed.length,
      };
    }
  }

  const lineCount = trimmed.split(/\n+/).filter(Boolean).length;
  const alphaNum = (trimmed.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (trimmed.length < 18 || (lineCount <= 2 && alphaNum < 10)) {
    return {
      qualityState: "trash_answer",
      reason: "answer too short to be substantive",
      answerChars: trimmed.length,
    };
  }

  for (const re of REFUSAL_PATTERNS) {
    if (re.test(trimmed)) {
      return {
        qualityState: "refusal_or_non_answer",
        reason: `matched refusal pattern ${re.source}`,
        answerChars: trimmed.length,
      };
    }
  }

  return {
    qualityState: "valid_answer",
    reason: "substantive answer",
    answerChars: trimmed.length,
  };
}
