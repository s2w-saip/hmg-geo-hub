# back/db/synth — 합성 운영형 데이터(고객 데이터 0 · 운영 접속 0)

운영(hmg-geo.vercel.app)과 **비슷하게 보이는** 개발·데모·QA 환경과, 운영 규모의 성능 시험 DB를 만든다.
값은 전부 `synth.py`가 생성한다. 운영 DB·운영 화면·운영 API에는 한 번도 접속하지 않는다.

## 1. 원칙(리스크 0)

| 원칙 | 지키는 방법 |
| --- | --- |
| 운영 부하 0 | 운영에 접속하지 않는다. 볼륨 기준은 레포 문서에 이미 있는 행 수, 모양 기준은 코드 상수다. 화면 서버(next dev)는 외부 통신 차단 훅(`front/e2e/lib/no-egress.cjs`)을 걸고 띄운다 |
| 운영 값 복사 0 | 운영 KPI 값·운영 카탈로그 문구·운영 답변 원문을 쓰지 않는다. 프롬프트 문구·답변 원문은 템플릿 생성 |
| 이름 | HMG 3사·경쟁 브랜드·차종·상위 출처 사이트는 공개 이름. 출처 롱테일은 예약 TLD `.test`(RFC 2606) |
| 규칙 표 | 브랜드 비트·공식 도메인·카테고리 규칙은 코드 상수 발췌인 `tests/fixtures/fixture-00-rules.sql`·`migration/seed/seed-3x-rules.sql` 그대로 |
| 계정 | E2E 합성 계정(`back/tests/support.py` ACCOUNTS_SQL = `front/e2e/accounts.json`, `@example.test`) |
| 표시 | 고객 프로젝트 이름은 `SYNTH · …`, 설명 "합성 데이터 프로젝트(고객 데이터 아님)" |
| 산출물 | `out/`(gitignore). 재생성 가능하므로 커밋·공유하지 않는다 |

## 2. 무엇을 어떻게 만드나

`synth.py`가 `app.*`·`ing.*` 행을 CSV(gzip)로 만든다. `synth-db.sh load`는 이것을 dev-db와 같은 경로로 적재한다:
`DB-v2.32.sql` → `fixture-00-rules.sql` → **합성 app·ing**(= `fixture-10-data.sql` 자리) → `seed-30-dims.sql` → `seed-40-facts.sql` →
`rd.refresh_entity_mention_total` · `rd.refresh_cycle_pick_basis`.
seed-30·40의 불변식 단언을 그대로 통과하므로 `rd.*`는 적재기와 같은 규칙으로 채워진다.

모양(값이 아니라 구조)의 근거:

| 항목 | 합성 규칙 | 근거 |
| --- | --- | --- |
| 엔진 | chatgpt·gemini(기본) + deepseek(프롬프트 40%) | `front/lib/scope/engines.ts:16,37` |
| 글로벌 시장 | 영어 프롬프트 = 8개 시장 태그(AE BE BR CA DE EG FR US), 한국어 = KR, 8/31부터 다국어 36개 시장 | `front/lib/standards/prompt-markets.ts`, `front/lib/scope/hidden-regions.ts` |
| 카탈로그 | 퍼널 3값·리스트 유형 2값·depth 라벨, scope 프롬프트 30%는 브랜드가 다른 카탈로그 행 2개 | `front/components/dash/dimension-filter-panel.tsx` |
| 회차 | 주간. 글로벌 월요일·웹사이트 금요일(사이트 정렬)·프로젝트 파생. 표시 지연 2·1·1일(KST 자정) | `back/ingest/cycles/ledger/service.py`, `app.rule_param` |
| 열린 회차 | 마지막 회차가 앵커 뒤 72시간(프로젝트 30시간) 안이면 측정 중·분석 대기 일부 | — |
| 추이 | 주마다 HMG 등장·긍정 편향·공식 출처 비율·경쟁사별 가중을 평균 회귀 랜덤 워크로 흔든다 | — |
| 출처 | 상위 공개 사이트 → 카테고리 시드 도메인(코드 상수 795개) → `.test` 롱테일(Zipf) | `migration/seed/seed-3x-rules.sql` `_r_cat_seed` |

운영 규모(scale 1, `--seed 1`) 실측. 운영 열은 2026-10-06 n_live_tup 추정(`docs/reports/부록/데이터 이관 문서 검토 메모.md`, 마이그레이션 부록 A):

| 표 | 합성 | 운영 |
| --- | ---: | ---: |
| 답변 `ing.answer` | 856,782 | 854,710 |
| 언급 `ing.mention` | 6,916,234 | 6,787,327 |
| 발생 `ing.mention_occurrence` | 8,088,732 | 7,876,641 |
| 인용 `ing.citation` | 7,229,956 | 7,179,865 |
| 스탠스 `ing.answer_stance` | 974,962 | 958,476 |
| ACR 롤업 `ing.acr_rollup_row` | 981,555 | 1,077,813 |
| 앵커 핀 `ing.answer_anchor_pin` | 145,829 | 177,007 |
| 드롭 `ing.answer_drop` | 12,027 | 14,182 |

정합성(적재 후 SQL 전수 대조, scale 0.1·1): 발생 오프셋 = 답변 원문 위치, 답변 `n_mentions`·`n_citations` = 자식 행 수,
스탠스 근거 위치가 모두 불일치 0건(scale 0.1 은 언급 `mention_count` = 발생 수도 0건). 같은 `--seed` 두 번 생성 = 바이트 동일.

적재 시간(이 PC, Docker 16 GB·8 CPU, 컨테이너 6 GB): scale 0.1 = 5분 23초(DB 1.4 GB), scale 1 = 생성 4분 23초 + 적재 68분
(합성 COPY 3분 · seed-30 15분 · seed-40 49분, DB 13 GB, `rd.answer` 826,026 · `rd.answer_brand` 3,412,440 · `rd.citation` 7,126,647).

## 3. 사용

Windows는 Git Bash 기준. 컨테이너는 공유 개발 DB(`hgh-dev-pg`)와 따로 둔다.

```bash
B=back/db/synth
bash $B/synth-db.sh up                         # hgh-synth-pg 127.0.0.1:56432 (볼륨 hgh-synth-pgdata, --shm-size 2g)
bash $B/synth-db.sh gen 0.1 1                  # 데모 규모(답변 약 8.5만) → out/s0.1-r1  (약 30초)
bash $B/synth-db.sh load 0.1 1                 # DB hmg_synth (약 5분)
bash $B/synth-db.sh gen 1 1                    # 운영 규모(답변 약 86만, gzip 약 1 GB, 약 4분 30초)
SYNTH_DB=hmg_synth_s1 bash $B/synth-db.sh load 1 1   # 성능 시험 DB hmg_synth_s1
bash $B/synth-db.sh api                        # 백엔드 hgh-synth-api 127.0.0.1:18090 → hmg_synth (SYNTH_DB 로 바꾼다)
bash $B/synth-db.sh demo                       # mock 인증 127.0.0.1:54599 + 화면 next dev 127.0.0.1:3200
bash $B/synth-db.sh demo-down; bash $B/synth-db.sh api-down; bash $B/synth-db.sh down
```

- 로그인: `http://127.0.0.1:3200/ko/login`, `t-admin@example.test` / `e2e-pass`(mock 인증 전용 상수). 다른 역할은 `front/e2e/accounts.json`.
- 화면은 모든 화면 그룹을 백엔드 경로로 띄운다(`HGH_SOURCE_SESSION`·`G1`~`G7`=api). 옛 경로 변수(`DATABASE_URL`·`SCOPE_*`)는 비운다.
- 포트: Windows Hyper-V 예약 대역(`netsh interface ipv4 show excludedportrange protocol=tcp`)을 피한다. 54467–54566 이 예약이라 mock 인증은 54599.
- 같은 `--scale`·`--seed`·`--asof`(기본 2026-10-14T12:00Z)면 같은 데이터. `--asof` 뒤 측정은 진행 중으로 남는다.

## 4. 성능 측정(`perf.py`)

`python back/db/synth/perf.py [--repeat 3] [--weeks 12] [--json out.json]` — 화면이 여는 대표 읽기 API 17종을
스냅샷(기본)·기간(12주) 두 모양으로 부르고 콜드(첫 호출)·웜(이어진 N회 중앙값)을 잰다. 결과 캐시는 끈 상태(`synth-db.sh api` 기본).

scale 1(`hmg_synth_s1`) 2026-10-15 실측: 스냅샷은 전부 콜드 0.4초 이하. 12주 기간에서 1초 근처·초과 =
인용 도메인 1.4초 · ACR 1.3~1.5초(응답 5.8 MB) · 언급 유형 1.0초 · 인용 출처 0.85초(웜도 같은 수준).

## 5. 한계(합성이라 다른 점)

- 숫자는 운영 성과가 아니다. 운영과 같은 값이 나오는지 검증하는 데 쓰지 않는다(리팩터링 동등성은 preserve 테스트로).
- 운영 특수 상태 일부는 없다: 동결 세대(`frz`), 운영자 숨김 회차, 회차 재배정, 엔티티 버전(ecat), GA4 원천, 키워드 캐시, 소셜·컨텍스트 맵(`ext.ctx_*`).
- 앵커 핀은 자기 회차 날짜로만 건다(경로만 탄다). 드롭은 완료 답변의 약 1.7%.
- 운영 규모 적재 시간·DB 크기는 이 PC(Docker 16 GB·8 CPU) 기준이다.
