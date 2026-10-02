# Add catalog prompt audit log

## Why

표준(글로벌) 카탈로그 프롬프트는 현재 앱에서 본문 편집이 불가(배치 SQL 경유)하고,
수정 이력이 어디에도 남지 않는다. GGMD 요구: 프롬프트가 수정되면 누가·언제·무엇을
바꿨는지 기록이 남아야 하며(고객 열람 + 내부 추적 + 측정 해석 + 감사), 편집 자체가
앱으로 들어와야 이력이 완전해진다. (2026-08-12 인터뷰 확정 — 정본 스펙은 workspace
`internal-kb/hmg-ggmd-global-prompt-audit-log-spec-2026-08-12.md`)

## What Changes

- `prompt_audit_logs` append-only 테이블 신설 + `prompts.updated_by`/`deleted_at` 추가 (0041)
- 표준 카탈로그 편집 신설: 단건(text·라벨) + 벌크 xlsx + soft-delete/복원 — admin 전용
- 쓰기 경로 정규화: 생성이 로컬 카탈로그 행도 만들도록 수정(현재 Scope 단독 생성 → orphan)
- 모든 카탈로그 mutation이 로컬 트랜잭션(UPDATE+로그 INSERT+Scope PATCH 콜백)으로 원자화
- 열람: 프롬프트별 타임라인 + `/standard/prompts` 이력 탭 + CSV (NON_VENDOR 열람)
- dashboard 추이 차트에 프롬프트 변경 마커

## Capabilities

### New Capabilities

- `catalog-prompt-audit`: 카탈로그 프롬프트 수명주기 이벤트의 append-only 감사 원장과 열람 면

## Impact

- `lib/db/migrations/0041_prompt_audit_logs.sql`, `lib/db/schema.ts`
- `lib/db/repositories/prompt-audit-logs.ts`(신설), `standards.ts`, `prompts.ts`
- `lib/standards/audit.ts`(신설), `lib/standards/excel.ts`(신설)
- `app/[locale]/(dash)/admin/standards/_actions.ts` + `prompts/_components/*`
- `app/[locale]/(dash)/standard/prompts/*`(이력 탭·타임라인), `dashboard/_components/live-trend-chart.tsx`
- 보안 경계 유지: DB는 리포지터리 경유만, scope는 `lib/scope/server.ts` 게이트 경유만, 신규 (dash) 라우트 없음(이력은 기존 `/standard/prompts`의 탭)
- 한계: append-only의 DB 수준 강제는 앱 접속 롤이 owner인 구성에서 불완전 — 비owner 롤 REVOKE + 리포지터리에 update/delete 메서드 부재 + ESLint `@/lib/db` 경계의 3중 방어(2026-08-12 확정)
