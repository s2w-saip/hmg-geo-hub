import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import { loadMessages } from "@/i18n/request";

// Render check of the entity version screens (E7) with the real dictionaries: every key a
// rendered branch uses exists in both locales (a missing key throws through onError), and the
// keys chosen at run time (error codes, statuses, apply blocks, preview change kinds, confirm
// dialogs) exist in both. No backend: the actions are stubs and nothing is clicked.

vi.mock("../_ecat-actions", () => ({
  createDraftAction: vi.fn(),
  patchDraftAction: vi.fn(),
  discardDraftAction: vi.fn(),
  putDraftEntityAction: vi.fn(),
  addHubEntityAction: vi.fn(),
  deleteDraftEntityAction: vi.fn(),
  addDraftSurfaceAction: vi.fn(),
  deleteDraftSurfaceAction: vi.fn(),
  runLintAction: vi.fn(),
  saveLintAcksAction: vi.fn(),
  versionDiffAction: vi.fn(),
  requestApplyAction: vi.fn(),
  getApplyAction: vi.fn(),
  applyStepAction: vi.fn(),
  entityMentionsAction: vi.fn(),
  decideReviewAction: vi.fn(),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/standards/entities/versions",
}));

const { EcatNav } = await import("./ecat-shared");
const { DraftBar } = await import("./draft-bar");
const { EntityManager } = await import("./entity-manager");
const { EntityDetailBody } = await import("./entity-drawer");
const { DraftPanel, applyBlockedKey } = await import("./draft-panel");
const { VersionList } = await import("./version-list");
const { ApplyDetail, AbandonPinsNotice } = await import("./apply-detail");
const { ReviewInbox } = await import("./review-inbox");
const { AuditLog } = await import("./audit-log");
const e = await import("@/lib/hgh/adapters/admin-entities");
const { PREVIEW } = await import("@/lib/hgh/adapters/admin-entities.fixture");

const MESSAGES = { ko: await loadMessages("ko"), en: await loadMessages("en") };
const DICT = { ko, en };
const U = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function render(node: ReactNode, locale: "ko" | "en"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={MESSAGES[locale]}
      timeZone="Asia/Seoul"
      onError={(err) => {
        throw err;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const override = (id: string, role: string, over: Record<string, unknown> = {}) => ({
  entity_id: id, origin: "scope", role, name: `n${id.slice(-2)}`, rep_name: null, entity_type: "Brand", brand_code: null, brand_name: null,
  merge_into: null, parent_brand_id: null, note: null, observed: true, updated_at: null, updated_by: null, ...over,
});
const summary = (ver: number, status: string, over: Record<string, unknown> = {}) => ({
  ver, status, title: `t${ver}`, reason: "why", origin: "admin", based_on: ver - 1, created_at: "2026-10-01T00:00:00+00:00", created_by: U(1),
  activated_at: status === "active" ? "2026-10-01T01:00:00+00:00" : null, retired_at: null, submitted_at: null, entity_rows: 2, surface_rows: 1,
  last_apply: status === "active" ? { apply_id: 7, status: "applied", scope_kind: "unexposed", from_round_date: null, requested_at: "2026-10-01T00:00:00Z", finished_at: null } : null,
  ...over,
});
const surface = { surface_id: 5, action: "block", entity_id: U(3), surface: "N", surface_norm: "n", lang: null, created_at: "2026-10-01T00:00:00Z", created_by: U(1) };
const LINT = {
  blocked: true, stale: false, counts: { L1: 1, L2: 2, L3: 0 }, escalated: 1, linted_at: "2026-10-01T00:00:00Z", observed_source: "rd",
  findings: [
    { key: "a", level: "L1", code: "L1_ONE_CHAR", target: "N", detail: "1 char", escalate: false },
    { key: "b", level: "L2", code: "L2_SHORT", target: "Epit", detail: "", escalate: false },
    { key: "c", level: "L2", code: "L2_OWN", target: "Hyundai", detail: "own", escalate: true },
  ],
  acked: ["b"], unacked: ["c"],
};
const active = e.toVersionDetail({ version: summary(2, "active"), content_md5: null, entities: [override(U(1), "own", { brand_code: "Hyundai" })], surfaces: [], lint: null } as never);
const draft = e.toVersionDetail({
  version: summary(3, "draft"), content_md5: null,
  entities: [override(U(1), "own", { brand_code: "Hyundai" }), override(U(3), "removed", { merge_into: U(1) }), override(U(4), "hidden", { origin: "hub", observed: false })],
  surfaces: [surface, { ...surface, surface_id: 6, entity_id: null, surface: "Plus" }], lint: LINT,
} as never);
const list = [
  { entity_id: U(1), name: "Hyundai", role: "own", registered: true, entity_type: "Brand", brand_code: "Hyundai", brand_name: "Hyundai", answers: 9, mentions: 20, updated_at: null },
  { entity_id: U(3), name: "Epit", role: "competitor", registered: false, entity_type: "Brand", brand_code: null, brand_name: "Epit", answers: 3, mentions: 3, updated_at: null },
  // 명부 밖이지만 접두 교정으로 자사(Hyundai) KPI 에 집계되는 엔티티(5차: 역할 배지와 함께 유효 귀속 표시)
  { entity_id: U(5), name: "Hyundai India", role: "competitor", registered: false, entity_type: "Brand", brand_code: null, brand_name: "Hyundai", answers: 4, mentions: 5, updated_at: null, own_brand: "Hyundai" },
] as never[];
const rows = e.mergeEntityRows(list, active, draft);
const diff = e.toDiff({
  ver: 3, against: 2, counts: { entity_added: 1, entity_changed: 1, surface_added: 1 },
  entities: [
    { entity_id: U(3), change: "added", after: { role: "removed", merge_into: U(1), name: "Epit" } },
    { entity_id: U(1), change: "changed", fields: ["note", "role"], before: { role: "own", note: null }, after: { role: "own", note: "x" } },
    { entity_id: U(8), change: "removed", before: { role: "hidden", name: "Old" } },
  ],
  surfaces: [{ surface_id: 5, surface: "N", entity_id: U(3), change: "added", before_action: null, after_action: "block" }],
} as never);
const apply = (status: string, over: Record<string, unknown> = {}) =>
  e.toApplyDetail({
    apply_id: 7, ver: 3, from_ver: 2, status, scope_kind: "from_round", from_round_date: "2026-09-20", reason: "fix N", requested_at: "2026-10-01T00:00:00Z",
    requested_by: U(1), approved_at: null, approved_by: null, has_preview: status !== "draft", requires_approval: true, approver_required: true, can_approve: false,
    actions: status === "previewed" ? ["approve", "preview", "reject"] : status === "applied" ? ["rollback"] : [], error_code: null,
    preview: status === "draft" ? null : PREVIEW, queue: [{ change_id: 1, op: "preview", status: "applied", requested_at: "2026-10-01T00:00:00Z", error: null }],
    ...over,
  } as never);
const review = (kind: string, over: Record<string, unknown> = {}) =>
  e.toReview({
    review_id: 4, kind, status: "pending", entity_id: U(9), display_name: "Newco", entity_type: "Brand", surface: kind === "new_surface" ? "NC" : null,
    n_answers: 3, n_mentions: 5, first_seen_at: "2026-09-20T00:00:00Z", last_seen_at: "2026-09-27T00:00:00Z", alert_grade: kind === "new_surface" ? 1 : null, ...over,
  } as never);

describe("entity version screens render in both locales", () => {
  for (const locale of ["ko", "en"] as const) {
    it(`${locale}: list, drawer body, draft panel`, () => {
      const nav = render(<EcatNav reviewCount={3} />, locale);
      expect(nav).toContain('aria-current="page"');
      expect(render(<DraftBar activeVer={2} draftVer={null} />, locale)).toContain('data-testid="ecat-draft-create"');
      expect(render(<DraftBar activeVer={2} draftVer={3} draftTitle="t3" changes={4} />, locale)).toContain("/admin/standards/entities/draft");

      const html = render(<EntityManager rows={rows} activeVer={2} draftVer={3} draftSurfaces={draft.surfaces} reviewCount={2} />, locale);
      expect(html.match(/data-testid="ecat-entity-row"/g)).toHaveLength(4);
      // 명부 밖 자사 귀속 엔티티: '경쟁사' 역할 배지 옆에 '자사 귀속: Hyundai'(자사 역할 행에는 붙이지 않는다)
      expect(html.match(/data-testid="ecat-own-lineage"/g)).toHaveLength(1);
      expect(html).toContain(DICT[locale].adminEcat.list.ownLineage.replace("{brand}", "Hyundai"));
      const india = render(
        <EntityDetailBody row={rows.find((r) => r.entityId === U(5))!} rows={rows} activeVer={2} draftVer={3} draftSurfaces={draft.surfaces} onOpen={() => {}} />,
        locale,
      );
      expect(india).toContain('data-testid="ecat-own-lineage-warn"');
      expect(india.replaceAll("&#x27;", "'")).toContain(DICT[locale].adminEcat.detail.ownLineageWarn.replaceAll("{brand}", "Hyundai"));
      expect(html).toContain(DICT[locale].adminEcat.roles.removed);

      const body = render(
        <EntityDetailBody row={rows.find((r) => r.entityId === U(3))!} rows={rows} activeVer={2} draftVer={3} draftSurfaces={draft.surfaces} onOpen={() => {}} />,
        locale,
      );
      expect(body).toContain('data-testid="ecat-surface-input"');
      expect(render(<EntityDetailBody row={rows[0]} rows={rows} activeVer={2} draftVer={null} draftSurfaces={[]} onOpen={() => {}} />, locale)).toContain(
        DICT[locale].adminEcat.detail.sectionSamples,
      );

      const panel = render(
        <DraftPanel version={draft.version} diff={diff} names={{ [U(1)]: "Hyundai" }} lint={draft.lint} globalBlocks={draft.surfaces.filter((s) => !s.entityId)} />,
        locale,
      );
      expect(panel.match(/data-testid="ecat-lint-finding"/g)).toHaveLength(3);
      expect(panel.match(/data-testid="ecat-diff-entity"/g)).toHaveLength(3);
      expect(panel).toContain(DICT[locale].adminEcat.apply.blocked.lintBlocked);
    });

    it(`${locale}: versions, apply (pending, previewed, applied), review, audit`, () => {
      const versions = [e.toVersionSummary(summary(3, "draft") as never), e.toVersionSummary(summary(2, "active") as never), e.toVersionSummary(summary(1, "retired", { origin: "cutover" }) as never)];
      const vl = render(<VersionList versions={versions} activeVer={2} draftVer={3} applies={[apply("applied")]} names={{}} />, locale);
      expect(vl.match(/data-testid="ecat-version-row"/g)).toHaveLength(3);
      expect(vl).toContain('data-testid="ecat-version-rollback"');

      const pending = render(<ApplyDetail initial={apply("draft")} />, locale);
      expect(pending).toContain('data-testid="ecat-apply-busy"');
      expect(pending).toContain('data-testid="ecat-preview-pending"');
      const previewed = render(<ApplyDetail initial={apply("previewed")} />, locale);
      expect(previewed).toContain('data-testid="ecat-preview-exposed"');
      expect(previewed).toContain('data-testid="ecat-kpi-round"');
      expect(previewed).toContain('data-testid="ecat-apply-approve"');
      expect(previewed).toContain("<mark");
      expect(previewed).not.toContain('data-testid="ecat-preview-refreeze"');
      const frozen = { applies: true, count: 2, exposed: 1, note: "n", approx: "a", cycles: [] };
      const card = { before: PREVIEW.kpi[0].before, after: PREVIEW.kpi[0].after };
      const refrozen = render(
        <ApplyDetail initial={apply("previewed", { preview: { ...PREVIEW, refreeze: frozen, kpi: [{ ...PREVIEW.kpi[0], card }, ...PREVIEW.kpi.slice(1)] } })} />,
        locale,
      );
      expect(refrozen).toContain('data-testid="ecat-preview-refreeze"');
      expect(refrozen).toContain(DICT[locale].adminEcat.preview.refreezeTitle.replace("{exposed}", "1").replace("{count}", "2"));
      expect(refrozen).toContain('data-testid="ecat-kpi-card"');
      expect(refrozen).toContain('data-testid="ecat-preview-refreeze-approx"');
      expect(refrozen).toContain(DICT[locale].adminEcat.preview.refreezeApprox);
      expect(render(<ApplyDetail initial={apply("previewed", { preview: { ...PREVIEW, refreeze: { ...frozen, approx: undefined } } })} />, locale))
        .not.toContain('data-testid="ecat-preview-refreeze-approx"');
      expect(render(<ApplyDetail initial={apply("previewed", { preview: { ...PREVIEW, refreeze: { ...frozen, applies: false } } })} />, locale))
        .not.toContain('data-testid="ecat-preview-refreeze"');
      const applied = render(<ApplyDetail initial={apply("applied", { error_code: "ECAT_SCAN_FAILED" })} />, locale);
      expect(applied).toContain('data-testid="ecat-apply-rollback"');
      expect(applied).toContain(DICT[locale].adminEcat.errors.ECAT_SCAN_FAILED);
      expect(render(<ApplyDetail initial={apply("failed", { error_code: "ECAT_SOMETHING_NEW" })} />, locale)).toContain("ECAT_SOMETHING_NEW");
      // N2: which cycles an abandon pins, before (confirm dialog body) and after (apply page)
      const pinsRaw = (state: string) => ({
        state, new_ver: 3, active_ver: 3, unexposed: 1, requires_approval_later: true,
        cycles: [
          { cyc_key: 11, round_date: "2026-09-14", surface: "global", exposed: true, pin_ver: 2 },
          { cyc_key: 12, round_date: "2026-09-21", surface: "global", exposed: false, pin_ver: 2 },
        ],
      });
      const planned = render(<AbandonPinsNotice pins={e.toAbandonPins(pinsRaw("planned") as never)!} />, locale).replaceAll("&quot;", '"');
      const tp = DICT[locale].adminEcat.applyDetail.abandonPins;
      expect(planned.match(/data-testid="ecat-abandon-pin"/g)).toHaveLength(2);
      expect(planned).toContain(tp.cycle.replace("{date}", "2026-09-21").replace("{surface}", DICT[locale].adminEcat.surface.global).replace("{ver}", "2"));
      expect(planned).toContain(tp.unexposedTag);
      expect(planned).toContain(tp.approval.replace("{active}", "3"));
      expect(planned).toContain(tp.planned.replace("{count}", "2").replace("{unexposed}", "1").replace("{scope}", DICT[locale].adminEcat.apply.scope.unexposed));
      const failedPlanned = render(<ApplyDetail initial={apply("failed", { actions: ["abandon"], abandon_pins: pinsRaw("planned") })} />, locale);
      expect(failedPlanned).not.toContain('data-testid="ecat-abandon-pins"');                // 포기 전 예정은 확인 대화상자에서만
      const abandoned = render(
        <ApplyDetail initial={apply("rejected", { error_code: "ECAT_APPLY_ABANDONED", abandon_pins: pinsRaw("abandoned") })} />,
        locale,
      ).replaceAll("&quot;", '"');
      expect(abandoned).toContain('data-testid="ecat-abandon-pins"');
      expect(abandoned).toContain(tp.abandoned.replace("{count}", "2").replace("{unexposed}", "1").replace("{scope}", DICT[locale].adminEcat.apply.scope.unexposed));
      expect(render(<AbandonPinsNotice pins={{ ...e.toAbandonPins(pinsRaw("planned") as never)!, cycles: [] }} />, locale)).toContain(tp.nonePlanned);
      // abandon: shown only when the backend offers it (failed), with the abandoned / abandoning messages
      const failed = render(<ApplyDetail initial={apply("failed", { actions: ["abandon"], error_code: "ECAT_SCAN_FAILED" })} />, locale);
      expect(failed).toContain('data-testid="ecat-apply-abandon"');
      expect(failed).toContain(DICT[locale].adminEcat.applyDetail.action.abandon);
      expect(render(<ApplyDetail initial={apply("previewed")} />, locale)).not.toContain('data-testid="ecat-apply-abandon"');
      expect(render(<ApplyDetail initial={apply("rejected", { error_code: "ECAT_APPLY_ABANDONED" })} />, locale)).toContain(
        DICT[locale].adminEcat.errors.ECAT_APPLY_ABANDONED,
      );

      // "preview again" follows the draft lint: a current blocked lint disables it, a stale or clean one does not
      const lintBlocked = render(<ApplyDetail initial={apply("previewed")} lint={draft.lint} />, locale);
      expect(lintBlocked).toContain('data-testid="ecat-apply-preview-lint-blocked"');
      expect(lintBlocked).toMatch(/<button[^>]*disabled=""[^>]*data-testid="ecat-apply-repreview"/);
      for (const lint of [null, { ...draft.lint!, stale: true }, { ...draft.lint!, blocked: false }]) {
        const html = render(<ApplyDetail initial={apply("previewed")} lint={lint} />, locale);
        expect(html).not.toContain('data-testid="ecat-apply-preview-lint-blocked"');
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="ecat-apply-repreview"/);
      }
      // hidden applies to every period at once: from the preview list when present, else from the version diff
      expect(render(<ApplyDetail initial={apply("previewed")} />, locale)).not.toContain('data-testid="ecat-apply-hidden-notice"');
      const hiddenDiff = render(<ApplyDetail initial={apply("previewed")} hiddenFromDiff={e.hiddenChangesInDiff(diff)} />, locale);
      expect(hiddenDiff).toContain('data-testid="ecat-apply-hidden-notice"');
      expect(hiddenDiff).toContain(DICT[locale].adminEcat.applyDetail.hiddenNotice.replace("{count}", "1"));
      const hiddenPreview = render(<ApplyDetail initial={apply("previewed", { preview: { ...PREVIEW, hidden: { all_periods: true, count: 2, changes: [{}, {}] } } })} hiddenFromDiff={0} />, locale);
      expect(hiddenPreview).toContain(DICT[locale].adminEcat.applyDetail.hiddenNotice.replace("{count}", "2"));

      // a rollback draft is read-only; INFO findings (structure already in the base) render in their own group
      const rbPanel = render(
        <DraftPanel
          version={{ ...draft.version, origin: "rollback" }}
          diff={diff}
          names={{}}
          lint={{ ...draft.lint!, findings: [...draft.lint!.findings, { key: "d", level: "INFO", code: "OWN_MERGED", target: "x", detail: "", entityId: null, surfaceId: null, escalate: false }] }}
          globalBlocks={[]}
        />,
        locale,
      );
      expect(rbPanel).toContain('data-testid="ecat-rollback-readonly"');
      expect(rbPanel).toContain('data-level="INFO"');
      expect(rbPanel).toContain(DICT[locale].adminEcat.lint.level.INFO);
      expect(rbPanel).toMatch(/<button[^>]*disabled=""[^>]*data-testid="ecat-global-submit"/);

      const inbox = render(<ReviewInbox items={[review("new_entity"), review("new_surface")]} status="pending" kind={null} q="" draftVer={null} mergeOptions={[]} />, locale);
      expect(inbox.match(/data-testid="ecat-review-row"/g)).toHaveLength(2);
      const audit = render(
        <AuditLog
          items={[e.toAudit({ audit_id: 9, ts: "2026-10-01T00:00:00Z", action: "apply.approve", actor_id: U(1), ver: 3, apply_id: 7, detail: { a: 1 } } as never)]}
          limit={1}
          beforeId={null}
        />,
        locale,
      );
      expect(audit).toContain("before_id=9");
    });
  }
});

describe("dictionary keys chosen at run time exist in both locales", () => {
  const get = (m: unknown, path: string) => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], m);
  const paths = [
    ...[...e.ECAT_ERROR_CODES, "notFound", "conflict", "invalid", "generic", "reasonRequired"].map((c) => `errors.${c}`),
    ...["notLinted", "stale", "lintBlocked", "unacked"].map((k) => `apply.blocked.${k}`),
    ...["unexposed", "from_round", "all"].flatMap((k) => [`apply.scope.${k}`, `apply.scopeHint.${k}`]),
    ...["remove", "block", "add", "restore", "unblock", "move"].map((k) => `preview.change.${k}`),
    ...["draft", "previewed", "approved", "running", "applied", "rejected", "failed", "rolled_back"].map((k) => `status.apply.${k}`),
    ...["draft", "active", "retired", "discarded"].map((k) => `status.version.${k}`),
    ...["pending", "resolved", "dismissed"].map((k) => `status.review.${k}`),
    ...["own", "competitor", "hidden", "removed"].flatMap((k) => [`roles.${k}`, `detail.roleHint.${k}`]),
    ...["legacy", "precutover", "unavailable"].map((k) => `page.${k}`),
    ...["approve", "preview", "reject", "resume", "abandon", "rollback"].flatMap((k) => [
      `applyDetail.action.${k}`,
      `applyDetail.done.${k}`,
      `applyDetail.confirm.${k}.title`,
      `applyDetail.confirm.${k}.body`,
    ]),
    ...["cutover", "admin", "rollback"].map((k) => `origin.${k}`),
    ...["L1", "L2", "L3", "INFO"].map((k) => `lint.level.${k}`),
    ...["global", "website", "project"].map((k) => `surface.${k}`),
    ...["new_entity", "new_surface"].flatMap((k) => [`review.kind.${k}`, `review.decideHint.${k}`]),
  ];
  it("each path is a non-empty string, without long dashes", () => {
    for (const [name, dict] of [["ko", ko], ["en", en]] as const) {
      for (const p of paths) {
        const v = get((dict as { adminEcat: unknown }).adminEcat, p);
        expect(typeof v === "string" && v.length > 0, `${name} adminEcat.${p}`).toBe(true);
      }
      expect(JSON.stringify((dict as { adminEcat: unknown }).adminEcat)).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("ko and en have the same adminEcat keys; apply block key mirrors the lint state", () => {
    const keys = (o: unknown, p = ""): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === "object" && v ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(en.adminEcat).sort()).toEqual(keys(ko.adminEcat).sort());
    expect(applyBlockedKey(null)).toBe("notLinted");
    expect(applyBlockedKey({ ...draft.lint!, stale: true })).toBe("stale");
    expect(applyBlockedKey(draft.lint)).toBe("lintBlocked");
    expect(applyBlockedKey({ ...draft.lint!, blocked: false })).toBe("unacked");
    expect(applyBlockedKey({ ...draft.lint!, blocked: false, unacked: [] })).toBeNull();
  });
});
