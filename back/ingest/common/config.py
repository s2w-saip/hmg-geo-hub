"""적재 워커 설정. 연결·비밀값 키는 core.config 한 곳(CORE-REQUESTS/ingest.md R1 반영, core 6라운드), 여기는 워커 동작 상한만 env 로 읽는다.

core.config(Settings) 에서 오는 키(비밀값은 SecretStr, 출력·argv 금지)
  HGH_INGEST_DB_URL(없으면 HGH_DB_URL)·HGH_INGEST_DB_ROLE·HGH_INGEST_STATEMENT_TIMEOUT(기본 180s)·HGH_INGEST_SYSTEM_ACTOR
  HGH_SCOPE_API_URL·HGH_SCOPE_API_KEY·HGH_DFS_API_URL·HGH_DFS_LOGIN·HGH_DFS_PASSWORD
  워커 진입점(ingest.worker·ingest.cli)은 기동 때 core.config.load_settings(purpose="worker") 를 설치한다(API 인증 키 필수 검증 없음).
이 파일이 읽는 워커 동작 상한
  HGH_INGEST_PASS_BUDGET_S     pull 패스 벽시계 예산(기본 900 = 15분, 20분 주기 겹침 방지)
  HGH_INGEST_RECHECK_MAX_RUNS  재확인 run 프로젝트당 상한(기본 25, 현행 RECHECK_MAX_RUNS_PER_PASS sync.ts:506)
  HGH_INGEST_ESCALATE_ANSWERS  재판정 단일 트랜잭션 상한(기본 200000, 초과 = escalated_rebuild)
  HGH_INGEST_GATE_CHUNK        게이트 전파 청크(기본 50000)
  HGH_INGEST_MAX_ATTEMPTS      run 연속 실패 상한(기본 5, 넘으면 blocked + 경보)
  HGH_WATCH_CHECKS             감시(ingest.cli watch)가 돌릴 점검 쉼표 목록(기본 빈 값 = 전부, cycles.watch.service.CHECKS). 예: pull 워커가 없는
                               환경(stg)은 projection_gap 만(하트비트가 늘 긴급으로 울지 않게: 알림 라우팅 룰 2)
  HGH_WATCH_FILL               투영 공백 자동 채움 요청(기본 1, 0 = 판정·경보만)
"""
from __future__ import annotations

import os
import uuid
from functools import lru_cache

from pydantic import BaseModel, SecretStr

from app.core.config import Settings, get_settings


class IngestSettings(BaseModel):
    db_url: SecretStr | None = None
    db_role: str | None = None
    statement_timeout: str = "180s"
    scope_api_url: str | None = None
    scope_api_key: SecretStr | None = None
    dfs_api_url: str | None = None
    dfs_login: SecretStr | None = None
    dfs_password: SecretStr | None = None
    system_actor: uuid.UUID | None = None
    pass_budget_s: int = 900
    recheck_max_runs: int = 25
    escalate_answers: int = 200_000
    gate_chunk: int = 50_000
    max_attempts: int = 5
    watch_checks: tuple[str, ...] = ()
    watch_fill: bool = True

    def __repr__(self) -> str:   # 비밀값·URL 을 로그에 남기지 않는다
        return (f"IngestSettings(db={'set' if self.db_url else 'unset'}, role={self.db_role!r}, "
                f"scope={'set' if self.scope_api_url else 'unset'}, dfs={'set' if self.dfs_api_url else 'unset'})")

    __str__ = __repr__


def load_ingest_settings(environ: dict[str, str] | None = None, core: Settings | None = None) -> IngestSettings:
    """core.config 의 연결·비밀값 키 + 이 모듈의 동작 상한(env). environ 을 주면 동작 상한만 거기서 읽는다(core 는 core 인자 또는 get_settings())."""
    e = os.environ if environ is None else environ
    c = core or get_settings()
    return IngestSettings(
        db_url=c.loader_url, db_role=c.ingest_db_role, statement_timeout=c.ingest_statement_timeout,
        scope_api_url=c.scope_api_url, scope_api_key=c.scope_api_key,
        dfs_api_url=c.dfs_api_url, dfs_login=c.dfs_login, dfs_password=c.dfs_password, system_actor=c.ingest_system_actor,
        pass_budget_s=int(e.get("HGH_INGEST_PASS_BUDGET_S", "900")),
        recheck_max_runs=int(e.get("HGH_INGEST_RECHECK_MAX_RUNS", "25")),
        escalate_answers=int(e.get("HGH_INGEST_ESCALATE_ANSWERS", "200000")),
        gate_chunk=int(e.get("HGH_INGEST_GATE_CHUNK", "50000")),
        max_attempts=int(e.get("HGH_INGEST_MAX_ATTEMPTS", "5")),
        watch_checks=tuple(x.strip() for x in (e.get("HGH_WATCH_CHECKS") or "").split(",") if x.strip()),
        watch_fill=(e.get("HGH_WATCH_FILL", "1").strip() != "0"),
    )


@lru_cache(maxsize=1)
def get_ingest_settings() -> IngestSettings:
    return load_ingest_settings()


def install_worker_settings() -> None:
    """워커 진입점 전용: core 설정을 purpose='worker' 로 설치(stg·prod 에서 API 인증 키 없이 기동, loader URL 필수)."""
    from app.core.config import load_settings, set_settings

    set_settings(load_settings(purpose="worker"))
    get_ingest_settings.cache_clear()
