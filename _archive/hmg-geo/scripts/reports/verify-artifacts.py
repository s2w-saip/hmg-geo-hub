#!/usr/bin/env python3
"""리포트 산출물 검수 게이트 — 통과해야 컨플루언스 업로드가 가능하다.

사용:
  python3 scripts/reports/verify-artifacts.py <extract.json> <YYYYMMDD> [--index <md>]

통과하면 docs/data/.verify-manifest.json 에 검수한 파일의 sha256 을 기록한다.
경로 정본은 scripts/paths.json (paths.py).
confluence-sync-attachments.cjs 는 올릴 파일이 이 매니페스트에 같은 해시로
들어있지 않으면 업로드를 거부한다 — 검수 후 파일을 다시 만들면 해시가 달라져
자동으로 막힌다(HTML 만 재생성하고 PDF·업로드는 옛 것이던 사고를 막는 장치).

검수 항목은 실제로 발생했던 오류에서 도출했다. 공통점은 전부 "리포트를 열어봐도
드러나지 않는" 종류라는 것이다:
  A 데이터 정합   추출본 원자료에서 KPI 가 재계산되는가 (분모·분자·분포·모순)
  B 벤치마크      상수가 발행 집합에서 재현되는가(고정점), 표기 지점이 모두 같은가
  C 판정          상·중·하가 기준표에 적힌 임계값과 일치하는가
  D 산출물 완결성 HTML/PDF 쌍·최신성·페이지 수·조합 집합 일치
  E 서술          인덱스 본문의 건수 주장이 실제 파일과 맞는가
"""
import hashlib, json, os, re, sys, glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402

REPO = paths.REPO
D = paths.PUBLISH
MANIFEST = paths.MANIFEST
BENCH_EXCLUDE_CC = {"CPO"}          # 국가 사이트가 아닌 사이트는 평균에서 제외
CANON_TOTAL = 110                   # 측정 정본 조합 수(인덱스 본문 검증용)
KEYS = ("owned", "share", "target")

fails, warns = [], []
def bad(section, msg): fails.append(f"[{section}] {msg}")
def warn(section, msg): warns.append(f"[{section}] {msg}")


def payload(path):
    m = re.search(r'type="application/json">(.*?)</script>', open(path, encoding="utf-8").read(), re.S)
    return json.loads(m.group(1).replace("<\\/", "</"))


def pct(n, d):
    return round(100 * n / d, 2) if d else None


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    extract_path, datef = sys.argv[1], sys.argv[2]
    index_md = None
    if "--index" in sys.argv:
        index_md = sys.argv[sys.argv.index("--index") + 1]

    data = json.load(open(extract_path, encoding="utf-8"))
    spec = json.load(open(os.path.join(REPO, "scripts", "reports", "report-spec.json"), encoding="utf-8"))

    # ── 발행본 적재 ───────────────────────────────────────────────────────
    docs = {}
    for f in paths.publish_glob(f"HMG-GEO_*_citation_v1.1_{datef}.html"):
        b = os.path.basename(f)[:-5]
        m = re.match(r"HMG-GEO_(\d+)_(KO|EN)_(.+)_([a-z]{2})_citation_v1\.1_(\d+)$", b)
        if not m:
            bad("D", f"파일명 규약 위반: {b}")
            continue
        docs.setdefault((int(m.group(1)), m.group(3), m.group(4)), {})[m.group(2)] = (f, payload(f))
    if not docs:
        sys.exit(f"검수 대상 없음: {D}/HMG-GEO_*_{datef}.html")

    # ── A. 데이터 정합 ────────────────────────────────────────────────────
    # 추출본 ↔ 발행본을 (fs, base슬러그, 언어)로 맞춘다
    ext_by = {}
    for d in data:
        ext_by[(d["fs"], d["base"].replace("/", "-"), d["lang"])] = d
    if set(ext_by) != set(docs):
        for k in set(ext_by) - set(docs):
            bad("A", f"추출본에 있으나 발행본 없음: fs={k[0]} {k[1]} {k[2]}")
        for k in set(docs) - set(ext_by):
            bad("A", f"발행본에 있으나 추출본 없음: fs={k[0]} {k[1]} {k[2]}")
    if len(spec) != len(data):
        bad("A", f"스펙 {len(spec)}건 ≠ 추출본 {len(data)}건 — 스펙이 어긋나면 다음 재발행에서 조용히 누락된다")

    for k, d in ext_by.items():
        if k not in docs:
            continue
        s = d["summary"]
        ans, mp, tc = int(s["answers"]), int(s["mp"]), int(s["tc"])
        oa, oc = int(s["oa"]), int(s["oc"])
        th = sum(1 for p in d["prompts"] if p["target_hit"])
        tag = f"fs={k[0]} {k[1]} {k[2]}"

        if not (ans and mp and tc):
            bad("A", f"{tag}: 분모 0 (답변 {ans}·프롬프트 {mp}·인용 {tc})")
            continue
        if oa > ans:
            bad("A", f"{tag}: 자사 인용 답변 {oa} > 전체 답변 {ans}")
        if oc > tc:
            bad("A", f"{tag}: 자사 인용 {oc} > 전체 인용 {tc}")
        if th > mp:
            bad("A", f"{tag}: 타겟 적중 {th} > 측정 프롬프트 {mp}")
        want = {"owned": pct(oa, ans), "share": pct(oc, tc), "target": pct(th, mp)}
        for dl, (path, J) in docs[k].items():
            got = {x: float(J["kpis"][x]["v"]) for x in KEYS}
            for x in KEYS:
                if got[x] != want[x]:
                    bad("A", f"{tag} {dl}: {x} 발행값 {got[x]} ≠ 원자료 재계산 {want[x]}")
            # 분포 = ○(타겟 적중) / △(사이트만) / ✕(인용 없음), 합은 프롬프트 수
            dist = J["dist"]
            # ○/△/✕ 는 분할이므로 target_hit 이 ✕ 에 겹치면 안 된다
            nn = sum(1 for p in d["prompts"]
                     if not p["target_hit"] and int(p["owned_answers"]) == 0)
            ns = mp - th - nn
            if [dist["good"], dist["warn"], dist["bad"], dist["total"]] != [th, ns, nn, mp]:
                bad("A", f"{tag} {dl}: 분포 {dist['good']}/{dist['warn']}/{dist['bad']}"
                         f"(합 {dist['total']}) ≠ 원자료 {th}/{ns}/{nn}(합 {mp})")
            if dist["good"] + dist["warn"] + dist["bad"] != dist["total"]:
                bad("A", f"{tag} {dl}: 분포 합계 불일치")

    # ── B. 벤치마크 ──────────────────────────────────────────────────────
    # 모든 리포트가 같은 글로벌 평균을 쓰는가 + 그 값이 발행 집합에서 재현되는가
    globals_seen, brand_seen = {}, {}
    for k, per in docs.items():
        for dl, (path, J) in per.items():
            g = tuple(float(J["kpis"][x]["g"]) for x in KEYS)
            globals_seen.setdefault(g, []).append(os.path.basename(path))
            b = tuple(m["brandAvg"] for m in J["metrics"])
            brand_seen.setdefault((J["org"], b), []).append(os.path.basename(path))
            # 한 리포트 안의 표기 지점 3곳이 서로 같은가
            if [m["global"] for m in J["metrics"]] != list(g):
                bad("B", f"{os.path.basename(path)}: 비교 막대 글로벌 {[m['global'] for m in J['metrics']]} ≠ KPI 카드 {list(g)}")
            for x, row in zip(KEYS, J["apxCrit"]["rows"]):
                if f"{float(J['kpis'][x]['g']):.2f}" not in row.get("sub", ""):
                    bad("B", f"{os.path.basename(path)}: 판정 기준표 '{row.get('sub')}' 가 KPI 카드 {J['kpis'][x]['g']} 와 불일치")
    if len(globals_seen) > 1:
        bad("B", "리포트마다 글로벌 평균이 다름: "
                 + " / ".join(f"{g} ({len(v)}건)" for g, v in globals_seen.items()))
    for org in {o for o, _ in brand_seen}:
        vs = [b for o, b in brand_seen if o == org]
        if len(set(vs)) > 1:
            bad("B", f"{org} 브랜드 평균이 리포트마다 다름: {set(vs)}")

    # 고정점 — 발행본(평균 제외 대상 빼고)에서 역산한 평균이 표기와 같은가
    br = lambda x: "Hyundai" if x == "Hyundai N" else x
    byb = {}
    for k, d in ext_by.items():
        if k not in docs or d["cc"] in BENCH_EXCLUDE_CC:
            continue
        s = d["summary"]
        byb.setdefault(br(d["brand"]), []).append((
            100 * int(s["oa"]) / int(s["answers"]),
            100 * int(s["oc"]) / int(s["tc"]),
            100 * sum(1 for p in d["prompts"] if p["target_hit"]) / int(s["mp"])))
    allv = [x for v in byb.values() for x in v]
    if allv and len(globals_seen) == 1:
        g = list(globals_seen)[0]
        for i, x in enumerate(KEYS):
            got = round(sum(r[i] for r in allv) / len(allv), 2)
            if got != g[i]:
                bad("B", f"글로벌 {x}: 표기 {g[i]} ≠ 발행 {len(allv)}건 평균 {got} — 상수가 발행 집합에서 재현되지 않음")
        for org, vs in byb.items():
            shown = {b for o, b in brand_seen if o == org}
            if len(shown) != 1:
                continue
            b = list(shown)[0]
            for i, x in enumerate(KEYS):
                got = round(sum(r[i] for r in vs) / len(vs), 2)
                if got != b[i]:
                    bad("B", f"{org} {x}: 표기 {b[i]} ≠ 발행 {len(vs)}건 평균 {got}")

    # ── C. 판정 ─────────────────────────────────────────────────────────
    TXT = {"KO": ["상", "중", "하"], "EN": ["High", "Mid", "Low"]}
    CLS = ["good", "warn", "bad"]
    for k, per in docs.items():
        for dl, (path, J) in per.items():
            fn = os.path.basename(path)
            # 임계값은 리포트의 판정 기준표에서 읽는다 → 표와 로직이 서로를 검증한다
            th_hi, th_mid = [], []
            for row in J["apxCrit"]["rows"]:
                nums = re.findall(r"(\d+(?:\.\d+)?)", row["good"] + " " + row["bad"])
                if len(nums) < 2:
                    bad("C", f"{fn}: 판정 기준표에서 임계값을 읽을 수 없음 {row}")
                    nums = ["0", "0"]
                th_hi.append(float(nums[0])); th_mid.append(float(nums[1]))
            for i, x in enumerate(KEYS):
                v = float(J["kpis"][x]["v"])
                exp = 0 if v >= th_hi[i] else (1 if v >= th_mid[i] else 2)
                m = J["metrics"][i]
                if m["vtext"] != TXT[dl][exp]:
                    bad("C", f"{fn}: {x} {v} → 표기 '{m['vtext']}' ≠ 기준({th_hi[i]}/{th_mid[i]}) 판정 '{TXT[dl][exp]}'")
                if m["verdict"] != CLS[exp]:
                    bad("C", f"{fn}: {x} verdict '{m['verdict']}' ≠ '{CLS[exp]}'")
            ow = float(J["kpis"]["owned"]["v"]); tg = float(J["kpis"]["target"]["v"])
            eo = 0 if ow >= th_hi[0] else (1 if ow >= th_mid[0] else 2)
            et = 0 if tg >= th_hi[2] else (1 if tg >= th_mid[2] else 2)
            want_tag = (f"오피셜 인용 {TXT[dl][eo]} × 타겟 URL {TXT[dl][et]}" if dl == "KO"
                        else f"Official citation {TXT[dl][eo]} × Target URL {TXT[dl][et]}")
            if J["obs"]["tag"] != want_tag:
                bad("C", f"{fn}: 종합 구간 '{J['obs']['tag']}' ≠ '{want_tag}'")

    # ── D. 산출물 완결성 ─────────────────────────────────────────────────
    verified = []
    for k, per in docs.items():
        for dl, (path, J) in per.items():
            pdf = path[:-5] + ".pdf"
            if not os.path.exists(pdf):
                bad("D", f"{os.path.basename(path)}: PDF 없음")
                continue
            if os.path.getmtime(pdf) < os.path.getmtime(path):
                bad("D", f"{os.path.basename(pdf)}: HTML 보다 오래됨 — 재생성 필요")
            if os.path.getsize(pdf) < 100_000:
                bad("D", f"{os.path.basename(pdf)}: 크기 {os.path.getsize(pdf):,}B — 생성 실패 의심")
            raw = open(pdf, "rb").read()
            pages = len(re.findall(rb"/Type\s*/Page[^s]", raw))
            if pages != int(J.get("totalPages", 7)):
                bad("D", f"{os.path.basename(pdf)}: {pages}쪽 ≠ 기대 {J.get('totalPages', 7)}쪽 — 레이아웃 붕괴")
            verified += [path, pdf]
        if set(per) != {"KO", "EN"}:
            bad("D", f"fs={k[0]} {k[1]} {k[2]}: 국·영문 쌍 불완전 ({sorted(per)})")

    # ── E. 인덱스 본문 서술 ──────────────────────────────────────────────
    if index_md and os.path.exists(index_md):
        t = open(index_md, encoding="utf-8").read()
        m = re.search(r"발행 완료: (\d+) / 정본 (\d+)개 조합 · (\d+)개 문서", t)
        if not m:
            bad("E", "인덱스 본문에서 발행 건수 문장을 찾지 못함")
        else:
            n, canon, ndoc = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if n != len(docs):
                bad("E", f"인덱스 '발행 완료 {n}' ≠ 실제 조합 {len(docs)}건")
            if ndoc != len(docs) * 2:
                bad("E", f"인덱스 '문서 {ndoc}개' ≠ 실제 {len(docs) * 2}개")
            if canon != CANON_TOTAL:
                warn("E", f"인덱스 정본 수 {canon} ≠ 스크립트 상수 {CANON_TOTAL}")
            mp_ = re.search(r"## 미발행 (\d+)건", t)
            if mp_ and int(mp_.group(1)) != canon - n:
                bad("E", f"인덱스 '미발행 {mp_.group(1)}건' ≠ {canon} - {n} = {canon - n}")
            rows = len(re.findall(r"^\| 20\d\d\.\d\d\.\d\d \|", t, re.M))
            if rows != len(docs):
                bad("E", f"인덱스 표 {rows}행 ≠ 발행 {len(docs)}건")

    # ── 결과 ────────────────────────────────────────────────────────────
    print(f"검수 대상: 조합 {len(docs)}건 · 문서 {len(docs) * 2}개 · 파일 {len(verified)}개")
    for w in warns:
        print("  ⚠", w)
    if fails:
        print(f"\n✗ 검수 실패 {len(fails)}건")
        for f in fails[:40]:
            print("   ", f)
        if len(fails) > 40:
            print(f"    … 외 {len(fails) - 40}건")
        if os.path.exists(MANIFEST):
            os.remove(MANIFEST)   # 실패 시 이전 통과 기록을 남겨두면 안 된다
            print("\n  이전 검수 매니페스트를 폐기했습니다 — 업로드가 차단됩니다.")
        sys.exit(1)

    files = {}
    for p in sorted(set(verified)):
        files[os.path.basename(p)] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    json.dump({"date": datef, "combos": len(docs), "files": files},
              open(MANIFEST, "w"), ensure_ascii=False, indent=1)
    print(f"\n✓ 전 항목 통과 — 매니페스트 기록 {len(files)}개 파일")
    print(f"  {MANIFEST}")


main()
