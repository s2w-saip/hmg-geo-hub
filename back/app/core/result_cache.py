"""데이터 버전 기반 결과 캐시(제품 책임자 승인 2026-09-30, DB-v2.11 P66~P68). 결과가 (요청 쿼리, 해석된 계정 스코프, 데이터)만의 함수인 무거운
분석 GET 을 명시 허용 목록(ALLOWLIST)으로만 캐시한다. 결정·표 커버 근거: docs/design/api/DECISIONS-API.md "결과 캐시".

적용(라우터 계층, service·queries 불변)
    router = APIRouter(tags=[...], route_class=CachedRoute)

    @router.get("/v1/trend", ...)
    @result_cache()                         # 끝점 표식. CachedRoute 가 게이트 의존성을 라우트 dependencies 맨 앞에 끼운다
    async def get_trend_0(...): ...
  표식이 없는 끝점은 CachedRoute 에서도 APIRoute 와 같다. 표식 끝점의 (메서드, 경로)는 ALLOWLIST 에 있어야 한다(아니면 import 시 오류).

한 요청의 흐름(HGH_RESULT_CACHE=1 일 때. 0 이면 게이트가 곧바로 돌아가 캐시 문장·헤더가 하나도 없다)
  1) 게이트 의존성: 토큰 → 계정(CurrentUser) → 요청 커넥션(RoConn, 한 스냅샷). 표면 게이트(core.auth.surface_denial)가 거부면 캐시하지 않고
     끝점이 원래대로 403 을 낸다. project 표면은 core.auth.resolve_project(level member)를 먼저 통과해야 한다(404·403 은 끝점이 낸다).
  2) 접두 = sha256(JSON{판, 메서드, 라우트 템플릿, 경로 매개변수, 원문 쿼리(키 정렬, 같은 키 값 순서 유지), 해석된 스코프 서명, 끝점 추가 키, 빌드}).
  3) app.result_cache_lookup(접두) 한 번: 같은 스냅샷의 데이터 버전을 읽고 키 = sha256(접두 || 버전) 행을 찾는다(SAVEPOINT 안: 캐시 쪽 오류가
     요청 트랜잭션을 망가뜨리지 않는다). 적중이면 저장된 바이트를 그대로 200 으로 돌려준다(직렬화 생략, X-HGH-Cache: hit).
  4) 미스: 같은 프로세스에서 같은 키를 계산 중인 요청이 있으면 그 결과를 기다려 받는다(single-flight). 아니면 끝점이 계산하고, FastAPI 가
     만든 응답 바이트(200)를 응답 뒤 배경 작업으로 app.result_cache_put 에 저장한다(X-HGH-Cache: miss). 저장 실패는 경고 로그만.
  키 공간 상한(저장하지 않는 요청): 끝점이 선언하지 않은 쿼리 파라미터가 하나라도 있으면(CommonFilters extra="ignore" 라 값만 바꿔 키를
     무한히 만들 수 있다) 캐시를 아예 거치지 않는다(조회·저장·헤더 없음, 응답은 그대로). cf.<uuid> 는 project 표면에서만 선언된 동적 키로 본다.
     응답 meta.dropped_filters 가 비지 않은 요청(모르는·권한 밖 값)도 저장하지 않는다(값 문자열만 바꿔 키를 늘리는 같은 경로).
  헤더 X-HGH-Cache 는 HGH_ENV=prod 에서 싣지 않는다(stg·local·test 만).

키 요소(정확히)
  - 원문 쿼리: request.query_params 전 항목. 기본값 적용·값 정렬은 하지 않는다(설계 편차: 값 순서가 응답에 드러나고
    (meta.dropped_filters·요청 순서 목록) 명시 기본값과 생략의 동치를 모델 밖에서 재현하지 않는다. 데우기는 front 가 보내는 URL 그대로 부른다).
  - 해석된 스코프 서명(scope_signature): DataScope.of(계정, 참조).for_surface(표면)의 all·brands(엄브렐러 제외, 계정 순서)·countries
    (권역 전개·웹사이트 의사 코드 포함) + project 표면이면 ProjectAccess 전부 + /v1/geo 는 시장 지도 게이트(shows_geo_map) 값.
    계정의 그 밖 속성(역할·운영자·메뉴·이메일·user_id)은 넣지 않는다: 게이트 판정은 조회 전에 끝나고, 캐시 대상 기능 코드가 계정 속성을
    읽지 않는다는 것을 tests/core/test_result_cache.py 정적 검사가 지킨다.
  - 데이터 버전(DB 가 계산, app.result_cache_version): 표면별 (generation, last_load_id, updated_at), max(judgment_change.change_id),
    추적 표 카운터 합(rcache.tg_bump 트리거: app 11 + rd 차원·파생 15, DB-v2.11 P67), rd.today_kst().
  - 빌드: HGH_BUILD_ID 또는 app 소스·잠금 파일 지문(build_id). 응답 형식이 코드 판마다 달라질 수 있다.
  - 끝점 추가 키(key_deps): 끝점이 의존성으로 받는 값 중 결과를 바꾸는 것(KPI 기준일 kpi_today 교체 지점).
"""
from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import pathlib
import re
import uuid
import zlib
from collections.abc import AsyncIterator, Callable, Iterable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, Any

from fastapi import Depends, Request
from fastapi.routing import APIRoute
from sqlalchemy import text
from starlette.background import BackgroundTask, BackgroundTasks
from starlette.responses import Response

from app.core.auth import CurrentUser, DataScope, Principal, ProjectAccess, resolve_project, shows_geo_map, surface_denial
from app.core.codes import Refs, load_refs
from app.core.config import get_settings
from app.core.db import RoConn, get_db, set_local
from app.core.errors import ApiError
from app.core.profile import parse_profile

log = logging.getLogger("hgh.rcache")

HEADER = "X-HGH-Cache"
KEY_RULE = 1                          # 키 규칙 판(접두 JSON 모양을 바꾸면 올린다)
COMPRESS_MIN = 1024                   # 이 크기 이상 응답은 zlib(1) 로 저장
MAX_BODY = 32 * 1024 * 1024           # 원본 응답 상한(넘으면 저장하지 않는다). 저장 크기 상한 4 MiB 는 DB 함수가 한 번 더 건다
FOLLOWER_WAIT_S = 30.0                # single-flight 대기 상한(넘으면 스스로 계산)
_SURFACES = ("global", "website", "project")

# 명시 허용 목록(메서드, 라우트 템플릿). 조건: 결과가 (쿼리, 해석된 스코프, 데이터)만의 함수, 사용자 개인 필드 없음, 읽는 표가 전부 데이터 버전
# 요소로 덮임(tests/core/test_result_cache_tables.py). 제외와 사유는 DECISIONS-API.md "결과 캐시" 표.
ALLOWLIST: tuple[tuple[str, str], ...] = (
    ("GET", "/v1/trend"),
    ("GET", "/v1/mentions/brands"),
    ("GET", "/v1/mentions/types"),
    ("GET", "/v1/citations/domains"),
    ("GET", "/v1/citations/domains/{skey}"),
    ("GET", "/v1/citations/sources"),
    ("GET", "/v1/citations/sources/types"),
    ("GET", "/v1/citations/sources/tone"),
    ("GET", "/v1/citations/prompts"),
    ("GET", "/v1/citations/targets"),
    ("GET", "/v1/kpi/summary"),
    ("GET", "/v1/kpi/unmeasured-prompts"),
    ("GET", "/v1/kpi/compare"),
    ("GET", "/v1/kpi/engines"),
    ("GET", "/v1/filters/options"),
    ("GET", "/v1/filters/dates"),
    ("GET", "/v1/geo"),
    ("GET", "/v1/funnel/acr"),
)


# ════════════════════════════════════════════════════════════════════════════
# 키
# ════════════════════════════════════════════════════════════════════════════
@lru_cache(maxsize=1)
def _source_fingerprint() -> str:
    """app 패키지 소스(.py·.json)와 잠금 파일 내용의 지문(프로세스당 1회). 같은 릴리스 디렉터리면 API·데우기 프로세스가 같은 값을 얻는다."""
    back = pathlib.Path(__file__).resolve().parents[2]
    h = hashlib.sha256()
    files = sorted(p for p in (back / "app").rglob("*") if p.suffix in (".py", ".json") and "__pycache__" not in p.parts)
    for extra in ("requirements.lock",):
        if (back / extra).is_file():
            files.append(back / extra)
    for f in files:
        h.update(str(f.relative_to(back)).encode())
        h.update(b"\0")
        h.update(f.read_bytes())
        h.update(b"\0")
    return "src:" + h.hexdigest()[:20]


def build_id() -> str:
    """캐시 키의 빌드 식별자: HGH_BUILD_ID(설정) 또는 소스 지문. 현행 프로필(core.profile)이 off 가 아니면 '+lp:<지문>' 을 붙인다
    (HGH_LEGACY_PROFILE 만 바꾼 재기동이 옛 정의로 계산한 캐시를 돌려주지 않게. off 는 붙이지 않아 도입 전 키와 같다)."""
    s = get_settings()
    base = s.build_id or _source_fingerprint()
    lp = parse_profile(s.legacy_profile, require_implemented=False)
    return base if lp.is_off else f"{base}+lp:{lp.fingerprint}"


def query_items(query_params: Any) -> list[list[str]]:
    """원문 쿼리 → [[키, 값], …]: 키로 안정 정렬(같은 키의 값 순서는 요청 그대로). 기본값 적용·값 정렬은 하지 않는다(모듈 머리 주석)."""
    items = query_params.multi_items() if hasattr(query_params, "multi_items") else list(query_params)
    return [[str(k), str(v)] for k, v in sorted(items, key=lambda kv: kv[0])]


def scope_signature(p: Principal, refs: Refs, surface: str, *, project: ProjectAccess | None = None,
                    geo_gate: bool = False) -> dict[str, Any]:
    """해석된 계정 스코프 서명(게이트 통과 뒤 실제 필터에 쓰이는 값). core.filters.resolve_read_context 가 계정에서 읽는 것과 같은 값:
    DataScope.of(계정, 참조).for_surface(표면)의 all·brands·countries(순서 유지: 관점 브랜드 순서가 응답에 드러날 수 있다),
    project 표면이면 resolve_project 결과 전부(멤버 역할 포함), /v1/geo 는 시장 지도 게이트 값."""
    ds = DataScope.of(p, refs).for_surface(surface)
    sig: dict[str, Any] = {
        "surface": surface,
        "all": ds.all,
        "brands": list(ds.brands) if ds.brands is not None else None,
        "countries": list(ds.countries) if ds.countries is not None else None,
    }
    if project is not None:
        sig["project"] = {"id": str(project.project_id), "keys": list(project.project_keys), "brand": project.brand_code,
                          "country": project.country_code, "member_role": project.member_role,
                          "scope_project_id": str(project.scope_project_id) if project.scope_project_id else None}
    if geo_gate:
        sig["geo_map"] = shows_geo_map(p)
    return sig


def key_prefix(*, method: str, route: str, path_params: Mapping[str, Any], query: list[list[str]], signature: Mapping[str, Any],
               extra: Mapping[str, Any], build: str) -> bytes:
    """키 접두(sha256). 데이터 버전은 DB 가 붙인다: 키 = sha256(접두 || 버전)(cache_key)."""
    obj = {"v": KEY_RULE, "m": method.upper(), "r": route, "pp": sorted([str(k), str(v)] for k, v in path_params.items()),
           "q": query, "s": signature, "x": dict(extra), "b": build}
    raw = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8")).digest()


def cache_key(prefix: bytes, data_version: str) -> bytes:
    """app.result_cache_lookup 의 sha256(p_prefix || convert_to(버전, 'UTF8')) 와 같은 값."""
    return hashlib.sha256(prefix + data_version.encode("utf-8")).digest()


# ════════════════════════════════════════════════════════════════════════════
# 저장소(DB-v2.11 SECURITY DEFINER 함수)
# ════════════════════════════════════════════════════════════════════════════
_LOOKUP_SQL = "SELECT data_version, codec, body FROM app.result_cache_lookup(:prefix)"
_PUT_SQL = "SELECT app.result_cache_put(:k, :route, :dv, :codec, :body, :n)"


async def lookup(conn: Any, prefix: bytes) -> tuple[str, bytes | None]:
    """(데이터 버전, 적중 바이트 또는 None). conn = 요청 트랜잭션(같은 스냅샷)."""
    row = (await conn.execute(text(_LOOKUP_SQL), {"prefix": prefix})).first()
    if row is None:                                   # 함수는 늘 한 행을 낸다(방어)
        raise RuntimeError("app.result_cache_lookup 결과 없음")
    dv, codec, body = row[0], row[1], row[2]
    return str(dv), (_decode(codec, body) if body is not None else None)


def _encode(body: bytes) -> tuple[str, bytes]:
    if len(body) >= COMPRESS_MIN:
        z = zlib.compress(body, 1)
        if len(z) < len(body):
            return "zlib", z
    return "identity", body


def _decode(codec: str, body: bytes) -> bytes | None:
    try:
        if codec == "zlib":
            return zlib.decompress(bytes(body))
        if codec == "identity":
            return bytes(body)
    except zlib.error:
        log.warning("결과 캐시 행 해제 실패(미스로 처리)")
        return None
    log.warning("결과 캐시 행 코덱 %r 모름(미스로 처리)", codec)
    return None


@asynccontextmanager
async def _write_tx() -> AsyncIterator[Any]:
    """저장 전용 짧은 트랜잭션: api_ro 풀 엔진, READ COMMITTED 쓰기 가능(DB 함수 put 만 부른다). 요청 커넥션이 반납된 뒤(응답 뒤 배경)에
    열어 한 요청이 같은 풀 커넥션을 동시에 둘 쥐지 않는다. 배포 로그인 롤 hgh_app(DB-v2.3 P33)은 기본 읽기 쓰기라 트랜잭션이 쓰기 가능하다.
    한계: api_ro 전용 로그인 URL(HGH_DB_URL_API_RO, 롤 기본 default_transaction_read_only = on)로 띄우면 저장이 읽기 전용 오류로 실패하고
    (경고 로그, 응답 영향 없음) 캐시는 채워지지 않는다. SET TRANSACTION READ WRITE 는 SQL 가드(G5)가 core 에도 금지해 쓰지 않는다."""
    db = get_db()
    async with db.engine("api_ro").connect() as raw:
        conn = await raw.execution_options(isolation_level="READ COMMITTED", postgresql_readonly=False)
        async with conn.begin():
            gucs: list[tuple[str, str]] = [("role", "api_ro")] if db.assumes_role("api_ro") else []
            gucs += [("statement_timeout", "3s"), ("lock_timeout", "1s")]
            await set_local(conn, gucs)
            yield conn


async def put(key: bytes, route: str, data_version: str, body: bytes) -> bool:
    """저장(실패는 경고 로그만, False). 같은 키가 이미 있으면 그대로 둔다(DB 함수)."""
    if len(body) > MAX_BODY:
        return False
    codec, blob = _encode(body)
    try:
        async with _write_tx() as conn:
            ok = (await conn.execute(text(_PUT_SQL), {"k": key, "route": route, "dv": data_version, "codec": codec,
                                                      "body": blob, "n": len(body)})).scalar()
        return bool(ok)
    except Exception as e:  # noqa: BLE001  캐시 저장 실패는 응답에 영향이 없어야 한다
        log.warning("결과 캐시 저장 실패 %s: %s", route, type(e).__name__)
        return False


# ════════════════════════════════════════════════════════════════════════════
# single-flight(프로세스 안): 같은 키 동시 계산 1회
# ════════════════════════════════════════════════════════════════════════════
_inflight: dict[bytes, asyncio.Future[bytes | None]] = {}


@dataclass
class _Pending:
    key: bytes
    route: str
    data_version: str
    leader: asyncio.Future[bytes | None] | None


def _finish(pend: _Pending, body: bytes | None) -> None:
    fut = pend.leader
    if fut is None:
        return
    pend.leader = None
    if _inflight.get(pend.key) is fut:
        del _inflight[pend.key]
    if not fut.done():
        fut.set_result(body)


class _CacheHit(Exception):                      # noqa: N818  제어 흐름 신호(오류 아님): 게이트 → CachedRoute 처리기
    def __init__(self, body: bytes):
        super().__init__("result cache hit")
        self.body = body


def _hit_response(body: bytes) -> Response:
    return Response(content=body, status_code=200, media_type="application/json", headers={HEADER: "hit"} if _show_header() else None)


_STATE = "hgh_rcache"
_CF_KEY = re.compile(r"^cf\.[0-9a-fA-F-]{36}$")
_DROPPED = b'"dropped_filters":{'


def _show_header() -> bool:
    return get_settings().env != "prod"


def undeclared_params(query_params: Any, declared: frozenset[str], surface: str) -> list[str]:
    """끝점이 선언하지 않은 쿼리 파라미터 이름(정렬). cf.<uuid> 는 project 표면에서만 선언된 동적 키(core.filters.parse_custom_fields)."""
    return sorted({k for k in query_params if k not in declared and not (surface == "project" and _CF_KEY.match(k))})


def has_dropped_filters(body: bytes) -> bool:
    """응답 meta.dropped_filters 가 비지 않았나(봉투 끝의 meta 를 뒤에서 찾는다: FastAPI dump_json 은 공백 없는 JSON)."""
    i = body.rfind(_DROPPED)
    return i >= 0 and body[i + len(_DROPPED):i + len(_DROPPED) + 1] != b"}"


# ════════════════════════════════════════════════════════════════════════════
# 끝점 표식·라우트
# ════════════════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class CacheSpec:
    geo_gate: bool = False                                    # /v1/geo: 시장 지도 게이트(shows_geo_map) 값을 서명에 넣는다
    key_deps: tuple[tuple[str, Callable[..., Any]], ...] = ()  # 끝점이 의존성으로 받는 값 중 결과를 바꾸는 것(키 추가 요소)


def result_cache(*, geo_gate: bool = False, key_deps: Mapping[str, Callable[..., Any]] | None = None) -> Callable[[Any], Any]:
    """끝점 표식(라우터 데코레이터 바로 아래). 캐시 여부는 요청마다 HGH_RESULT_CACHE 로 정한다."""
    spec = CacheSpec(geo_gate=geo_gate, key_deps=tuple(sorted((key_deps or {}).items())))

    def deco(fn: Any) -> Any:
        fn.__hgh_result_cache__ = spec
        return fn
    return deco


async def _gate_impl(spec: CacheSpec, method: str, route: str, declared: frozenset[str], request: Request, p: Principal, conn: Any,
                     extra: Mapping[str, Any]) -> None:
    s = get_settings()
    if not s.result_cache or request.method != method:
        return
    qp = request.query_params
    surfaces = qp.getlist("surface")
    if len(surfaces) != 1 or surfaces[0] not in _SURFACES:
        return                                          # 끝점이 422 를 낸다
    surface = surfaces[0]
    if surface_denial(p, surface) is not None:
        return                                          # 끝점이 403 을 낸다(거부 요청은 조회하지 않는다)
    if undeclared_params(qp, declared, surface):
        return                                          # 선언 밖 파라미터: 키 공간 상한(모듈 머리 주석). 캐시를 거치지 않는다
    refs = await load_refs(conn)
    project: ProjectAccess | None = None
    if surface == "project":
        pids = qp.getlist("project_id")
        if len(pids) != 1:
            return
        try:
            pid = uuid.UUID(pids[0])
        except ValueError:
            return
        try:
            project = await resolve_project(conn, p, refs, pid, "member")
        except ApiError:
            return                                      # 끝점이 같은 404·403 을 낸다
    sig = scope_signature(p, refs, surface, project=project, geo_gate=spec.geo_gate)
    prefix = key_prefix(method=method, route=route, path_params=request.path_params, query=query_items(qp), signature=sig,
                        extra=extra, build=build_id())
    try:
        async with conn.begin_nested():                 # 캐시 쪽 오류(함수 없음·권한)가 요청 트랜잭션을 망가뜨리지 않게
            dv, body = await lookup(conn, prefix)
    except Exception as e:  # noqa: BLE001
        log.warning("결과 캐시 조회 실패 %s: %s", route, type(e).__name__)
        return
    if body is not None:
        raise _CacheHit(body)
    key = cache_key(prefix, dv)
    fut = _inflight.get(key)
    if fut is not None:
        try:
            got = await asyncio.wait_for(asyncio.shield(fut), FOLLOWER_WAIT_S)
        except TimeoutError:
            got = None
        if got is not None:
            raise _CacheHit(got)
        setattr(request.state, _STATE, _Pending(key, route, dv, None))     # 선행 계산이 실패·시간 초과: 스스로 계산·저장
        return
    leader: asyncio.Future[bytes | None] = asyncio.get_running_loop().create_future()
    _inflight[key] = leader
    setattr(request.state, _STATE, _Pending(key, route, dv, leader))


def _make_gate(spec: CacheSpec, method: str, route: str, declared: dict[str, frozenset[str]]) -> Callable[..., Any]:
    """declared = {'names': 선언 쿼리 파라미터}: 라우트 생성 뒤(의존성 해석이 끝난 뒤) CachedRoute 가 채운다."""
    async def gate(request: Request, p: Principal, conn: Any, **extra: Any) -> None:
        await _gate_impl(spec, method, route, declared["names"], request, p, conn, {k.removeprefix("kd_"): v for k, v in extra.items()})

    params = [inspect.Parameter("request", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=Request),
              inspect.Parameter("p", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=CurrentUser),
              inspect.Parameter("conn", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=RoConn)]
    for name, dep in spec.key_deps:
        params.append(inspect.Parameter(f"kd_{name}", inspect.Parameter.KEYWORD_ONLY, annotation=Annotated[Any, Depends(dep)]))
    gate.__signature__ = inspect.Signature(params)     # type: ignore[attr-defined]
    return gate


def _attach(response: Response, task: BackgroundTask) -> None:
    if response.background is None:
        response.background = task
        return
    both = BackgroundTasks()
    both.add_task(response.background)
    both.add_task(task)
    response.background = both


class CachedRoute(APIRoute):
    """결과 캐시 표식(@result_cache) 끝점만 게이트 의존성·처리기 감싸기를 더한다. 표식 없는 끝점은 APIRoute 그대로."""

    def __init__(self, path: str, endpoint: Callable[..., Any], **kwargs: Any) -> None:
        spec: CacheSpec | None = getattr(endpoint, "__hgh_result_cache__", None)
        self._rcache: CacheSpec | None = spec
        if spec is not None:
            methods = sorted(m.upper() for m in (kwargs.get("methods") or ["GET"]))
            # path 는 변환기 표기({skey:path})일 수 있다: 키·허용 목록은 템플릿 표기(path_format)로 쓴다
            route_tpl = re.sub(r"\{([^}:]+):[^}]+\}", r"{\1}", path)
            bad = [m for m in methods if (m, route_tpl) not in ALLOWLIST]
            if bad or len(methods) != 1:
                raise RuntimeError(f"결과 캐시 허용 목록 밖: {methods} {route_tpl}")
            self._rcache_method = methods[0]
            declared: dict[str, frozenset[str]] = {"names": frozenset()}
            kwargs["dependencies"] = [Depends(_make_gate(spec, self._rcache_method, route_tpl, declared)), *(kwargs.get("dependencies") or [])]
            responses = dict(kwargs.get("responses") or {})
            ok = dict(responses.get(200) or {})
            ok["headers"] = {**(ok.get("headers") or {}), HEADER: {
                "description": "결과 캐시(HGH_RESULT_CACHE=1 이고 HGH_ENV 가 prod 가 아닌 배포에서만): hit = 저장된 응답 바이트, miss = 이번에 계산함"
                               "(저장 조건을 만족하면 저장). 꺼져 있거나 prod·선언 밖 쿼리 파라미터 요청이면 헤더 없음",
                "schema": {"type": "string", "enum": ["hit", "miss"]}}}
            responses[200] = ok
            kwargs["responses"] = responses
        super().__init__(path, endpoint, **kwargs)
        if spec is not None:
            if (self._rcache_method, self.path_format) not in ALLOWLIST:
                raise RuntimeError(f"결과 캐시 허용 목록 밖: {self.path_format}")
            from fastapi.dependencies.utils import get_flat_params, get_validation_alias
            declared["names"] = frozenset(get_validation_alias(f) for f in get_flat_params(self.dependant))

    def get_route_handler(self) -> Callable[[Request], Any]:
        handler = super().get_route_handler()
        if self._rcache is None:
            return handler

        async def cached_handler(request: Request) -> Response:
            try:
                response = await handler(request)
            except _CacheHit as hit:
                return _hit_response(hit.body)
            except BaseException:
                pend = getattr(request.state, _STATE, None)
                if pend is not None:
                    _finish(pend, None)
                raise
            pend = getattr(request.state, _STATE, None)
            if pend is None:
                return response
            body = getattr(response, "body", None)
            ok = response.status_code == 200 and isinstance(body, (bytes, bytearray)) and bool(body) \
                and (response.media_type or "").startswith("application/json")
            data = bytes(body) if ok else None             # type: ignore[arg-type]
            _finish(pend, data)
            if data is not None:
                if _show_header():
                    response.headers[HEADER] = "miss"
                if not has_dropped_filters(data):          # 모르는·권한 밖 값이 버려진 요청은 저장하지 않는다(키 공간 상한)
                    _attach(response, BackgroundTask(put, pend.key, pend.route, pend.data_version, data))
            return response
        return cached_handler


def cacheable_routes(routes: Iterable[Any]) -> list[tuple[str, str]]:
    """앱 라우트 중 결과 캐시 표식 끝점(메서드, 템플릿). 허용 목록 대조 시험용."""
    out = []
    for r in routes:
        spec = getattr(getattr(r, "endpoint", None), "__hgh_result_cache__", None)
        if spec is not None and isinstance(r, CachedRoute):
            for m in sorted(r.methods or ()):
                out.append((m, r.path_format))
    return sorted(out)


__all__ = ["ALLOWLIST", "HEADER", "CacheSpec", "CachedRoute", "build_id", "cache_key", "cacheable_routes", "has_dropped_filters",
           "key_prefix", "lookup", "put", "query_items", "result_cache", "scope_signature", "undeclared_params"]
