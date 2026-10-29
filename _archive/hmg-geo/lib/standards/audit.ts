// catalog-prompt-audit의 공유 타입 + 순수 diff. 서버·클라이언트 모두에서 import
// 가능해야 하므로 의존성 없음 (리포지터리·액션·UI가 타입을 여기서 가져간다).

export type PromptAuditEventType =
  | "created"
  | "text_updated"
  | "meta_updated"
  | "enabled_changed"
  | "kind_changed"
  | "deleted"
  | "restored";

export const PROMPT_AUDIT_EVENT_TYPES: PromptAuditEventType[] = [
  "created",
  "text_updated",
  "meta_updated",
  "enabled_changed",
  "kind_changed",
  "deleted",
  "restored",
];

export type PromptAuditChanges = Record<string, { old: string | null; new: string | null }>;

// undefined = "이 필드는 건드리지 않음"(xlsx 파서의 omit 의미론과 동일),
// null = 명시적 clear. 값 비교는 문자열화 후 — jsonb에 문자열로 저장한다.
export function computeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): PromptAuditChanges {
  const out: PromptAuditChanges = {};
  for (const f of fields) {
    if (!(f in after) || after[f] === undefined) continue;
    const oldV = before[f] == null ? null : String(before[f]);
    const newV = after[f] == null ? null : String(after[f]);
    if (oldV !== newV) out[f] = { old: oldV, new: newV };
  }
  return out;
}
