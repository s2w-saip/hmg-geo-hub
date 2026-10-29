#!/usr/bin/env node

/**
 * Read-only Scope/HMG anchor reconciliation planner.
 *
 * This module deliberately has no database, HTTP, or write dependency.  It
 * consumes metadata snapshots exported by an operator and emits a plan.  The
 * planner is intentionally conservative: an incomplete or mixed source is a
 * BLOCK, never a guessed repair.
 */

import { readFileSync } from "node:fs";

export type Decision = "MATCH" | "RECOMMEND_PARENT_ANCHOR" | "BLOCK";

export interface ParentSnapshot {
  runId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  cycleAnchorAt?: string | null;
  startedAt?: string | null;
  status?: string | null;
  deletedAt?: string | null;
  archivedAt?: string | null;
  projectDeletedAt?: string | null;
  projectArchivedAt?: string | null;
  sourceRevision?: string | null;
  snapshotId?: string | null;
  expectedChildCount?: number | null;
}

export interface ChildSnapshot {
  runId: string;
  childId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  cycleAnchorAt?: string | null;
  status?: string | null;
  ticketStatus?: string | null;
  deletedAt?: string | null;
  archivedAt?: string | null;
  sourceRevision?: string | null;
  snapshotId?: string | null;
}

export interface MirrorSnapshot {
  runId: string;
  projectId?: string | null;
  cycleAnchorAt?: string | null;
  status?: string | null;
  syncedAt?: string | null;
  totalJobs?: number | null;
  answerCount?: number | null;
  truncated?: boolean | null;
  oversized?: boolean | null;
  completenessVerified?: boolean | null;
  diagnosticEvidenceId?: string | null;
  sourceRevision?: string | null;
  snapshotId?: string | null;
}

export interface CycleSnapshot {
  runId: string;
  cycleId?: string | null;
  projectId?: string | null;
  cycleAnchorAt?: string | null;
  status?: string | null;
  viewAnchorAt?: string | null;
  activeGenerationId?: string | null;
  generationStatus?: string | null;
  sourceRevision?: string | null;
  snapshotId?: string | null;
}

export interface AnchorAuditInput {
  workspaceId?: string | null;
  snapshotConsistencyId?: string | null;
  parents: ParentSnapshot[];
  children: ChildSnapshot[];
  mirrors?: MirrorSnapshot[];
  cycles?: CycleSnapshot[];
}

export interface AnchorAuditOptions {
  runIds?: readonly string[];
  projectId?: string;
  observedAfter?: string;
  observedBefore?: string;
}

export interface AnchorAuditRow {
  runId: string;
  decision: Decision;
  reasons: string[];
  parentAnchorAt: string | null;
  parentAnchorMs: string | null;
  expectedChildCount: number | null;
  childCount: number;
  childNullAnchorCount: number;
  childAnchorValuesMs: string[];
  recommendedAnchorAt: string | null;
  mirrorAnchorAt: string | null;
  mirrorAnchorMs: string | null;
  mirrorRowCount: number;
  cycleCount: number;
  cycleAnchorMs: string[];
  sourceRevisions: string[];
  snapshotConsistencyIds: string[];
}

const TERMINAL = new Set(["completed", "failed", "partial_failed"]);
const CHILD_STATUSES = new Set(["queued", "running", "completed", "failed", "partial_failed"]);
const CYCLE_STATUSES = new Set(["open", "closed", "generating", "published", "stale"]);
const IMMUTABLE_CYCLE_STATUSES = new Set(["closed", "published", "stale", "generating"]);

function canonicalMs(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year); const mo = Number(month); const d = Number(day);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  // Date normalizes to UTC with exactly millisecond precision. This mirrors
  // the API's ISO representation while retaining the raw input elsewhere.
  return date.toISOString();
}

function validDate(value: string | null | undefined): boolean {
  return value == null || value === "" || canonicalMs(value) !== null;
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function hasField<T extends object>(value: T, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field) && value[field as keyof T] !== undefined;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))].sort();
}

function sourceRevisions(
  parent: ParentSnapshot,
  children: ChildSnapshot[],
  mirror: MirrorSnapshot | undefined,
  cycles: CycleSnapshot[],
): string[] {
  return unique([
    parent.sourceRevision ?? null,
    ...children.map((c) => c.sourceRevision ?? null),
    mirror?.sourceRevision ?? null,
    ...cycles.map((c) => c.sourceRevision ?? null),
  ]);
}

function snapshotConsistencyIds(
  input: AnchorAuditInput,
  parent: ParentSnapshot,
  children: ChildSnapshot[],
  mirror: MirrorSnapshot | undefined,
  cycles: CycleSnapshot[],
): string[] {
  return unique([
    input.snapshotConsistencyId ?? null,
    parent.snapshotId ?? null,
    ...children.map((c) => c.snapshotId ?? null),
    mirror?.snapshotId ?? null,
    ...cycles.map((c) => c.snapshotId ?? null),
  ]);
}

function validateOptions(options: AnchorAuditOptions): void {
  for (const [name, value] of [["observedAfter", options.observedAfter], ["observedBefore", options.observedBefore]] as const) {
    if (value && !canonicalMs(value)) throw new Error(`${name} must be an ISO-8601 timestamp with timezone`);
  }
  if (options.observedAfter && options.observedBefore && new Date(options.observedAfter).getTime() >= new Date(options.observedBefore).getTime()) {
    throw new Error("observedAfter must be earlier than observedBefore");
  }
}

function inObservedWindow(
  value: string | null | undefined,
  options: AnchorAuditOptions,
): boolean {
  if (!value) return true;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  if (options.observedAfter && time < new Date(options.observedAfter).getTime()) return false;
  if (options.observedBefore && time >= new Date(options.observedBefore).getTime()) return false;
  return true;
}

function checkScopeBoundary(
  workspaceId: string | null | undefined,
  parent: ParentSnapshot,
  children: ChildSnapshot[],
): string[] {
  const reasons: string[] = [];
  if (!workspaceId) addReason(reasons, "WORKSPACE_BOUNDARY_MISSING");
  for (const row of [parent, ...children]) {
    if (row.workspaceId && workspaceId && row.workspaceId !== workspaceId) {
      addReason(reasons, "WORKSPACE_MISMATCH");
    }
  }
  for (const child of children) {
    if (!child.workspaceId) addReason(reasons, "CHILD_WORKSPACE_MISSING");
    if (!child.projectId) addReason(reasons, "CHILD_PROJECT_MISSING");
    if (child.projectId && parent.projectId && child.projectId !== parent.projectId) {
      addReason(reasons, "PROJECT_MISMATCH");
    }
  }
  return reasons;
}

export function planAnchorAudit(
  input: AnchorAuditInput,
  options: AnchorAuditOptions = {},
): AnchorAuditRow[] {
  validateOptions(options);
  const wanted = options.runIds?.length ? new Set(options.runIds) : null;
  const childrenByRun = new Map<string, ChildSnapshot[]>();
  for (const child of input.children) {
    const rows = childrenByRun.get(child.runId);
    if (rows) rows.push(child);
    else childrenByRun.set(child.runId, [child]);
  }
  const mirrorsByRun = new Map<string, MirrorSnapshot[]>();
  for (const mirror of input.mirrors ?? []) {
    const rows = mirrorsByRun.get(mirror.runId);
    if (rows) rows.push(mirror);
    else mirrorsByRun.set(mirror.runId, [mirror]);
  }
  const cyclesByRun = new Map<string, CycleSnapshot[]>();
  for (const cycle of input.cycles ?? []) {
    const rows = cyclesByRun.get(cycle.runId);
    if (rows) rows.push(cycle);
    else cyclesByRun.set(cycle.runId, [cycle]);
  }
  const parentCounts = new Map<string, number>();
  for (const parent of input.parents) parentCounts.set(parent.runId, (parentCounts.get(parent.runId) ?? 0) + 1);
  const parentRows = input.parents.filter((p) =>
    (!wanted || wanted.has(p.runId)) &&
    (!options.projectId || p.projectId === options.projectId) &&
    ((!options.observedAfter && !options.observedBefore) ||
      !p.startedAt ||
      !validDate(p.startedAt) ||
      inObservedWindow(p.startedAt, options)),
  );
  const rows: AnchorAuditRow[] = [];

  for (const parent of parentRows) {
    const children = childrenByRun.get(parent.runId) ?? [];
    const mirrorRows = mirrorsByRun.get(parent.runId) ?? [];
    const mirror = mirrorRows[0];
    const cycles = cyclesByRun.get(parent.runId) ?? [];
    const reasons = checkScopeBoundary(input.workspaceId, parent, children);
    const parentMs = canonicalMs(parent.cycleAnchorAt);
    const childNullCount = children.filter((c) => !c.cycleAnchorAt).length;
    const childValues = unique(children.map((c) => canonicalMs(c.cycleAnchorAt)));
    const revisions = sourceRevisions(parent, children, mirror, cycles);
    const consistencyIds = snapshotConsistencyIds(input, parent, children, mirror, cycles);
    const cycleValues = unique(cycles.map((c) => canonicalMs(c.cycleAnchorAt)));
    let recommended: string | null = null;

    if ((parentCounts.get(parent.runId) ?? 0) > 1) addReason(reasons, "DUPLICATE_PARENT_RUN_ID");
    for (const source of [parent, ...children]) {
      if (!validDate(source.cycleAnchorAt)) addReason(reasons, "INVALID_ANCHOR_TIMESTAMP");
    }
    if (!parent.startedAt) addReason(reasons, "MISSING_PARENT_STARTED_AT");
    else if (!validDate(parent.startedAt)) addReason(reasons, "INVALID_STARTED_TIMESTAMP");
    if (consistencyIds.length !== 1) addReason(reasons, consistencyIds.length === 0 ? "SNAPSHOT_CONSISTENCY_MISSING" : "SNAPSHOT_CONSISTENCY_MISMATCH");
    if (!input.snapshotConsistencyId) addReason(reasons, "SNAPSHOT_CONSISTENCY_MISSING");
    for (const child of children) if (!child.snapshotId) addReason(reasons, "CHILD_SNAPSHOT_ID_MISSING");
    if (!parent.snapshotId) addReason(reasons, "PARENT_SNAPSHOT_ID_MISSING");
    for (const cycle of cycles) if (!cycle.snapshotId) addReason(reasons, "CYCLE_SNAPSHOT_ID_MISSING");
    for (const mirrorRow of mirrorRows) if (!mirrorRow.snapshotId) addReason(reasons, "MIRROR_SNAPSHOT_ID_MISSING");
    if (parent.snapshotId && input.snapshotConsistencyId && parent.snapshotId !== input.snapshotConsistencyId) addReason(reasons, "SNAPSHOT_CONSISTENCY_MISMATCH");
    if (children.some((c) => c.snapshotId && c.snapshotId !== input.snapshotConsistencyId)) addReason(reasons, "SNAPSHOT_CONSISTENCY_MISMATCH");
    if (mirrorRows.some((m) => m.snapshotId && m.snapshotId !== input.snapshotConsistencyId)) addReason(reasons, "SNAPSHOT_CONSISTENCY_MISMATCH");
    if (cycles.some((c) => c.snapshotId && c.snapshotId !== input.snapshotConsistencyId)) addReason(reasons, "SNAPSHOT_CONSISTENCY_MISMATCH");
    if (!parent.workspaceId) addReason(reasons, "PARENT_WORKSPACE_MISSING");
    if (!parent.projectId) addReason(reasons, "PARENT_PROJECT_MISSING");
    if (parent.expectedChildCount == null) addReason(reasons, "EXPECTED_CHILD_COUNT_MISSING");
    else if (!Number.isInteger(parent.expectedChildCount) || parent.expectedChildCount < 1) addReason(reasons, "EXPECTED_CHILD_COUNT_INVALID");
    else if (parent.expectedChildCount !== children.length) addReason(reasons, "EXPECTED_CHILD_COUNT_MISMATCH");
    if (parent.deletedAt || parent.archivedAt || parent.projectDeletedAt || parent.projectArchivedAt) addReason(reasons, "PARENT_ARCHIVED_OR_DELETED");
    if (children.some((c) => c.deletedAt || c.archivedAt)) addReason(reasons, "CHILD_ARCHIVED_OR_DELETED");
    if (children.length === 0) addReason(reasons, "EMPTY_CHILD_ROWS");
    if (children.some((c) => !c.childId)) addReason(reasons, "NULL_CHILD_ID");
    const childIds = children.map((c) => c.childId).filter((id): id is string => Boolean(id));
    if (new Set(childIds).size !== childIds.length) addReason(reasons, "DUPLICATE_CHILD_IDS");
    if (childNullCount > 0) addReason(reasons, "NULL_CHILD_ANCHOR");
    if (childValues.length === 0 && children.length > 0) addReason(reasons, "NULL_CHILD_ANCHOR");
    if (childValues.length > 1) addReason(reasons, "MIXED_CHILD_ANCHORS");
    if (children.some((c) => !c.status || !CHILD_STATUSES.has(c.status))) addReason(reasons, "MISSING_OR_INVALID_CHILD_STATUS");
    if (children.some((c) => !hasField(c, "ticketStatus"))) addReason(reasons, "CHILD_TICKET_STATUS_OBSERVATION_MISSING");
    if (children.some((c) => c.status && !TERMINAL.has(c.status))) addReason(reasons, "MUTABLE_CHILD_STATUS");
    if (children.some((c) => c.ticketStatus != null && !["submitted", "finalized", "abandoned"].includes(c.ticketStatus))) addReason(reasons, "INVALID_TICKET_STATUS");
    if (children.some((c) => c.ticketStatus === "submitted")) addReason(reasons, "OPEN_TICKET");

    if (parentMs && parent.startedAt) {
      const startedMs = canonicalMs(parent.startedAt);
      if (startedMs && parentMs > startedMs) addReason(reasons, "PARENT_ANCHOR_AFTER_STARTED_AT");
    }
    if (childValues.length === 1 && parent.startedAt) {
      const startedMs = canonicalMs(parent.startedAt);
      if (startedMs && childValues[0] > startedMs) addReason(reasons, "CHILD_ANCHOR_AFTER_STARTED_AT");
    }

    if (cycles.length === 0) addReason(reasons, "MISSING_CYCLE_MEMBERSHIP");
    if (cycles.length > 1) addReason(reasons, "MULTIPLE_CYCLE_MEMBERSHIPS");
    for (const cycle of cycles) {
      if (!cycle.cycleId || !cycle.cycleAnchorAt || !canonicalMs(cycle.cycleAnchorAt)) addReason(reasons, "INVALID_CYCLE_ANCHOR");
      if (!cycle.projectId) addReason(reasons, "CYCLE_PROJECT_MISSING");
      if (!cycle.status || !CYCLE_STATUSES.has(cycle.status)) addReason(reasons, "MISSING_OR_INVALID_CYCLE_STATUS");
      if (!hasField(cycle, "viewAnchorAt") || !hasField(cycle, "activeGenerationId") || !hasField(cycle, "generationStatus")) addReason(reasons, "CYCLE_GENERATION_OBSERVATION_MISSING");
      if (cycle.projectId && parent.projectId && cycle.projectId !== parent.projectId) {
        addReason(reasons, "CYCLE_PROJECT_MISMATCH");
      }
      if (cycle.status && IMMUTABLE_CYCLE_STATUSES.has(cycle.status)) {
        addReason(reasons, "GENERATED_OR_CLOSED_CYCLE");
      }
      if (cycle.viewAnchorAt || cycle.activeGenerationId || cycle.generationStatus != null) {
        addReason(reasons, "STALE_OR_ACTIVE_GENERATION");
      }
    }

    if (mirror) {
      if (mirrorRows.length > 1) addReason(reasons, "DUPLICATE_MIRROR_ROWS");
      if (!mirror.cycleAnchorAt || !canonicalMs(mirror.cycleAnchorAt)) addReason(reasons, "NULL_MIRROR_ANCHOR");
      if (!mirror.projectId) addReason(reasons, "MIRROR_PROJECT_MISSING");
      if (!mirror.status || !TERMINAL.has(mirror.status)) addReason(reasons, "MISSING_OR_INVALID_MIRROR_STATUS");
      if (mirror.projectId && parent.projectId && mirror.projectId !== parent.projectId) {
        addReason(reasons, "MIRROR_PROJECT_MISMATCH");
      }
      if (mirror.truncated) addReason(reasons, "MIRROR_TRUNCATED");
      if (mirror.oversized) addReason(reasons, "MIRROR_OVERSIZED");
      if (mirror.completenessVerified !== true || !mirror.diagnosticEvidenceId) addReason(reasons, "MIRROR_COMPLETENESS_UNKNOWN");
      const mirrorMs = canonicalMs(mirror.cycleAnchorAt);
      if (mirrorMs && parentMs && mirrorMs !== parentMs && childValues.length === 1 && mirrorMs !== childValues[0]) {
        addReason(reasons, "MIRROR_CONFLICT");
      }
    } else addReason(reasons, "MISSING_MIRROR_ROW");

    // A NULL parent is explicitly non-repairable: a unanimous child is useful
    // evidence, but cannot establish the immutable parent ledger by itself.
    if (!parent.cycleAnchorAt) addReason(reasons, "NULL_PARENT_ANCHOR");
    if (childValues.length === 1 && parentMs && cycleValues.length !== 1) {
      addReason(reasons, "CYCLE_ANCHOR_CONFLICT");
    }
    if (childValues.length === 1 && parentMs && cycleValues.length === 1 && cycleValues[0] !== childValues[0]) {
      addReason(reasons, "CYCLE_ANCHOR_CONFLICT");
    }
    if (childValues.length === 1 && parentMs && childValues[0] !== parentMs) {
      recommended = children.find((c) => c.cycleAnchorAt)?.cycleAnchorAt ?? childValues[0];
      if (cycles.some((c) => canonicalMs(c.cycleAnchorAt) !== childValues[0])) {
        addReason(reasons, "CYCLE_ANCHOR_CONFLICT");
      }
      if (mirror && canonicalMs(mirror.cycleAnchorAt) && canonicalMs(mirror.cycleAnchorAt) !== childValues[0] && canonicalMs(mirror.cycleAnchorAt) !== parentMs) {
        addReason(reasons, "MIRROR_CONFLICT");
      }
    }

    const decision: Decision = reasons.length > 0
      ? "BLOCK"
      : recommended
        ? "RECOMMEND_PARENT_ANCHOR"
        : "MATCH";

    rows.push({
      runId: parent.runId,
      decision,
      reasons,
      parentAnchorAt: parent.cycleAnchorAt ?? null,
      parentAnchorMs: parentMs,
      expectedChildCount: parent.expectedChildCount ?? null,
      childCount: children.length,
      childNullAnchorCount: childNullCount,
      childAnchorValuesMs: childValues,
      recommendedAnchorAt: decision === "RECOMMEND_PARENT_ANCHOR" ? recommended : null,
      mirrorAnchorAt: mirror?.cycleAnchorAt ?? null,
      mirrorAnchorMs: canonicalMs(mirror?.cycleAnchorAt),
      mirrorRowCount: mirrorRows.length,
      cycleCount: cycles.length,
      cycleAnchorMs: cycleValues,
      sourceRevisions: revisions,
      snapshotConsistencyIds: consistencyIds,
    });
  }
  return rows;
}

function parseCsv(text: string): AnchorAuditInput {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { parents: [], children: [], mirrors: [], cycles: [] };
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; continue; }
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === "," && !quoted) { out.push(field); field = ""; continue; }
      field += ch;
    }
    out.push(field);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim());
  const headerSet = new Set(headers);
  const records = lines.slice(1).map((line) => {
    const values = parseLine(line);
    if (values.length !== headers.length) throw new Error("CSV row has a different field count from its header");
    return Object.fromEntries(headers.map((h, i) => [h, values[i]?.trim() ?? ""]));
  });
  const textValue = (row: Record<string, string>, ...keys: string[]) => keys.map((k) => row[k]).find((v) => v !== undefined && v !== "") || null;
  const numberValue = (row: Record<string, string>, ...keys: string[]) => {
    const value = textValue(row, ...keys);
    return value == null ? null : Number(value);
  };
  const boolValue = (row: Record<string, string>, ...keys: string[]) => {
    const value = textValue(row, ...keys)?.toLowerCase();
    if (value == null) return null;
    if (["1", "true", "yes"].includes(value)) return true;
    if (["0", "false", "no"].includes(value)) return false;
    throw new Error(`invalid boolean value for ${keys[0]}`);
  };
  const parents: ParentSnapshot[] = [];
  const children: ChildSnapshot[] = [];
  const mirrors: MirrorSnapshot[] = [];
  const cycles: CycleSnapshot[] = [];
  for (const row of records) {
    const kind = (textValue(row, "kind", "source") ?? "").toLowerCase();
    const runId = textValue(row, "run_id", "measurement_run_id");
    if (!runId) continue;
    const requireHeaders = (names: string[], label: string) => {
      if (!names.some((name) => headerSet.has(name))) throw new Error(`CSV ${label} observation header missing: ${names.join(" or ")}`);
    };
    const common = { runId, projectId: textValue(row, "project_id"), sourceRevision: textValue(row, "source_revision", "revision"), snapshotId: textValue(row, "snapshot_id", "snapshot_consistency_id") };
    if (kind === "parent" || kind === "measurement_run") {
      requireHeaders(["started_at"], "parent.started_at");
      parents.push({ ...common, workspaceId: textValue(row, "workspace_id"), cycleAnchorAt: textValue(row, "parent_anchor_at", "cycle_anchor_at"), startedAt: textValue(row, "started_at"), status: textValue(row, "status"), deletedAt: textValue(row, "deleted_at"), archivedAt: textValue(row, "archived_at"), projectDeletedAt: textValue(row, "project_deleted_at"), projectArchivedAt: textValue(row, "project_archived_at"), expectedChildCount: numberValue(row, "expected_child_count", "total_jobs") });
    } else if (kind === "child" || kind === "query_run") {
      requireHeaders(["child_status", "status"], "child.status");
      requireHeaders(["ticket_status"], "child.ticket_status");
      const child: ChildSnapshot = { ...common, childId: textValue(row, "child_id", "query_run_id", "job_id"), workspaceId: textValue(row, "workspace_id"), cycleAnchorAt: textValue(row, "child_anchor_at", "cycle_anchor_at"), status: textValue(row, "child_status", "status"), ticketStatus: textValue(row, "ticket_status"), deletedAt: textValue(row, "deleted_at"), archivedAt: textValue(row, "archived_at") };
      children.push(child);
    } else if (kind === "mirror" || kind === "scope_run") {
      requireHeaders(["mirror_status", "status"], "mirror.status");
      mirrors.push({ ...common, cycleAnchorAt: textValue(row, "mirror_anchor_at", "cycle_anchor_at"), status: textValue(row, "mirror_status", "status"), syncedAt: textValue(row, "mirror_synced_at", "synced_at"), totalJobs: numberValue(row, "total_jobs"), answerCount: numberValue(row, "answer_count"), truncated: boolValue(row, "truncated"), oversized: boolValue(row, "oversized"), completenessVerified: boolValue(row, "completeness_verified"), diagnosticEvidenceId: textValue(row, "diagnostic_evidence_id") });
    } else if (kind === "cycle" || kind === "summary_cycle") {
      requireHeaders(["cycle_status", "status"], "cycle.status");
      requireHeaders(["view_anchor_at"], "cycle.view_anchor_at");
      requireHeaders(["active_generation_id"], "cycle.active_generation_id");
      requireHeaders(["generation_status"], "cycle.generation_status");
      const cycle: CycleSnapshot = { ...common, cycleId: textValue(row, "cycle_id"), cycleAnchorAt: textValue(row, "cycle_anchor_at"), status: textValue(row, "cycle_status", "status"), viewAnchorAt: textValue(row, "view_anchor_at"), activeGenerationId: textValue(row, "active_generation_id"), generationStatus: textValue(row, "generation_status") };
      cycles.push(cycle);
    }
  }
  const workspaceId = records.map((r) => textValue(r, "workspace_id")).find(Boolean) ?? null;
  const consistencyIds = records.map((r) => textValue(r, "snapshot_consistency_id", "snapshot_id")).filter(Boolean);
  return { workspaceId, snapshotConsistencyId: consistencyIds[0] ?? null, parents, children, mirrors, cycles };
}

export function parseSnapshot(text: string, format?: "json" | "csv"): AnchorAuditInput {
  const selected = format ?? (/^[\[{]/.test(text.trimStart()) ? "json" : "csv");
  if (selected === "csv") return parseCsv(text);
  const parsed = JSON.parse(text) as AnchorAuditInput;
  return { parents: [], children: [], ...parsed, mirrors: parsed.mirrors ?? [], cycles: parsed.cycles ?? [] };
}

export function missingRequestedRunIds(rows: readonly AnchorAuditRow[], runIds: readonly string[]): string[] {
  const present = new Set(rows.map((row) => row.runId));
  return runIds.filter((runId) => !present.has(runId));
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function formatRows(rows: AnchorAuditRow[], format: "json" | "csv" = "json"): string {
  if (format === "json") return `${JSON.stringify({ rows }, null, 2)}\n`;
  const headers = ["run_id", "decision", "reasons", "parent_anchor_ms", "expected_child_count", "child_count", "child_null_anchor_count", "child_anchor_values_ms", "recommended_anchor_at", "mirror_anchor_ms", "mirror_row_count", "cycle_count", "cycle_anchor_ms", "source_revisions", "snapshot_consistency_ids"];
  const lines = [headers.join(",")];
  for (const row of rows) lines.push([
    row.runId, row.decision, row.reasons.join("|"), row.parentAnchorMs, row.expectedChildCount, row.childCount,
    row.childNullAnchorCount, row.childAnchorValuesMs.join("|"), row.recommendedAnchorAt,
    row.mirrorAnchorMs, row.mirrorRowCount, row.cycleCount, row.cycleAnchorMs.join("|"), row.sourceRevisions.join("|"), row.snapshotConsistencyIds.join("|"),
  ].map(csvEscape).join(","));
  return `${lines.join("\n")}\n`;
}

export interface ParsedCliArgs {
  help: boolean;
  path?: string;
  format?: "json" | "csv";
  runIds: string[];
  projectId?: string;
  observedAfter?: string;
  observedBefore?: string;
}

const USAGE = "usage: anchor-audit.ts <snapshot.json|snapshot.csv> [--format json|csv] [--run-id id] [--project-id id] [--observed-after ISO] [--observed-before ISO]";
const VALUE_OPTIONS = new Set(["--format", "--run-id", "--project-id", "--observed-after", "--observed-before"]);

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const result: ParsedCliArgs = { help: false, runIds: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      if (result.path) throw new Error(`unexpected positional argument: ${arg}`);
      result.path = arg;
      continue;
    }
    if (!VALUE_OPTIONS.has(arg)) throw new Error(`unknown option: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--format") {
      if (value !== "json" && value !== "csv") throw new Error("--format must be json or csv");
      result.format = value;
    } else if (arg === "--run-id") result.runIds.push(value);
    else if (arg === "--project-id") result.projectId = value;
    else if (arg === "--observed-after") result.observedAfter = value;
    else result.observedBefore = value;
  }
  if (result.help) return result;
  if (!result.path) throw new Error(USAGE);
  if (!result.format) {
    if (result.path.toLowerCase().endsWith(".json")) result.format = "json";
    else if (result.path.toLowerCase().endsWith(".csv")) result.format = "csv";
    else throw new Error("format is required for files without .json or .csv extension");
  }
  validateOptions({ observedAfter: result.observedAfter, observedBefore: result.observedBefore });
  return result;
}

export function main(argv = process.argv.slice(2)): void {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  // Input is detected from its content. `--format` controls output only, so a
  // JSON snapshot can intentionally be rendered as CSV.
  const snapshot = parseSnapshot(readFileSync(cli.path!, "utf8"));
  if (snapshot.parents.length === 0) throw new Error("parent snapshot is empty");
  const rows = planAnchorAudit(snapshot, { runIds: cli.runIds, projectId: cli.projectId, observedAfter: cli.observedAfter, observedBefore: cli.observedBefore });
  const missingRunIds = missingRequestedRunIds(rows, cli.runIds);
  if (missingRunIds.length) throw new Error(`requested run_id not found in selected parent snapshot: ${missingRunIds.join(",")}`);
  if (rows.length === 0) throw new Error("no runs matched the requested filters");
  process.stdout.write(formatRows(rows, cli.format));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
