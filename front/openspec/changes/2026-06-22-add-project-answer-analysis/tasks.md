## 1. scope seam (per-project read)

- [x] 1.1 `lib/scope/result-adapter.ts` — `aggregateProjectCitations`(jobs `?include=result` → 인용)
      + `fetchAllJobs`/`fetchJobsForRuns` 에 `includeResult` 옵션.
- [x] 1.2 `lib/scope/server.ts` — `fetchProjectMentions`/`fetchProjectCitations` + `resolveScopeProjectId`
      (enforce + assertProjectInScope; live 미매핑 → null).

## 2. mock 합성 측정

- [x] 2.1 `lib/scope/mock.ts` — 결정론적 SYNTH 프롬프트/잡(멘션 + 인용 + Category/Subcategory).
- [x] 2.2 `listMeasurementRuns`/`listRunJobs`(include=result 존중)/`listPrompts` 오버라이드.

## 3. 페이지 배선

- [x] 3.1 `projects/[id]/analysis/mention/page.tsx` — `fetchProjectMentions(id, filters)` 렌더.
- [x] 3.2 `projects/[id]/analysis/citation/page.tsx` — `fetchProjectCitations(id, filters)` 렌더.

## 4. 검증

- [ ] 4.1 `tsc` · `npm test` · `npm run lint`(lib/db 경계) · `check:strings` 통과.
- [ ] 4.2 (후속) live 세션 + scope `?include=result` 배포 시 실데이터 확인.
- [ ] 4.3 (후속) per-project read 캐싱(unstable_cache) — 현재 비캐시(HTTP 경로).
