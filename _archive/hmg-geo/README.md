# hmg-geo

Next.js 15 / React 19 기반 GEO 대시보드입니다. Supabase Auth와 PostgreSQL을 사용하며, Scope 코어 연동은 서버의 BFF 계층에서 처리합니다.

## 설치·실행

Node.js 24와 npm을 사용합니다. 저장소 루트에서 실행합니다.

```sh
nvm install
nvm use
npm ci
cp .env.example .env.local
```

기존 `.env.local`이 있으면 덮어쓰지 않습니다. 다음 값을 같은 운영 환경에서 인계받아 입력합니다.

| 설정 | 용도 |
| --- | --- |
| `DATABASE_URL` | 기존 Supabase의 앱 실행용 DB 연결 |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 같은 프로젝트의 Auth |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용 키 |
| `SCOPE_MODE=live`, `SCOPE_API_BASE`, `SCOPE_API_KEY`, `SCOPE_ROOT_PROJECT_ID` | 운영 Scope 연동 |
| `STANDARD_ROOT_PROJECT_ID`, `SCOPE_EXTRA_PROJECT_IDS` | 운영에서 사용 중인 카탈로그·추가 프로젝트 매핑 |

`mock`도 로그인과 앱 DB를 사용합니다. 실제 운영 데이터를 재현하려면 기존 DB와 `live` 연동 설정이 필요합니다.

```sh
npm run setup:doctor
npm run setup:doctor -- --connect
npm run db:verify -- --application-only
npm run build
npm run start
```

doctor와 db:verify는 읽기 전용 검사입니다. `db:verify -- --application-only`는 앱 범위만 판정하며 외부 DB 객체 경고를 해소하지 않습니다. 전체 권한 확인은 `npm run db:verify`를 사용합니다.
`http://localhost:3000/ko/login`에서 기존 관리자 계정으로 로그인합니다. 개발 모드는 `npm run dev`입니다.
공개 Auth 환경변수를 바꾸면 다시 빌드합니다. 배포 주소 변경 시 Supabase의 Site URL/redirect 설정도 맞춥니다.

## 코드 구조

| 경로 | 역할 |
| --- | --- |
| `app/[locale]/` | ko/en 화면·서버 액션 |
| `app/api/` | 서버 API·cron |
| `lib/auth/`, `lib/db/scoped.ts` | 인증·역할·데이터 범위 제한 |
| `lib/scope/` | Scope 클라이언트·변환·미러 동기화 |
| `lib/db/schema.ts`, `lib/db/repositories/` | DB 모델·조회·집계 |
| `lib/summary/`, `scripts/summary/` | 회차별 집계 생성·검증 |
| `lib/geo-catalog/`, `lib/citation-categorizer/` | 국가·사이트 카탈로그·인용 출처 분류 |
| `messages/`, `components/` | 번역·공통 UI |
| `ops/summary-runner/`, `.github/workflows/` | 배치·CI·배포 |

## 변경 전후 검증

```sh
npm run test
npm run lint
npm run check:strings
npm run typecheck:worker
npm run db:check
npm run build
```

DB 변경·권한·집계 규칙은 [유지보수 기준](docs/maintenance.md)을 따릅니다.
기존 운영 DB는 초기화하지 않습니다. 신규 격리 개발 DB가 필요한 경우에만 [초기화 절차](docs/handover-db-bootstrap.md)를 사용합니다.
현행 배포는 `.github/workflows/deploy-production.yml`의 수동 실행이며 main 병합만으로 운영 배포되지 않습니다.
`npm start`는 cron·summary/mirror 배치를 실행하지 않습니다. 별도 스케줄과 [배치 서버](ops/summary-runner/README.md)를 인계받습니다.
