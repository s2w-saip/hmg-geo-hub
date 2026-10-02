#!/usr/bin/env python3
"""R7 대조 입력(동기화 S1 BE-B): 출처 그룹 키 후보 + 오버라이드 시나리오를 JSON 으로 낸다. dump-official.ts 가 이 파일을 읽어 현행 TS 판정을 붙인다.

후보(판정 입력 = 출처 그룹 키, hub rd.dim_source.skey = 현행 citationGroupKey 결과):
  - 공식 도메인 42개(ts-dump-b.json owned_domains)와 경계 변형(www.·서브도메인·대문자·접두 붙음·뒤 라벨 붙음)
  - 공식 소셜 계정 키 9개와 변형(소문자·대문자·뒤 경로·www.)
  - 큐레이션 시드 도메인 전부(ts-dump-b.json seed)
  - 규칙 집합 값 전부(seed-3x-rules.sql _r_set = rules.ts 원문 순서) + 라벨 규칙 합성(라벨 + TLD) + 정규식 규칙 합성 예
  - 합성 픽스처 출처 키(tests/fixtures) + 입력 가장자리(빈 값·공백·대문자·경로)
오버라이드(현행 CitationOverrideMap: 정규화 도메인 → 카테고리): 공식 → 비공식, 비공식 → 공식, 공식 소셜 키 덮기, 비공식 → 비공식, 경쟁사 → 공식.
사용: python3 gen_official_cases.py > official-candidates.json   (dump-official.ts 머리말 참고)
"""
from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
B = json.loads((HERE / "ts-dump-b.json").read_text(encoding="utf-8"))
RULES = (HERE / "seed-3x-rules.sql").read_text(encoding="utf-8")

OVERRIDES = {
    "hyundai.com": "Blogs & Reviews",                  # 공식 도메인 → 비공식(오버라이드가 공식 도메인보다 위)
    "reddit.com": "Official (HMG)",                    # 커뮤니티 → 공식
    "linkedin.com/hyundai-motor-group": "News & Media",  # 공식 소셜 키 덮기(오버라이드가 공식 소셜보다 위)
    "example.org": "Blogs & Reviews",                  # 비공식 → 비공식
    "bmwusa.com": "Official (HMG)",                    # 경쟁사 → 공식
    "kia.co.uk": "Dealer & Marketplace",               # 규칙(HMG 라벨) 공식 → 비공식
}


def rule_sets() -> dict[str, list[str]]:
    m = re.search(r"INSERT INTO _r_set VALUES\n(.*?);\n", RULES, re.S)
    assert m, "_r_set 없음"
    out: dict[str, list[str]] = {}
    for name, v in re.findall(r"\('([A-Z_]+)', '((?:[^']|'')*)'\)", m.group(1)):
        out.setdefault(name, []).append(v.replace("''", "'"))
    return out


def main() -> None:
    keys: list[str] = []
    for d, _brand in B["owned_domains"]:
        keys += [d, f"www.{d}", f"shop.{d}", d.upper(), f"x{d}", f"{d}.example", f"{d}/us"]
    for acc in B["social"]:
        k = acc["key"]
        keys += [k, k.lower(), k.upper(), f"{k}/posts", f"www.{k}"]
    keys += [d for d, _c in B["seed"]]
    sets = rule_sets()
    for name, vals in sets.items():
        keys += vals
        if name.endswith("_LABEL"):
            for v in vals:
                keys += [f"{v}.com", f"{v}.co.uk", f"shop.{v}.com", f"{v}-club.org"]
    keys += ["wiki.example.com", "en-wiki.org", "fandom.wiki", "carwiki.net",
             "hyundaiofboston.com", "kia-dealer.net", "toyotaofdallas.com", "bmwcenter.de",
             "usa.gov", "tax.gouv.fr", "army.mil", "canada.gc.ca", "ec.europa.eu", "seoul.go.kr",
             "mit.edu", "ox.ac.uk", "unsw.edu.au",
             "carforum.net", "kiaownersclub.co.uk", "owners.example.com", "bestdealer.com",
             "myhyundaiblog.com", "kiaworld.net", "genesisfans.org", "genesis.co.kr", "genesis.a.b", "genesis.com"]
    keys += ["hyundai.com", "reddit.com", "linkedin.com/hyundai-motor-group", "example.org", "caranddriver.com", "foo-bar.xyz",
             "hyundaiusa.com", "kia.com", "bmwusa.com", "kia.de", "example.com"]
    keys += ["", " ", "WWW.HYUNDAI.COM", " hyundai.com ", "hyundai.com/", "Kia.Com", "www.reddit.com", "sub.www.kia.com"]
    seen: set[str] = set()
    uniq = [k for k in keys if not (k in seen or seen.add(k))]
    json.dump({"source": "back/migration/seed/gen_official_cases.py", "overrides": OVERRIDES, "keys": uniq}, fp=__import__("sys").stdout,
              ensure_ascii=False)


if __name__ == "__main__":
    main()
