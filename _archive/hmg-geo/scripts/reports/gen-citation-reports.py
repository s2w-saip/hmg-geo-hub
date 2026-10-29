#!/usr/bin/env python3
"""오피셜 사이트 AI 인용 리포트 생성기 (국문·영문).

입력  : 추출 JSON (scripts/reports/extract-citation-data.mts 산출물)
템플릿: scripts/reports/templates/citation-v1.1.html
        — 이 파일의 <style>/<script> 가 정본. JSON 데이터만 갈아끼운다.
출력  : docs/data/3-publish/citation-v1.1_{date}/HMG-GEO_{seq}_{KO|EN}_{base}_{lang}_citation_v1.1_{date}.html
        (경로 정본 = scripts/paths.json — paths.py 로 읽는다)

사용  : python3 scripts/reports/gen-citation-reports.py <data.json> [YYYY.MM.DD] [manifest.json]

정책(2026-08-06 확정, memory: citation-report-owned-policy):
  자사 = 해당 사이트 base URL 만. 타 브랜드·그룹 지주·미러 호스트는 타사.
  벤치마크 = 글로벌 평균 + 해당 브랜드 평균.
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  — 경로 정본(scripts/paths.json)

REPO = paths.REPO
TPL_PATH = f"{paths.TEMPLATES}/citation-v1.1.html"
TPL = open(TPL_PATH).read()
DATA = json.load(open(sys.argv[1]))
DATE = sys.argv[2] if len(sys.argv) > 2 else "2026.08.11"
DATE_F = DATE.replace(".", "")
OUT_DIR = paths.publish_batch(f"citation-v1.1_{DATE_F}")
MANIFEST = sys.argv[3] if len(sys.argv) > 3 else "/tmp/manifest.json"

# 벤치마크 = 발행 리포트 중 '국가 사이트' 집합(108건)의 단순평균. CPO 처럼 국가
# 단위가 아닌 서비스 전용 사이트는 기준선을 왜곡하므로 제외한다
# (calc-benchmarks.py::BENCH_EXCLUDE_CC). 리포트 집합이 바뀌면
# `python3 scripts/reports/calc-benchmarks.py <extract.json>` 로 재산출해 갱신할 것.
GLOBAL_AVG = {"owned": 55.85, "share": 22.24, "target": 52.11}
BRAND_AVG = {"Hyundai": {"owned": 61.25, "share": 26.12, "target": 59.11},
             "Kia": {"owned": 57.87, "share": 23.34, "target": 53.77},
             "Genesis": {"owned": 41.52, "share": 12.66, "target": 35.42}}
BENCH_N = 108              # 위 평균을 산출한 국가 사이트 수 — 아래 검증의 기준
BENCH_EXCLUDE_CC = {"CPO"}  # calc-benchmarks.py 와 동일 규칙
# 상/중/하 경계. "상" = 글로벌 평균을 웃도는 수준, "하" = 평균의 약 40% 이하.
TIER_HI = {"owned": 60, "share": 25, "target": 60}
TIER_MID = {"owned": 30, "share": 10, "target": 20}


def _verify_benchmarks(data):
    """입력 추출본이 위 상수와 같은 모수인지 확인.

    상수는 calc-benchmarks.py 로 추출본에서 뽑는다. 그런데 추출 → 상수 갱신 →
    생성 사이에 재추출이 끼면(그 사이 새 측정이 동기화되면) 상수와 리포트가 서로
    다른 모수를 갖게 되고, 리포트에 찍힌 "글로벌/브랜드 평균"이 실제 발행 집합에서
    재현되지 않는다. 눈에 안 띄는 종류의 오류라 여기서 막는다.
    """
    br = lambda b: "Hyundai" if b == "Hyundai N" else b
    by = {}
    for d in data:
        s = d["summary"]
        ans, mp, tc = int(s["answers"]), int(s["mp"]), int(s["tc"])
        if not (ans and mp and tc) or d["cc"] in BENCH_EXCLUDE_CC:
            continue
        by.setdefault(br(d["brand"]), []).append(
            (100 * int(s["oa"]) / ans, 100 * int(s["oc"]) / tc,
             100 * sum(1 for p in d["prompts"] if p["target_hit"]) / mp))
    allv = [x for v in by.values() for x in v]
    if len(allv) != BENCH_N:
        sys.exit(f"[중단] 벤치마크 모수 불일치: 상수는 {BENCH_N}건 기준인데 입력은 {len(allv)}건입니다.\n"
                 f"        python3 scripts/reports/calc-benchmarks.py {sys.argv[1]} 로 재산출해\n"
                 f"        GLOBAL_AVG/BRAND_AVG/BENCH_N 을 갱신한 뒤 같은 추출본으로 다시 생성하세요.")
    avg = lambda v, i: round(sum(x[i] for x in v) / len(v), 2)
    drift = []
    for i, k in enumerate(("owned", "share", "target")):
        if avg(allv, i) != GLOBAL_AVG[k]:
            drift.append(f"글로벌 {k}: 상수 {GLOBAL_AVG[k]} vs 입력 {avg(allv, i)}")
        for b in by:
            if avg(by[b], i) != BRAND_AVG[b][k]:
                drift.append(f"{b} {k}: 상수 {BRAND_AVG[b][k]} vs 입력 {avg(by[b], i)}")
    if drift:
        sys.exit("[중단] 벤치마크 상수가 입력 추출본에서 재현되지 않습니다:\n  "
                 + "\n  ".join(drift)
                 + f"\n        python3 scripts/reports/calc-benchmarks.py {sys.argv[1]} 로 재산출한 뒤\n"
                   "        같은 추출본으로 다시 생성하세요.")


_verify_benchmarks(DATA)

COUNTRY = {
 "AE": ("아랍에미리트", "United Arab Emirates"), "AM": ("아르메니아", "Armenia"), "AT": ("오스트리아", "Austria"),
 "AU": ("호주", "Australia"), "BA": ("보스니아", "Bosnia and Herzegovina"), "BE": ("벨기에", "Belgium"),
 "BH": ("바레인", "Bahrain"), "BG": ("불가리아", "Bulgaria"), "BR": ("브라질", "Brazil"),
 "CA": ("캐나다", "Canada"), "CH": ("스위스", "Switzerland"), "CL": ("칠레", "Chile"),
 "CN": ("중국", "China"), "CN-BJ": ("베이징현대", "Beijing Hyundai"), "CO": ("콜롬비아", "Colombia"),
 # 국가 사이트가 아닌 서비스 전용 사이트 — 벤치마크 평균에서는 제외한다(BENCH_EXCLUDE_CC)
 "CPO": ("인증중고차", "Certified Pre-Owned"),
 "CZ": ("체코", "Czechia"), "DE": ("독일", "Germany"), "DK": ("덴마크", "Denmark"),
 "EE": ("에스토니아", "Estonia"), "ES": ("스페인", "Spain"), "EU": ("유럽", "Europe"),
 "FI": ("핀란드", "Finland"), "FR": ("프랑스", "France"), "GB": ("영국", "United Kingdom"),
 "GR": ("그리스", "Greece"), "HR": ("크로아티아", "Croatia"), "HU": ("헝가리", "Hungary"),
 "ID": ("인도네시아", "Indonesia"), "IE": ("아일랜드", "Ireland"), "IL": ("이스라엘", "Israel"),
 "IN": ("인도", "India"), "IS": ("아이슬란드", "Iceland"), "IT": ("이탈리아", "Italy"),
 "JP": ("일본", "Japan"), "KR": ("한국", "South Korea"), "KW": ("쿠웨이트", "Kuwait"),
 "KZ": ("카자흐스탄", "Kazakhstan"), "LT": ("리투아니아", "Lithuania"), "LV": ("라트비아", "Latvia"),
 "MIDDLEEAST": ("중동", "Middle East"), "MM": ("미얀마", "Myanmar"), "MT": ("몰타", "Malta"),
 "MX": ("멕시코", "Mexico"), "MY": ("말레이시아", "Malaysia"), "NL": ("네덜란드", "Netherlands"),
 "NO": ("노르웨이", "Norway"), "OM": ("오만", "Oman"), "PE": ("페루", "Peru"),
 "PH": ("필리핀", "Philippines"), "PL": ("폴란드", "Poland"), "PR": ("푸에르토리코", "Puerto Rico"),
 "PT": ("포르투갈", "Portugal"), "QA": ("카타르", "Qatar"), "RO": ("루마니아", "Romania"),
 "RS": ("세르비아", "Serbia"), "RU": ("러시아", "Russia"), "SA": ("사우디아라비아", "Saudi Arabia"),
 "SE": ("스웨덴", "Sweden"), "SG": ("싱가포르", "Singapore"), "SI": ("슬로베니아", "Slovenia"),
 "SK": ("슬로바키아", "Slovakia"), "TH": ("태국", "Thailand"), "TR": ("튀르키예", "Türkiye"),
 "TW": ("대만", "Taiwan"), "UA": ("우크라이나", "Ukraine"), "US": ("미국", "United States"),
 "UZ": ("우즈베키스탄", "Uzbekistan"), "VN": ("베트남", "Vietnam"), "worldwide": ("글로벌", "Worldwide"),
}
CITY = {"sa-dammam": ("담맘", "Dammam"), "sa-jeddah": ("제다", "Jeddah"), "sa-riyadh": ("리야드", "Riyadh")}
LANGN = {
 "ar": ("아랍어", "Arabic"), "bg": ("불가리아어", "Bulgarian"), "bs": ("보스니아어", "Bosnian"),
 "cs": ("체코어", "Czech"), "da": ("덴마크어", "Danish"), "de": ("독일어", "German"),
 "el": ("그리스어", "Greek"), "en": ("영어", "English"), "es": ("스페인어", "Spanish"),
 "et": ("에스토니아어", "Estonian"), "fi": ("핀란드어", "Finnish"), "fr": ("프랑스어", "French"),
 "he": ("히브리어", "Hebrew"), "hr": ("크로아티아어", "Croatian"), "hu": ("헝가리어", "Hungarian"),
 "hy": ("아르메니아어", "Armenian"), "id": ("인도네시아어", "Indonesian"), "is": ("아이슬란드어", "Icelandic"),
 "it": ("이탈리아어", "Italian"), "ja": ("일본어", "Japanese"), "ko": ("한국어", "Korean"),
 "lt": ("리투아니아어", "Lithuanian"), "lv": ("라트비아어", "Latvian"), "my": ("미얀마어", "Burmese"),
 "nl": ("네덜란드어", "Dutch"), "no": ("노르웨이어", "Norwegian"), "pl": ("폴란드어", "Polish"),
 "pt": ("포르투갈어", "Portuguese"), "ro": ("루마니아어", "Romanian"), "ru": ("러시아어", "Russian"),
 "sk": ("슬로바키아어", "Slovak"), "sl": ("슬로베니아어", "Slovenian"), "sr": ("세르비아어", "Serbian"),
 "sv": ("스웨덴어", "Swedish"), "th": ("태국어", "Thai"), "tr": ("튀르키예어", "Turkish"),
 "uk": ("우크라이나어", "Ukrainian"), "uz": ("우즈베크어", "Uzbek"), "vi": ("베트남어", "Vietnamese"),
 "zh": ("중국어", "Chinese"),
}
BRAND_KO = {"Hyundai": "현대자동차", "Kia": "기아", "Genesis": "제네시스"}

EN_UI = [
 ("이 리포트를 읽는 관점", "How to Read This Report"),
 ("글로벌 평균 ${K[k].g}%", "Global avg ${K[k].g}%"),
 ("핵심 측정 요약", "Key Measurement Summary"),
 ("타겟 URL 도달 분포", "Target URL Reach"),
 ("프롬프트 ${T}개", "${T} prompts"),
 ("핵심 발견", "Key Findings"),
 ("판정 ${esc(m.vtext)}", "Rating ${esc(m.vtext)}"),
 ("지표 정의와 전사 대비 위치", "Metric Definitions & Benchmark"),
 ('<th class="lf">프롬프트</th>', '<th class="lf">Prompt</th>'),
 ("지정 페이지 (base 이하 경로)", "Target page (path under base)"),
 ("자사 인용 답변", "Own-site citing answers"),
 ("타겟 도달", "Target reach"),
 ("프롬프트별 인용 사례", "Prompt-level Citation Examples"),
 ("지정 페이지까지 정확 인용", "Exact target page cited"),
 ("사이트는 인용, 지정 페이지 미도달", "Site cited, target not reached"),
 ("사이트 인용 없음", "Site not cited"),
 ("전체 ${D.dist.total}개 프롬프트 점검 내역은 동봉 데이터 파일(.xlsx)에 수록.",
  "Full details for all ${D.dist.total} prompts are provided in the accompanying data file (.xlsx)."),
 ("인용 출처 비교 — 자사 base 대비 대체 출처", "Citation Sources — Own Base vs Alternatives"),
 ("도메인 / 경로", "Domain / Path"),
 ("인용 점유율 (0~100%)", "Citation share (0–100%)"),
 ("<th>점유율</th>", "<th>Share</th>"),
 ("<th>인용 수</th>", "<th>Count</th>"),
 ("<th class=\"lf\" style=\"padding-left:8px\">유형</th>", "<th class=\"lf\" style=\"padding-left:8px\">Type</th>"),
 ("'관찰 요약'", "'Observations'"),
 ("'부록 · 판정 기준과 용어'", "'Appendix · Criteria & Glossary'"),
 ("용어 설명", "Glossary"),
 ("<th style=\"width:40mm\">용어</th><th>설명</th>", "<th style=\"width:40mm\">Term</th><th>Description</th>"),
 ('<html lang="ko">', '<html lang="en">'),
]
JS_2DEC = [
 ("${v.toFixed(1)}%", "${v.toFixed(2)}%"),
 ("${pctS(D.srcBase.n).toFixed(1)}%", "${pctS(D.srcBase.n).toFixed(2)}%"),
 ("${pctS(s.n).toFixed(1)}%", "${pctS(s.n).toFixed(2)}%"),
 ("const gp=Math.round(ds.good/T*100), wp=Math.round(ds.warn/T*100), bp=100-gp-wp;",
  "const gp=(100*ds.good/T).toFixed(2), wp=(100*ds.warn/T).toFixed(2), bp=(100*ds.bad/T).toFixed(2);"),
]

def make_templates():
    m = re.search(r'(<script id="report-data" type="application/json">)(.*?)(</script>)', TPL, re.S)
    head, tail = TPL[:m.end(1)], TPL[m.start(3):]
    for a, b in JS_2DEC:
        head = head.replace(a, b); tail = tail.replace(a, b)
    en_head, en_tail = head, tail
    for a, b in EN_UI:
        en_head = en_head.replace(a, b); en_tail = en_tail.replace(a, b)
    return (head, tail), (en_head, en_tail)

KO_TPL, EN_TPL = make_templates()
BASE_JSON = json.loads(re.search(r'type="application/json">(.*?)</script>', TPL, re.S).group(1).replace("<\\/", "</"))
LOGO = {
 "Hyundai": BASE_JSON["logoSvg"],
 "Kia": open(f"{paths.LOGOS}/Kia/kia_logo_2021.svg").read(),
 "Genesis": open(f"{paths.LOGOS}/Genesis/genesis_emblem.svg").read(),
}

NOTE_KO = "※ 측정 프롬프트는 각 페이지의 콘텐츠가 답변의 근거로 인용될 수 있도록 페이지 내용을 기반으로 설계한 질문입니다. 이 때문에 일부 문장이 실제 사용자 표현과 다소 다르게 느껴질 수 있습니다."
NOTE_EN = "※ Measurement prompts are questions designed from each page's content so that the page can serve as the cited source of the answer. Some phrasing may therefore read differently from natural user queries."

def tier(v, hi, mid): return 0 if v >= hi else (1 if v >= mid else 2)
TIER_KO = ["상", "중", "하"]; TIER_EN = ["High", "Mid", "Low"]; TIER_CLS = ["good", "warn", "bad"]

def classify(k, brand, L):
    b = brand.lower(); host = k.split("/")[0]
    other = [x for x in ("hyundai", "kia", "genesis") if x != b]
    if k.startswith("eu-www."):
        return (("EU 미러 호스트(타사 분류)", "EU mirror host (other)")[L], "ext")
    if "hyundaimotorgroup" in host or "kiacorp" in host:
        return (("그룹 지주 사이트(타사 분류)", "Group holding site (other)")[L], "ext")
    if any(o in host for o in other):
        return (("그룹 타브랜드(타사)", "Group sibling brand (other)")[L], "ext")
    if b in host:
        if host == f"{b}.com" and "/" in k:
            seg = k.split("/")[1]
            if seg == "worldwide": return (("자사 글로벌 페이지", "Own global page")[L], "own")
            if seg == "content": return (("자사 공용 리소스 경로", "Own shared resource path")[L], "own")
            return ((f"타국 자사({seg.upper()})", f"Own brand — other market ({seg.upper()})")[L], "own")
        if "news" in host or "press" in host:
            return (("자사 뉴스룸", "Own newsroom")[L], "own")
        return (("자사 계열 호스트", "Own-family host")[L], "own")
    return (("외부 출처", "External source")[L], "ext")

def build(doc, L):
    brand_raw = doc["brand"]
    brand = "Hyundai" if brand_raw.startswith("Hyundai") else brand_raw
    cc, lang = doc["cc"], doc["lang"]
    base = doc["base"]; s = doc["summary"]
    ans, mp, tc, oc, oa = int(s["answers"]), int(s["mp"]), int(s["tc"]), int(s["oc"]), int(s["oa"])
    prompts = doc["prompts"]
    for p in prompts: p["answers"] = int(p["answers"]); p["owned_answers"] = int(p["owned_answers"])
    th = sum(1 for p in prompts if p["target_hit"])
    owned = 100*oa/ans if ans else 0; share = 100*oc/tc if tc else 0; target = 100*th/mp if mp else 0
    hit = [p for p in prompts if p["target_hit"]]
    site_only = [p for p in prompts if not p["target_hit"] and p["owned_answers"] > 0]
    # ○/△/✕ 는 프롬프트를 남김없이 한 번씩만 나누는 분할이어야 한다. 타겟 URL 이
    # base 밖(타 경로·모델 서브도메인)인 프롬프트가 있어 target_hit 을 빼지 않으면
    # ○ 와 ✕ 에 이중 계상되어 합이 프롬프트 수를 넘는다.
    none_ = [p for p in prompts if not p["target_hit"] and p["owned_answers"] == 0]
    nh, ns, nn = len(hit), len(site_only), len(none_)
    seg = doc.get("pathSeg")
    cn = COUNTRY[cc][L] + (f" {CITY[seg][L]}" if seg else "")
    scope_en = f"{brand} {COUNTRY[cc][1]}" + (f" {CITY[seg][1]}" if seg else "")
    h1 = f"{brand.upper()} {COUNTRY[cc][1]}" + (f" {CITY[seg][1]}" if seg else "")
    sub = " (Hyundai N)" if brand_raw == "Hyundai N" else ""
    ln = LANGN[lang][L]
    bavg = BRAND_AVG[brand]
    t_owned = tier(owned, TIER_HI["owned"], TIER_MID["owned"])
    t_share = tier(share, TIER_HI["share"], TIER_MID["share"])
    t_target = tier(target, TIER_HI["target"], TIER_MID["target"])
    TIER = TIER_EN if L else TIER_KO
    per_engine = ans // 2
    alt = [{"k": a["k"], "n": int(a["n"])} for a in doc["alt"]][:10]
    alt1 = alt[0] if alt else {"k": "-", "n": 0}
    own_family = sum(int(a["n"]) for a in doc["alt"] if classify(a["k"], brand, 0)[1] == "own")
    above = sum(1 for v, k in [(owned, "owned"), (share, "share"), (target, "target")]
                if v >= GLOBAL_AVG[k])

    def rel(u):
        r_ = re.sub(r"^https?://(www\.)?" + re.escape(base), "", u.strip())
        return (r_ or "/")[:60]
    def prow(p, mark):
        t = p["prompt_text"].strip()
        return {"p": t[:110] + ("…" if len(t) > 110 else ""), "u": rel(p["target_url"]),
                "n": f'{p["owned_answers"]}/{p["answers"]}', "v": mark}
    cited_rows = [prow(p, "good") for p in sorted(hit, key=lambda x: -x["owned_answers"])[:5]] or \
                 [prow(p, "warn") for p in sorted(site_only, key=lambda x: -x["owned_answers"])[:5]]
    g2 = none_ if nn else site_only
    g2_rows = [prow(p, "bad" if nn else "warn") for p in g2[:5]]
    sources = []
    for a in alt:
        t_, c_ = classify(a["k"], brand, L)
        sources.append({"k": a["k"], "n": a["n"], "t": t_, "c": c_})

    if L == 0:
        h2 = f"오피셜 사이트 AI 답변 인용 현황 · 1차 측정 · {ln} 프롬프트"
        desc = (f"본 리포트는 {BRAND_KO[brand]} {cn} 공식 웹사이트({base})의 Generative Engine Optimization(GEO) 개선 작업에 앞서 "
                f"현재 상태를 진단한 베이스라인(Baseline) 자료입니다. 주요 {ln} 프롬프트 {mp}개를 기준으로 2개 AI 엔진에서의 "
                f"공식 사이트 인용 비율 및 동시 인용 출처 현황을 분석·정리하였습니다.")
        guide = ["AI 답변이 오피셜 사이트를 출처로 인용하는지는 새로운 디지털 노출 지표입니다 — 인용되지 않으면 브랜드 정보의 서술 주도권이 외부 출처로 넘어갑니다.",
                 "모든 수치는 전사 공통 기준 · 최근 측정 라운드 스냅샷으로 산출되어 국가 간 비교가 가능하며, 비교 기준선은 글로벌 평균입니다."]
        meta = [{"k": "진단 대상", "v": base}, {"k": "측정 프롬프트", "v": str(mp), "s": f"언어: {ln}"},
                {"k": "AI 답변", "v": str(ans), "s": f"ChatGPT {per_engine} · Gemini {per_engine}"},
                {"k": "측정일", "v": str(s["we"]).replace("-", ".")}]
        kpis = {"owned": {"v": f"{owned:.2f}", "n": oa, "t": ans, "unit": "답변", "label": "오피셜 인용 답변률", "g": f'{GLOBAL_AVG["owned"]:.2f}',
                          "step": "1단계 · 사이트 도달", "def": "전체 답변 중 자사 인용 답변 비중"},
                "share": {"v": f"{share:.2f}", "n": oc, "t": tc, "unit": "인용", "label": "오피셜 인용 점유율", "g": f'{GLOBAL_AVG["share"]:.2f}',
                          "step": "2단계 · 커버리지", "def": "전체 인용 출처 중 자사 비중"},
                "target": {"v": f"{target:.2f}", "n": th, "t": mp, "unit": "프롬프트", "label": "타겟 URL 인용률", "g": f'{GLOBAL_AVG["target"]:.2f}',
                           "step": "3단계 · 페이지 도달", "def": "지정 페이지 정확 인용 · 가장 엄격"}}
        sumBig = (f"답변 {ans}건 중 <em>{oa}건({owned:.2f}%)</em>이 오피셜 사이트를 인용했으며, "
                  f"지정 페이지까지 정확히 인용된 프롬프트는 <em>{th}개({target:.2f}%)</em>입니다.")
        sumSm = (f"{ln} 프롬프트 {mp}개 × AI 엔진 2종(ChatGPT·Gemini) = 답변 {ans}건. 전체 인용 {tc:,}건 중 자사 인용은 {oc}건({share:.2f}%). "
                 f"판정: 오피셜 인용 {TIER[t_owned]} × 타겟 URL {TIER[t_target]} — 기준은 부록 참조.")
        dist = {"good": nh, "warn": ns, "bad": nn, "total": mp,
                "labels": {"good": "지정 페이지까지 정확 인용", "warn": "사이트는 인용, 지정 페이지 미도달", "bad": "사이트 인용 없음"},
                "desc": f"프롬프트 {mp}개 각각에 대해 답변 인용을 URL 기준으로 판정한 분포입니다: 지정 페이지까지 정확 인용(○) / 사이트는 인용됐으나 지정 페이지에는 미도달(△) / 사이트 인용 없음(✕)."}
        f1 = (f"답변 {ans}건 중 자사 인용 {oa}건({owned:.2f}%) · 전체 인용 {tc:,}건 중 자사 {oc}건({share:.2f}%) · 지정 페이지 정확 인용 {th}개 프롬프트({target:.2f}%)"
              + ("로, 세 지표 모두 글로벌 평균을 상회합니다." if above == 3 else ("로, 세 지표 모두 글로벌 평균을 밑돕니다." if above == 0 else f"로, 3개 지표 중 {above}개가 글로벌 평균을 상회합니다.")))
        if oc >= alt1["n"] and alt1["n"]:
            f2 = f"자사 base({oc}회)가 대체 출처 1위 {alt1['k']}({alt1['n']}회)의 {oc/alt1['n']:.2f}배로, 출처 구조에서 오피셜 사이트가 우위를 유지하고 있습니다."
        elif alt1["n"]:
            f2 = f"자사 base({oc}회)보다 {alt1['k']} 단독 인용({alt1['n']}회)이 더 많습니다 — 자사 페이지가 출처 경쟁에서 밀리는 구간입니다."
        else:
            f2 = ""
        f3 = ((f"자사 계열 페이지(글로벌·타국·뉴스룸 등) 인용이 합산 {own_family:,}회로 자사 base의 {own_family/oc:.2f}배입니다." if own_family > oc
               else f"자사 계열 페이지 인용은 합산 {own_family:,}회(자사 base의 {100*own_family/oc:.2f}%)로 제한적입니다.") if oc else "")
        f4 = f"사이트 인용이 전혀 없는 프롬프트 {nn}개({100*nn/mp:.2f}%) · 사이트는 인용되나 지정 페이지 미도달 {ns}개({100*ns/mp:.2f}%)가 개선 대상입니다."
        findings = [x for x in [f1, f2, f3, f4] if x]
        cur = ("전사 상위권 — 세 지표 모두 글로벌 평균 상회" if above == 3 else
               ("전사 하위권 — 세 지표 모두 글로벌 평균 미달" if above == 0 else f"중위권 — 3개 지표 중 {above}개 글로벌 평균 상회"))
        nxt = (f"지정 페이지 미도달 프롬프트 {ns}개 개선 → 타겟 URL 인용률을 파일럿 성과 수준(80~90%대)까지 상승 (보수적 기대 70%대)" if above == 3 else
               f"사이트 인용 없음 {nn}개·지정 페이지 미도달 {ns}개 프롬프트 개선 → 1차 목표 오피셜 인용 답변률 글로벌 평균(" + f'{GLOBAL_AVG["owned"]:.2f}%' + ") 수준 " + ("유지·강화" if owned >= GLOBAL_AVG["owned"] else "회복") + ", 이후 파일럿 성과 수준(타겟 70%대 이상)")
        expect = {"t": "기대 성과", "rows": [{"k": "현재 상황", "v": cur}, {"k": "다음 액션·목표", "v": nxt}],
                  "note": "근거: 파일럿(오너스 매뉴얼 최적화) 작업에서 타겟 출처 인용률이 60%대에서 80~90%대로 상승한 실적."}
        metricsLead = ("각 지표가 AI 검색에서 무엇을 의미하며 왜 중요한지, 그리고 전사 국가 사이트 평균 대비 현재 위치를 함께 표시합니다. "
                       "막대 축은 0~100% 고정으로 국가 간 비교 기준이 동일합니다. '답변률'은 전체 답변 중 자사 인용 비중(도달), '점유율'은 전체 인용 출처 중 자사 비중(커버리지)이라는 점에서 다른 지표입니다.")
        metrics = [
          {"label": "오피셜 인용 답변률", "en": "Official Citation Rate", "verdict": TIER_CLS[t_owned], "vtext": TIER[t_owned],
           "why": "AI 답변이 출처로 오피셜 사이트를 실제 인용한 비율입니다. 타국·글로벌 자사 사이트 인용은 인정하지 않습니다. 이 값이 낮으면 브랜드 정보의 서술 주도권이 외부·타국 출처로 넘어갑니다.",
           "self": round(owned, 2), "global": GLOBAL_AVG["owned"], "brandAvg": bavg["owned"]},
          {"label": "오피셜 인용 점유율", "en": "Citation Share", "verdict": TIER_CLS[t_share], "vtext": TIER[t_share],
           "why": "답변에 등장한 전체 인용(출처 링크) 중 자사 사이트가 차지하는 비중입니다. 답변 하나에 여러 출처가 인용되므로, 인용되더라도 점유율이 낮으면 자사 페이지는 여러 출처 중 하나로 밀려납니다.",
           "self": round(share, 2), "global": GLOBAL_AVG["share"], "brandAvg": bavg["share"]},
          {"label": "타겟 URL 인용률", "en": "Target URL Hit Rate", "verdict": TIER_CLS[t_target], "vtext": TIER[t_target],
           "why": "프롬프트마다 답의 근거가 되어야 할 지정 페이지가 정확히 인용된 비율입니다. 페이지 단위 콘텐츠가 AI에 도달하는지를 측정하는 가장 엄격한 지표입니다.",
           "self": round(target, 2), "global": GLOBAL_AVG["target"], "brandAvg": bavg["target"]}]
        benchNames = {"self": f"{brand} {cc}", "global": "글로벌 평균", "brand": f"{brand} 평균"}
        casesLead = f"프롬프트 원문 일부와 지정 페이지, 답변 2건(엔진 2종) 중 자사 인용 수, 타겟 도달 여부입니다. 전체 {mp}개 내역은 동봉 데이터 파일에 수록합니다."
        caseGroups = [
          {"label": "인용되고 있는 프롬프트", "count": nh if hit else ns,
           "gap": "지정 페이지까지 정확 인용된 사례" if hit else "사이트 인용 사례(지정 페이지 미도달)",
           "rows": cited_rows, "more": (f"외 {max(0,(nh if hit else ns)-5)}개" if (nh if hit else ns) > 5 else "")},
          {"label": "인용되지 않는 프롬프트" if nn else "지정 페이지 미도달 프롬프트", "count": nn if nn else ns,
           "gap": "사이트 인용 없음" if nn else "사이트는 인용되나 지정 페이지 미도달",
           "rows": g2_rows, "more": (f"외 {max(0,(nn if nn else ns)-5)}개" if (nn if nn else ns) > 5 else ""),
           "note": NOTE_KO}]
        srcLead = "자사 base와 함께 어떤 출처가 인용되는지입니다. 공유 도메인은 국가/경로 단위로 분해해 집계했으며, 자사 base 행을 기준으로 함께 표시합니다."
        srcBase = {"k": base, "n": oc, "t": "자사 base (기준)"}
        srcNote = "막대·점유율 = 전체 인용 대비 비중(0~100% 고정 축, 국가 간 비교 동일 기준) · 네이비 = 자사 base · 옅은 네이비 = 자사 계열 · 회색 = 타사·외부 출처"
        obs_li = [x for x in [
          ("사이트·페이지 모두 안정적으로 인용되고 있으며, 출처 구조에서 오피셜 사이트가 우위를 유지하고 있습니다." if above == 3 else
           ("사이트·페이지 모두 인용이 미미하며, AI 답변의 출처 대부분이 외부 또는 자사 타 사이트입니다." if above == 0 else
            "지표별로 혼조 — 강한 축과 약한 축이 공존합니다.")),
          f2, f3, f4,
          "본 측정은 개선 작업 전 기준선입니다. 동일 프롬프트·동일 기준으로 재측정하면 개선 효과를 같은 척도로 비교할 수 있습니다."] if x]
        obs = {"tag": f"오피셜 인용 {TIER[t_owned]} × 타겟 URL {TIER[t_target]}", "li": obs_li}
        milestone = {"t": "예상 마일스톤", "li": ["1차 측정 완료 (본 리포트)", "웹사이트 개선 작업 지원", "개선 후 재측정으로 인용률 변화 추적 (동일 프롬프트·동일 기준)"]}
        # 판정 기준표는 상수에서 파생 — 템플릿에 박아두면 벤치마크와 조용히 어긋난다
        apxCrit = {"t": "판정 기준", "cols": ["지표", "상", "중", "하"],
                   "rows": [{"item": lb, "sub": f"글로벌 평균 {GLOBAL_AVG[k]:.2f}%",
                             "good": f"{TIER_HI[k]}% 이상", "warn": f"{TIER_MID[k]} ~ {TIER_HI[k]}%",
                             "bad": f"{TIER_MID[k]}% 미만"}
                            for k, lb in (("owned", "오피셜 인용 답변률"), ("share", "오피셜 인용 점유율"),
                                          ("target", "타겟 URL 인용률"))],
                   "note": ("종합 구간 판정은 (오피셜 인용 답변률 × 타겟 URL 인용률) 두 지표의 상·중·하 등급 조합으로 나뉩니다.<br>"
                            '각 지표에서 "상" 등급은 글로벌 평균을 상회하는 수준을 뜻합니다.<br>'
                            f'· 답변률 {TIER_HI["owned"]}% (글로벌 평균 {GLOBAL_AVG["owned"]:.2f}%)<br>'
                            f'· 점유율 {TIER_HI["share"]}% (글로벌 평균 {GLOBAL_AVG["share"]:.2f}%)<br>'
                            f'· 타겟 URL {TIER_HI["target"]}% (글로벌 평균 {GLOBAL_AVG["target"]:.2f}%)')}
        terms = [
          {"t": "GEO", "sub": "생성형 엔진 최적화", "d": "ChatGPT·Gemini 같은 생성형 AI가 질문에 답할 때, 우리 페이지를 정확히 발견·이해·인용하도록 만드는 최적화 활동."},
          {"t": "base URL", "sub": "자사 기준 주소", "d": f"해당 사이트의 기준 주소({base}). 이 주소 이하 페이지 인용만 자사 인용으로 인정하며, 타국·글로벌 자사 사이트는 자사 계열로 별도 분류(자사 불인정). 타 브랜드·그룹 지주·미러 호스트는 타사."},
          {"t": "인용", "sub": "citation", "d": "AI 답변이 근거로 제시한 출처 링크. 답변 하나에 여러 인용이 포함될 수 있음."},
          {"t": "타겟 URL", "sub": "지정 페이지", "d": "프롬프트마다 답의 근거가 되어야 할 페이지로 사전에 지정한 주소. 사이트 인용과 별개로, 이 주소가 정확히 인용됐는지를 판정."},
          {"t": "측정 라운드 스냅샷", "sub": "", "d": "사이트별 마지막 측정일 기준 최근 라운드에서, 프롬프트×엔진 쌍마다 가장 최신의 완료 답변 1건씩을 채택한 데이터셋. 국가 간 동일 기준."},
          {"t": "프롬프트", "sub": "prompt", "d": "사이트 콘텐츠(모델·견적·시승·보증 등)를 기반으로 설계한 자연어 질문."}]
    else:
        h2 = f"Official Site AI Citation Status · Round 1 · {ln} prompts"
        desc = (f"This report is a baseline assessment of the official {brand} website for {cn} ({base}), conducted ahead of "
                f"Generative Engine Optimization (GEO) improvements. Based on {mp} key prompts in {ln}, it analyzes how often "
                f"the official site is cited by two AI engines and which sources are cited alongside it.")
        guide = ["Whether AI answers cite the official site is a new digital-visibility metric — when the site is not cited, the narrative authority over brand information shifts to external sources.",
                 "All figures use company-wide common definitions on the latest measurement-round snapshot, so countries are directly comparable; the global average is the benchmark."]
        meta = [{"k": "Subject", "v": base}, {"k": "Prompts", "v": str(mp), "s": f"Language: {ln}"},
                {"k": "AI answers", "v": str(ans), "s": f"ChatGPT {per_engine} · Gemini {per_engine}"},
                {"k": "Measured", "v": str(s["we"]).replace("-", ".")}]
        kpis = {"owned": {"v": f"{owned:.2f}", "n": oa, "t": ans, "unit": "answers", "label": "Official Citation Rate", "g": f'{GLOBAL_AVG["owned"]:.2f}',
                          "step": "Step 1 · Site reach", "def": "Answers citing the official site"},
                "share": {"v": f"{share:.2f}", "n": oc, "t": tc, "unit": "citations", "label": "Citation Share", "g": f'{GLOBAL_AVG["share"]:.2f}',
                          "step": "Step 2 · Coverage", "def": "Own share of all cited sources"},
                "target": {"v": f"{target:.2f}", "n": th, "t": mp, "unit": "prompts", "label": "Target URL Hit Rate", "g": f'{GLOBAL_AVG["target"]:.2f}',
                           "step": "Step 3 · Page reach", "def": "Exact target page cited · strictest"}}
        sumBig = (f"Of {ans} answers, <em>{oa} ({owned:.2f}%)</em> cited the official site; the exact target page was cited for "
                  f"<em>{th} prompts ({target:.2f}%)</em>.")
        sumSm = (f"{mp} {ln} prompts × 2 AI engines (ChatGPT · Gemini) = {ans} answers. Own citations: {oc} of {tc:,} total ({share:.2f}%). "
                 f"Rating: Official citation {TIER[t_owned]} × Target URL {TIER[t_target]} — criteria in Appendix.")
        dist = {"good": nh, "warn": ns, "bad": nn, "total": mp,
                "labels": {"good": "Exact target page cited", "warn": "Site cited, target not reached", "bad": "Site not cited"},
                "desc": f"Each of the {mp} prompts is judged by cited URLs: exact target page cited (○) / site cited but target page not reached (△) / site not cited (✕)."}
        f1 = (f"Own citations in {oa} of {ans} answers ({owned:.2f}%) · {oc} of {tc:,} total citations ({share:.2f}%) · exact target cited for {th} prompts ({target:.2f}%)"
              + (" — all three metrics above the global average." if above == 3 else (" — all three metrics below the global average." if above == 0 else f" — {above} of 3 metrics above the global average.")))
        if oc >= alt1["n"] and alt1["n"]:
            f2 = f"The own base ({oc}) outweighs the top alternative source {alt1['k']} ({alt1['n']}) by {oc/alt1['n']:.2f}×, keeping the official site dominant in the source mix."
        elif alt1["n"]:
            f2 = f"{alt1['k']} alone is cited more often ({alt1['n']}) than the own base ({oc}) — the official site is losing the source competition."
        else:
            f2 = ""
        f3 = ((f"Own-family pages (global, other markets, newsroom) total {own_family:,} citations — {own_family/oc:.2f}× the own base." if own_family > oc
               else f"Own-family page citations are limited: {own_family:,} total ({100*own_family/oc:.2f}% of own base).") if oc else "")
        f4 = f"{nn} prompts ({100*nn/mp:.2f}%) have no site citation and {ns} ({100*ns/mp:.2f}%) cite the site without reaching the target page — these are the improvement targets."
        findings = [x for x in [f1, f2, f3, f4] if x]
        cur = ("Top tier company-wide — all three metrics above the global average" if above == 3 else
               ("Bottom tier company-wide — all three metrics below the global average" if above == 0 else f"Mid tier — {above} of 3 metrics above the global average"))
        nxt = (f"Improve the {ns} prompts not reaching their target page → raise Target URL Hit Rate toward pilot performance (80–90%; conservative expectation 70%+)" if above == 3 else
               f"Improve the {nn} uncited and {ns} target-missing prompts → first goal: bring Official Citation Rate to the global average ({GLOBAL_AVG['owned']:.2f}%), then toward pilot performance (Target 70%+)")
        expect = {"t": "Expected Outcome", "rows": [{"k": "Current status", "v": cur}, {"k": "Next actions · goal", "v": nxt}],
                  "note": "Basis: in the pilot (owner's-manual optimization), target-source citation rose from the 60% range to 80–90%."}
        metricsLead = ("What each metric means for AI search and why it matters, with the site's position against the company-wide country-site average. "
                       "Bar axes are fixed at 0–100% for cross-country comparability. Note: 'Citation Rate' is the share of answers citing the site (reach); 'Citation Share' is the own share of all cited sources (coverage).")
        metrics = [
          {"label": "Official Citation Rate", "en": "", "verdict": TIER_CLS[t_owned], "vtext": TIER[t_owned],
           "why": "Share of AI answers that actually cite the official site as a source. Citations of global or other-market own sites do not count. When low, narrative authority over brand information shifts to external sources.",
           "self": round(owned, 2), "global": GLOBAL_AVG["owned"], "brandAvg": bavg["owned"]},
          {"label": "Citation Share", "en": "", "verdict": TIER_CLS[t_share], "vtext": TIER[t_share],
           "why": "Own-site share of all citations (source links) in answers. An answer cites multiple sources, so even when cited, a low share means the official page is one voice among many.",
           "self": round(share, 2), "global": GLOBAL_AVG["share"], "brandAvg": bavg["share"]},
          {"label": "Target URL Hit Rate", "en": "", "verdict": TIER_CLS[t_target], "vtext": TIER[t_target],
           "why": "Share of prompts whose designated target page is cited exactly. The strictest metric — it measures whether page-level content reaches AI.",
           "self": round(target, 2), "global": GLOBAL_AVG["target"], "brandAvg": bavg["target"]}]
        benchNames = {"self": f"{brand} {cc}", "global": "Global avg", "brand": f"{brand} avg"}
        casesLead = f"Prompt excerpts with target page, own-site citations out of 2 answers (2 engines), and target reach. Full details for all {mp} prompts are in the accompanying data file."
        caseGroups = [
          {"label": "Prompts being cited", "count": nh if hit else ns,
           "gap": "Exact target page cited" if hit else "Site cited (target not reached)",
           "rows": cited_rows, "more": (f"+{max(0,(nh if hit else ns)-5)} more" if (nh if hit else ns) > 5 else "")},
          {"label": "Prompts not cited" if nn else "Prompts missing the target page", "count": nn if nn else ns,
           "gap": "No site citation" if nn else "Site cited, target page not reached",
           "rows": g2_rows, "more": (f"+{max(0,(nn if nn else ns)-5)} more" if (nn if nn else ns) > 5 else ""),
           "note": NOTE_EN}]
        srcLead = "Which sources are cited alongside the own base. Shared domains are split by country/path; the own base row is shown as the reference."
        srcBase = {"k": base, "n": oc, "t": "Own base (reference)"}
        srcNote = "Bar · share = proportion of all citations (fixed 0–100% axis, same basis across countries) · navy = own base · light navy = own family · gray = other/external"
        obs_li = [x for x in [
          ("Both site and pages are cited consistently; the official site holds the leading position in the source mix." if above == 3 else
           ("Citations are minimal at both site and page level; most sources in AI answers are external or non-local own sites." if above == 0 else
            "Mixed picture — strong and weak axes coexist across metrics.")),
          f2, f3, f4,
          "This measurement is the pre-improvement baseline. Re-measuring with the same prompts and criteria makes improvement directly comparable."] if x]
        obs = {"tag": f"Official citation {TIER[t_owned]} × Target URL {TIER[t_target]}", "li": obs_li}
        milestone = {"t": "Milestones", "li": ["Round 1 measurement complete (this report)", "Website improvement support", "Re-measurement after improvements (same prompts, same criteria)"]}
        apxCrit = {"t": "Rating Criteria", "cols": ["Metric", "High", "Mid", "Low"],
                   "rows": [{"item": lb, "sub": f"Global avg {GLOBAL_AVG[k]:.2f}%",
                             "good": f"≥ {TIER_HI[k]}%", "warn": f"{TIER_MID[k]}–{TIER_HI[k]}%",
                             "bad": f"< {TIER_MID[k]}%"}
                            for k, lb in (("owned", "Official Citation Rate"), ("share", "Citation Share"),
                                          ("target", "Target URL Hit Rate"))],
                   "note": ("The 'High' threshold for each metric is set above the global average — "
                            f'Citation Rate {TIER_HI["owned"]}% (avg {GLOBAL_AVG["owned"]:.2f}%) · '
                            f'Share {TIER_HI["share"]}% (avg {GLOBAL_AVG["share"]:.2f}%) · '
                            f'Target URL {TIER_HI["target"]}% (avg {GLOBAL_AVG["target"]:.2f}%). '
                            "The overall band uses the High/Mid/Low combination of Official Citation Rate × Target URL Hit Rate.")}
        terms = [
          {"t": "GEO", "sub": "Generative Engine Optimization", "d": "Optimizing pages so generative AI (ChatGPT, Gemini) accurately discovers, understands, and cites them when answering."},
          {"t": "base URL", "sub": "own reference address", "d": f"The reference address of this site ({base}). Only citations under this address count as own; global/other-market own sites are classified as own family (not counted). Sibling brands, group holding sites, and mirror hosts are treated as other."},
          {"t": "Citation", "sub": "", "d": "A source link presented as evidence in an AI answer. One answer can contain multiple citations."},
          {"t": "Target URL", "sub": "designated page", "d": "The page pre-designated as the intended source for each prompt. Judged separately from site citation: whether this exact address was cited."},
          {"t": "Round snapshot", "sub": "", "d": "Per site, the latest round window ending on the last measured date; for each prompt × engine pair, the most recent completed answer is used. Same basis across countries."},
          {"t": "Prompt", "sub": "", "d": "A natural-language question designed from site content (models, quotes, test drives, warranty, etc.)."}]

    D = dict(BASE_JSON)
    D.update({
        "brand": brand.lower(), "scope": scope_en + sub, "org": brand, "site": base,
        "lang": "ko" if L == 0 else "en", "date": DATE, "round": str(s["we"]).replace("-", "."),
        "totalPages": 7, "logoSvg": LOGO[brand],
        "cover": {"kicker": "GEO Citation Report", "h1": h1 + sub, "h2": h2, "desc": desc,
                  "guide": guide, "meta": meta, "confidential": "Confidential — HMG Internal"},
        "kpis": kpis, "sumBig": sumBig, "sumSm": sumSm, "dist": dist, "findings": findings, "expect": expect,
        "milestone": milestone, "metricsLead": metricsLead, "metrics": metrics, "benchNames": benchNames,
        "casesLead": casesLead, "caseGroups": caseGroups, "srcLead": srcLead, "srcBase": srcBase, "srcMax": oc,
        "sources": sources, "srcNote": srcNote, "obs": obs, "apxCrit": apxCrit, "terms": terms,
    })
    return D

manifest = []
for doc in DATA:
    for L, dl in ((0, "KO"), (1, "EN")):
        D = build(doc, L)
        head, tail = KO_TPL if L == 0 else EN_TPL
        slug = doc["base"].replace("/", "-")
        fn = f"HMG-GEO_{doc['fs']:03d}_{dl}_{slug}_{doc['lang']}_citation_v1.1_{DATE_F}"
        open(f"{OUT_DIR}/{fn}.html", "w").write(head + json.dumps(D, ensure_ascii=False).replace("</", "<\\/") + tail)
        manifest.append({"brand": doc["brand"], "cc": doc["cc"], "lang": doc["lang"], "doclang": dl,
                         "pathSeg": doc.get("pathSeg"), "fn": fn,
                         "owned": D["kpis"]["owned"]["v"], "share": D["kpis"]["share"]["v"],
                         "target": D["kpis"]["target"]["v"], "measured": D["round"]})
json.dump(manifest, open(MANIFEST, "w"), ensure_ascii=False)
print("GENERATED:", len(manifest), "documents from", len(DATA), "combos")
