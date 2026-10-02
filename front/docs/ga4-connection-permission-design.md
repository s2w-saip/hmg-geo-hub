# GA4 연동·권한 설계 규격서 (WBS 1.2.1)

> 상태: 설계안(리뷰 대기) · 2026-07-23 · 산출물 = 연동 규격서
> 관련: [[ga4-conversion-backlog.md]] · [[kia-italy-ga4-claude-context.md]] · 오픈이슈 GA-1~5(컨플 78708748 "오픈 이슈")

## 0. 목적·범위

GA4 속성을 **brand × country 프로젝트에 연결하고 읽기 권한을 확보하는 표준**을 정의한다.
- **범위 안**: 연결(속성 매핑) 모델 · 읽기 권한 모델 · 온보딩 플로우 · 미확보 법인 폴백 · 담당 롤.
- **범위 밖(1.2.2로 이관)**: 트래킹할 **이벤트 정의**(국가·권역별 상이 → 정책 선행, GA-1) 및 이벤트 선택 UI. 여기선 "연결·권한"만.

## 1. 현재 상태 (as-is)

| 축 | 현재 구현 | 위치 |
|---|---|---|
| **인증** | Google **OAuth 사용자 계정**(geo-ops@example.com) refresh token. 개인계정 1개가 연결된 모든 속성을 읽음. `.ga4-token.json`(dev) / `GA4_OAUTH_REFRESH_TOKEN`(prod). | `lib/ga4/auth.ts` |
| **속성 매핑** | 하드코딩 `MAP=[{brand,country,envVar}]` — **현재 Kia/IT 1건뿐**. 속성ID는 env(`GA4_PROPERTY_ID_KIA_IT`) 간접참조. | `lib/ga4/property-map.ts` |
| **프로젝트 오버라이드** | `projects.ga4_property_id` 컬럼 — 프로젝트 설정에서 직접 속성ID 지정. 해석식 `project.ga4PropertyId ?? resolveProperty(brand,country)`. | `schema.ts` · `projects/[id]/setting` |
| **데이터** | AI cohort(`sessionDefaultChannelGroup="AI Assistant"`) 전환·방문·landingPage 분해. cron 프리빌드. | `lib/ga4/conversion.ts` · `api/cron/ga4-prebuild` |

**한계 (온보딩이 안 스케일함)**:
1. 시장 1개 추가 = **코드 변경(MAP 행) + Vercel env(속성ID) 배포** 2단계. "권역/국가 확장"(정책 2.3)에 역행.
2. 권한이 **개인계정 1개**에 묶임 — 그 계정 이탈/2FA/비번변경 시 전 시장 데이터 중단(GA-4 "GA 전문가 부재" 리스크).
3. 고객이 GA를 연결하는 **인앱 플로우·가이드 부재**(GA-5).

## 2. 목표 모델 (to-be)

### 2.1 연동 레지스트리 — 코드/env → DB

속성 매핑을 코드에서 걷어내고 **DB 레지스트리**로. 온보딩 = 배포가 아니라 **데이터 입력**이 된다.

제안 테이블(초안, 마이그는 1.2.2에서):
```
ga4_properties(
  id, brand, country_code,      -- brand×country 키 (unique)
  property_id text,             -- GA4 Data API 속성ID
  status text,                  -- 'active' | 'pending_grant' | 'unmapped'
  granted_at, verified_at,      -- 뷰어 권한 부여·검증 시각
  created_by, created_at, updated_at
)
```
- `resolveProperty`/`resolveProperties`가 env MAP 대신 이 테이블을 읽는다(현 인터페이스 유지 → conversion.ts 무변).
- `projects.ga4_property_id` 오버라이드는 **유지**(프로젝트가 표준 매핑과 다른 속성을 쓸 때).
- env 간접참조는 **비밀이 아닌 속성ID엔 불필요** — 속성ID는 비밀이 아니므로 DB 평문 저장 무방(비밀은 OAuth/SA 자격뿐).

### 2.2 권한 모델 — 현행 OAuth 유지 (확정 2026-07-23)

**결정: (B) 현행 OAuth 사용자 계정(geo-ops@example.com) 유지.** 이미 동작하고 뷰어 부여 온보딩이 단순한 점을 우선한다. 서비스 계정(A) 전환은 개인계정 단일장애점(GA-4)을 없애는 이점이 있으나 지금은 채택하지 않고 **확장·견고성 필요 시 재검토(백로그)**.

| 옵션 | 방식 | 상태 |
|---|---|---|
| **(B) OAuth 사용자 유지** | geo-ops@example.com refresh token(`GA4_OAUTH_*`), 각 속성에 이 계정을 뷰어로 | **채택** |
| (A) 서비스 계정 | Google SA를 속성 뷰어로 + SA 키 headless 인증 | 백로그(확장 시 재검토) |

**현행 유지 시 리스크 완화**(GA-4 개인계정 의존 잔존):
- refresh token·클라이언트 자격은 server-only env(`GA4_OAUTH_REFRESH_TOKEN` 등)로만 관리(NEXT_PUBLIC_ 금지).
- 계정 **소유·복구 절차 문서화** + 2FA 백업 코드 보관 — 계정 이탈이 전 시장 데이터 중단으로 번지지 않게.
- 토큰 만료/취소 시 재발급 런북.

> **GA-3 (ICT 중앙 소비)**: ICT가 전 권역 GA를 통합 수집·관리하면, 우리는 개별 속성 뷰어 대신 **ICT 중앙 지점에서 소비**한다(개별 연동 대체). 이때도 2.1 레지스트리는 "무엇을 어디서 읽는가"의 단일 지점으로 재사용된다. 그 전환 시나리오는 **ICT 협의용으로 별도 정리** → [ga4-ict-central-consumption-scenario.md](ga4-ict-central-consumption-scenario.md).

### 2.3 온보딩 플로우 (1.2.3 UXUI 프리뷰)

고객 시장 1개 연결 표준 절차:
1. **속성ID 확보** — 고객 GA4 관리 → 속성 설정에서 숫자 property id.
2. **뷰어 권한 부여** — 우리 SA(또는 OAuth 계정) 이메일을 해당 속성에 **뷰어(Viewer)** 로 추가.
3. **검증** — `npm run ga4:probe`(현존) 또는 인앱 "연결 테스트"로 실제 read 확인 → status `active`.
4. **매핑** — brand×country ↔ property_id를 레지스트리에 등록(admin UI, 1.2.2).

담당 롤: **admin = 전역 등록/검증**. country 롤의 자기 시장 자가 등록은 2차(권한 UX 별도 검토 ET-3와 연계).

## 3. 미확보 법인 폴백 (1.2.2 연계)

GA 미연결(status ≠ active) 시장은:
- 전환·AI유입 KPI **비활성**(측정대기 빈처리 — 현행 패턴 재사용).
- 대체 지표 없음(전환은 GA 고유) → 타일에 "GA 미연동" 안내.
- 커버리지 노출: `resolveProperties`가 이미 "5/41 measured" 형태를 반환하므로 rollup에서 미측정 시장 가시화.

## 4. 오픈 이슈 반영

| ID | 이슈 | 이 규격에서의 처리 |
|---|---|---|
| GA-1 | 키 이벤트 국가·권역별 상이 | **1.2.2로 이관**(이벤트 정의 정책). 본 규격은 "연결·권한"만. |
| GA-2 | 전체 이벤트 로드·선택 실효성(수 과다) | 1.2.2 UI 설계 이슈. 사전 큐레이션 방식 검토. |
| GA-3 | ICT 전권역 GA 통합 계획 | 2.2 주석 — 통합 시 중앙 속성/SA 소비로 재사용. 경계 조율 선행. |
| GA-4 | GA 전문가 없이 사전 설정 난이 | 현행 OAuth 유지 → 개인계정 의존 잔존. 완화책(server-only env·소유/복구 런북·2FA 백업)으로 대응, SA 전환은 백로그. |
| GA-5 | 연동·이벤트 설정 가이드 부재 | 산출물 2종: **① GA 연동 가이드**(2.3 절차 고객용) **② 이벤트 설정 정의 가이드**(1.2.2). |

## 5. 산출물 체크리스트 (1.2.1 완료 기준)

- [x] as-is 정리(인증·매핑·오버라이드·한계)
- [x] 연동 레지스트리 데이터 모델 초안(2.1)
- [x] 권한 모델 확정: **현행 OAuth 유지**(2.2) — 2026-07-23
- [x] 온보딩 표준 절차(2.3) + 담당 롤
- [x] 미확보 법인 폴백 방침(3)
- [x] ICT 중앙 소비 시나리오(협의용) 작성 → [ga4-ict-central-consumption-scenario.md](ga4-ict-central-consumption-scenario.md)
- [ ] **ICT 협의 대기**: 중앙 소비 전환 여부·형태(위 문서로 협의)
- [ ] GA 연동 가이드(고객용) 문서화 — GA-5 ①
- [ ] → 1.2.2: 레지스트리 마이그레이션 + admin 등록 UI + 이벤트 정의(GA-1)
