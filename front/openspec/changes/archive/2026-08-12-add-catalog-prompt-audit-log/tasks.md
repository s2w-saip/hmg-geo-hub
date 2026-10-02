# Tasks — add-catalog-prompt-audit-log

계획 정본: `internal-kb/hmg-ggmd-global-prompt-audit-log-implementation-plan-2026-08-12.md`

## 1. 데이터 계층

- [x] 1.1 `lib/db/migrations/0041_prompt_audit_logs.sql` — 원장 테이블(uuid PK·CHECK·인덱스 3종·REVOKE) + `prompts.updated_by`/`deleted_at` (멱등, drizzle 저널 무변경)
- [x] 1.2 `lib/db/schema.ts` — `promptAuditLogs` 정의 + prompts 컬럼 2개
- [x] 1.3 `lib/standards/audit.ts` — `PromptAuditEventType`/`PromptAuditChanges`/`computeChanges` (+ 테스트)
- [x] 1.4 `lib/db/repositories/prompt-audit-logs.ts` — listForPrompt/listGlobalScoped/listDailyCounts/insert + composite(applyAuditedCatalogChange·createAuditedCatalogPrompt)
- [x] 1.5 `lib/db/repositories/standards.ts` — StandardCatalogRow.deletedAt·includeDeleted·뷰어/집계 삭제 제외

## 2. 액션 계층

- [x] 2.1 `admin/standards/_actions.ts` — requireCatalogEditor + updateStandardPromptText/Labels·softDelete·restore (+ `_actions.audit.test.ts`)
- [x] 2.2 기존 액션 배선 — createStandardPrompt 정규화(로컬+scope 원자)·setStandardPromptKind composite·deleteStandardPrompt→softDelete 위임·toggleEnabled 로그
- [x] 2.3 `lib/db/repositories/prompts.ts` — getByScopePromptId
- [x] 2.4 `lib/standards/excel.ts` — buildCatalogWorkbook/parseCatalogWorkbook (kind 제외, + 테스트)
- [x] 2.5 벌크 액션 — exportStandardCatalogXlsx·previewStandardCatalogImport·applyStandardCatalogChunk(≤25, batch_id)

## 3. UI 계층

- [x] 3.1 admin 편집 — prompt-edit-dialog·삭제/복원·삭제됨 뷰 (+ i18n ko/en)
- [x] 3.2 admin 벌크 — catalog-io.tsx (업로드→프리뷰→청크 적용·진행률·실패 재시도)
- [x] 3.3 열람 — `standard/prompts/_actions.ts`(fetchPromptAuditTimeline)·PromptAuditTimeline·이력 탭(AuditHistoryView)·CSV
- [x] 3.4 차트 마커 — prompt-change-markers·LiveTrendChart 통합·서버 로드 배선

## 4. 마무리

- [x] 4.1 배치 로더 강등 헤더 — load-standard-prompts-v04.sql·gen-standard-prompts-v04.mjs·reconcile-v04.ts
- [x] 4.2 배포 게이트 — `npm run db:apply -- 0041`(멱등 2회)·Scope live root text PATCH 실측·프리뷰 그라운딩

## 검증

- [x] 5.1 `npx tsc --noEmit` · `npm test` · `npm run lint`(lib/db 경계) · `npm run check:strings` 통과
