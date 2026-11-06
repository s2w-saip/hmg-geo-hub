// Type-only snapshot; no database or server implementation is included.
import "server-only";
import type { AllowedScope } from "@/lib/auth/types";
import type { PromptAuditChanges, PromptAuditEventType } from "@/lib/standards/audit";
export interface PromptAuditLogInsert {
    promptId: string;
    projectId: string;
    actorId: string | null;
    actorType?: "user" | "system";
    eventType: PromptAuditEventType;
    changes: PromptAuditChanges;
    batchId?: string | null;
}
export interface PromptAuditLogView {
    id: string;
    promptId: string;
    actorId: string | null;
    actorType: string;
    eventType: string;
    changes: PromptAuditChanges;
    batchId: string | null;
    createdAt: Date;
    actorEmail: string | null;
    promptText: string | null;
    promptBrand: string | null;
}
export interface GlobalAuditQuery {
    scope: AllowedScope | null | undefined;
    from?: Date;
    eventTypes?: PromptAuditEventType[];
    limit?: number;
}
export interface PromptAuditDailyCount {
    day: string;
    total: number;
}
export declare const promptAuditLogRepository: {
    listForPrompt(promptId: string, limit?: number): Promise<PromptAuditLogView[]>;
    listGlobalScoped(input: GlobalAuditQuery): Promise<PromptAuditLogView[]>;
    listDailyCounts(days?: number): Promise<PromptAuditDailyCount[]>;
    insert(input: PromptAuditLogInsert): Promise<void>;
};
export interface AuditedCatalogPatch {
    text?: string;
    promptType?: string | null;
    category?: string | null;
    brand?: string | null;
    brandPresence?: string | null;
    listType?: string | null;
    depth1?: string | null;
    depth2?: string | null;
    depth3?: string | null;
    depth4?: string | null;
    funnelStage?: string | null;
    kind?: "single" | "acr";
    /**
     * 언어·시장 축 (H5). `regions` 만 `string[]` 이라 다른 필드와 타입 계열이 다르다 —
     * `CatalogLabelsPatch`(전부 `string|null`)에 욱여넣지 않고 별도 액션으로 둔 이유가
     * 이것이다(`kind` 가 별도 액션인 것과 같은 규약).
     *
     * ⚠️ `changes` 직렬화 주의: `computeChanges` 는 `String(v)` 로 값을 문자열화하므로
     * 배열을 그대로 넘기면 `"KR,US"` 와 `"US,KR"` 이 **다른 변경으로 기록된다.**
     * 호출부가 `[...r].sort().join(",")` 로 정렬 CSV 를 만들어 넘긴다.
     */
    lang?: string | null;
    regions?: string[] | null;
    deletedAt?: Date | null;
}
export interface AuditedChangeInput {
    promptId: string;
    actorId: string;
    eventType: PromptAuditEventType;
    patch: AuditedCatalogPatch;
    changes: PromptAuditChanges;
    batchId?: string | null;
    applyScope?: () => Promise<void>;
}
export declare function applyAuditedCatalogChange(input: AuditedChangeInput): Promise<void>;
export interface AuditedCreateInput {
    actorId: string;
    values: {
        text: string;
        promptType?: string | null;
        category?: string | null;
        brand?: string | null;
    };
    pushScope?: () => Promise<{
        scopePromptId: string;
    } | null>;
}
export declare function createAuditedCatalogPrompt(input: AuditedCreateInput): Promise<{
    id: string;
}>;
