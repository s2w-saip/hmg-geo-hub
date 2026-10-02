"""적재 파이프라인(ingest): Scope pull → ing(넓은 원본) → rd(좁은 투영), 회차 원장·큐·아웃박스·감시.

API 프로세스(api_ro)는 운영 조회 3개(ingest.pull.ops)만 쓴다. 나머지는 워커 프로세스(loader 롤, 직접 DB 연결)다.
  python -m ingest.cli sync --project <uuid> [--force] [--max-runs N]   수동·백필 1패스
  python -m ingest.cli tick | queue | outbox | watch                    한 틱 실행(로컬 시험·운영 수동)
  python -m ingest.worker                                               상시 루프(pull 20분·queue 60초·cycles_tick 20분 + 일 1회)
설계: docs/design/api/모듈-적재-파이프라인.md, 단위 IG-1·IG-2·IG-3.
"""
