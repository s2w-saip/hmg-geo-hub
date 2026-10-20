# 골드 ERD 생성기

워크스페이스 루트의 `GEO HUB 골드 ERD.html` 을 만드는 키트입니다. 루트 파일이 결과물입니다.

- 페이지는 메달리온 골드 레벨 ERD 만 담습니다: 계열별 탭, 그림, 상세 패널(한 행 · PK · 입력 · 갱신 · 용도 · 규칙).
- 현행 대응, BE 내부, app · 캐시 내용은 페이지에 두지 않습니다(사용자 2026-10-20).
- 골드가 현행 서비스의 화면 기능을 100% 커버하는지는 키트 검사(`node_check.js`)로만 확인합니다.
- 페이지의 모든 요소가 근거와 맞는지는 검토 원장(`검토/*.json`)으로 확인합니다.

## 구조

| 경로 | 내용 |
|---|---|
| `src/page_head.part` · `src/page_body.part` | 페이지 머리(CSS) · 본문(머리말 · ERD 섹션) |
| `src/tables/NN_*.js` | 골드 테이블 정의. 계열별 파일 하나 |
| `src/views.js` | ERD 탭 · 노트 · 상자 배치 |
| `src/render.js` · `src/meta.js` | 그림 · 상세 패널 렌더, 머리 칩 |
| `cov_core.js` | 커버리지 검증 핵심 (키트 전용, 페이지에 넣지 않음) |
| `inventory.json` · `routes_ast.json` · `item_routes.json` · `be_scan.json` · `db_cols.tsv` · `db_funcs.txt` | 커버리지 기준 데이터 |
| `manual_map.py` | API 로 매칭되지 않는 화면 항목 · 화면 밖 경로의 수동 매핑 |
| `coverage_data.js` | `gen_data.py` 출력 (FEATURES · COLMAP · BEMODS) |
| `검토/` | 요소별 판정 원장 · 검토 지침(7절 골드 설계 변환 규칙) · 알려진 오류 |
| `이력/` | v7 사본, v8 결과물(`erd_v8.html` · `src_v8/` · `검토_v8/`, 현행 대응 · 신규 요청 · app 그룹 포함), v8 이전 패치 스크립트 |

## 빌드 · 검증

```
python -X utf8 -I build.py <출력.html>
node node_check.js               # ERD 무결성 0(골드 밖 참조 · 표시 안 하는 필드 없음) · 현행 열 1039 · BE 모듈 136 · 화면 항목 789
node review.js check <출력.html>  # 페이지 요소 전부 판정 · 근거 있음
node shot.js <출력.html> <폴더>   # 헤드리스 Chrome: 콘솔 오류 0 · 상자 겹침 0 · 열 이름 잘림 0 · 상세 패널 · 390px 폭 넘침 0
```

세 검사가 모두 0 이면 루트 `GEO HUB 골드 ERD.html` 로 복사합니다.

## 고치는 법

1. `src/` 를 고칩니다. 규칙은 `검토/README.md` 7절을 따릅니다.
   - 현행 열을 옮긴 열은 이름을 그대로 둡니다. 커버리지 검사가 이 이름에 걸려 있습니다.
   - 골드 밖을 가리키는 FK 는 두지 않습니다.
   - `cur` 같은 표시하지 않는 필드도 두지 않습니다.
2. 빌드한 뒤 바뀐 요소를 기록합니다.
   - `node review.js todo <html> <원장>` 로 바뀐 요소를 봅니다.
   - 근거를 확인해 `node review.js put <html> <원장> <판정.json>` 으로 기록합니다.
3. 열 수가 바뀌면 `node layout.js <html> --write` 로 상자 배치를 다시 잡습니다.
4. 표기만 바꾼 열 행(같은 물리 열)은 `node rekey.js <html> <옛 원장 폴더> <원장…>` 로 옛 판정을 물려받습니다.
5. 테이블을 어느 BE 모듈 · 화면이 쓰는지는 `node uses.js <테이블 id>` 로 찾습니다.

## 다시 뽑는 법 (코드 · DB · 점검표가 바뀌었을 때)

```
python -X utf8 -I dump_inventory.py "<repo>/docs/reports/부록/지표 점검표 생성기" inventory.json
python -X utf8 -I routes_ast.py <repo>/back/app routes_ast.json
python -X utf8 -I match_routes.py
python -X utf8 -I be_scan.py <repo>/back/app db_cols.tsv db_funcs.txt be_scan.json
python -X utf8 -I gen_data.py <repo>/back/app
```

`db_cols.tsv` · `db_funcs.txt` 는 dev-pg `hmg_tpl` 의 `pg_class` · `pg_attribute` · `pg_proc` 에서 뽑습니다(스키마 rd · frz · ext · app · ing · rcache · mig).
