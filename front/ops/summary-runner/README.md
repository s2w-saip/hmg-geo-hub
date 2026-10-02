# summary-runner — 사실표 생성 러너(EC2 ap-south-1) 런타임 파일

정본 문서: `internal-kb/hmg-geo-summary-runner-ec2-plan-2026-09-10.md`.
프로비저닝(IAM·EC2·코드 전송)은 워크스페이스 `tools/hmg-summary-runner/`(AWS CLI) 가 담당하고,
이 디렉토리는 **러너 위에서 도는 것**만 담는다 — 번들에 실려 `/opt/hmg-runner/current/ops/summary-runner/` 로 배포된다.

| 파일 | 역할 |
| --- | --- |
| `install.sh` | systemd 유닛·타이머 설치(타이머 enable 은 옵션 — **실패 알림 도달 실증 뒤** 상시화) |
| `hmg-summary.service` / `hmg-summary.timer` | 30분 폴링 유닛 |
| `run-generate.sh` | 인스턴스 롤로 Secrets Manager 직독 → env 로만 → `npm run summary:generate -- --pending --yes --revalidate` (flock·값 미출력) |
| `hmg-runner-failure@.service` / `notify-failure.sh` | **실패 알림**(2026-09-16). `OnFailure=` 가 부르고, Slack(운영 알림 채널)으로 1(주의) 등급 발송(2026-09-25 잔디에서 전환) |
| `dryrun.sh` / `probe-e2e.sh` | 쓰기 0 성립 확인(툴체인·RTT·시크릿 도달·revalidate 라우트·읽기 전용 verify) |

규약: 시크릿은 env 로만(argv·로그 금지), 원격 임시 경로 유니크, `DB_POOL_MAX=2`.

## 실패 알림 (타이머 상시화의 선결 조건)

`hmg-summary.service` · `hmg-mirror.service` 둘 다 `OnFailure=hmg-runner-failure@%n.service`
를 건다. 그 템플릿 유닛이 `notify-failure.sh` 를 root 로 실행해 ① `journalctl -u <유닛>`
마지막 25줄을 붙이고 ② Slack Incoming Webhook(운영 알림 채널)으로 보낸다.

- **등급 1(주의)**. 한 번의 실패는 30분 뒤 타이머가 다시 시도하므로 그 자체로 서비스가
  죽지 않는다. "계속 실패한다" 는 앱 크론 `/api/cron/cycle-chain-watch` 가 **생성 대기
  적체**로 잡아 24h 부터 등급 2로 올린다. 매 실패를 적색으로 내면 그 긴급이 묻힌다.
- 웹훅 URL 은 **Secrets Manager** `hmg-geo/summary-runner/slack-webhook`(us-west-2, JSON 키 `SLACK_WEBHOOK_URL`)에 둔다. 유닛에는 ARN(포인터)만 들어가고, 스크립트가
  인스턴스 롤로 직독해 셸 변수로만 쥔다. curl 에는 argv 가 아니라 **stdin(`--config -`)**
  으로 넘긴다 — `--url` 도 argv 라 `ps` 에 보인다(2026-08-06 실증).
  `install.sh` 는 `SLACK_SECRET_ARN` 이 없으면 **중단**한다(미배선을 통과로 치지 않는다).
- 도달 실증(설치 뒤 반드시 1회):
  ```bash
  bash ./ssm-run.sh <IID> 'systemctl start hmg-runner-failure@hmg-summary.service.service'
  ```
  Slack 운영 알림 채널 에 메시지가 오는 것을 **눈으로 확인**한 뒤에만 `--enable-timer` 로 넘어간다.

⚠️ 알림 자체가 네트워크 문제로 못 나갈 수 있다. 그 사각지대는 앱 쪽 감시가 덮는다 —
러너가 몇 시간 안 돌면 마감된 회차가 쌓여 `/api/cron/cycle-chain-watch` 가 GitHub Issue 를
연다(그쪽은 러너와 다른 인프라에서 돈다).

## 단발: 집계층 재접기(`--refold`)

세부층은 그대로 두고 **활성 generation 의 세부층에서 집계층 4표만** 다시 만든다.
`run-generate.sh`(30분 폴링)에는 **넣지 않는다** — 단발 운영 명령이다.

```bash
# 러너에서, run-generate.sh 와 같은 방식으로 env 를 세운 뒤(값 미출력):
npm run summary:generate -- --surface=website --refold --all-published            # dry-run(기본)
npm run summary:generate -- --surface=website --refold --all-published --yes      # 실행
npm run summary:generate -- --surface=global  --refold --cycle=<uuid> --yes       # 회차 하나만
npm run summary:generate -- --surface=website --refold --all-published --since=2026-08-01 --yes
```

- **왜**: 집계층에 접힌 회차가 적으면 읽기 경로가 `fallback:agg-fold-missing` 으로 미러를 서빙한다.
  세부층 재생성(회차당 수 s~135 s) 없이 접기만 다시 하면 된다.
- **안 건드리는 것**: 스왑 3문장·`view_anchor_at`·`generator_version`·회차 상태·세부층.
  건드리는 것은 집계층 4표와 `summary_generations.timings`(`refold_*` 병합)뿐이다.
- **안전**: 기본이 dry-run(`--yes` 없으면 쓰기 0) · 회차 단위 원자(표별 DELETE→INSERT 한 tx)·멱등 ·
  실패 회차는 건너뛰고 계속(마지막 줄에 성공/실패/건너뜀 요약).
- **건너뛰는 경우**: 활성 generation 이 없거나 **세부층 행이 0**(13주 파티션 창 밖)인 회차.
  후자를 접으면 집계층을 빈 채로 덮어쓰게 되므로 일부러 막는다 — 창을 좁히려면 `--since`.
- `--revalidate` 를 붙이면 성공분이 있을 때 캐시 무효화까지 한다(env `HMG_INTERNAL_BASE_URL`·`CRON_SECRET`).
