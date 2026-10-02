"""ACR 테스트 추가 합성 데이터(core 롤백 전용 준비: 모듈 하나가 한 트랜잭션, 끝에 ROLLBACK).

공용 픽스처의 ACR 은 셀 501(회차 11·SP3·chatgpt·US, 유효 2: Hyundai 선택 1·Toyota 1·Apple keep 거짓) 하나뿐이라,
필터·게이트·당사 판정을 가르는 셀을 더 넣는다. 키는 9000 번대(픽스처와 겹치지 않음). 차원 키는 코드로 찾는다.

| 셀   | 회차(날짜)      | 프롬프트        | bgrp | 엔진     | 국가 | 언어 | 유효 | acr_in | 브랜드 선택(등장)                      | 차종                 |
| 9101 | 11 (09-14)      | 9001 Hyundai   | 1    | gemini   | KR   | en   | 4    | 참     | Hyundai 3(4), Toyota 1(2)              | Hyundai Creta 2(3)   |
| 9102 | 11 (09-14)      | 9002 Kia       | 2    | chatgpt  | US   | en   | 3    | 참     | Kia 2(3), Hyundai 1(1)                 |                      |
| 9103 | 11 (09-14)      | 3 HMG          | 8    | deepseek | US   | en   | 5    | 참     | Toyota 5(5)                            | Toyota RAV4 3(4)     |
| 9104 | 10 (09-07)      | 3 HMG          | 8    | chatgpt  | US   | en   | 2    | 참     | Hyundai 2(2)                           |                      |
| 9105 | 11 (09-14)      | 3 HMG          | 8    | chatgpt  | DE   | de   | 9    | 거짓   | Toyota 9(9)                            |                      |
| 9106 | 12 (09-21 비서빙) | 3 HMG         | 8    | chatgpt  | US   | en   | 7    | 참     | Toyota 7(7)                            |                      |
카탈로그: 9001 = Hyundai 비트 1·list_type L1, 9002 = Kia 비트 2·list_type L1.
"""
from __future__ import annotations

import pathlib

import pytest_asyncio

from tests.support import SqlFile, staged

# 시드 SQL 은 rd 쓰기(소유자 실행)라 데이터 파일(.pgsql)로 둔다(back/tests/README.md 6절). 모듈이 끝나면 ROLLBACK 이라 정리 문장이 없다.
SEED = pathlib.Path(__file__).with_name("seed_acr.pgsql")


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def acr_seed(seeded):
    """모듈 단위 롤백 전용 준비: 소유자가 시드를 넣고, 모듈 안 요청은 같은 트랜잭션에서 api_ro 로 돈다(반환 = 그 커넥션).
    시험 하나가 더하는 행은 tests.support.savepoint 안에서 stage() 로 넣는다(그 시험 끝에 되돌린다)."""
    async with staged(SqlFile(SEED)) as conn:
        yield conn
