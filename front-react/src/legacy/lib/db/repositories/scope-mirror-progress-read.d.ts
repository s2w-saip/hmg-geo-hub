// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type SQL } from "drizzle-orm";
/**
 * SQL gate shared by every direct mirror reader. During a rollout before
 * migration 0073 this returns `true`; once the table exists it excludes a
 * run until its durable bulk checkpoint is complete or past publication
 * invalidation.
 */
export declare function bulkMirrorRunVisibleSql(runIdCol: SQL): Promise<SQL>;
/**
 * Synchronous companion for SQL builders that must retain their existing
 * signature. Their async entrypoint probes first; an unresolved cache remains
 * fail-open until that explicit probe completes.
 */
export declare function bulkMirrorRunVisibleSqlKnown(runIdCol: SQL): SQL;
/** Test-only cache reset; production callers should rely on probe caching. */
export declare function resetBulkMirrorRunVisibilityForTests(): void;
