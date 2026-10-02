#!/usr/bin/env python3
"""신구 대조 3분류: 일치 / 설명됨 / 미해명.

입력: values-old(프로덕션 현행), values-new(새 설계 rd 쿼리), values-emu(rd 위 현행 정의 모사, 진단용).
규칙
  1) old·new 모두 있고 값이 같거나 반올림 범위(비율 0.05pp, 스칼라 0.05) → 일치
  2) 다르면: emu 가 old 를 재현(같거나 반올림 범위)하면 → 설명됨. 사유 = 그 조합에서 new 와 emu 가 갈리는 정의 변경 목록
     (emu 는 new 와 같은 rd 사실 위에서 정의만 현행으로 되돌린 것이므로, 재현되면 차이는 그 정의 변경들로 전부 설명된다)
  3) emu 로도 재현되지 않으면 잔여 규칙(RESID)로 사유를 붙이고, 사유가 '미해명' 계열이면 미해명
  한쪽 누락 키는 기능·키 종류별 규칙으로 판정(신규 항목, 현행 값 없음, x축·창 정의 등)
사용: classify.py <res-dir> <out-dir>
"""
import json
import os
import sys
from collections import Counter, defaultdict

OLD = "notes/hmg-refactor-proto/runs/20260927-1714-full/values-old.jsonl"
FEATS = ["F01", "F02", "F03", "F04", "F05", "F06", "F07"]
CIT = ("citation_share", "citations", "owned", "target_rate")

SNAP_G = {"C01", "C02", "C03", "C06", "C12"}
SNAP_W = {"C08", "C09"}
RANGE_G = {"C04", "C05", "C07"}
RANGE_W = {"C10", "C11"}
# round_date -1일 시드 결함(09-18 좌석 1,743답변 → 비노출 09-17 유령 회차): seed-40 §2 coh 0078 규칙 수정(2026-09-28)으로 해소.
# 수정 전 판정을 재현하려면 SEED_M1 = {"C10"}, SEED_ROUND = "2026-09-18" 로 되돌린다(cmp-values-190616 참조).
SEED_M1 = set()
SEED_ROUND = None

T = {
    "A1": "A1 스냅샷 = 최신 노출 회차의 모든 완료 측정(현행 = 셀 대표 1건)",
    "GEN": "현행 집계층 사실표 생성(09-15 17:12Z) 이후 도착 측정 미반영(18셀) — 새 구조는 적재 트랜잭션에서 반영",
    "A15A16": "A15·A16 언급 모수 std_in(ACR 반복 run-셀당 1건·분석 결손 제외, 현행 = 전부 포함)",
    "A16": "A16 분석 결손 답변 언급 모수 제외",
    "A41": "A4 #1 소프트삭제 카탈로그 행 제외(현행은 삭제 행 브랜드도 모수)",
    "G21A": "G-21 (a) 호스트 없는 인용 제외",
    "R07PUB": "R07·R03 발행·노출 회차만(현행 기간 경로는 진행 중·미발행 회차 포함)",
    "R07SCOPE": "R07 지역 스코핑(한국어 비-KR·시장 태그) 전 기간 적용(현행 기간·추이 경로는 미적용 = SA:1190 표 '없었다')",
    "R04CIT": "R04 인용 숨김 회차(551) 인용 계열 제외(현행 기간 경로는 미적용)",
    "A2": "A2 ⑥ 측정 단위(현행 = 프롬프트 단위, 스냅샷은 프롬프트별 최신 round·기간은 창 안 1회 이상 적중)",
    "XAXIS_G": "R11·G-04 추이 x축 = 회차 round_date 자리 12개(현행 = 측정 주(UTC) 버킷·버킷 내 셀 최신 1건·120일 창·격자 갭 슬롯)",
    "XAXIS_W": "R11·G-04 추이 x축 = 프로젝트 round_date 좌석(현행 = 집계층 함대 회차 라벨·부분 회차 skip)",
    "G20": "G-20 (a) 표시 브랜드 등장 단위 노출(현행 집계층 = (답변, 롤업 엔티티) 단위라 별칭 rid 중복 계상)",
    "NAME": "표시명 정본 선택 차이(같은 브랜드 KGM ↔ KG모빌리티, 값 동일)",
    "GEOAX": "웹사이트 국가 축 = 사이트 국가(DB-측정-코어). 현행 미러 누적 경로는 답변 region(합계 동일 899,443/1,056,890)",
    "DFLT": "기본 엔진 게이트 dflt(현행 웹사이트 국가 경쟁 누적은 엔진 무필터: DeepSeek 154답변 2,460/2,615 언급)",
    "F1W4": "F-1 규칙 4 옵션 창 = 데이터 창(현행 = 최근 7일 run·웹사이트 등록 사이트 기준, 엔진 정적 목록)",
    "NEWKEY": "신규 항목(현행 대조점 없음: M12 답변 수·A16 결손·M07 자사 URL 인용률·D5 평균 순위·추이 ⑥)",
    "OLDNONE": "현행 값 없음(C11 카드는 degrade 로 빈 값, F07 은 프로덕션 스위치 off·적용일 이전) — A6 로 새로 노출",
    "SEED": "미해명(시드 결함): round_date -1일 — 09-18 좌석 웹사이트 6개 프로젝트 1,743답변이 비노출 09-17 유령 회차로 투영",
    "ROUND": "반올림 범위 잔여",
    "TOPN": "상위 N(경쟁사 10·도메인 20) 경계 이동: 모수 정의 변경으로 11번째 전후 순위가 바뀜",
    "WEBREG16": "현행 웹 집계층 사실표는 웹 카탈로그 미등록 프롬프트(CPO 사이트 8프롬프트×2엔진=16셀, 08-21~09-04)를 빼고 미러 경로는 포함 — 새 구조는 포함(미러와 같음, A4 고지 후보)",
    "SEEDNOTE": "새 값 자체가 시드 결함(round_date -1일)의 영향을 받음(현행 비교값 없음)",
    "RESUB": "09-18 웹 회차: 09-19 재제출 run(원장상 09-17 유령 회차 귀속)을 새 구조는 0078 앵커 규칙대로 09-18 좌석에 포함, 현행 집계층 사실표는 원장 귀속이라 제외(재제출 제외 시 C10 297/300·2132/2789·545 정확 재현, x24)",
    "OWN4": "미해명(경미): C08 beijing-hyundai.com.cn 자사 인용 4건(881 vs 877, 인용 점유율은 반올림 범위)",
}


def load(p):
    d = {}
    for l in open(p):
        r = json.loads(l)
        if "key" in r:
            d[(r["combo_id"], r["feature"], r["key"])] = r
    return d


def val(r):
    if r is None:
        return None
    if r.get("den") is None:
        return r.get("num")
    return (100.0 * r["num"] / r["den"]) if r["den"] else None


def eq(a, b):
    if a is None or b is None:
        return False
    if a.get("num") == b.get("num") and a.get("den") == b.get("den"):
        return True
    va, vb = val(a), val(b)
    if va is None or vb is None:
        return False
    try:
        return abs(float(va) - float(vb)) <= 0.05 + 1e-9
    except (TypeError, ValueError):
        return False


def exact(a, b):
    return a is not None and b is not None and a.get("num") == b.get("num") and a.get("den") == b.get("den")


def is_seed(c, f, key):
    """시드 결함(round_date -1일)이 새 값에 들어간 키: C10 의 값 기능(F01~F05), 웹사이트 추이의 09-18 자리."""
    if c in SEED_M1 and f in ("F01", "F02", "F03", "F04", "F05"):
        return True
    return bool(SEED_ROUND) and f == "F02" and c in SNAP_W | RANGE_W and key.startswith(SEED_ROUND) and c != "C09"


def base_tags(c, f, key):
    m = key.split(":")[-1]
    cit = m in CIT
    tags = []
    if f == "F02":
        tags.append("XAXIS_G" if c in SNAP_G | RANGE_G else "XAXIS_W")
    if f == "F06":
        return ["F1W4"] + (["R07SCOPE"] if c == "C05" else [])
    if c in SNAP_G:
        tags += ["A1", "GEN"] + ([] if cit else ["A15A16"]) + (["G21A"] if cit else []) + (["A41"] if c == "C03" else [])
    elif c in SNAP_W:
        tags += ["A1"] + ([] if cit else ["A16"]) + (["G21A"] if cit else []) + (["A2"] if m == "target_rate" else [])
    elif c in RANGE_G:
        tags += ["R07PUB"] + (["R07SCOPE"] if c == "C05" else []) + ([] if cit else ["A15A16"]) + (["G21A"] if cit else [])
        tags += (["R04CIT"] if cit and c == "C05" else [])
    elif c in RANGE_W:
        tags += ["R07PUB"] + ([] if cit else ["A16"]) + (["G21A"] if cit else []) + (["A2"] if m == "target_rate" else [])
        if f == "F05" and c == "C11":
            tags += ["GEOAX", "DFLT"]
    if f == "F03" and m == "exposure":
        tags.append("G20")
    return tags


def resid(c, f, key, o, n, e):
    """emu 로 재현되지 않은 차이의 사유(조사 결과, 보고서 근거 파일 병기)."""
    m = key.split(":")[-1]
    if is_seed(c, f, key):
        return "미해명", ["SEED"]
    if f == "F03" and m == "exposure":
        return "설명됨", base_tags(c, f, key)
    if f == "F03" and "KGM" in key:
        return "설명됨", ["NAME"]
    if f == "F05" and c == "C11":
        return "설명됨", ["GEOAX", "DFLT", "R07PUB", "A16"]
    if f == "F06":
        return "설명됨", base_tags(c, f, key)
    if f == "F02" and c in SNAP_W | RANGE_W and key.startswith("2026-09-18"):
        return "설명됨", ["RESUB"] + base_tags(c, f, key)[1:]
    if f == "F02" and c in SNAP_W | RANGE_W:
        extra = ["WEBREG16"] if key[:10] in ("2026-08-21", "2026-08-28", "2026-09-04") and c in ("C08", "C11") else []
        return "설명됨", ["XAXIS_W"] + extra + base_tags(c, f, key)[1:]
    if f == "F04" and c == "C08" and "beijing-hyundai" in key:
        return "미해명", ["OWN4"]
    if eq(o, n) or eq(o, e):
        return "일치", ["ROUND"]
    return "미해명", ["UNKNOWN"]


def main():
    res, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    O, N, E = load(OLD), load(f"{res}/values-new.jsonl"), load(f"{res}/values-emu.jsonl")
    rows = []
    for k in sorted(set(O) | set(N)):
        c, f, key = k
        o, n, e = O.get(k), N.get(k), E.get(k)
        m = key.split(":")[-1]
        if o is not None and n is not None:
            if exact(o, n):
                cls, tags = "일치", []
            elif eq(o, n):
                cls, tags = "일치", ["ROUND"]
            elif eq(o, e):
                cls, tags = "설명됨", base_tags(c, f, key)
                if is_seed(c, f, key):
                    cls, tags = "미해명", ["SEED"] + tags
            else:
                cls, tags = resid(c, f, key, o, n, e)
        elif n is not None:          # new 만
            if f == "F07" or (c == "C11" and f in ("F01", "F03", "F04")):
                cls, tags = "설명됨", ["OLDNONE"]
            elif m in ("answers", "analysis_gap", "owned_rate") or (f == "F03" and m == "position") or (f == "F02" and m == "target_rate"):
                cls, tags = "설명됨", ["NEWKEY"]
            elif f == "F06":
                cls, tags = "설명됨", ["F1W4"]
            elif f == "F03" and "KG모빌리티" in key:
                cls, tags = "설명됨", ["NAME"]
            elif f == "F03":
                cls, tags = "설명됨", ["TOPN"] + [t for t in base_tags(c, f, "x:mentions") if t != "G20"]
            elif f == "F05" and c == "C11":
                cls, tags = "설명됨", ["GEOAX"]
            elif f == "F02":
                cls, tags = "설명됨", ["XAXIS_G" if c in SNAP_G | RANGE_G else "XAXIS_W"]
            elif f == "F04":
                cls, tags = "설명됨", ["TOPN"] + base_tags(c, f, "x:citations")   # 상위 20 경계가 모수 변경으로 이동
            else:
                cls, tags = "미해명", ["UNKNOWN-newonly"]
            if is_seed(c, f, key):
                cls, tags = "미해명", ["SEED"] + tags
            elif c in SEED_M1 and f == "F07":
                tags = tags + ["SEEDNOTE"]
        else:                        # old 만
            if f == "F02":
                cls, tags = "설명됨", ["XAXIS_G" if c in SNAP_G | RANGE_G else "XAXIS_W"]
            elif f == "F06":
                cls, tags = "설명됨", ["F1W4"] + (["R07SCOPE"] if c == "C05" else [])
            elif f == "F03" and "KGM" in key:
                cls, tags = "설명됨", ["NAME"]
            elif f == "F03":
                cls, tags = "설명됨", ["TOPN"] + [t for t in base_tags(c, f, "x:mentions") if t != "G20"]
            elif f == "F05" and c == "C11":
                cls, tags = "설명됨", ["GEOAX"]
            elif f == "F04":
                cls, tags = "설명됨", ["TOPN"] + base_tags(c, f, "x:citations")
            elif f == "F05" and c == "C05":
                cls, tags = "설명됨", ["R07SCOPE"]
            else:
                cls, tags = "미해명", ["UNKNOWN-oldonly"]
            if is_seed(c, f, key):
                cls, tags = "미해명", ["SEED"] + tags
        rows.append({"combo_id": c, "feature": f, "key": key, "class": cls, "tags": tags,
                     "old": None if o is None else [o.get("num"), o.get("den")],
                     "new": None if n is None else [n.get("num"), n.get("den")],
                     "emu": None if e is None else [e.get("num"), e.get("den")],
                     "emu_reproduces_old": bool(o is not None and eq(o, e))})
    with open(f"{out}/classified.jsonl", "w") as fo:
        for r in rows:
            fo.write(json.dumps(r, ensure_ascii=False) + "\n")
    cnt = defaultdict(Counter)
    for r in rows:
        cnt[r["feature"]][r["class"]] += 1
    tagc = defaultdict(Counter)
    for r in rows:
        for t in r["tags"]:
            tagc[r["class"]][t] += 1
    L = ["# 신구 대조 3분류 (키 단위)", "", "| 기능 | 일치 | 설명됨 | 미해명 | 합계 |", "| --- | ---: | ---: | ---: | ---: |"]
    tot = Counter()
    for f in FEATS:
        c = cnt[f]
        tot.update(c)
        L.append(f"| {f} | {c['일치']} | {c['설명됨']} | {c['미해명']} | {sum(c.values())} |")
    L.append(f"| 합계 | {tot['일치']} | {tot['설명됨']} | {tot['미해명']} | {sum(tot.values())} |")
    L += ["", "## 사유 태그별 건수", "", "| 분류 | 태그 | 건수 | 뜻 |", "| --- | --- | ---: | --- |"]
    for cls in ("일치", "설명됨", "미해명"):
        for t, v in tagc[cls].most_common():
            L.append(f"| {cls} | {t} | {v} | {T.get(t, t)} |")
    emu_ok = sum(1 for r in rows if r["old"] is not None and r["emu_reproduces_old"])
    emu_all = sum(1 for r in rows if r["old"] is not None)
    L += ["", f"emu(현행 정의 모사)가 old 키를 재현한 비율: {emu_ok}/{emu_all}", "",
          "## 미해명 목록", "", "| 조합 | 기능 | 키 | old | new | emu | 태그 |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        if r["class"] == "미해명":
            L.append(f"| {r['combo_id']} | {r['feature']} | `{r['key']}` | {r['old']} | {r['new']} | {r['emu']} | {','.join(r['tags'])} |")
    open(f"{out}/classified.md", "w").write("\n".join(L) + "\n")
    print("\n".join(L[:14]))
    print("emu 재현", emu_ok, "/", emu_all)
    print("미해명", sum(1 for r in rows if r["class"] == "미해명"))


if __name__ == "__main__":
    main()
