"""projects.prompts.io: xlsx 내보내기(형식·권한·접근 감사)·가져오기(multipart·본문, 규칙·상한·오류·롤백) + xlsx 읽기 단위 테스트.

테스트 수집 충돌(표준 라이브러리 io 와 'io.tests' 이름 충돌, pj-prompts §5): 처분: 우회 유지(메인 2026-09-28,
import-mode 는 바꾸지 않는다). 지금은 app/ 부터 이 디렉터리까지 __init__.py 가 이어져 모듈 이름이 app.features.projects.prompts.io.tests.*
로 잡히고, 파일 이름도 test_prompts_io.py 로 유일하게 둔다. conftest 대신 env 픽스처를 여기서 직접 가져온다.
"""
from __future__ import annotations

import io
import os
import threading
import uuid
import warnings as pywarnings
import zipfile
from xml.sax.saxutils import escape

import pytest

from app.core.write import get_audit_writer
from app.core.xlsx import SheetSpec
from app.core.xlsx import write_workbook as core_write_workbook
from app.features.projects.prompts.crud.tests._support import env_fixture  # noqa: F401  (fixture 'env' 등록)
from app.features.projects.prompts.io.xlsx import XlsxError, read_workbook
from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def handmade_xlsx(rows: list[list[str | None]]) -> bytes:
    """구현 쓰기와 독립인 xlsx: 공유 문자열(sharedStrings) 셀, 빈 칸은 셀 생략, 워크북 관계 경로 절대형."""
    strings: list[str] = []
    body = []
    for rn, row in enumerate(rows, start=1):
        cells = []
        for ci, v in enumerate(row):
            if v is None:
                continue
            strings.append(v)
            cells.append(f'<c r="{chr(65 + ci)}{rn}" t="s"><v>{len(strings) - 1}</v></c>')
        body.append(f'<row r="{rn}">{"".join(cells)}</row>')
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    files = {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        "xl/workbook.xml": f'<workbook xmlns="{main}" xmlns:r="{rel}"><sheets><sheet name="S" sheetId="7" r:id="rIdX"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                                       f'<Relationship Id="rIdX" Type="{rel}/worksheet" Target="/xl/worksheets/data.xml"/></Relationships>'),
        "xl/sharedStrings.xml": f'<sst xmlns="{main}">' + "".join(f"<si><t>{escape(s)}</t></si>" for s in strings) + "</sst>",
        "xl/worksheets/data.xml": f'<worksheet xmlns="{main}"><sheetData>{"".join(body)}</sheetData></worksheet>',
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for k, v in files.items():
            z.writestr(k, v)
    return buf.getvalue()


def write_workbook(headers: list[str], rows: list[list[str]]) -> bytes:
    """내보내기와 같은 쓰기(6라운드: 기능 write_workbook 을 core.xlsx.write_workbook(SheetSpec)으로 통일, pj-prompts §1 처분)."""
    return core_write_workbook([SheetSpec("prompts", headers, rows)])


# ── 단위(DB 없음) ──
def test_xlsx_roundtrip_and_reader_cases():
    data = write_workbook(["id", "text", "태그"], [["a", "=SUM(1)", " 공백 "], ["b", "x\x01y", ""]])
    rows = read_workbook(data, max_rows=10)
    # core 쓰기는 빈 값('') 셀을 쓰지 않는다(core.xlsx 셀 규칙) → 읽은 행은 마지막 값 셀까지(예전 기능 쓰기는 빈 inlineStr 셀을 썼다)
    assert rows == [(1, ["id", "text", "태그"]), (2, ["a", "=SUM(1)", "공백"]), (3, ["b", "xy"])]
    assert read_workbook(handmade_xlsx([["ID", "Text"], [None, "only text"], [None, None], ["i", None]]), max_rows=10) == [
        (1, ["ID", "Text"]), (2, ["", "only text"]), (4, ["i"])]
    with pytest.raises(XlsxError) as e:
        read_workbook(b"not a zip", max_rows=10)
    assert e.value.code == "invalid_xlsx"
    with pytest.raises(XlsxError) as e:
        read_workbook(handmade_xlsx([["text"], ["a"], ["b"], ["c"]]), max_rows=2)
    assert e.value.code == "too_many_rows"
    evil = io.BytesIO()
    with zipfile.ZipFile(evil, "w") as z:
        z.writestr("xl/workbook.xml", '<!DOCTYPE x [<!ENTITY a "b">]><workbook/>')
    with pytest.raises(XlsxError):
        read_workbook(evil.getvalue(), max_rows=10)


def _swap_parts(base: bytes, parts: dict[str, bytes]) -> bytes:
    """base xlsx 의 부분 파일을 바꿔 끼운다(폭탄 시트 제작용)."""
    src = zipfile.ZipFile(io.BytesIO(base))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for n in src.namelist():
            z.writestr(n, parts.pop(n, None) or src.read(n))
        for n, v in parts.items():
            z.writestr(n, v)
    return out.getvalue()


_MAIN = b"http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def _sheet(body: bytes) -> bytes:
    return b'<worksheet xmlns="' + _MAIN + b'"><sheetData>' + body + b"</sheetData></worksheet>"


def _peak(fn):
    """fn() 실행 중 파이썬 할당 최고치(바이트)와 결과(예외면 XlsxError 코드)."""
    import tracemalloc
    tracemalloc.start()
    try:
        try:
            res = fn()
        except XlsxError as e:
            res = e.code
        return tracemalloc.get_traced_memory()[1], res
    finally:
        tracemalloc.stop()


def test_xlsx_bomb_limits_applied_while_streaming():
    """검증 D3 회귀: 38MB '<c/>' 반복 시트(zip 40KB)가 통째 파싱돼 RSS +900MB 이던 결함.
    지금은 상한을 파싱 중에 적용해 행 하나 분량만 메모리에 둔다(최고 할당 수 MB 이내)."""
    base = handmade_xlsx([["text"], ["a"]])
    sheet_path = "xl/worksheets/data.xml"
    cases = {
        "38MB 빈 셀(부분 파일 상한)": (_sheet(b'<row r="1">' + b"<c/>" * (38 * 1024 * 1024 // 4) + b"</row>"), "file_too_large"),
        "15MB 빈 셀(열 상한)": (_sheet(b'<row r="1">' + b"<c/>" * (15 * 1024 * 1024 // 4) + b"</row>"), "too_many_columns"),
        "같은 칸 반복(셀 수 상한)": (_sheet(b'<row r="1">' + b'<c r="A1"/>' * 1_000_000 + b"</row>"), "too_many_columns"),
        "빈 행 반복(행 요소 상한)": (_sheet(b"<row/>" * 2_000_000), "too_many_rows"),
    }
    for name, (xml, code) in cases.items():
        data = _swap_parts(base, {sheet_path: xml})
        assert len(data) < 200_000, name                                          # 압축 폭탄: 업로드 상한(5MB)을 가볍게 통과
        peak, res = _peak(lambda d=data: read_workbook(d, max_rows=5000))
        assert res == code, (name, res)
        assert peak < 8 * 1024 * 1024, (name, peak)                                # 예전 구현은 수백 MB
    big_shared = _swap_parts(base, {"xl/sharedStrings.xml": b'<sst xmlns="' + _MAIN + b'">' + b"<si><t>ab</t></si>" * 2_000_000 + b"</sst>"})
    assert _peak(lambda: read_workbook(big_shared, max_rows=5000))[1] == "file_too_large"      # 36MB > 16MB
    many_shared = _swap_parts(base, {"xl/sharedStrings.xml": b'<sst xmlns="' + _MAIN + b'">' + b"<si/>" * 201 + b"</sst>"})
    assert _peak(lambda: read_workbook(many_shared, max_rows=0))[1] == "too_many_cells"         # 공유 문자열 (0+1)·200 개 초과
    dtd = _swap_parts(base, {sheet_path: b'<?xml version="1.0"?><!DOCTYPE w [<!ENTITY e "x">]>' + _sheet(b"")})
    assert _peak(lambda: read_workbook(dtd, max_rows=10))[1] == "invalid_xlsx"


# ── 검증 D3-R 회귀: 공유 문자열 참조 증폭·중복 헤더 경고 증폭(parse_rows = 라우터가 스레드 풀에서 부르는 경로) ──
def _outcome(fn):
    from app.core.errors import ApiError
    try:
        return fn()
    except (XlsxError, ApiError) as e:
        return e.code


# 간격(gap·비율) 단언은 공용 셀프호스트 러너(HGH_CI_SHARED_RUNNER=1, 조직 공용 러너)에서만 판정하지 않고 값을 경고로 남긴다: 머신
# 과부하(loadavg 27, 8코어 실측)로 0.26~0.65초까지 흔들린다(2026-09-30, 같은 시험이 호스티드·로컬에서는 통과). 파싱이 작업 스레드에서
# 도는지(_route_parse 의 스레드 단언)·피크 메모리·처리 시간·결과 단언은 어디서나 그대로 판정한다.
SHARED_RUNNER = os.environ.get("HGH_CI_SHARED_RUNNER") == "1"


def _assert_loop_gap(ok: bool, detail) -> None:
    if SHARED_RUNNER:
        pywarnings.warn(f"HGH_CI_SHARED_RUNNER=1: 이벤트 루프 간격 단언 판정 생략(공용 러너 부하), 만족={ok} {detail}", stacklevel=2)
        return
    assert ok, detail


class _Parsed(Exception):
    """가져오기 라우터가 파싱을 마치고 DB 쓰기(import_rows)로 넘어가는 지점에서 멈춘다."""


async def _route_parse(monkeypatch, data: bytes):
    """가져오기 라우터(post_projects_by_id_prompts_import_1)를 게이트·업로드 읽기·DB 쓰기만 막고 그대로 태운다.
    (parse_rows 결과 또는 오류 코드, parse_rows 가 돈 스레드 목록). 라우터가 run_in_threadpool 없이 parse_rows 를 직접 부르면
    (= 이벤트 루프 스레드에서 파싱) 목록에 이벤트 루프 스레드가 들어가 호출 쪽 단언이 실패한다."""
    from app.core.errors import ApiError
    from app.features.projects.prompts.io import router as io_router
    from app.features.projects.prompts.io import service as io_service
    seen: list[int] = []
    out: list = []
    real = io_service.parse_rows

    def spy(d: bytes):                                                                    # 실제 파싱 함수가 도는 스레드를 기록
        seen.append(threading.get_ident())
        res = real(d)
        out.append(res)
        return res

    async def gate(*_a, **_k):
        return None

    async def upload(*_a, **_k):
        return data

    async def stop(*_a, **_k):
        raise _Parsed

    monkeypatch.setattr(io_router, "project_gate", gate)
    monkeypatch.setattr(io_router, "read_upload_request", upload)
    monkeypatch.setattr(io_service, "parse_rows", spy)
    monkeypatch.setattr(io_service, "import_rows", stop)
    try:
        await io_router.post_projects_by_id_prompts_import_1(uuid.uuid4(), None, None, None, None)
    except _Parsed:
        return out[0], seen
    except (XlsxError, ApiError) as e:
        return e.code, seen
    raise AssertionError("라우터가 import_rows 전에 끝났다")


async def _gap(afn):
    """afn()(코루틴)을 기다리는 동안 5ms asyncio 티커의 최대 간격(초)·처리 시간(초)·결과."""
    import asyncio
    import time

    gaps: list[float] = []
    done = asyncio.Event()

    async def ticker():
        last = time.perf_counter()
        while not done.is_set():
            await asyncio.sleep(0.005)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    task = asyncio.create_task(ticker())
    await asyncio.sleep(0.03)
    gaps.clear()
    t0 = time.perf_counter()
    res = await afn()
    took = time.perf_counter() - t0
    done.set()
    await task
    return max(gaps, default=0.0), took, res


def _shared_book(header: list[bytes], rows: list[list[int | None]], strings: list[bytes]) -> bytes:
    """행: 공유 문자열 번호 목록(None = 셀 없음). header 는 인라인 문자열."""
    def c(ref, idx):
        return f'<c r="{ref}" t="s"><v>{idx}</v></c>'.encode()
    from app.core.xlsx import column_letter as L
    body = [b'<row r="1">' + b"".join(f'<c r="{L(i)}1" t="inlineStr"><is><t>'.encode() + h + b"</t></is></c>" for i, h in enumerate(header))
            + b"</row>"]
    for rn, row in enumerate(rows, start=2):
        body.append(f'<row r="{rn}">'.encode() + b"".join(c(f"{L(i)}{rn}", v) for i, v in enumerate(row) if v is not None) + b"</row>")
    sst = b'<sst xmlns="' + _MAIN + b'">' + b"".join(b'<si><t xml:space="preserve">' + t + b"</t></si>" for t in strings) + b"</sst>"
    return _swap_parts(handmade_xlsx([["text"]]), {"xl/worksheets/data.xml": _sheet(b"".join(body)), "xl/sharedStrings.xml": sst})


def _junk(n: int, alphabet: bytes, seed: int = 3) -> bytes:
    """압축이 잘 안 되는 n 바이트(alphabet 문자만). 무작위 바이트를 alphabet 으로 사상한다."""
    import random
    table = bytes(alphabet[i % len(alphabet)] for i in range(256))
    return random.Random(seed).randbytes(n).translate(table)


_B64 = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"


@pytest.mark.parametrize("name", ["amp_50", "amp_200x100", "amp_verifier"])
async def test_parse_rows_shared_string_amplification(name, monkeypatch):
    """D3-R(a): 큰 공유 문자열 하나를 셀 여럿이 참조. 수정 전: 셀마다 strip 복사(검증 실측 50셀 → maxrss 28→132MB, 상한 안 최악
    행 하나 ≈ 3GB). 지금: 읽을 때 한 번 strip·4,001자에서 자르고 셀은 같은 객체를 참조, 참조마다 센 누적 문자가 16M 을 넘으면 422."""
    from app.features.projects.prompts.io.service import parse_rows
    big = b"  " + _junk(900_000, _B64) + b"  "                                  # 압축 안 되는 0.9MB(압축비 가드를 피한다)
    data, code = {
        "amp_50": (_shared_book([b"text"], [[0] * 50], [big]), None),
        "amp_200x100": (_shared_book([b"text"], [[0] * 200] * 100, [big]), "text_too_large"),        # 2만 참조 × 4,001자 > 16M
        "amp_verifier": (_shared_book([b"text"], [[0] * 50], [b" " + b"x" * (2 * 1024 * 1024) + b" "]), "file_too_large"),  # 압축비
    }[name]
    loop_thread = threading.get_ident()
    gap, took, (res, parse_threads) = await _gap(lambda: _route_parse(monkeypatch, data))
    assert parse_threads and loop_thread not in parse_threads, (name, loop_thread, parse_threads)   # 결정적: 작업 스레드 파싱(D3)
    peak, res2 = _peak(lambda: _outcome(lambda: parse_rows(data)))
    if code is None:
        rows, _, warnings = res
        assert len(rows) == 1 and len(rows[0]["text"]) == 4001                    # 본문 상한 + 1: import 가 '4000자를 넘어 건너뜀'
        assert len(warnings) == 50 and warnings.used < 64 * 1024                  # 잘림 경고(셀 위치), 건수·바이트 상한 안
    else:
        assert res == code and res2 == code, res
    assert peak < 16 * 1024 * 1024, (name, peak)
    assert took < 3, (name, took)
    _assert_loop_gap(gap < max(0.1, 0.25 * took) and gap < 0.5, (name, took, gap))


@pytest.mark.parametrize("name", ["dup_199", "dup_verifier", "dup_2mb_incompressible"])
async def test_parse_rows_duplicate_header_warning_amplification(name, monkeypatch):
    """D3-R(b): 정규화하면 'id' 가 되는 긴 헤더를 여러 칸이 참조 → '헤더 …가 중복' 경고에 원문이 그대로 실려 응답으로 나가던 결함
    (검증 실측: 24칸 × 2MB → 경고 합계 5,033만 자·rss 67→168MB, 상한 안 최악 ≈ 3GB). 지금: 원문은 40자로 자르고 경고는
    200건·64KB 상한, 셀 값은 4,001자 상한, 2MB 원문은 토큰·압축비 가드로 422."""
    from app.core.xlsx import column_letter as L
    from app.features.projects.prompts.io.service import parse_rows

    def header_refs(n: int, first_text: bool) -> bytes:
        text = b'<c r="A1" t="inlineStr"><is><t>text</t></is></c>' if first_text else b""
        start = 1 if first_text else 0
        return _sheet(b'<row r="1">' + text + b"".join(f'<c r="{L(i)}1" t="s"><v>0</v></c>'.encode() for i in range(start, n)) + b"</row>")

    raw = {"dup_199": b"i" + _junk(3999, b" \t_-") + b"d",                        # 정규화(공백·_·- 제거)하면 'id', 셀 상한 안
           "dup_verifier": b"i" + b" " * (2 * 1024 * 1024) + b"d",                    # 검증 원판(압축 잘 됨)
           "dup_2mb_incompressible": b"i" + _junk(2 * 1024 * 1024, b" \t_-") + b"d"}[name]
    code = {"dup_199": None, "dup_verifier": "file_too_large", "dup_2mb_incompressible": "invalid_xlsx"}[name]   # 압축비 / 토큰 1MB
    data = _swap_parts(handmade_xlsx([["text"]]), {"xl/worksheets/data.xml": header_refs(200 if name == "dup_199" else 24, name == "dup_199"),
                                                   "xl/sharedStrings.xml": b'<sst xmlns="' + _MAIN + b'"><si><t xml:space="preserve">'
                                                   + raw + b"</t></si></sst>"})
    loop_thread = threading.get_ident()
    gap, took, (res, parse_threads) = await _gap(lambda: _route_parse(monkeypatch, data))
    assert parse_threads and loop_thread not in parse_threads, (name, loop_thread, parse_threads)   # 결정적: 작업 스레드 파싱(D3)
    peak, _ = _peak(lambda: _outcome(lambda: parse_rows(data)))
    if code is None:
        _, _, warnings = res
        out = warnings.to_list()
        dup = [w for w in out if "중복" in w]
        assert len(dup) == 198 and max(len(w) for w in out) < 100                # 원문은 40자로 잘린다(예전: 칸마다 4,001자)
        assert sum(len(w.encode()) for w in out) <= 64 * 1024 + 100
    else:
        assert res == code, res
    assert peak < 16 * 1024 * 1024, (name, peak)
    assert took < 3, (name, took)
    _assert_loop_gap(gap < max(0.1, 0.25 * took) and gap < 0.5, (name, took, gap))


async def test_parse_rows_normal_max_size_stays_responsive(monkeypatch):
    """정상 최대 규모(데이터 5,000행 × 20열): 성공, 작업 스레드 파싱, 피크·시간·이벤트 루프 간격 상한."""
    from app.features.projects.prompts.io.service import parse_rows
    data = write_workbook(["text", *[f"t{i}" for i in range(19)]], [[f"본문 {r}", *[f"v{r}-{c}" for c in range(19)]] for r in range(5000)])
    loop_thread = threading.get_ident()
    gap, took, (res, parse_threads) = await _gap(lambda: _route_parse(monkeypatch, data))
    assert parse_threads and loop_thread not in parse_threads, (loop_thread, parse_threads)       # 결정적: 작업 스레드 파싱(D3)
    peak, _ = _peak(lambda: _outcome(lambda: parse_rows(data)))
    rows, tags, warnings = res
    assert len(rows) == 5000 and len(tags) == 19 and len(warnings) == 0
    assert peak < 64 * 1024 * 1024 and took < 5, (peak, took, gap)
    _assert_loop_gap(gap < max(0.1, 0.25 * took) and gap < 0.5, (peak, took, gap))


# ── API ──
def eurl(pid):
    return f"/v1/projects/{pid}/prompts/export"


def iurl(pid):
    return f"/v1/projects/{pid}/prompts/import"


@needs_db
async def test_export_contents_permissions_and_audit(env, client_as):
    pid = await env.mk_project()
    a = await env.mk_prompt("first", project_id=pid)
    b = await env.mk_prompt("second", project_id=pid, status="done", scope_prompt_id=uuid.uuid4())
    gone = await env.mk_prompt("gone", project_id=pid)
    await env.as_actor("UPDATE app.prompt SET deleted_at = now() WHERE prompt_id = $1", gone)
    f = await env.mk_field("세그먼트", project_id=pid)
    await env.mk_field("보관됨", project_id=pid, archived=True)
    await env.set_tag(b, f, "SUV", project_id=pid)
    w = get_audit_writer()
    await w.flush()
    async with client_as(VENDOR) as c:
        r = await c.get(eurl(pid), params={"country": "US"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == XLSX and "attachment" in r.headers["content-disposition"]
    assert r.headers["x-hgh-ignored-filters"] == "country"
    rows = read_workbook(r.content, max_rows=100)
    assert rows[0][1] == ["id", "text", "세그먼트"]
    # 태그 값이 없는 칸은 셀이 없다(6라운드 core.xlsx 쓰기: 빈 값 셀 생략) → 행은 마지막 값 셀까지
    assert sorted(x[1] for x in rows[1:]) == sorted([[str(a), "first"], [str(b), "second", "SUV"]])
    await w.flush()
    assert await env.val("SELECT count(*) FROM app.access_audit_log WHERE actor_id = $1 AND kind = 'download' "
                         "AND action = 'projects.prompts.export' AND target = $2", VENDOR, str(pid)) == 1
    for uid, code in ((HQ_HYUNDAI, 404), (KIA_US, 404), (env.nomenu, 403), (None, 401)):   # 메인 정정 2026-09-28: 비멤버(스코프 안) 읽기 404(front prompt/page.tsx:43 notFound)
        async with client_as(uid) as c:
            assert (await c.get(eurl(pid))).status_code == code, uid


@needs_db
async def test_import_rules(env, client_as):
    pid = await env.mk_project()
    draft = await env.mk_prompt("draft old", project_id=pid)
    done = await env.mk_prompt("done text", project_id=pid, status="done", scope_prompt_id=uuid.uuid4())
    seg = await env.mk_field("세그먼트", project_id=pid)
    await env.set_tag(draft, seg, "SUV", project_id=pid)
    await env.set_tag(done, seg, "Sedan", project_id=pid)
    other = await env.mk_project()
    foreign = await env.mk_prompt("foreign", project_id=other)
    sheet = [
        ["ID", "Text", "세그먼트", "새태그", "brand", "세그먼트"],     # 중복 헤더·예약어·신규 태그
        [str(draft), "draft new", "", "N1", "Hyundai", "ignored"],     # 본문 변경(draft) + 세그먼트 비움 + 새 태그
        [str(done), "changed text", "Sedan", None, None, None],        # 본문 변경 불가(경고), 태그 동일 → skipped
        [None, "brand new", "EV", "N2", None, None],                   # 신규
        [None, "brand new", None, None, None, None],                   # 파일 내 중복
        [None, "done text", None, None, None, None],                   # 기존 본문 중복
        [str(foreign), "x", None, None, None, None],                   # 다른 프로젝트 id
        ["not-a-uuid", "x", None, None, None, None],
        [None, None, "orphan tag", None, None, None],                  # id·본문 없음
    ]
    async with client_as(env.owner) as c:
        r = await c.post(iurl(pid), files={"file": ("p.xlsx", handmade_xlsx(sheet), XLSX)})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert (d["created"], d["updated"], d["skipped"], d["created_tags"]) == (1, 1, 6, 1)
    assert any("중복" in w and "헤더" in w for w in d["warnings"]) and any("고정 분류축" in w for w in d["warnings"])
    rows = {x["text"]: x for x in await env.q("SELECT prompt_id, text, status FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL", pid)}
    assert set(rows) == {"draft new", "done text", "brand new"}
    new_tag = await env.val("SELECT field_id FROM app.project_custom_field WHERE project_id = $1 AND label = '새태그'", pid)
    vals = {(x["prompt_id"], x["field_id"]): x["value"] for x in await env.q(
        "SELECT prompt_id, field_id, value FROM app.prompt_custom_field_value WHERE project_id = $1", pid)}
    assert vals == {(draft, new_tag): "N1", (done, seg): "Sedan", (rows["brand new"]["prompt_id"], seg): "EV",
                    (rows["brand new"]["prompt_id"], new_tag): "N2"}
    assert await env.val("SELECT count(*) FROM app.project_custom_field WHERE project_id = $1 AND lower(label) = 'brand'", pid) == 0
    assert await env.val("SELECT text FROM app.prompt WHERE prompt_id = $1", foreign) == "foreign"
    assert [a["event_type"] for a in await env.audits(draft)][-1] == "text_updated"
    assert (await env.audits(draft))[-1]["actor_id"] == env.owner
    # xlsx 본문 그대로도 받는다(두 번째 가져오기 = 모두 변화 없음)
    async with client_as(env.owner) as c:
        r = await c.post(iurl(pid), content=handmade_xlsx([["text"], ["brand new"]]), headers={"content-type": XLSX})
    assert r.status_code == 200 and r.json()["data"]["created"] == 0 and r.json()["data"]["skipped"] == 1


@needs_db
async def test_import_errors_permissions_and_limits(env, client_as):
    pid = await env.mk_project()
    ok = handmade_xlsx([["text"], ["a"]])
    for uid, code in ((VENDOR, 403), (HQ_HYUNDAI, 403), (env.op, 403), (KIA_US, 404)):
        async with client_as(uid) as c:
            assert (await c.post(iurl(pid), files={"file": ("p.xlsx", ok, XLSX)})).status_code == code, uid
    async with client_as(env.owner) as c:
        cases = [
            ({"files": {"file": ("p.xlsx", b"garbage", XLSX)}}, 422, "invalid_xlsx"),
            ({"files": {"other": ("p.xlsx", ok, XLSX)}}, 422, "invalid_upload"),
            ({"files": {"file": ("p.xlsx", handmade_xlsx([["foo", "bar"], ["1", "2"]]), XLSX)}}, 422, "missing_header"),
            ({"files": {"file": ("p.xlsx", handmade_xlsx([["text"]] + [[f"r{i}"] for i in range(5001)]), XLSX)}}, 422, "too_many_rows"),
            ({"content": b"{}", "headers": {"content-type": "application/json"}}, 415, "unsupported_media_type"),
            ({"content": b"x" * (5 * 1024 * 1024 + 70 * 1024), "headers": {"content-type": XLSX}}, 413, "payload_too_large"),
        ]
        for kw, code, err in cases:
            r = await c.post(iurl(pid), **kw)
            assert r.status_code == code and r.json()["error"]["code"] == err, (err, r.text[:200])
    assert await env.val("SELECT count(*) FROM app.prompt WHERE project_id = $1", pid) == 0
    async with client_as(ADMIN) as c:
        r = await c.post(iurl(pid), files={"file": ("p.xlsx", ok, XLSX)})
    assert r.status_code == 200 and r.json()["data"]["created"] == 1


@needs_db
async def test_import_applies_field_rules(env, client_as):
    """검증 D5 회귀: 가져오기가 fields API 상한(이름 100자·제어 문자·대소문자 무시 중복, 값 500자)을 우회하던 결함."""
    pid = await env.mk_project()
    archived = await env.mk_field("color", project_id=pid, archived=True)
    long_label = "L" * 101
    sheet = [
        ["text", "Color", long_label, "tab\there", "ok"],
        ["row one", "red", "x", "y", "v" * 501],               # 값 501자 → 그 칸만 건너뜀
        ["row two", "blue", None, None, "multi\nline"],        # 값 줄바꿈 → 그 칸만 건너뜀
        ["bad\u007ftext", "green", None, None, "fine"],         # 본문 제어 문자(DEL) → 행 건너뜀
    ]
    async with client_as(env.owner) as c:
        r = await c.post(iurl(pid), files={"file": ("p.xlsx", handmade_xlsx(sheet), XLSX)})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert (d["created"], d["skipped"], d["created_tags"]) == (2, 1, 1)                     # 새 태그는 'ok' 하나뿐
    labels = sorted(x["label"] for x in await env.q("SELECT label FROM app.project_custom_field WHERE project_id = $1", pid))
    assert labels == ["color", "ok"]                                                          # 'Color' 는 보관된 color 로 매칭
    ws = d["warnings"]
    assert sum("태그 이름 규칙" in w for w in ws) == 2
    assert sum("값이 규칙" in w for w in ws) == 2 and any("제어 문자가 있어" in w for w in ws)
    ok = await env.val("SELECT field_id FROM app.project_custom_field WHERE project_id = $1 AND label = 'ok'", pid)
    vals = {(x["text"], x["field_id"]): x["value"] for x in await env.q(
        "SELECT p.text, v.field_id, v.value FROM app.prompt_custom_field_value v JOIN app.prompt p USING (prompt_id) "
        "WHERE v.project_id = $1", pid)}
    assert vals == {("row one", archived): "red", ("row two", archived): "blue"}
    assert ok not in {f for _, f in vals}
