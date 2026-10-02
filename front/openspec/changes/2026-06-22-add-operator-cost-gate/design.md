# Design — 운영자 비용 게이트

## 결정 배경

유저 시나리오(3-2)와 현행 코드가 충돌했고(아래), 2026-06-22 "시나리오가 최신 의사결정"으로
확정되어 코드를 시나리오에 맞춘다.

| 항목 | 시나리오(3-2) | 현행 코드 | 결정 |
| --- | --- | --- | --- |
| 외부 수행사(vendor) | 운영자 영구 OFF, 배정 READ만 | `PROJECT_CREATORS` 에 포함(생성 가능) | 시나리오 채택 → vendor 영구 OFF |
| 그룹사(HQ/권역/국가) | 기본 OFF, 지정 시 배정 한정 ON | 역할만으로 생성·실행 도달 | operator 차원으로 게이팅 |
| 비용 통제 단위 | 운영자 ON/OFF 플래그 | 없음 | `profiles.operator` 도입 |

## operator 는 role 과 **직교(orthogonal)** 한다

- `role` = 무엇을 **볼** 수 있나(데이터 scope + 라우트). 기존 그대로.
- `operator` = 비용 유발 액션을 **실행**할 수 있나. 신규.

둘을 한 enum 으로 합치지 않는다 — 한 역할 안에서도 운영자/비운영자가 갈리고(그룹사 "지정 시
ON"), 한 사람의 데이터 가시성과 실행 권한은 서로 다른 축이기 때문. scope-policy(값) /
route-policy(장소) 분리 원칙과 동일한 이유로 operator-policy(비용 액션)를 별도 모듈로 둔다.

## operator 3-값 의미론

| 값 | 주체 | 생성 | 수집·실행 |
| --- | --- | --- | --- |
| `global` | 이노션 본사 | ○ (scope 내) | ○ (scope 내 모든 프로젝트) |
| `assigned` | 이노션 법인 · 지정 그룹사 | ✕ | ○ (active member 프로젝트 한정) |
| `none` | 외부 수행사(영구) · 미지정 그룹사(기본) | ✕ | ✕ (조회만) |

- **생성(create)** 은 `global` 전용: "법인은 배정 프로젝트 한정"이므로 신규 프로젝트 발의는
  본사(global) + admin 만. 생성자는 자동으로 해당 프로젝트 Owner(=배정)가 된다.
- **수집·실행(operate)** 은 `global`(scope 내 무제한) 또는 `assigned`(배정 프로젝트 한정).
  배정 여부는 기존 `project_members`(active) 로 판정 — 새 배정 테이블을 만들지 않는다.
- `admin` 은 개발 superuser 로 모든 게이트 우회(2026-06-02 기존 규약 유지).

## owner/viewer vs operator

- `project_members.role`(owner/viewer) = 프로젝트 **관리** 권한(초대·설정·삭제). 변경 없음.
- operator = 비용 **실행** 권한. 별도 축.
- 비용 액션(수집·실행)은 owner 여부가 아니라 **active member + operator≠none** 으로 게이팅한다.
  (기존 `requireOwner` 게이트는 관리성 mutation(분류·삭제·초대)에만 유지.)

## vendor 영구 OFF 강제 — 이중 방어

1. `session.ts` 도출 시 role=`vendor` → `operator='none'` 으로 정규화(저장값 무시).
2. admin 갱신 액션에서 role=`vendor` 인 대상의 operator 를 `none` 외 값으로 저장 시도 → 거부.

## 게이팅 지점(단일 진실의 원천)

`lib/auth/operator-policy.ts`:

```
canCreateProject(user): boolean
  admin → true; operator==='global' → true; else false

canOperateProject(user, membership): boolean
  admin → true
  operator==='none' → false
  operator==='global' → true
  operator==='assigned' → membership?.status==='active'
```

비용 액션 서버 액션이 이 함수만 호출한다(중복 정의 금지). UI(메뉴/버튼)도 동일 함수로 가시성을
도출해 *보이는 것 = 할 수 있는 것* 을 유지한다.

## 마이그레이션 안전성

`profiles.operator` 는 NOT NULL DEFAULT `'none'` 추가 ALTER — 기존 행은 자동으로 `none`(=조회만,
가장 안전한 기본값). 0007 prod outage 교훈대로 기존 컬럼 변경 없이 additive 만.
