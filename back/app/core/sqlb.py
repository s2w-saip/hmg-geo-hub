"""작은 SQL 조립 도구: 이름 바인드(:pN) 수집기와 값 인라인 렌더러.

- 기능 코드는 사용자 입력을 SQL 문자열에 넣지 않는다. 값은 Binder 로만 넣고, 열·식 조각은 화이트리스트 상수에서 고른다.
- 배열·날짜는 CAST(:p AS 타입) 으로 감싼다(SQLAlchemy text() 에서 ':p::타입' 은 바인드로 인식되지 않는다).
- render_literals 는 정수·불리언·날짜·짧은 문자열·정수 배열만 인라인한다(EC2 대조 러너·EXPLAIN 용). 요청 경로에서는 쓰지 않는다.
외부 의존 없음(표준 라이브러리만): 대조 러너가 이 파일을 그대로 가져다 쓴다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any


@dataclass
class Sql:
    text: str
    params: dict[str, Any] = field(default_factory=dict)


class Binder:
    """이름 바인드 수집기. 같은 문장 안에서 이름이 겹치지 않게 접두·일련번호를 붙인다."""

    def __init__(self, prefix: str = "p"):
        self.prefix = prefix
        self.params: dict[str, Any] = {}
        self._n = 0

    def v(self, value: Any, cast: str | None = None) -> str:
        name = f"{self.prefix}{self._n}"
        self._n += 1
        self.params[name] = value
        return f"CAST(:{name} AS {cast})" if cast else f":{name}"

    def ints(self, values: Any, typ: str = "int2") -> str:
        return self.v(sorted({int(x) for x in values}), f"{typ}[]")

    def date(self, d: date) -> str:
        return self.v(d, "date")

    def sql(self, text: str) -> Sql:
        return Sql(text, dict(self.params))


_BIND = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)(?!:)")


def _lit(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(int(v))
    if isinstance(v, datetime):
        return "'" + v.isoformat() + "'"
    if isinstance(v, date):
        return "'" + v.isoformat() + "'"
    if isinstance(v, (list, tuple)):
        if not v:
            return "'{}'"
        if all(isinstance(x, int) and not isinstance(x, bool) for x in v):
            return "'{" + ",".join(str(int(x)) for x in v) + "}'"
        if all(isinstance(x, (str, date)) for x in v):          # 문자열·날짜 배열은 ARRAY[...] (CAST(... AS text[]·date[]) 안)
            return "ARRAY[" + ", ".join(_lit(x) for x in v) + "]"
        raise ValueError("배열 인라인은 정수·문자열·날짜만")
    if isinstance(v, str):
        if len(v) > 200 or "\x00" in v:
            raise ValueError("문자열 인라인 한도 초과")
        return "'" + v.replace("'", "''") + "'"
    raise ValueError(f"인라인 불가 타입 {type(v).__name__}")


def render_literals(q: Sql) -> str:
    """바인드를 리터럴로 치환한 SQL(psycopg2·EXPLAIN 용). 모든 바인드 값이 있어야 한다."""
    def rep(m: re.Match[str]) -> str:
        name = m.group(1)
        if name not in q.params:
            raise KeyError(name)
        return _lit(q.params[name])
    return _BIND.sub(rep, q.text)



# 경계 가드는 app.core.sqlguard(PostgreSQL 17 파서 AST 검사, pglast)로 옮겼다. 이 파일은 대조 러너(EC2, 표준 라이브러리만)가 그대로 쓴다.
