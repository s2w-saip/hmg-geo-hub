# HMG GEO · scope-analysis 개발 인수인계

개발 및 운영을 이어받기 위한 소스와 필수 절차입니다. 기존 운영 HMG Supabase의 DB·Auth·데이터를 유지합니다.

## 전달 범위

| 저장소 | 역할 | 코드 기준 |
| --- | --- | --- |
| [hmg-geo](hmg-geo/README.md) | 고객 대시보드, 로그인·권한, Scope 연동·집계 | `04bc8894849cffa40d087eafac6f9516d9a964b6` |
| [scope-analysis](scope-analysis/README.md) | 분석 티켓 API·워커·LLM 분석 | `18b5a22c1cfce1f203c374d6e1976e8c8f5e76ae` |

실행 코드·테스트·마이그레이션·배포 설정을 포함합니다. 문서는 인수인계용으로 정리했으며 코드 기준은 `VERSIONS.json`에 기록했습니다. Git 이력은 포함하지 않습니다.

HMG → Scope 코어(`/api/v1`) → 분석 서비스(`/v1/analysis-tickets`) 구조입니다.
Scope 코어·측정 서비스의 전체 소스는 이번 전달 범위에 포함되지 않으므로 해당 서비스 운영 주체와 연동을 유지해야 합니다.
HMG의 `SCOPE_API_BASE`를 분석 서비스 주소로 대체하지 않습니다. 분석 서비스는 **별도 PostgreSQL/RDS**를 사용합니다.

## 먼저 읽을 문서

1. [HMG 설치·개발](hmg-geo/README.md)
2. [HMG 유지보수 기준](hmg-geo/docs/maintenance.md)
3. [분석 서비스 설치·개발·운영](scope-analysis/README.md)
4. [집계 배치 운영](hmg-geo/ops/summary-runner/README.md)

## 별도로 인계할 접근 권한

값은 이 문서에 기입하지 않고 인수 업체의 비밀 저장소로 전달합니다.

| 대상 | 필요한 권한·설정 |
| --- | --- |
| 소스 | 이 zip이 전달 소스입니다(Git 이력 없음). 인수 업체 저장소를 새로 만들고 `.github/workflows`의 변수·시크릿·AWS OIDC 신뢰를 인수 환경에 맞게 설정합니다 |
| HMG DB/Auth | 기존 Supabase 프로젝트 접근, DB URL, Auth URL/공개 키/service key, 기존 관리자 계정 |
| HMG 배포·배치 | Vercel·도메인/DNS, GitHub 배포 변수, cron, summary/mirror 실행 서버·IAM·알림 저장소(`GITHUB_ALERT_REPO`) |
| Scope 연동 | 코어 API 주소·키, root/project 매핑, 계약 변경 협의 담당자 |
| 분석 인프라 | AWS ECS·전용 RDS·ECR·VPC·NLB·CloudWatch·IAM·Secrets Manager |
| 분석 인증·모델 | mTLS 인증서, 컨텍스트/콜백 토큰, LLM 키·승인 모델·공급자 풀 |
| 선택 기능 | GA4 OAuth/property, DataForSEO, 키워드 생성용 OpenRouter |

GA4 화면에는 기존 운영 계정의 권한 요청 주소가 고정돼 있습니다(`hmg-geo/messages/{ko,en}.json`). 실제 OAuth 주체와 property 권한을 인계받고, 계정을 교체하면 각 property의 권한 재부여와 화면 안내 문구도 함께 변경합니다.

## 인수 시 확인할 사항

- 기존 HMG 운영 DB에 `db:bootstrap`, reset, demo seed를 실행하지 않습니다.
- HMG의 전체 DB 권한 검사는 앱 외부 함수 `public.inbound_counts(text[])`의 anon/authenticated 실행 권한 때문에 실패합니다. 앱 범위 검사와 별도로 DB 담당자가 해당 권한을 확인해야 합니다.
- 최근 점검에서 범위가 완전히 미배정된 일반 계정 3개가 확인됐습니다. 해당 계정은 접근이 차단되므로 실제 담당 범위를 관리자에게 배정받아야 합니다.
- 분석 API/worker는 시작 시 migration을 적용합니다. 전용 DB와 배포 대상을 확인한 뒤 실행합니다.
- 배포 설정에는 기존 AWS/Vercel 대상이 남아 있습니다. 새 저장소는 최초 업로드 전에 Actions를 비활성화하고, 소유권·접속 대상·OIDC 신뢰·알림 설정을 확인한 뒤 활성화합니다.

## 검수 기준

- [ ] 각 저장소 설치·검증 명령 성공 (압축 해제 후 각 폴더에서 `git init && git add -A`를 먼저 실행합니다. HMG 테스트 일부가 `git grep`으로 소스를 검사합니다)
- [ ] HMG 기존 관리자 로그인, 일반 사용자 범위 안/밖 접근 확인
- [ ] 동일 프로젝트·기간·필터의 대표 KPI와 분모 확인
- [ ] 분석 티켓 접수 → 처리 → 결과 조회·코어 반영 확인
- [ ] 배포·배치·백업·알림 담당자 및 장애 대응 접근권한 확인

기준 코드 검증: HMG 빌드·테스트 3,900개 통과(조건부 112개 생략), 분석 서비스 타입·핀 검사·테스트 407개·CDK 합성 통과(실 PostgreSQL 3개 생략).
운영 키 전달, 상대측 로그인·실제 분석 호출·운영 배포는 인수 환경에서 확인해야 합니다.
압축 해제 후 `shasum -a 256 -c FILES.sha256`으로 파일 무결성을 확인할 수 있습니다.
