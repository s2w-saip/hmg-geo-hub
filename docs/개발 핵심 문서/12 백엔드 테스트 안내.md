# back 테스트 가이드(기능 빌더용)

로컬 개발 DB(PostgreSQL 17 컨테이너 `hgh-dev-pg`, 합성 픽스처만)와 공용 픽스처로 기능 테스트를 쓴다. **고객 데이터 금지, 로컬 전용.**
CI(`ci/github-workflows/back-ci.yml`)는 같은 DB 를 postgres:17 서비스로 올려 ruff + pytest(가드 포함)를 돌린다.

## 1. 준비

```bash
bash back/db/dev-db.sh up                 # 컨테이너가 없으면 기동(4g·max_connections 500), 있으면 템플릿 hmg_tpl 만 재구성
bash back/db/dev-db.sh clone <빌더키>      # hmg_<빌더키> = 템플릿 복제본(빌더마다 따로. 다른 빌더 DB 를 쓰지 않는다)
export HGH_TEST_DB_URL="$(bash back/db/dev-db.sh url <빌더키>)"
cd back && python -m pytest app/features/<대분류>/<도메인>/<기능>/tests -q
```

- **clone 이름 = 빌더 키**: 영문 소문자·숫자·밑줄(예: `kpi_summary`, `mentions`). 복제본은 자유롭게 써도 되고 망가지면 다시 clone 한다.
- `HGH_TEST_DB_URL` 이 없으면 DB 테스트(`@needs_db`)는 건너뛰고 단위 테스트만 돈다.
- 컨테이너는 여럿이 공유한다: `down`·`restart` 는 합의 후에만. `up` 은 템플릿만 다시 만들고(기존 복제본은 그대로) 다른 빌더에 영향이 없다.
- 템플릿 = `DB-v2.26.sql` → `fixture-00-rules.sql`(판정 규칙) → `fixture-10-data.sql`(합성 원본) → `seed-30-dims.sql` → `seed-40-facts.sql` → `rd.refresh_entity_mention_total(NULL)`(엔티티 합계, dev-db.sh·CI 같음).
  옛 템플릿(v2.10·v2.11 = 로컬 hmg_tpl 을 다시 만들기 전)이면 루트 conftest 의 세션 자동 픽스처 `_db_latest`(tests/dbforward.py)가 **복제본에만**
  `DB-v2.11-patch.sql` → `DB-v2.12-patch.sql` → `DB-v2.13-patch.sql`(동기화 S1 BE-B `rd.answer.cit_off`) → `DB-v2.14-patch.sql`(원장 발행 게이트) → `DB-v2.15-patch.sql`(현행 재현 되돌림 열. 이번에 적용했으면 bulk 시드 seed-30·40 을 한 번 다시 돌려 시드가 쓰는 P88·P89 열을 새 템플릿과 같게 채운다, P85~P87 은 NULL) → `DB-v2.16-patch.sql`(WU-7 웹 보고서 유닛 표 3개, 빈 표. 명세 행은 시험이 준비) → `DB-v2.17-patch.sql`(엔티티 버전 모델, 버전 없음 = 기존 명부 동작 그대로)
  → `back/migration/fill-cit-off.sql`(commit=1)을
  차례로 적용한다(템플릿 이름이면 거부). DB-v2.13 부터 적재기·core.measure·seed-40 이 새 열을 읽고 쓰므로 모든 DB 시험의 전제다
  (`rcache_db`·`db_v212` 픽스처는 이미 적용됐으면 건너뛴다).

### 전체 실행(대분류 여럿을 한 복제본에서)

- `python -m pytest`(대분류 둘 이상)는 대분류(tests/core · app/features/<x> · ingest)가 바뀔 때마다 복제본을 세션 시작 상태로 되돌린다
  (`tests/area_reset.py`, 세션 첫 시험 전 `<db>_pristine` 복제 → 경계마다 DROP·재생성 + 공용 계정 행, 끝에 pristine 삭제). 쓰기 시험이 커밋하고
  남기는 행(카탈로그 seed.py·admin 생성 등)이 뒤 대분류를 오염시키지 않는다. 공식 게이트 `tests/run-areas.sh` 와 같은 격리 단위이고,
  대분류 하나만 도는 실행에서는 아무것도 하지 않는다. 끄기: `HGH_TEST_AREA_RESET=0`. 같은 대분류 안의 순서 의존은 범위 밖(재진입 안전 규약).

### 현행 프로필(HGH_LEGACY_PROFILE)을 켠 시험

- `HGH_TEST_LEGACY_PROFILE=<off | implemented | 스위치 쉼표 목록>`(기본 off). `implemented` = 구현된 스위치 전부(stg 배포 값과 같다).
  운영 env `HGH_LEGACY_PROFILE` 은 시험이 읽지 않는다.
- 세션 `settings` 픽스처·적재기·bulk 시드(`ingest.testkit.bulk_seed`, 기본 = 활성 프로필)가 같은 값을 쓴다. 투영 스위치(rep_pick_latest_first·
  rep_round_date_cell·resub_phantom_exclude·cit_hostless_per_row·web_owned_target_base·display_name_latin)가 켜져 있으면 세션 시작에 복제본 rd 를 그 프로필로 다시
  투영한다(`tests/dbforward.project_test_profile`, 1회, DB 주석 `hgh-test-projection:<스위치>` 로 표시. 템플릿은 거부).
- 시험 하나만 다른 프로필: `@pytest.mark.legacy_profile("spec")`(활성 프로필만 바꾼다, rd 재투영 없음). 투영 스위치를 고정하는 시험은
  bulk 시드도 `bulk_seed(conn, profile=OFF 또는 parse_profile(spec))` 로 같은 값을 직접 넘긴다.
- 예: `HGH_TEST_LEGACY_PROFILE=implemented HGH_TEST_DB_URL=… python -m pytest ingest -q`

## 2. 공용 픽스처·상수

픽스처는 `back/conftest.py`, 상수·도우미는 `tests/support.py`(기능 테스트에서 `from tests.support import …`).

| 이름 | 종류 | 내용 |
| --- | --- | --- |
| `client_as` | 픽스처 | `async with client_as(HQ_HYUNDAI) as c: r = await c.get("/v1/…", params=…)`. 앱 = `app.main.app`, `None` 이면 무인증 |
| `token` | 픽스처 | `token(uid, exp_in=…, aud=…)` → 테스트 서명 키 JWT(RS256, kid `test-kid`) |
| `database`·`ro`·`refs` | 픽스처 | `core.db.Database`, api_ro 트랜잭션 커넥션, 참조 차원(`core.codes.Refs`) |
| `seeded` | 픽스처 | 아래 계정 7종·멤버십 멱등 UPSERT(`database` 가 자동 의존) |
| `settings` | 픽스처 | test 설정: SQL 경계 가드 켬, QA 게이트 켬(비밀번호 `pw-test`) |
| `needs_db`·`TODAY`·`DB_URL` | 상수 | DB 테스트 표식, 회차 노출 기준일 2026-09-27(`ctx.window(conn, today=TODAY)`), URL |
| `make_token`·`principal` | 함수 | 토큰 발급, 계정 → `Principal` |
| `staged(...)`·`Rows`·`Update`·`SqlFile`·`Sql`·`load_named_sql` | 함수 | 롤백 전용 준비: 소유자로 행을 더하고(가드 밖) 같은 트랜잭션에서 api_ro 로 요청(`client_as`)·기대값 SQL 을 돈다. 끝나면 ROLLBACK(아래 6절) |

## 3. 계정 7종(`tests.support`)

| 상수 | role | operator | 스코프 | 메뉴 | 비고 |
| --- | --- | --- | --- | --- | --- |
| `ADMIN` | admin | global | 전체(scope_all) | 무제한 | admin 은 항상 전체 스코프(Q16) |
| `HQ_HYUNDAI` | hq | assigned | 브랜드 Hyundai | standard·project | 고객 프로젝트 비멤버지만 스코프 안이라 열람 가능, 소유·운영 불가 |
| `KIA_US` | country | none | Kia · 국가 US | 무제한 | 글로벌 자사 인용 = 국가 1개 좁힘(country1) |
| `VENDOR` | vendor | none | 브랜드 없음(데이터 스코프 무제한, 추가 결정) | project | 고객 프로젝트 활성 멤버(viewer). 표면 경로 게이트로 global·website 는 403 `role_forbidden`(D-vendor) |
| `KIA_EU` | region | none | Kia · 권역 kia-western-europe | 무제한 | 권역 → 국가 전개(DE 포함) |
| `SUSPENDED` | hq | none | Hyundai | 무제한 | 정지 계정 → 401 `no_account` |
| `WEBSITE_KIA` | website | none | 브랜드 Kia | website | 웹사이트 경로만(global·project 403 `role_forbidden`) |

## 4. 합성 데이터 범위(`tests/fixtures/fixture-10-data.sql`)

| 표면 | 프로젝트(project_key) | 회차(cyc_key · round_date · 노출일) | 주요 답변 |
| --- | --- | --- | --- |
| global | 루트 `ROOT_PROJECT`(1) | 10 · 09-07 · 09-09 / 11 · 09-14 · 09-16 / 12 · 09-21 · open(비서빙) | 회차 11 스냅샷: 서빙 13건(US·KR·DE·ID), std_in 3(k1·k2·k12) |
| website | Kia DE 사이트 `KIA_DE_SITE`(2), 유닛 101·102 | 21 · 09-18 · 09-19 · **인용 숨김** | k21·k22 |
| project | 고객 `CUST_PROJECT` Hyundai US(3) | 31 · 09-20 · 09-21(가상 회차) | k31 |

- 서빙 답변 19건(job 21건: 비완료 1·드롭 1), 인용 19건, answer_brand 10건. 엔진 chatgpt·gemini(기본)·deepseek.
- 브랜드: 카탈로그 비트 Hyundai 1·Kia 2·Genesis 4·HMG(엄브렐러) 8·Hyundai N 16. 숨김 표준 국가 ID.
- 발행값(R09): 2026-09-18 유닛 101·102(Kia DE)·301(Kia FR, 웹 유닛 없음)·401(Hyundai DE), 2026-09-25 유닛 102(가상 지역 `SA-Dammam`).
- 정수 키(geo_key·prompt_key 등)는 하드코딩하지 말고 `refs.geo_key("US")` 처럼 코드로 찾는다(픽스처가 늘면 번호가 바뀐다).
- 손 계산 기대값: `tests/fixtures/check-expected.sql`(94건: DB-v2.13 cit_off 합·음성 2건 추가), 지표 예시는 `tests/core/test_db.py` 머리 주석.

## 5. 규칙

- 기능 SQL 은 `app.core.measure`·`core.cycles.Window.where` 빌더를 쓴다. 테스트 중 모든 실행 문장은 SQL 경계 가드(`app.core.sqlguard`,
  `HGH_SQL_GUARD`)를 거친다: 사실 표 3술어(surface·round_date·cyc_key), ing·리프 참조 금지, FILTER 밖 비트 연산 금지, SET·set_config(app.* 밖) 금지.
  위반은 `SqlGuardError` 로 테스트가 실패한다. 기능 모듈의 파싱되는 SQL 문자열·`.sql` 파일은 `tests/core/test_guards.py` 가 정적으로도 검사한다.
- 기능 코드에서 `hgh_sql_guard`·`driver_connection`·`get_raw_connection` 을 쓰지 않는다(정적 테스트가 막는다).
- 가드는 실수를 잡는 린트이고 보안 경계는 DB 권한(api_ro 읽기 전용, ing 권한 없음, api_rw rd 권한 없음)이다.
- 계정 쓰기(`app.user_account`)는 행위자 GUC 가 필요하다(`Database.write(uid)` 또는 `set_config('app.actor_id', …)`).
- 복제본 밖(템플릿·다른 빌더 DB)을 쓰지 않는다. 컨테이너 전역 롤을 바꾸지 않는다(필요하면 임시 롤을 만들고 지운다).

## 6. 픽스처에 없는 상태 만들기(`tests.support.staged`)

숨김 회차·추가 사실 행·발행값 변형처럼 합성 픽스처에 없는 상태는 **롤백 전용** 준비로 만든다. 커밋하지 않으므로 다른 테스트·빌더에 영향이 없다.

```python
from tests.support import HQ_HYUNDAI, Rows, SqlFile, Update, staged

async def test_hidden_round(client_as):
    async with staged(Update("rd.cycle", {"cyc_key": 11}, {"hidden_scope": 3, "hidden_reason": 1}),
                      SqlFile(pathlib.Path(__file__).with_name("extra.pgsql"))) as conn:
        async with client_as(HQ_HYUNDAI) as c:
            r = await c.get("/v1/trend", params={"surface": "global"})      # 이 트랜잭션에서 api_ro 로 돈다
```

- 준비 단계(`Rows`·`Update`·`SqlFile`·`Sql`·임의 `async def step(conn)`)는 소유자로 가드 없이 실행한다. 준비 SQL 은 기능 폴더
  `tests/*.pgsql` 데이터 파일에 두고(정적 가드는 `*.py` 문자열·`*.sql` 만 검사), 기능 `.py` 문자열에 rd 쓰기 SQL 을 쓰지 않는다.
- 준비 뒤 `set_config('role', 'api_ro', true)`(role=None 이면 소유자 유지) → 엔진에 실행 가드 → `get_ro_conn` 을 이 커넥션으로 덮어쓴다.
  블록 안의 요청·기대값 SQL 은 전부 SQL 경계 가드를 거친다. 블록이 끝나면 의존성 원복 + ROLLBACK.
- `-- name: x` 로 나눈 준비 파일은 `load_named_sql(path)` 로 읽어 `Sql(stmts["x"], (인자,…))` 로 쓴다.
