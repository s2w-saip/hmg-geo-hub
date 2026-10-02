## 1. 데이터 모델 (lib/db)

- [ ] 1.1 `lib/db/schema.ts` — `operatorEnum`(`operator_scope`: none/assigned/global) +
      `profiles.operator` NOT NULL DEFAULT `'none'`(additive ALTER, 기존 행 안전).
- [ ] 1.2 `npm run db:generate` → 마이그레이션 생성 / `db:migrate` 적용(env 가능 시).
- [ ] 1.3 `lib/db/repositories/profiles.ts` — update 액션이 operator 를 patch 에 포함.

## 2. Auth 타입·도출 (lib/auth)

- [ ] 2.1 `lib/auth/types.ts` — `OperatorScope = "none"|"assigned"|"global"` + `User.operator`.
- [ ] 2.2 `lib/auth/session.ts` — profiles.operator → User.operator. role=vendor → `none` 정규화.
- [ ] 2.3 `lib/auth/operator-policy.ts`(신규) — `canCreateProject(user)` / `canOperateProject(user, membership)`
      단일 진실의 원천 + JSDoc.

## 3. 라우트·메뉴 가시성

- [ ] 3.1 `lib/auth/route-policy.ts` — `PROJECT_CREATORS` 에서 vendor 제거. `/projects/new` 는
      operator 게이트로 위임(주석 갱신: route=장소, operator=비용 액션).
- [ ] 3.2 프로젝트 목록 "새 프로젝트" 진입점 — `canCreateProject` 로 가시성 도출.

## 4. 비용 액션 강제(서버 액션)

- [ ] 4.1 `projects/new/_actions.ts` — `createProject` 시작부에 `canCreateProject` 재확인(거부 시 차단).
- [ ] 4.2 `projects/[id]/prompt/_actions.ts` — `executePrompts` 를 `canOperateProject`(membership 조회)로 게이팅.
- [ ] 4.3 `projects/[id]/intent/_actions.ts` — `addCandidate` 를 `canOperateProject` 로 게이팅.
- [ ] 4.4 관리성 mutation(분류·삭제·초대)은 기존 `requireOwner` 유지(비용 액션 아님).

## 5. Admin 운영자 부여 UI·액션

- [ ] 5.1 `admin/_actions.ts` — 사용자 갱신에 operator 포함(원자적 patch). vendor → none 강제, 위반 거부.
- [ ] 5.2 admin 사용자 편집 다이얼로그 — operator 선택 컨트롤(역할 vendor 선택 시 비활성/none 고정).

## 6. i18n + seed

- [ ] 6.1 `messages/{ko,en}.json` — `admin.user.operator.*`(none/assigned/global 라벨),
      비용 액션 거부 메시지, 프로젝트 생성 비활성 안내.
- [ ] 6.2 `scripts/db/seed.ts` — 데모 계정 operator 부여(이노션 본사 global / 법인 assigned /
      vendor none / 그룹사 none).

## 7. 테스트·검증

- [ ] 7.1 `lib/auth/operator-policy.test.ts` — canCreateProject/canOperateProject × operator 3값 ×
      membership 유무 × vendor 강제 OFF.
- [ ] 7.2 `npm test` · `tsc --noEmit`(build) · `npm run lint`(lib/db 경계) · `check:strings` 통과.
- [ ] 7.3 (후속) 라이브 세션에서 operator 별 생성/실행/수집 버튼 가시성 + 차단 수동 확인.
