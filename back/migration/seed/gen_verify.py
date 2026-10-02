#!/usr/bin/env python3
"""verify-seed.sql 생성: TS 덤프(out.json)의 정규화 결과로 파리티 기대 md5 를 계산해 psql 변수로 앞에 붙인다.
사용: python3 gen_verify.py <out.json> > verify-seed.sql"""
import hashlib, json, sys, os
d = json.load(open(sys.argv[1]))
def md5(pairs):
    return hashlib.md5("\n".join(f"{i}|{n}" for i, n in sorted(pairs)).encode("utf8")).hexdigest()
here = os.path.dirname(os.path.abspath(__file__))
tpl = open(os.path.join(here, "verify-seed.tpl.sql"), encoding="utf8").read()
head = f"\\set pob_md5 '{md5(d['pob_norm'])}'\n\\set ptu_md5 '{md5(d['ptu_norm'])}'\n"
sys.stdout.write(head + tpl)
