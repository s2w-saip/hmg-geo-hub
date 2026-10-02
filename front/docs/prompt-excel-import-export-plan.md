# 프롬프트 Excel Import/Export + 커스텀 라벨 — 상세 구현 계획서

작성일: 2026-06-23
대상: `/{locale}/projects/[id]/prompt` (프로젝트별 프롬프트 탭)
범위: 기존 DB 컬럼 재사용 방식의 라벨링 + 엑셀 가져오기/내보내기

---

## 1. 목표

프로젝트 프롬프트 탭에서 프롬프트를 추가/수정할 때:

1. **Export** — 현재 프롬프트 목록을 라벨 컬럼까지 포함해 엑셀로 내보낸다.
2. **Import** — 외부 엑셀에서 라벨(필터링용 custom attribute)을 작업한 뒤 업로드하면, 행별로 upsert(있으면 수정 / 없으면 신규 draft 추가)한다.
3. 가져온 라벨로 목록을 **필터링**할 수 있다.

라벨은 **이미 존재하는 `prompts` 테이블 컬럼**에 매핑한다. DB 마이그레이션 불필요.

---

## 2. 핵심 제약 (설계 전제)

- **scope는 라벨을 모른다.** scope 공개 API는 `text / funnel_stage / keywords / active` 4개 필드만 받는다(`docs/scope-api-integration.md`, `lib/scope/types.ts:111-133`). 따라서 라벨은 **이 BFF 로컬 DB에만 존재**하며 측정 자체엔 영향을 주지 않는다 → "필터/그룹핑/리포팅용 라벨"로 동작.
- **boundary 준수**: DB 접근은 `lib/db/repositories/*` 경유(ESLint 강제), scope 호출은 `lib/scope/server.ts` 경유. 본 기능은 로컬 prompts 레포만 사용하므로 scope 게이트웨이를 건드리지 않는다.
- **i18n 강제**: JSX에 한국어 리터럴 금지. 모든 문구는 `messages/{ko,en}.json`. `npm run check:strings` 통과 필요.
- **exceljs는 server-only로 유지.** 이미 `exceljs@4.4.0` 설치됨(`scripts/ga4/*`에서 사용). 클라이언트 번들에 넣지 않기 위해 파싱/생성을 모두 server action에서 수행한다.

---

## 3. 라벨 컬럼 매핑 (기존 컬럼 재사용)

`lib/db/repositories/prompts.ts`의 `PromptInsert`/`PromptUpdate`가 이미 전부 지원하는 컬럼:

| 엑셀 열(헤더) | DB 컬럼 | 타입/검증 | 비고 |
|---|---|---|---|
| `id` | `id` | UUID | 비어 있으면 신규 insert, 있으면 update 매칭 키 |
| `text` | `text` | 필수(신규 시) | 비-draft 행은 text 변경 금지(측정 desync 방지) |
| `promptType` | `promptType` | enum: comparison/recommendation/information/other | 그 외 값 → null + 경고 |
| `category` | `category` | free text | |
| `brand` | `brand` | free text (HMG/Hyundai/Kia/Genesis 권장) | |
| `listType` | `listType` | free text | |
| `depth1` | `depth1` | free text | HMG framework L1 |
| `depth2` | `depth2` | free text | L2 |
| `depth3` | `depth3` | free text | L3 |
| `depth4` | `depth4` | free text | L4(예비축) |
| `funnelStage` | `funnelStage` | free text | CEJ 단계 |
| `status` | (export 전용) | — | 읽기 전용. import 시 무시 |

**헤더 매칭**: 1행을 헤더로 사용. **영문 머신키**(`id`, `text`, `promptType`, `category`, `brand`, `listType`, `depth1`~`depth4`, `funnelStage`, `status`)를 정식 헤더로 사용한다(결정됨 2026-06-23). import 시 대소문자·공백에 관대하게 매칭(`promptType` ≈ `prompttype`). export도 동일한 영문 헤더로 출력 → 라운드트립 보장.

---

## 4. 변경/신규 파일 목록

### 신규
| 파일 | 역할 |
|---|---|
| `lib/prompts/excel.ts` | (server-only) exceljs 기반 워크북 생성/파싱 + 헤더 매핑 + 행 검증. export 행 build, import 행 parse 두 함수. |
| `app/[locale]/(dash)/projects/[id]/prompt/_components/prompt-io.tsx` | (client) "엑셀 내보내기"/"엑셀 가져오기" 버튼 + 파일 input + import 결과 토스트(생성 N / 수정 M / 건너뜀 K + 경고). |

### 수정
| 파일 | 변경 |
|---|---|
| `app/[locale]/(dash)/projects/[id]/prompt/_actions.ts` | server action 2개 추가: `exportPromptsXlsx(projectId)` → base64 반환, `importPromptsXlsx(projectId, formData)` → upsert 결과 반환. 둘 다 `requireOwner` 재사용(또는 export는 멤버 read 허용). |
| `app/[locale]/(dash)/projects/[id]/prompt/page.tsx` | `PromptRow` 매핑에 라벨 컬럼 추가(현재 text/promptType/category/status만 전달 → brand/listType/depth1-4/funnelStage 추가). `<PromptIO>` 렌더. |
| `app/[locale]/(dash)/projects/[id]/prompt/_components/prompt-list.tsx` | `PromptRow` 타입 확장 + 라벨 표시 + 라벨 기반 필터 UI(admin standard 페이지 필터 패턴 재사용). 기존 CSV export 버튼은 `PromptIO`로 통합/대체. |
| `messages/ko.json`, `messages/en.json` | `projectDetail.prompt.io.*` 키 추가(버튼/토스트/헤더명/검증 메시지). |

> DB 마이그레이션 **없음** — 컬럼이 이미 존재(`lib/db/schema.ts:241-271`).

---

## 5. 데이터 흐름

### Export
```
[client] PromptIO "내보내기" 클릭
  → server action exportPromptsXlsx(projectId)
      requireMember(projectId)            // 읽기 권한
      promptRepository.listForProject(id) // 모든 라벨 컬럼 포함
      lib/prompts/excel.buildWorkbook(rows) // exceljs, 헤더 1행 + 데이터
      return { base64, filename }
  → client: base64 → Blob → 다운로드 (a.click)
```
- 첫 행 헤더 + (선택) `promptType` 열에 데이터 검증 드롭다운(exceljs `dataValidation`)으로 enum 안내.
- 파일명: `prompts-{projectId 짧게}-{YYYYMMDD}.xlsx`.

### Import
```
[client] 파일 선택(.xlsx) → FormData
  → server action importPromptsXlsx(projectId, formData)
      requireOwner(projectId)                 // 수정 권한
      file.arrayBuffer() → excel.parseWorkbook()
      각 행:
        - 헤더 매핑(HEADER_ALIASES)
        - id 있음 & 해당 project 소속 → update(라벨만; 비-draft면 text 변경 skip)
        - id 없음 & text 있음 → insert(draft, createdBy=userId)
        - text 없고 id도 없음 → skip
        - promptType 검증 실패 → null 처리 + 경고 누적
      revalidatePath
      return { created, updated, skipped, warnings[] }
  → client: 토스트로 결과 요약
```

**id 소속 검증(중요)**: 업로드된 `id`가 *이 프로젝트의 프롬프트인지* 반드시 확인(다른 프로젝트 id로 위장한 수정 차단). `listForProject(projectId)` 결과의 id Set과 대조 후 update.

---

## 6. 권한 모델 (기존 재사용)

- **Export**: 프로젝트 활성 멤버(Owner/Viewer) + admin. (기존 CSV export도 전원 노출)
- **Import**: `requireOwner(projectId)` 재사용(`_actions.ts:27-50`) — Owner 또는 admin만. Viewer는 버튼 비노출.
- **비-draft 행의 라벨 update**: **프로젝트 Owner(+admin)에게 허용** (결정됨 2026-06-23). import 전체가 `requireOwner` 게이트이므로 별도 처리 불필요 — Owner면 done/queued 행의 라벨도 갱신 가능. 단 `text`는 여전히 draft에서만 변경(측정 desync 방지).
- 라벨은 측정 비용을 유발하지 않으므로 `requireOperate`(비용 게이트)는 불필요.

---

## 7. 검증 / 엣지 케이스

1. **잘못된 promptType** → null + `warnings`에 "행 N: 알 수 없는 유형 'X'" 누적, 행 자체는 통과.
2. **비-draft 행** → Owner면 라벨은 갱신, **text만 무시 + 경고**(text 변경 = 다른 측정이므로 draft에서만 허용).
3. **타 프로젝트 id** → 해당 행 skip + 경고.
4. **빈 행 / 헤더만 있는 파일** → created=0, 토스트로 안내.
5. **대용량** → 행 수 상한(예: 1000) 두고 초과 시 거부. 트랜잭션 단위 insert는 순차(현 repo 패턴) — 필요 시 후속에서 bulk insert 최적화.
6. **파일 형식**: `.xlsx`만 허용(accept 속성 + 서버에서 load 실패 시 친절한 에러). CSV는 기존 export로 커버.
7. **인코딩**: exceljs가 처리(한글 안전). CSV 경로 유지 시 기존 BOM 처리(`lib/export/csv.ts`) 그대로.

---

## 8. UI 변경 상세

- 프롬프트 탭 목록 카드 우상단: 기존 "CSV 내보내기" → **"엑셀 내보내기" + "엑셀 가져오기"** 버튼 그룹(`PromptIO`).
- 라벨 표시: 각 프롬프트 행에 brand/category/depth 칩 추가(현재 promptType/category만 표시).
- 필터 바: brand·promptType·depth1·funnelStage 셀렉트(값은 현재 목록에서 distinct 추출). `admin/standards/prompts`의 필터 컴포넌트 패턴 재사용.
- (선택) 인라인 편집을 brand/depth까지 확장하는 것은 별도 범위 — 본 계획은 "엑셀로 라벨 작업 → 화면은 표시/필터" 우선.

---

## 9. 작업 분해 (구현 순서)

1. **`lib/prompts/excel.ts`** — `HEADER_ALIASES`, `buildWorkbook(rows): Buffer`, `parseWorkbook(buf): { rows, warnings }`. 단위 테스트(`excel.test.ts`): 헤더 매핑, enum 검증, 라운드트립(build→parse 동등).
2. **server actions** — `exportPromptsXlsx`, `importPromptsXlsx`를 `_actions.ts`에 추가. 권한/소속검증/upsert 로직.
3. **page.tsx** — `PromptRow` 매핑에 라벨 컬럼 추가, `PromptIO` 배치.
4. **`prompt-io.tsx`** — 버튼/파일 input/토스트.
5. **`prompt-list.tsx`** — 타입 확장, 라벨 칩, 필터 UI.
6. **i18n 키** — ko/en 추가, `npm run check:strings` 통과.
7. **검증** — `npm test`, `npm run lint`, `npm run build`. 수동: export → 엑셀 라벨 수정 → import → 목록/필터 확인.

---

## 10. 견적 / 리스크

- **난이도**: 중. 신규 외부 의존성 없음(exceljs·sonner·shadcn 전부 기존). DB 변경 없음.
- **주요 리스크**: (a) 헤더 매핑/한글 헤더 호환 — 사전 + 테스트로 해소. (b) id 소속 검증 누락 시 IDOR — 7장 항목3에서 차단. (c) 클라 번들에 exceljs 유입 — server action 격리로 차단.
- **scope 연동 영향 없음** — 라벨은 로컬 전용. 측정/미러 동기화와 독립.

---

## 11. 결정 사항 (확정 2026-06-23)

- [x] 비-draft 라벨 update → **프로젝트 Owner(+admin)에게 허용**. text 변경만 draft 한정.
- [x] 엑셀 헤더 → **영문 머신키** (export/import 동일).
- [x] 인라인 편집 확장 안 함 → 화면은 **표시 + 필터**만, 라벨 작업은 **엑셀**이 주 경로.
- [x] 범위 → **프로젝트 프롬프트 탭 한정**. admin 표준 카탈로그는 후속.
```
