// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type SQL } from "drizzle-orm";
import { type StandardPromptRow, type StandardKeywordRow, type StandardSourceRow } from "@/lib/db/schema";
import type { PromptType } from "@/lib/db/repositories/prompts";
import type { AllowedScope } from "@/lib/auth/types";
export declare const STANDARD_ROOT_PROJECT_ID: string;
export type StandardKeywordSource = "google_keyword" | "community_voc";
export interface StandardPromptInsert {
    text: string;
    promptType?: PromptType | null;
    category?: string | null;
    brand?: string | null;
    enabled?: boolean;
    createdBy: string;
}
export interface StandardPromptUpdate {
    text?: string;
    promptType?: PromptType | null;
    category?: string | null;
    brand?: string | null;
    enabled?: boolean;
}
export interface StandardPromptRepository {
    list(): Promise<StandardPromptRow[]>;
    insert(input: StandardPromptInsert): Promise<StandardPromptRow>;
    update(id: string, patch: StandardPromptUpdate): Promise<StandardPromptRow>;
    delete(id: string): Promise<void>;
}
export declare const standardPromptRepository: StandardPromptRepository;
export interface StandardCatalogRow {
    id: string;
    text: string;
    promptType: PromptType | null;
    category: string | null;
    brand: string | null;
    brandPresence: string | null;
    listType: string | null;
    depth1: string | null;
    depth2: string | null;
    depth3: string | null;
    depth4: string | null;
    funnelStage: string | null;
    kind: string;
    lang: string | null;
    regions: string[] | null;
    scopePromptId: string | null;
    scopeText: string | null;
    deletedAt: Date | null;
}
export interface StandardCatalogStats {
    total: number;
    tracked: number;
    untracked: number;
    scopeOrphans: number;
    acr: number;
    deleted: number;
}
export declare function listStandardCatalog(opts?: {
    includeDeleted?: boolean;
}): Promise<{
    rows: StandardCatalogRow[];
    stats: StandardCatalogStats;
}>;
export declare function catalogMarketScopeCondition(allowed: string[]): SQL | null;
export declare function listStandardCatalogScoped(scope: AllowedScope | null | undefined): Promise<{
    rows: StandardCatalogRow[];
}>;
export interface CatalogTaxonomyRow {
    brand: string | null;
    brandPresence: string | null;
    listType: string | null;
    depth1: string | null;
    depth2: string | null;
    depth3: string | null;
    depth4: string | null;
}
export declare function countStandardAcrPrompts(): Promise<number>;
export declare function listCatalogTaxonomy(projectId?: string): Promise<CatalogTaxonomyRow[]>;
export interface StandardKeywordInsert {
    term: string;
    sourceType: StandardKeywordSource;
    brand?: string | null;
    notes?: string | null;
    enabled?: boolean;
    createdBy: string;
}
export interface StandardKeywordUpdate {
    term?: string;
    sourceType?: StandardKeywordSource;
    brand?: string | null;
    notes?: string | null;
    enabled?: boolean;
}
export interface StandardKeywordRepository {
    list(): Promise<StandardKeywordRow[]>;
    insert(input: StandardKeywordInsert): Promise<StandardKeywordRow>;
    update(id: string, patch: StandardKeywordUpdate): Promise<StandardKeywordRow>;
    delete(id: string): Promise<void>;
}
export declare const standardKeywordRepository: StandardKeywordRepository;
export type StandardSourceChannel = "news" | "pr" | "social" | "community";
export interface StandardSourceInsert {
    url: string;
    channel: StandardSourceChannel;
    brand?: string | null;
    notes?: string | null;
    enabled?: boolean;
    createdBy: string;
}
export interface StandardSourceUpdate {
    url?: string;
    channel?: StandardSourceChannel;
    brand?: string | null;
    notes?: string | null;
    enabled?: boolean;
}
export interface StandardSourceRepository {
    list(): Promise<StandardSourceRow[]>;
    insert(input: StandardSourceInsert): Promise<StandardSourceRow>;
    update(id: string, patch: StandardSourceUpdate): Promise<StandardSourceRow>;
    delete(id: string): Promise<void>;
}
export declare const standardSourceRepository: StandardSourceRepository;
