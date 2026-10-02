"""GA4 전환 테스트 합성 데이터(core 롤백 전용 준비: 모듈 하나가 한 트랜잭션, 끝에 ROLLBACK). 공용 픽스처에는 GA4 행이 없다.

레지스트리(app.ga4_property): Kia IT active · Hyundai US active · Kia DE pending_grant · Genesis KR unmapped(적재 투영 없음).
적재 투영(rd.ga4_dim_property): 901 Kia IT active conv_basis 2(event_count) · 902 Hyundai US active conv_basis 1(key_events) · 903 Kia DE pending_grant.
차원 값(rd.ga4_dim_value, 키 9001~): device mobile·desktop, nvr new·returning, page /a·/b, event purchase·page_view.

rd.ga4_row (날짜 2026-09-10·09-11, 창 밖 05-01)
| 속성 | 보고서 | 날짜  | 코호트(엔진)  | 기기    | 신규 | 페이지 | 이벤트    | 전환 | sessions | page_views | key_events | event_count |
| 901  | 1      | 09-10 | AI(chatgpt)   | mobile  | new  |        |           |      | 10       |            |            |             |
| 901  | 1      | 09-10 | 비AI          | desktop | ret  |        |           |      | 100      |            |            |             |
| 901  | 1      | 09-11 | AI(gemini)    | desktop | new  |        |           |      | 5        |            |            |             |
| 901  | 1      | 09-11 | 비AI          | mobile  | new  |        |           |      | 50       |            |            |             |
| 901  | 1      | 05-01 | 비AI          | mobile  | new  |        |           |      | 999      |            |            |             |
| 901  | 2      | 09-10 | AI(chatgpt)   | mobile  | new  |        |           |      | 10       | 30         |            |             |
| 901  | 2      | 09-11 | AI(gemini)    | desktop | new  |        |           |      | 5        | 8          |            |             |
| 901  | 3      | 09-10 | AI(chatgpt)   | mobile  | new  |        | purchase  | 참   |          |            | 9          | 2           |
| 901  | 3      | 09-10 | 비AI          | desktop | ret  |        | purchase  | 참   |          |            | 99         | 7           |
| 901  | 3      | 09-11 | AI(gemini)    | desktop | new  |        | purchase  | 참   |          |            | 0          | 1           |
| 901  | 3      | 09-10 | 비AI          | desktop | ret  |        | page_view | 거짓 |          |            |            | 500         |
| 901  | 4      | 09-10 | AI(chatgpt)   | mobile  | new  | /a     |           |      | 10       |            |            |             |
| 901  | 4      | 09-10 | 비AI          | desktop | ret  | /a     |           |      | 60       |            |            |             |
| 901  | 4      | 09-11 | 비AI          | mobile  | new  | /b     |           |      | 50       |            |            |             |
| 901  | 4      | 09-11 | AI(gemini)    | desktop | new  | /b     |           |      | 5        |            |            |             |
| 901  | 4      | 09-10 | AI(chatgpt)   | mobile  | new  | /a     | purchase  | 참   |          |            | 9          | 2           |
| 901  | 4      | 09-10 | 비AI          | desktop | ret  | /a     | purchase  | 참   |          |            | 99         | 7           |
| 902  | 1      | 09-11 | AI(chatgpt)   | mobile  | ret  |        |           |      | 20       |            |            |             |
| 902  | 1      | 09-11 | 비AI          | desktop | ret  |        |           |      | 200      |            |            |             |
| 902  | 2      | 09-11 | AI(chatgpt)   | mobile  | ret  |        |           |      | 20       | 40         |            |             |
| 902  | 3      | 09-11 | AI(chatgpt)   | mobile  | ret  |        | purchase  | 참   |          |            | 4          | 50          |
| 902  | 3      | 09-11 | 비AI          | desktop | ret  |        | purchase  | 참   |          |            | 10         | 60          |
| 902  | 4      | 09-11 | AI(chatgpt)   | mobile  | ret  | /a     |           |      | 20       |            |            |             |
| 902  | 4      | 09-11 | 비AI          | desktop | ret  | /a     |           |      | 200      |            |            |             |
| 903  | 1      | 09-11 | 비AI          | desktop | ret  |        |           |      | 7777     |            |            |             |
"""
from __future__ import annotations

import pathlib

import pytest_asyncio

from tests.support import SqlFile, staged

# 시드 SQL 은 rd 쓰기(소유자 실행)라 데이터 파일(.pgsql)로 둔다(back/tests/README.md 6절). 모듈이 끝나면 ROLLBACK 이라 정리 문장이 없다.
SEED = pathlib.Path(__file__).with_name("seed_ga4.pgsql")


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def ga4_seed(seeded):
    """모듈 단위 롤백 전용 준비: 소유자가 시드를 넣고, 모듈 안 요청은 같은 트랜잭션에서 api_ro 로 돈다(반환 = 그 커넥션).
    시험 하나가 더하는 행은 tests.support.savepoint 안에서 stage() 로 넣는다(그 시험 끝에 되돌린다)."""
    async with staged(SqlFile(SEED)) as conn:
        yield conn
