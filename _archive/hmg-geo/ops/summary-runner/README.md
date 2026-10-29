# summary·mirror 배치 운영

이 디렉터리는 기존 배치 서버에서 사용하는 systemd 실행 파일입니다. 서버·IAM·Secrets Manager 자원은 별도로 인계받습니다.

| 파일 | 역할 |
| --- | --- |
| `install.sh` | systemd 유닛·타이머 설치 |
| `hmg-summary.service`, `hmg-summary.timer` | 30분 주기 summary 생성 |
| `run-generate.sh` | 시크릿 로드, 잠금, pending 집계 생성 및 캐시 갱신 |
| `hmg-mirror.service`, `run-mirror.sh` | 미러 discovery·consumer 실행 |
| `dryrun.sh`, `probe-e2e.sh` | 실행 환경·연결·캐시 갱신 경로 점검 |

운영 서버의 설치 경로, 서비스 사용자, AWS 리전·시크릿 참조, 실행 주기·로그·실패 알림을 인계받습니다.
비밀값은 환경변수로 주입하며 명령행 인수나 로그에 기록하지 않습니다. 동일 작업의 중복 실행을 막는 잠금을 유지합니다.

## 집계층만 다시 계산할 때

runner와 동일하게 환경변수를 준비한 뒤 먼저 dry-run을 확인합니다.

```sh
npm run summary:generate -- --surface=website --refold --all-published
```

적용 범위를 확인한 뒤 `--yes`를 추가하면 활성 generation의 집계층을 다시 만듭니다.
`--revalidate`는 `HMG_INTERNAL_BASE_URL`과 `CRON_SECRET`으로 캐시를 갱신합니다.
세부층이 없거나 보존 기간을 벗어난 회차는 건너뜁니다. `--refold`는 상시 폴링 명령에 넣지 않습니다.
