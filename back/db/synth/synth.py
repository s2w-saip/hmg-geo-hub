#!/usr/bin/env python3
"""합성 운영형 데이터 생성기. 고객 데이터 0 · 운영 접속 0 · 표준 라이브러리만.

무엇: 운영과 같은 '모양'(행 수·카디널리티·쏠림)의 app·ing 행을 만든다. 값은 전부 여기서 생성한다.
  볼륨 기준(scale 1.0) = 레포 문서의 운영 행 수(2026-10-06 n_live_tup 추정, docs/reports/부록/데이터 이관 문서 검토 메모.md·
    마이그레이션 부록 A): 답변 854,710 · 언급 6,787,327 · 발생 7,876,641 · 인용 7,179,865 · ACR 롤업 1,077,813 · 스탠스 958,476.
  모양 기준 = 코드 상수·코드 주석(값이 아니라 구조): 엔진 front/lib/scope/engines.ts, 원래 9개 시장·영어 프롬프트 8개 시장 태그
    front/lib/standards/prompt-markets.ts, 8/31 다국어 시장 확대 front/lib/scope/hidden-regions.ts, 퍼널·리스트 유형·깊이 라벨
    front/components/dash/dimension-filter-panel.tsx, 회차 요일 back/ingest/cycles/ledger/service.py(글로벌 월·웹사이트 금),
    표시 지연 app.rule_param view_delay_days_by_surface.
  이름: HMG 3사·경쟁 브랜드·차종은 공개 이름. 출처 도메인은 상위 공개 사이트 + 롱테일 예약 TLD(.test, RFC 2606).
    프롬프트 문구·답변 원문은 템플릿 생성. 운영 KPI 값·운영 카탈로그 문구는 쓰지 않는다.
  규칙 표(브랜드 비트·공식 도메인·카테고리·숨김 시장)는 synth-db.sh 가 tests/fixtures/fixture-00-rules.sql(코드 상수 발췌)로 넣는다.
  데모 계정 = back/tests/support.py ACCOUNTS_SQL(E2E 와 같은 합성 계정).
산출(--out): load.sql(적재 순서·\\copy 목록) + app/<표>.csv.gz + ing/<표>.csv.gz + manifest.json(행 수·시드·스케일).
결정적: 같은 --scale·--seed·--asof 면 같은 내용.
사용: python synth.py --scale 0.02 --seed 1 --out out/s0.02-r1   (적재 = synth-db.sh load 0.02 1)
"""
from __future__ import annotations

import argparse
import bisect
import csv
import gzip
import hashlib
import json
import os
import random
import re
import uuid
from datetime import UTC, date, datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
NS = uuid.UUID("5e7a0000-0000-4000-8000-00000000c0de")
SYS_USER = "5eed0000-0000-4000-8000-000000000001"   # fixture-00 시스템 사용자(귀속 전용)
ADMIN_USER = "11111111-0000-4000-8000-000000000001"  # 데모 admin(ACCOUNTS_SQL)


def uid(*parts) -> str:
    return str(uuid.uuid5(NS, "\x1f".join(map(str, parts))))


def ts(d: datetime | None) -> str | None:
    return None if d is None else d.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S+00")


def kst_date(d: datetime) -> date:
    return d.astimezone(KST).date()


def kst_midnight(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=KST)


def pg_arr(xs) -> str | None:
    if xs is None:
        return None
    return "{" + ",".join('"' + str(x).replace("\\", "\\\\").replace('"', '\\"') + '"' for x in xs) + "}"


def b(v: bool) -> str:
    return "t" if v else "f"


def _read(*rel: str) -> str:
    """이 파일 기준 상대 경로의 레포 파일(코드 상수 원천)을 읽는다."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), *rel), encoding="utf-8") as f:
        return f.read()


# ════════════════════════════════════════════════════════════════════════════
# 1. 이름·값 공간(공개 이름·코드 상수 어휘만)
# ════════════════════════════════════════════════════════════════════════════
# HMG 3사 정본 엔티티 = lib/scope/hmg-brands.ts 합성 고정 UUID(fixture-00 app.brand), 표기 변형 id = app.entity_alias(fixture-00 3-5)
HMG = {
    "Hyundai": {"id": "00000000-0000-0000-0000-000000000301", "alias": "e0348d5f-afe4-48e6-aa99-1dee566f2822", "ko": "현대자동차",
                "dom": "hyundai.com",
                "models": ["Tucson", "Santa Fe", "IONIQ 5", "IONIQ 6", "Kona", "Elantra", "Palisade", "Sonata", "Venue", "Creta", "i20", "Casper"]},
    "Kia": {"id": "00000000-0000-0000-0000-000000000302", "alias": "ed4b8012-4a73-4174-9b43-4cb696934b25", "ko": "기아", "dom": "kia.com",
            "models": ["Sportage", "Sorento", "EV6", "EV9", "Seltos", "Telluride", "Niro", "K5", "Carnival", "Picanto", "EV3", "Sonet"]},
    "Genesis": {"id": "00000000-0000-0000-0000-000000000304", "alias": "fd2f4a33-8f9b-4a46-bfd0-62133d162d28", "ko": "제네시스",
                "dom": "genesis.com", "models": ["GV80", "GV70", "G80", "G90", "GV60", "G70"]},
}
HMG_ORDER = ["Hyundai", "Kia", "Genesis"]
COMPETITORS = {   # 공개 브랜드·차종(app.non_competitor_name 과 겹치지 않음). 가중치 = 전역 노출 쏠림
    "Toyota": (10, ["RAV4", "Camry", "Corolla", "Highlander", "bZ4X"]), "Honda": (8, ["CR-V", "Civic", "Accord", "HR-V"]),
    "Tesla": (8, ["Model Y", "Model 3"]), "Volkswagen": (7, ["ID.4", "Tiguan", "Golf"]), "BMW": (7, ["X5", "X3", "i4", "iX"]),
    "Mercedes-Benz": (7, ["GLC", "EQE", "C-Class", "GLE"]), "Ford": (6, ["Mustang Mach-E", "Explorer", "Escape", "F-150"]),
    "Nissan": (5, ["Rogue", "Leaf", "Qashqai", "X-Trail"]), "Audi": (5, ["Q5", "Q4 e-tron", "A4"]), "BYD": (5, ["Atto 3", "Seal", "Dolphin"]),
    "Mazda": (4, ["CX-5", "CX-50", "Mazda3"]), "Subaru": (3, ["Forester", "Outback"]), "Chevrolet": (4, ["Equinox", "Bolt", "Tahoe"]),
    "Volvo": (4, ["XC60", "XC40", "EX30"]), "Lexus": (4, ["RX", "NX", "ES"]), "Skoda": (3, ["Octavia", "Enyaq", "Kodiaq"]),
    "Peugeot": (3, ["3008", "208"]), "Renault": (3, ["Clio", "Austral"]), "MG": (3, ["ZS", "MG4"]), "Mitsubishi": (2, ["Outlander"]),
    "Jeep": (2, ["Grand Cherokee", "Compass"]), "Porsche": (2, ["Macan", "Taycan"]), "Polestar": (2, ["Polestar 2"]),
    "Tata": (2, ["Nexon", "Harrier"]), "Maruti Suzuki": (2, ["Brezza", "Swift"]), "Mahindra": (2, ["XUV700", "Scorpio-N"]),
    "Rivian": (1, ["R1S"]), "Cupra": (1, ["Born"]), "Land Rover": (1, ["Defender", "Range Rover Evoque"]), "Fiat": (1, ["500e"]),
    "Chery": (2, ["Tiggo 7"]), "Geely": (2, ["Coolray"]), "Changan": (1, ["CS55"]), "Suzuki": (2, ["Vitara", "Jimny"]),
}
MARKET_BOOST = {   # 시장별 경쟁 브랜드 가중 배수(모양만: 지역 강세)
    "US": {"Ford": 2.0, "Chevrolet": 2.0, "Tesla": 1.5, "Jeep": 2.0, "Rivian": 3.0, "Honda": 1.4},
    "CA": {"Ford": 1.8, "Chevrolet": 1.8, "Toyota": 1.4, "Honda": 1.4},
    "KR": {"BMW": 1.5, "Mercedes-Benz": 1.5, "Tesla": 1.3, "Volvo": 1.5},
    "DE": {"Volkswagen": 2.2, "BMW": 1.8, "Mercedes-Benz": 1.8, "Audi": 1.8, "Skoda": 2.0, "Cupra": 2.0},
    "FR": {"Peugeot": 3.0, "Renault": 3.0}, "BE": {"Volkswagen": 1.6, "Peugeot": 1.8, "Renault": 1.6, "BMW": 1.4},
    "BR": {"Chevrolet": 2.0, "Fiat": 3.0, "Volkswagen": 2.0, "BYD": 1.8}, "AE": {"Toyota": 2.0, "Nissan": 1.8, "Lexus": 2.0, "Chery": 1.5},
    "EG": {"Chery": 2.5, "Nissan": 1.6, "MG": 2.0, "Geely": 1.8},
    "GB": {"Land Rover": 2.5, "MG": 1.8, "Ford": 1.5}, "IT": {"Fiat": 3.0}, "ES": {"Cupra": 2.5}, "IN": {"Tata": 4.0, "Maruti Suzuki": 5.0, "Mahindra": 4.0},
    "AU": {"Toyota": 2.0, "Mazda": 1.8, "Mitsubishi": 2.0}, "ID": {"Toyota": 2.0, "Mitsubishi": 2.0, "Suzuki": 2.0},
    "JP": {"Toyota": 2.5, "Honda": 2.0, "Nissan": 2.0, "Suzuki": 2.0}, "MX": {"Nissan": 2.0, "Chevrolet": 1.6}, "TR": {"Renault": 2.0, "Fiat": 2.0},
}
FEATURES_EN = ["safety rating", "fuel efficiency", "warranty", "infotainment", "driving range", "price", "reliability", "resale value",
               "charging speed", "cargo space", "ride comfort", "driver assistance", "interior quality", "maintenance cost"]
FEATURES_KO = ["안전성", "연비", "보증", "인포테인먼트", "주행거리", "가격", "신뢰성", "중고 잔존가치", "충전 속도", "적재 공간", "승차감",
               "운전자 보조", "실내 품질", "유지비"]

# 엔진(= Scope target, front/lib/scope/engines.ts:16). 기본 = chatgpt·gemini(:37). deepseek 는 비기본(필터를 걸 때만 집계)
ENGINE = {"chatgpt": "gpt-4o", "gemini": "gemini-2.5-flash", "deepseek": "deepseek-v3"}
# 원래 9개 시장(영어 프롬프트 8개 시장 태그 + KR 한국어), 8/31 다국어 확대 36개 시장(언어 = 현지어, 모양만)
ORIG_EN = ["AE", "BE", "BR", "CA", "DE", "EG", "FR", "US"]
NEW36 = [("GB", "EN"), ("AU", "EN"), ("IN", "EN"), ("ZA", "EN"), ("NZ", "EN"), ("IE", "EN"), ("SG", "EN"), ("PH", "EN"),
         ("ES", "ES"), ("MX", "ES"), ("AR", "ES"), ("CL", "ES"), ("CO", "ES"), ("PE", "ES"), ("IT", "IT"), ("PL", "PL"),
         ("NL", "NL"), ("TR", "TR"), ("SA", "AR"), ("KW", "AR"), ("QA", "AR"), ("JP", "JA"), ("TH", "TH"), ("VN", "VI"),
         ("ID", "ID"), ("MY", "MS"), ("CZ", "CS"), ("SK", "SK"), ("HU", "HU"), ("RO", "RO"), ("GR", "EL"), ("PT", "PT"),
         ("SE", "SV"), ("NO", "NO"), ("DK", "DA"), ("AT", "DE")]
MULTILINGUAL_FROM = datetime(2026, 8, 31, 0, 30, tzinfo=UTC)

# 카탈로그 택소노미 라벨(front/components/dash/dimension-filter-panel.tsx 정적 목록). 부모 관계는 접두로 묶은 합성 트리
FUNNELS = ["인지/탐색", "비교/검증", "구매/사후관리"]
LIST_TYPES = [("Consumer base Response", 7), ("Brand Message", 3)]
PROMPT_TYPES = ["comparison", "recommendation", "information", "other"]
DEPTH = {
    "Car+Features": {"Features_Size/Spec": ["Size/Spec", "Size/spec/seat", "Trunk space"],
                     "Features_Software/Connectivity": ["Software/Connectivity", "connected services", "software update"],
                     "Features_Design/Color": ["Design/Color", "color", "design"], "Features_Mileage/Efficiency": ["Mileage/Efficiency", "hybrid efficiency"],
                     "Features_Interior": ["Interior"], "Features_Accessories": ["Accessories"], "Features_driving Option": ["driving option"],
                     "Features_Engine Output/Oil": ["Engine/output"], "Features_Technology": ["remote start", "Self driving/FSD"],
                     "Features_Vehicle Parts": ["parts"], "Features_Wheels/Tire": ["wheels"]},
    "Action+Car": {"Action_Pricing Plan": ["Price/deal/Financing", "Dealership/Configurator", "Used car/lease"],
                   "Action_Insurance/Warranty": ["Warranty", "Insurance"]},
    "Compare+Car/Features": {"Compare_Size/Spec": ["Size/Spec"], "Compare_Software/Connectivity": ["Software/Connectivity"],
                             "Compare_Design/Color": ["Design/Color"], "Compare_Mileage/Efficiency": ["Mileage/Efficiency", "EV Efficiency"],
                             "Compare_Car/Brand": ["Car/Brand"]},
    "Review+Car/Features": {"Review_Software/Connectivity": ["Software/Connectivity"], "Review_Design/Color": ["Design/Color"],
                            "Review_Mileage/Efficiency": ["Mileage/Efficiency"], "Review_Size/Spec": ["Size/spec"],
                            "Review_Car/Brand": ["Car/Brand", "Reliability"]},
    "Car Ownership": {"Ownership_Support": ["Support", "Myhyundai"], "Ownership_Issue/Problem": ["Issue/Problem", "recall"]},
    "Brand Image/key value": {"Brand Awareness": ["Car/Brand"], "Value Awareness": ["EV Value"],
                              "EV,Hybrid Brand Awareness": ["EV, Hybrid Awareness", "EV range", "EV Battery"],
                              "Innovative Brand Awareness": ["EV Design", "EV Driving"]},
    "Human & Sustainable Mobility": {"Human Centered Innovation": ["long distance/range"], "Social Responsibility": ["Support"],
                                     "Environmental Friendliness": ["EV Efficiency", "hybrid efficiency"]},
    "Innovation & Technology": {"Autonomous car": ["Self driving/FSD"], "Relation with AI": ["software update"],
                                "Software Technology": ["connected services", "Software/Connectivity"]},
}
DEPTH1_W = {"Car+Features": 30, "Action+Car": 12, "Compare+Car/Features": 14, "Review+Car/Features": 12, "Car Ownership": 9,
            "Brand Image/key value": 11, "Human & Sustainable Mobility": 5, "Innovation & Technology": 7}

# 출처 도메인: 상위 공개 사이트(호스트, 등록 도메인, Scope 카테고리 표기) + 롱테일 .test. 카테고리 판정은 seed 규칙이 domain_label 로 한다
TOP_DOMAINS = [
    ("www.reddit.com", "reddit.com", "Community & Forums"), ("www.youtube.com", "youtube.com", "Social & Video"),
    ("en.wikipedia.org", "wikipedia.org", "Wiki & Reference"), ("www.caranddriver.com", "caranddriver.com", "Automotive Media"),
    ("www.motortrend.com", "motortrend.com", "Automotive Media"), ("www.edmunds.com", "edmunds.com", "Blogs & Reviews"),
    ("www.kbb.com", "kbb.com", "Blogs & Reviews"), ("www.cars.com", "cars.com", "Dealer & Marketplace"),
    ("www.autotrader.com", "autotrader.com", "Dealer & Marketplace"), ("www.topgear.com", "topgear.com", "Automotive Media"),
    ("www.autocar.co.uk", "autocar.co.uk", "Automotive Media"), ("www.whatcar.com", "whatcar.com", "Blogs & Reviews"),
    ("www.carwow.co.uk", "carwow.co.uk", "Blogs & Reviews"), ("www.consumerreports.org", "consumerreports.org", "Blogs & Reviews"),
    ("www.iihs.org", "iihs.org", "Award & Certification"), ("www.nhtsa.gov", "nhtsa.gov", "Government & Public"),
    ("insideevs.com", "insideevs.com", "Automotive Media"), ("electrek.co", "electrek.co", "News & Media"),
    ("www.autoblog.com", "autoblog.com", "Automotive Media"), ("www.thedrive.com", "thedrive.com", "Automotive Media"),
    ("www.jdpower.com", "jdpower.com", "Award & Certification"), ("www.cargurus.com", "cargurus.com", "Dealer & Marketplace"),
    ("www.carsguide.com.au", "carsguide.com.au", "Blogs & Reviews"), ("www.drive.com.au", "drive.com.au", "Automotive Media"),
    ("www.auto-motor-und-sport.de", "auto-motor-und-sport.de", "Automotive Media"), ("www.adac.de", "adac.de", "Wiki & Reference"),
    ("www.autobild.de", "autobild.de", "Automotive Media"), ("www.caradisiac.com", "caradisiac.com", "Automotive Media"),
    ("www.largus.fr", "largus.fr", "Automotive Media"), ("www.quattroruote.it", "quattroruote.it", "Automotive Media"),
    ("www.motor.es", "motor.es", "Automotive Media"), ("www.cardekho.com", "cardekho.com", "Dealer & Marketplace"),
    ("www.carwale.com", "carwale.com", "Dealer & Marketplace"), ("www.autocarindia.com", "autocarindia.com", "Automotive Media"),
    ("namu.wiki", "namu.wiki", "Wiki & Reference"), ("www.encar.com", "encar.com", "Dealer & Marketplace"),
    ("www.bobaedream.co.kr", "bobaedream.co.kr", "Community & Forums"), ("news.naver.com", "naver.com", "News & Media"),
    ("blog.naver.com", "naver.com", "Blogs & Reviews"), ("www.webmotors.com.br", "webmotors.com.br", "Dealer & Marketplace"),
    ("www.dubizzle.com", "dubizzle.com", "Dealer & Marketplace"), ("www.yallamotor.com", "yallamotor.com", "Automotive Media"),
    ("www.linkedin.com", "linkedin.com", "Social & Video"), ("www.facebook.com", "facebook.com", "Social & Video"),
    ("www.instagram.com", "instagram.com", "Social & Video"), ("x.com", "x.com", "Social & Video"),
    ("www.toyota.com", "toyota.com", "Official (Competitor)"), ("www.honda.com", "honda.com", "Official (Competitor)"),
    ("www.tesla.com", "tesla.com", "Official (Competitor)"), ("www.bmw.com", "bmw.com", "Official (Competitor)"),
    ("www.mercedes-benz.com", "mercedes-benz.com", "Official (Competitor)"), ("www.volkswagen.de", "volkswagen.de", "Official (Competitor)"),
    ("www.ford.com", "ford.com", "Official (Competitor)"), ("www.byd.com", "byd.com", "Official (Competitor)"),
]
LONGTAIL_WORDS = ["auto", "car", "motor", "drive", "wheel", "road", "ev", "garage", "fleet", "torque", "gear", "lane", "mile", "pilot"]
LONGTAIL_CATS = ["Automotive Media", "Blogs & Reviews", "Community & Forums", "Dealer & Marketplace", "News & Media", "Other"]


# ════════════════════════════════════════════════════════════════════════════
# 2. 출력
# ════════════════════════════════════════════════════════════════════════════
class Table:
    def __init__(self, out: str, schema: str, name: str, cols: list[str]):
        os.makedirs(os.path.join(out, schema), exist_ok=True)
        self.rel = f"{schema}/{name}.csv.gz"
        self.qual = f"{schema}.{name}"
        self.cols = cols
        self._f = gzip.open(os.path.join(out, self.rel), "wt", encoding="utf-8", newline="", compresslevel=1)  # noqa: SIM115 (행마다 쓰고 close() 로 닫는다)
        self._w = csv.writer(self._f, lineterminator="\n")
        self.n = 0

    def row(self, *vals) -> None:
        # 빈 문자열은 쓰지 않는다(COPY csv 에서 따옴표 없는 빈 칸 = NULL). 값이 없으면 None.
        self._w.writerow(vals)
        self.n += 1

    def close(self) -> None:
        self._f.close()

    def copy_stmt(self) -> str:
        return f"\\copy {self.qual} ({', '.join(self.cols)}) FROM PROGRAM 'gzip -dc {self.rel}' WITH (FORMAT csv)"


class Pick:
    """가중 표본(누적 합 이분 탐색)."""

    def __init__(self, items: list, weights: list[float]):
        self.items = items
        self.acc, s = [], 0.0
        for w in weights:
            s += w
            self.acc.append(s)
        self.total = s

    def __call__(self, rng: random.Random):
        return self.items[bisect.bisect_right(self.acc, rng.random() * self.total)]


# ════════════════════════════════════════════════════════════════════════════
# 3. 생성기
# ════════════════════════════════════════════════════════════════════════════
class Gen:
    def __init__(self, scale: float, seed: int, out: str, asof: datetime):
        self.scale, self.seed, self.out, self.asof = scale, seed, out, asof
        os.makedirs(out, exist_ok=True)
        A = lambda name, cols: Table(out, "app", name, cols)   # noqa: E731
        G = lambda name, cols: Table(out, "ing", name, cols)   # noqa: E731
        self.t_project = A("project", ["project_id", "kind", "name", "description", "domain", "brand_code", "country_code",
                                       "scope_project_id", "ai_engines", "created_by", "created_at", "updated_at"])
        self.t_prompt = A("prompt", ["prompt_id", "project_id", "text", "prompt_type", "category", "brand_code", "brand_presence",
                                     "list_type", "depth1", "depth2", "depth3", "funnel_stage", "kind", "lang", "regions",
                                     "scope_prompt_id", "status", "created_by", "created_at", "updated_at", "deleted_at"])
        self.t_site = A("website_site", ["site_id", "brand_code", "country_code", "scope_project_id", "created_at", "updated_at"])
        self.t_wprompt = A("website_prompt", ["website_prompt_id", "site_id", "file_seq", "domain", "lang_code", "seq_no",
                                              "target_url", "prompt_text", "owned_base_url", "scope_prompt_id"])
        self.t_tbrand = A("project_tracked_brand", ["project_id", "canonical_name", "aliases"])
        self.t_tcomp = A("project_tracked_competitor", ["project_id", "brand_name", "aliases", "is_target"])
        self.t_tkw = A("project_tracked_keyword", ["keyword_id", "project_id", "term", "country_code"])
        self.t_tveh = A("project_tracked_vehicle", ["project_id", "brand", "model", "segment"])
        self.t_obase = A("project_owned_base", ["project_id", "base_url", "base_norm", "label", "created_by"])
        self.t_turl = A("project_tracked_url", ["project_id", "url", "url_norm", "label", "created_by"])
        self.t_cursor = G("sync_cursor", ["scope_project_id", "surface", "regions", "last_success_at"])
        self.t_iprompt = G("prompt", ["scope_prompt_id", "scope_project_id", "text", "funnel_stage", "lang", "regions", "kind",
                                      "scope_updated_at", "enabled"])
        self.t_run = G("run", ["run_id", "run_key", "scope_project_id", "run_month", "status", "trigger", "targets", "regions",
                               "total_jobs", "started_at", "completed_at", "cycle_anchor_at", "seen_jobs", "completed_jobs",
                               "unresolved_jobs", "sync_state", "last_load_id", "synced_at"])
        self.t_cycle = G("cycle", ["cycle_id", "cyc_key", "surface", "scope_project_id", "cycle_anchor_at", "anchor_source",
                                   "anchor_date", "round_date", "status", "closed_by", "closed_at", "expected_units",
                                   "completed_units", "completed_answers", "gap_answers", "fleet_visible", "view_anchor_at",
                                   "published_at", "origin"])
        self.t_cycle_run = G("cycle_run", ["run_id", "cycle_id", "attributed_by"])
        self.t_akm = G("answer_key_map", ["job_id", "answer_key", "run_month"])
        self.t_answer = G("answer", ["run_month", "job_id", "answer_key", "run_id", "prompt_id", "target", "region", "status",
                                     "measured_at", "model_slug", "prompt_run_id", "analysis_status", "analysis_version",
                                     "answer_text", "n_mentions", "n_citations", "content_hash", "seed_origin", "first_seen_at",
                                     "load_id"])
        self.t_mention = G("mention", ["run_month", "job_id", "ord", "entity_id", "display_name", "entity_type", "mention_count",
                                       "sentiment_positive", "sentiment_neutral", "sentiment_negative", "sentiment_mixed",
                                       "avg_position", "surfaces", "brand_rollup_entity_id", "product_rollup_entity_id",
                                       "type_mention", "type_recommendation", "type_comparison", "type_definition",
                                       "type_final_choice"])
        self.t_occ = G("mention_occurrence", ["run_month", "job_id", "ord", "entity_id", "brand_rollup_entity_id", "turn_index",
                                              "source_start", "source_end", "surface_text", "sentiment", "mention_role",
                                              "assertion", "context_snippet"])
        self.t_stance = G("answer_stance", ["run_month", "job_id", "turn_index", "entity_id", "brand_label", "is_tracked", "stance",
                                            "confidence", "evidence_text", "evidence_start", "evidence_end", "model_slug"])
        self.t_cit = G("citation", ["run_month", "job_id", "ord", "url", "title", "ref_index", "scope_category", "host",
                                    "domain_label"])
        self.t_acr = G("acr_prompt_run", ["prompt_run_id", "acr_cell_key", "run_id", "prompt_id", "target", "region",
                                          "measured_at", "planned_iterations", "valid_turn1_iterations", "valid_acr_iterations",
                                          "co_single_entity", "co_conditional_multiple", "co_generic_category",
                                          "co_resolved_off_shortlist", "co_unresolved_choice", "co_none", "source_job_ids",
                                          "acr_summary", "load_id"])
        self.t_acr_row = G("acr_rollup_row", ["prompt_run_id", "entity_id", "rollup_level", "run_id", "entity_name",
                                              "brand_rollup_entity_id", "parent_name", "entity_type", "appearance_count",
                                              "choice_count", "conditional_choice_count", "off_shortlist_choice_count",
                                              "unresolved_choice_count", "generic_choice_count", "appearance_rate", "acr",
                                              "overall_choice_share"])
        self.t_drop = G("answer_drop", ["job_id", "source_measured_at", "reason", "dropped_at", "origin"])
        self.t_pin = G("answer_anchor_pin", ["job_id", "anchor", "source_measured_at", "reason", "pinned_at", "origin"])
        self.months: set[date] = set()
        self.answer_key = self.run_key = self.cyc_key = self.acr_key = 0
        self._build_entities()
        self._build_domains()
        self._build_drift()

    # ── 회차 드리프트: 주(2026-03-02 기준 주차)마다 평균 회귀 랜덤 워크 + 완만한 추세. 추이 차트가 평평하지 않게 ──
    def _build_drift(self) -> None:
        rng = random.Random(self.seed * 31 + 7)
        hmg, pos, off = 1.0, 0.62, 0.10
        comp = {n: 1.0 for n in COMPETITORS}
        self.drift = []
        for _ in range(40):
            hmg = min(1.22, max(0.75, hmg + rng.gauss(0, 0.06) + (1.0 - hmg) * 0.12 + 0.003))
            pos = min(0.72, max(0.52, pos + rng.gauss(0, 0.012) + (0.62 - pos) * 0.2))
            off = min(0.14, max(0.06, off + rng.gauss(0, 0.006) + (0.10 - off) * 0.2))
            comp = {n: min(1.5, max(0.65, v + rng.gauss(0, 0.06) + (1.0 - v) * 0.12)) for n, v in comp.items()}
            self.drift.append({"hmg": hmg, "pos": pos, "off": off, "comp": dict(comp)})
        self._week = 0
        self.cur = self.drift[0]
        self._comp_cache: dict = {}

    def _set_week(self, anchor: datetime) -> None:
        self._week = max(0, min(len(self.drift) - 1, (anchor - datetime(2026, 3, 2, tzinfo=UTC)).days // 7))
        self.cur = self.drift[self._week]

    def _comp(self, region: str) -> Pick:
        """그 주·시장의 경쟁 브랜드 표본기(전역 쏠림 × 시장 강세 × 주 드리프트)."""
        key = (self._week, region)
        p = self._comp_cache.get(key)
        if p is None:
            boost = MARKET_BOOST.get(region, {})
            names = list(COMPETITORS)
            p = Pick(names, [COMPETITORS[n][0] * boost.get(n, 1.0) * self.cur["comp"][n] for n in names])
            self._comp_cache[key] = p
        return p

    # ── 엔티티 풀 ────────────────────────────────────────────────────────────
    def _build_entities(self) -> None:
        self.ent_brand: dict[str, dict] = {}
        for bn in HMG_ORDER:
            h = HMG[bn]
            self.ent_brand[bn] = {"id": h["id"], "name": bn, "type": "Brand", "rollup": h["id"], "hmg": True}
        for bn in COMPETITORS:
            eid = uid("entity", "Brand", bn)
            self.ent_brand[bn] = {"id": eid, "name": bn, "type": "Brand", "rollup": eid, "hmg": False}
        self.ent_product: dict[str, list[dict]] = {}
        for bn in list(HMG_ORDER) + list(COMPETITORS):
            models = HMG[bn]["models"] if bn in HMG else COMPETITORS[bn][1]
            self.ent_product[bn] = [{"id": uid("entity", "Product", bn, m), "name": f"{bn} {m}", "type": "Product",
                                     "rollup": self.ent_brand[bn]["id"], "brand": bn, "hmg": bn in HMG} for m in models]
        self.ent_feature = {lang: [{"id": uid("entity", "Feature", f), "name": f, "type": "Feature", "rollup": None, "hmg": False}
                                   for f in feats] for lang, feats in (("EN", FEATURES_EN), ("KO", FEATURES_KO))}

    # ── 출처 도메인 풀(상위 공개 + 롱테일 .test, Zipf) ─────────────────────────
    def _build_domains(self) -> None:
        """출처 풀 = 상위 공개 사이트 → 카테고리 시드 도메인(코드 상수: migration/seed/seed-3x-rules.sql _r_cat_seed = front
        lib/citation-categorizer/seed.json, 공개 도메인) → 롱테일 .test(일부 이름은 규칙 토큰 forum·dealer·wiki 를 담아 패턴 판정을 탄다).
        순서대로 Zipf 가중(머리 집중 + 운영 출처 56,407 규모의 긴 꼬리)."""
        rng = random.Random(self.seed * 7919 + 1)
        doms = list(TOP_DOMAINS)
        seen = {d[1] for d in doms}
        rules = _read("..", "..", "migration", "seed", "seed-3x-rules.sql")
        m = re.search(r"INSERT INTO _r_cat_seed VALUES(.*?);\s*\n", rules, re.S)
        seeds = re.findall(r"\('([a-z0-9.-]+)', '([^']+)'\)", m.group(1) if m else "")
        if len(seeds) < 500:
            raise SystemExit(f"카테고리 시드 도메인 파싱 실패: {len(seeds)}행")
        rng.shuffle(seeds)
        for d, cat in seeds:
            if d not in seen and cat != "Official (HMG)":
                seen.add(d)
                doms.append((("www." + d) if d.count(".") == 1 else d, d, cat))
        target = len(doms) + max(300, int(56_000 * self.scale))
        while len(doms) < target:
            w1, w2 = rng.choice(LONGTAIL_WORDS), rng.choice(LONGTAIL_WORDS + ["forum", "dealer", "wiki", "news", "blog"])
            d = f"{w1}{w2}{rng.randint(1, 99999)}.test"
            if d not in seen:
                seen.add(d)
                doms.append(((f"www.{d}" if rng.random() < 0.5 else d), d, rng.choice(LONGTAIL_CATS)))
        self.dom_pick = Pick(doms, [1.0 / (i + 1) ** 1.05 for i in range(len(doms))])

    # ════════════════════════════════════════════════════════════════════════
    # 답변 1건: 원문·언급·발생·스탠스·인용
    # ════════════════════════════════════════════════════════════════════════
    def answer(self, rng: random.Random, run: dict, p: dict, target: str, region: str, measured_at: datetime | None,
               status: str, prompt_run_id: str | None = None, iteration: int = 0) -> str:
        job_id = uid("job", run["run_id"], p["pid"], target, region, iteration)
        self.answer_key += 1
        key = self.answer_key
        rm = run["run_month"]
        self.t_akm.row(job_id, key, rm)
        if status != "completed":
            self.t_answer.row(rm, job_id, key, run["run_id"], p["pid"], target, region, status, ts(measured_at), ENGINE[target],
                              prompt_run_id, None, None, None, 0, 0, "\\x" + hashlib.md5(job_id.encode()).hexdigest(), "scope_api",
                              ts(measured_at or run["started_at"]), 1)
            return job_id
        ko = p["lang"] == "KO"
        ents = self._pick_entities(rng, p, region)
        text, occs, first_pos = self._compose(rng, p, ents, ko)
        r_an = rng.random()
        if run.get("analysis_pending") and r_an < 0.35:
            astat = "pending"
        elif r_an < 0.008:
            astat = "failed"
        elif r_an < 0.02:
            astat = "partial"
        else:
            astat = "completed"
        n_m = 0
        if astat in ("completed", "partial"):
            per_ent: dict[str, list] = {}
            for o in occs:
                per_ent.setdefault(o["e"]["id"], []).append(o)
            for e in ents:
                lst = per_ent.get(e["id"])
                if not lst:
                    continue
                n_m += 1
                sent = {"positive": 0, "neutral": 0, "negative": 0, "mixed": 0}
                role = {"recommendation": 0, "comparison": 0, "definition": 0, "final_choice": 0}
                for o in lst:
                    sent[o["sent"]] += 1
                    if o["role"] in role:
                        role[o["role"]] += 1
                mc = len(lst)
                self.t_mention.row(rm, job_id, n_m, e["disp_id"], e["disp"], e["type"], mc, sent["positive"], sent["neutral"],
                                   sent["negative"], sent["mixed"], first_pos[e["id"]], None, e["rollup"],
                                   e["id"] if e["type"] == "Product" else None, mc - sum(role.values()), role["recommendation"],
                                   role["comparison"], role["definition"], role["final_choice"])
            for i, o in enumerate(occs, 1):
                self.t_occ.row(rm, job_id, i, o["e"]["disp_id"], o["e"]["rollup"], 0, o["s"], o["t"], o["e"]["disp"], o["sent"],
                               o["role"], None, text[max(0, o["s"] - 60):o["t"] + 60])
            # 스탠스: 언급된 추적 브랜드(HMG) + 경쟁 브랜드 일부(운영 비율 ≈ 답변당 1.1)
            for e in ents:
                if e["type"] == "Brand" and e["id"] in per_ent and (e["hmg"] or rng.random() < 0.05):
                    o = per_ent[e["id"]][0]
                    end = min(len(text), o["t"] + 80)
                    self.t_stance.row(rm, job_id, 0, e["disp_id"], e["disp"], b(e["hmg"]), o["sent"], round(0.55 + rng.random() * 0.44, 2),
                                      text[o["s"]:end], o["s"], end, ENGINE[target])
        n_c = self._citations(rng, job_id, rm, p, ents, target)
        self.t_answer.row(rm, job_id, key, run["run_id"], p["pid"], target, region, status, ts(measured_at), ENGINE[target],
                          prompt_run_id, astat, "synth-1", text, n_m, n_c, "\\x" + hashlib.md5(text.encode()).hexdigest(),
                          "scope_api", ts(measured_at), 1)
        return job_id

    def _pick_entities(self, rng: random.Random, p: dict, region: str) -> list[dict]:
        if rng.random() < 0.07:   # 언급 없는 답변(분석됨·언급 0)
            return []
        ko = p["lang"] == "KO"
        n_brand = max(1, min(10, round(rng.gauss(4.5, 1.6))))
        n_prod = max(0, min(10, round(rng.gauss(3.7, 1.8))))
        n_feat = max(0, min(4, round(rng.gauss(1.2, 1.0))))
        brands: list[str] = []
        pb = p.get("brand")
        if rng.random() < min(0.97, (0.88 if pb in HMG else 0.52) * self.cur["hmg"]):
            brands.append(pb if pb in HMG else rng.choice(["Hyundai", "Kia", "Hyundai", "Kia", "Genesis"]))
        if rng.random() < 0.35 * self.cur["hmg"]:
            other = rng.choice(HMG_ORDER)
            if other not in brands:
                brands.append(other)
        cp = self._comp(region)
        for _ in range(40):
            if len(brands) >= n_brand:
                break
            c = cp(rng)
            if c not in brands:
                brands.append(c)
        rng.shuffle(brands)
        ents = []
        for bn in brands:
            e = dict(self.ent_brand[bn])
            alias = e["hmg"] and ko   # 한국어 답변의 HMG 표기 = 표기 변형 엔티티(현대자동차·기아·제네시스, app.entity_alias 로 접힘)
            e["disp"] = HMG[bn]["ko"] if alias else bn
            e["disp_id"] = HMG[bn]["alias"] if alias else e["id"]
            ents.append(e)
        have = set()
        for _ in range(n_prod):
            pe = rng.choice(self.ent_product[rng.choice(brands)])
            if pe["id"] in have:
                continue
            have.add(pe["id"])
            ents.append(dict(pe, disp=pe["name"], disp_id=pe["id"]))
        for f in rng.sample(self.ent_feature["KO" if ko else "EN"], n_feat):
            ents.append(dict(f, disp=f["name"], disp_id=f["id"]))
        return ents

    LIST_EN = ["often cited as a well-balanced choice. ", "praised for value for money. ", "recent updates improved its competitiveness. ",
               "strong on running costs. ", "frequently compared with segment leaders. ", "noted for its warranty coverage. "]
    LIST_KO = [" - 균형 잡힌 선택지로 자주 언급됩니다. ", " - 가격 대비 구성이 좋다는 평가가 많습니다. ", " - 최근 모델 변경으로 상품성이 높아졌습니다. ",
               " - 유지비 측면에서 강점이 있습니다. ", " - 보증 조건이 좋은 편입니다. "]
    FILL_EN = ["Consider test-driving several options before deciding. ", "Pricing varies by trim and region. ",
               "Incentives and financing offers change frequently. ", "Check local warranty terms and service coverage. ",
               "Real-world efficiency depends on driving conditions. ", "Insurance costs differ by model and driver profile. "]
    FILL_KO = ["구매 전 여러 모델을 직접 시승해 보는 것을 권합니다. ", "가격은 트림과 지역에 따라 다릅니다. ", "프로모션과 금융 조건은 자주 바뀝니다. ",
               "보증 조건과 서비스 네트워크를 확인하세요. ", "실제 효율은 주행 환경에 따라 달라집니다. "]
    ROLES = ["mention", "recommendation", "comparison", "definition"]

    def _compose(self, rng: random.Random, p: dict, ents: list[dict], ko: bool):
        """원문을 조각으로 이어 붙이며 엔티티 표기 위치를 기록한다(발생 오프셋 = 원문 문자 위치, BMP 문자만)."""
        parts: list[str] = []
        occs: list[dict] = []
        first_pos: dict[str, float] = {}
        pos = 0

        def put(s: str) -> None:
            nonlocal pos
            parts.append(s)
            pos += len(s)

        def name(e: dict, role: str) -> None:
            r = rng.random()
            bias = self.cur["pos"] if e.get("hmg") else 0.5
            sent = "positive" if r < bias else "neutral" if r < bias + 0.26 else "negative" if r < bias + 0.34 else "mixed"
            occs.append({"e": e, "s": pos, "t": pos + len(e["disp"]), "sent": sent, "role": role})
            first_pos.setdefault(e["id"], float(len(first_pos) + 1))
            put(e["disp"])

        put(f"{p['text']}에 대해 정리하면 다음과 같습니다.\n\n" if ko else f"Here is an overview for \"{p['text']}\".\n\n")
        for i, e in enumerate(ents, 1):
            role = rng.choice(self.ROLES) if e["type"] != "Feature" else "mention"
            put(f"{i}. " if ko else f"{i}. **")
            name(e, role)
            put(rng.choice(self.LIST_KO) if ko else "** - " + rng.choice(self.LIST_EN))
            if rng.random() < 0.09:   # 같은 엔티티 반복 언급(발생 > 언급 행: 운영 ≈ 1.16배)
                put(" 또한 " if ko else " Additionally, ")
                name(e, rng.choice(self.ROLES))
                put(" 은(는) 장기 보유 만족도가 높습니다. " if ko else " scores well on long-term satisfaction. ")
            put("\n")
        target_len = int(min(9000, max(600, rng.lognormvariate(7.6, 0.45))))
        put("\n")
        fill = self.FILL_KO if ko else self.FILL_EN
        while pos < target_len:
            put(rng.choice(fill))
            if ents and rng.random() < 0.02:
                name(rng.choice(ents), "final_choice" if rng.random() < 0.3 else "mention")
                put(". ")
        return "".join(parts), occs, first_pos

    def _citations(self, rng: random.Random, job_id: str, rm: date, p: dict, ents: list[dict], target: str) -> int:
        mean = {"gemini": 11.0, "chatgpt": 8.8, "deepseek": 7.2}[target]
        if rng.random() < (0.06 if target != "chatgpt" else 0.14):
            return 0
        n = max(1, min(30, round(rng.gauss(mean, mean * 0.45))))
        hmg_in = [e for e in ents if e.get("hmg") and e["type"] == "Brand"]
        for o in range(1, n + 1):
            r = rng.random()
            if hmg_in and r < self.cur["off"]:   # 공식(HMG) 출처
                bn = rng.choice(hmg_in)["name"]
                if p.get("own_base") and bn == p["brand"] and rng.random() < 0.7:   # 프로젝트 자사 base 아래(일부는 추적 URL 그대로)
                    url = rng.choice(p["tracked"]) if rng.random() < 0.4 else f"{p['own_base']}{p['slug']}/"
                    self.t_cit.row(rm, job_id, o, url, f"{HMG[bn]['dom']} - {p['text']}", o, "Official (HMG)", url.split("/")[2], HMG[bn]["dom"])
                    continue
                dom = HMG[bn]["dom"]
                host, cat = "www." + dom, "Official (HMG)"
            elif p.get("target_url") and r < self.cur["off"] + 0.06:   # 웹사이트 유닛 타겟 URL 적중
                url = p["target_url"]
                self.t_cit.row(rm, job_id, o, url, f"{p['domain']} - {p['text']}", o, "Official (HMG)", url.split("/")[2], p["domain"])
                continue
            else:
                host, dom, cat = self.dom_pick(rng)
            self.t_cit.row(rm, job_id, o, f"https://{host}/{p['slug']}-{rng.randint(1, 400)}", f"{dom} - {p['text']}", o, cat, host, dom)
        return n

    # ════════════════════════════════════════════════════════════════════════
    # 회차·run·측정
    # ════════════════════════════════════════════════════════════════════════
    def _cycle(self, surface: str, spid: str, anchor: datetime, status: str, *, source: str, origin: str, delay: int,
               units: int, answers: int, closed_at: datetime | None, closed_by: str | None, rng: random.Random) -> str:
        self.cyc_key += 1
        cid = uid("cycle", spid, anchor.isoformat())
        ad = kst_date(anchor)
        closed = status != "open"
        view = kst_midnight(ad + timedelta(days=delay)) if status == "published" else None
        self.t_cycle.row(cid, self.cyc_key, surface, spid, ts(anchor), source, ad.isoformat(), ad.isoformat(), status,
                         closed_by if closed else None, ts(closed_at) if closed else None, units if closed else None,
                         (units - int(units * rng.uniform(0, 0.01))) if closed else None, answers if closed else None,
                         int(answers * rng.uniform(0.0, 0.012)) if closed else None, "t", ts(view), ts(view), origin)
        return cid

    def _cycles(self, rng: random.Random, surface: str, spid: str, anchors: list[datetime], delay: int, measure, *,
                source: str, origin: str, attributed_by: str, targets: list[str], regions: list[str], open_hours: int = 72) -> None:
        """회차마다 run 1개. 마지막 회차는 앵커 뒤 open_hours(완주 + 정온, 글로벌·웹사이트 3일 · 프로젝트 1일)가 지나지 않았으면
        열린 회차(측정 중·분석 대기 일부)."""
        for ci, anchor in enumerate(anchors):
            self._set_week(anchor)
            last = ci == len(anchors) - 1
            nxt = anchors[ci + 1] if not last else None
            done_at = anchor + timedelta(hours=open_hours - 10)
            published = not last or anchor + timedelta(hours=open_hours) <= self.asof
            run = self._new_run(spid, anchor, ("partial_failed" if rng.random() < 0.03 else "completed") if published else "running",
                                targets, regions, anchor + timedelta(hours=31) if published else None)
            run["analysis_pending"] = not published
            done, units = measure(rng, run, ci, anchor, not published)
            self._finish_run(run)
            if published and nxt is not None and nxt < done_at:
                c_at, c_by = nxt, "next_anchor"
            else:
                c_at, c_by = done_at, "complete"
            cid = self._cycle(surface, spid, anchor, "published" if published else "open", source=source, origin=origin, delay=delay,
                              units=units, answers=done, closed_at=c_at, closed_by=c_by, rng=rng)
            self.t_cycle_run.row(run["run_id"], cid, attributed_by)

    def _new_run(self, spid: str, anchor: datetime, status: str, targets: list[str], regions: list[str],
                 completed: datetime | None) -> dict:
        """run 행은 job 을 다 만든 뒤 _finish_run 이 쓴다(job 수·완료 수). run_month = 시작 시각의 KST 월."""
        self.run_key += 1
        kd = kst_date(anchor)
        rm = date(kd.year, kd.month, 1)
        self.months.add(rm)
        return {"run_id": uid("run", spid, anchor.isoformat()), "run_key": self.run_key, "spid": spid, "run_month": rm,
                "started_at": anchor, "status": status, "targets": targets, "regions": regions, "completed_at": completed,
                "jobs": 0, "done": 0}

    def _finish_run(self, run: dict) -> None:
        total, done = run["jobs"], run["done"]
        self.t_run.row(run["run_id"], run["run_key"], run["spid"], run["run_month"], run["status"], "schedule", pg_arr(run["targets"]),
                       pg_arr(run["regions"]) if run["regions"] else None, total, ts(run["started_at"]), ts(run["completed_at"]),
                       ts(run["started_at"]), total, done, 0 if run["status"] == "completed" else total - done, "loaded", 1,
                       ts(run["completed_at"] or self.asof))

    def _measure(self, rng: random.Random, run: dict, units_: list[tuple[dict, str, str]], anchor: datetime, open_cycle: bool,
                 pin_rate: float = 0.0, acr_iter: int = 5) -> tuple[int, int]:
        """한 run 의 job 전부. units_ = (프롬프트, 지역, 엔진). 반환 (완료 답변 수, 유닛 수)."""
        done = jobs = 0
        for p, region, target in units_:
            m_at = anchor + timedelta(minutes=30 + rng.random() * 60 * 30)
            if (open_cycle and rng.random() < 0.22) or m_at > self.asof:   # 열린 회차: 아직 안 돈 job
                self.answer(rng, run, p, target, region, None, "running")
                jobs += 1
                continue
            if p["kind"] == "acr":   # ACR: 셀당 반복 측정 acr_iter 회 + prompt-run 롤업
                prid = uid("acr", run["run_id"], p["pid"], target, region)
                ids = []
                for it in range(acr_iter):
                    st = "completed" if rng.random() > 0.03 else "failed"
                    ids.append(self.answer(rng, run, p, target, region, m_at + timedelta(minutes=it * 3), st, prid, it))
                    done += st == "completed"
                    jobs += 1
                self._acr(rng, run, p, target, region, prid, ids, m_at, acr_iter)
                continue
            st = "completed" if rng.random() > 0.012 else "failed"
            jid = self.answer(rng, run, p, target, region, m_at, st)
            done += st == "completed"
            jobs += 1
            if st == "completed":
                r = rng.random()
                if r < 0.017:   # 드롭 레지스트리(운영 ≈ 1.7%)
                    self.t_drop.row(jid, ts(m_at), "duplicate measurement superseded", ts(m_at + timedelta(days=1)), "loader")
                elif r < 0.017 + pin_rate:   # 수작업 앵커 고정(자기 회차 날짜: 귀속은 그대로, 고정 경로만 탄다)
                    self.t_pin.row(jid, kst_date(anchor).isoformat(), ts(m_at), "operator registry", ts(m_at + timedelta(days=2)), "loader")
        run["jobs"] += jobs
        run["done"] += done
        return done, len(units_)

    def _acr(self, rng, run, p, target, region, prid, ids, m_at, k) -> None:
        self.acr_key += 1
        valid1 = k - (1 if rng.random() < 0.05 else 0)
        valid = valid1 - (1 if rng.random() < 0.08 else 0)
        co = [0] * 6
        for _ in range(valid):
            co[min(5, int(rng.expovariate(1.4)))] += 1
        self.t_acr.row(prid, self.acr_key, run["run_id"], p["pid"], target, region, ts(m_at), k, valid1, valid, *co, pg_arr(ids),
                       json.dumps({"synthetic": True}), 1)
        cp = self._comp(region)
        hmg_in = [bn for bn in HMG_ORDER if rng.random() < min(0.95, 0.72 * self.cur["hmg"])]   # 후보군에 HMG 가 안 오르는 반복도 있다
        brands = list(dict.fromkeys(hmg_in + [cp(rng) for _ in range(40)]))[:24]
        for bn in brands:   # 롤업: 브랜드 ~24 + 차종 ~17 (운영 108만 행 ≈ prompt-run 당 ~35)
            rows = [(self.ent_brand[bn], "brand", None)]
            if rng.random() < 0.7:
                rows.append((rng.choice(self.ent_product[bn]), "product", bn))
            for e, lvl, parent in rows:
                app_ = rng.randint(0, valid)
                ch = rng.randint(0, app_)
                self.t_acr_row.row(prid, e["id"], lvl, run["run_id"], e["name"], e["rollup"], parent, e["type"], app_, ch,
                                   rng.randint(0, max(0, app_ - ch)), 0, 0, 0, round(app_ / valid, 4) if valid else None,
                                   round(ch / app_, 4) if app_ else None, round(ch / valid, 4) if valid else None)

    # ════════════════════════════════════════════════════════════════════════
    # 표면별 생성
    # ════════════════════════════════════════════════════════════════════════
    def run(self) -> dict:
        self._global()
        self._websites()
        self._projects()
        for t in [v for v in vars(self).values() if isinstance(v, Table)]:
            t.close()
        return self._write_load_sql()

    def _weekly(self, first: datetime) -> list[datetime]:
        out, a = [], first
        while a <= self.asof:
            out.append(a)
            a += timedelta(days=7)
        return out

    MODS_EN = ["", " for families", " under $40k", " for long commutes", " with the best safety", " for first-time buyers",
               " with low running costs", " for winter driving", " with the most cargo space", " for city driving", " in 2026",
               " with fast charging", " for towing"]
    MODS_KO = ["", " 가족용으로", " 4천만 원 이하로", " 장거리 출퇴근용으로", " 안전 위주로", " 첫 차로", " 유지비 적게", " 겨울 주행용으로",
               " 캠핑용으로", " 도심 주행용으로"]

    def _prompt_text(self, rng: random.Random, lang: str, brand: str | None, d3: str) -> str:
        model = rng.choice(HMG[brand]["models"]) if brand in HMG else None
        if lang == "KO":
            subj = f"{HMG[brand]['ko']} {model}" if model else d3
            mod = rng.choice(self.MODS_KO)
            return rng.choice([f"{subj}{mod} 추천해줘", f"{subj} 장단점{mod} 알려줘", f"{subj}{mod} 경쟁 모델과 비교해줘",
                               f"2026년 {subj} 구매 가이드{mod}"])
        subj = f"{brand} {model}" if model else d3.lower()
        mod = rng.choice(self.MODS_EN)
        return rng.choice([f"best {subj}{mod}", f"is the {subj} worth it{mod}", f"{subj} vs competitors{mod}",
                           f"pros and cons of {subj}{mod}", f"which {subj} has the best reliability{mod}"])

    @staticmethod
    def _slug(text: str) -> str:
        s = re.sub(r"[^0-9a-z가-힣]+", "-", text.lower()).strip("-")
        return "-".join(s.split("-")[:6]) or "page"

    # ── 글로벌(표준 루트): 영어 8개 시장 태그·한국어 KR·8/31 이후 다국어 36개 시장 ──────────
    def _global(self) -> None:
        rng = random.Random(self.seed * 101 + 1)
        pid_root, spid = uid("project", "root"), uid("scope_project", "root")
        self.t_project.row(pid_root, "standard_root", "root", None, None, None, "KR", spid, None, SYS_USER,
                           "2026-02-15 00:00:00+00", "2026-02-15 00:00:00+00")
        self.t_cursor.row(spid, "global", None, ts(self.asof))
        anchors = self._weekly(datetime(2026, 3, 2, 0, 30, tzinfo=UTC))   # 월요일 00:30 UTC(= KST 09:30, round_date 정본 요일)
        ml_from = next(i for i, a in enumerate(anchors) if a >= MULTILINGUAL_FROM)
        d1_pick = Pick(list(DEPTH1_W), list(DEPTH1_W.values()))
        lt_pick = Pick([x[0] for x in LIST_TYPES], [x[1] for x in LIST_TYPES])
        specs = ([("EN", ORIG_EN, None)] * max(20, round(930 * self.scale)) +
                 [("KO", ["KR"], None)] * max(8, round(630 * self.scale)) +          # 한국어 프롬프트 630(fix-sync-s1-rules.sql)
                 [("ML", None, ml_from)] * max(18, round(2_000 * self.scale)))
        prompts, n_cat = [], 0
        for i, (kind_l, regions, start_fixed) in enumerate(specs):
            if kind_l == "ML":
                mkt, lang = NEW36[i % len(NEW36)]
                regions = [mkt]
            else:
                lang = kind_l
            d1 = d1_pick(rng)
            d2 = rng.choice(list(DEPTH[d1]))
            d3 = rng.choice(DEPTH[d1][d2])
            branded = rng.random() < 0.62
            brand = Pick(HMG_ORDER, [45, 38, 17])(rng)
            text = self._prompt_text(rng, "KO" if lang == "KO" else "EN", brand if branded else None, d3)
            acr = kind_l == "EN" and i % 18 == 3   # ACR 프롬프트 ≈ 5.6%(규모와 무관하게 최소 1개)
            start = start_fixed if start_fixed is not None else (0 if rng.random() < 0.45 else int(rng.random() ** 1.6 * len(anchors) * 0.85))
            pid = uid("scope_prompt", "g", i)
            created = anchors[start] - timedelta(days=rng.randint(1, 6))
            funnel = rng.choice(FUNNELS)
            self.t_iprompt.row(pid, spid, text, funnel, lang, pg_arr(regions), "acr" if acr else "single", ts(created), "t")
            # 카탈로그 행: 30% 는 같은 scope 프롬프트에 브랜드가 다른 둘째 행(cat_mask OR)
            cat_brands = [brand] + ([b2] if rng.random() < 0.3 and (b2 := rng.choice(HMG_ORDER)) != brand else [])
            for cb in cat_brands:
                n_cat += 1
                deleted = rng.random() < 0.012
                self.t_prompt.row(uid("catalog", i, cb), pid_root, text, rng.choice(PROMPT_TYPES), None, cb,
                                  "branded" if branded else "unbranded", lt_pick(rng), d1, d2, d3, funnel, "acr" if acr else "single",
                                  lang, pg_arr(regions), pid, "done", SYS_USER, ts(created), ts(created),
                                  ts(self.asof - timedelta(days=rng.randint(1, 60))) if deleted else None)
            engines = ["chatgpt", "gemini"] + (["deepseek"] if rng.random() < 0.4 else [])
            prompts.append({"pid": pid, "text": text, "lang": "KO" if lang == "KO" else "EN", "brand": brand if branded else None,
                            "kind": "acr" if acr else "single", "start": start, "slug": self._slug(text),
                            "units": [(r, e) for r in regions for e in engines]})

        def measure(rng_, run, ci, anchor, open_cycle):
            u = [(p, r, e) for p in prompts if p["start"] <= ci for r, e in p["units"]]
            return self._measure(rng_, run, u, anchor, open_cycle, pin_rate=0.28)   # 운영 앵커 핀 177,007 ≈ 답변의 20%

        self._cycles(rng, "global", spid, anchors, 2, measure, source="scope", origin="summary_cycles", attributed_by="scope",
                     targets=list(ENGINE), regions=ORIG_EN + ["KR"])
        self.n_catalog = n_cat

    # ── 웹사이트(사이트 = scope project, 유닛 = file_seq): 금요일 정렬 ──────────────────
    def _websites(self) -> None:
        rng = random.Random(self.seed * 101 + 2)
        sites = ([("Hyundai", c) for c in ("US", "CA", "DE", "FR", "GB", "IT", "ES", "AU", "IN", "BR", "worldwide", "CPO")] +
                 [("Kia", c) for c in ("US", "CA", "DE", "FR", "GB", "IT", "ES", "AU", "IN", "BR", "worldwide")] +
                 [("Genesis", c) for c in ("US", "KR", "DE", "GB", "AU", "SA-Dammam", "worldwide")] +
                 [("Hyundai N", "KR"), ("Hyundai N", "worldwide")])
        sites = sites[:max(4, round(len(sites) * min(1.0, 0.2 + self.scale)))]
        lang_of = {"KR": "ko", "DE": "de", "FR": "fr", "IT": "it", "ES": "es", "BR": "pt", "SA-Dammam": "ar"}
        region_of = {"worldwide": "US", "CPO": "US", "SA-Dammam": "SA"}
        anchors = self._weekly(datetime(2026, 5, 8, 0, 30, tzinfo=UTC))   # 금요일 00:30 UTC(사이트 사이 round_date 정렬)
        file_seq = 100
        for bn, cc in sites:
            site_id, spid = uid("site", bn, cc), uid("scope_project", "site", bn, cc)
            self.t_site.row(site_id, bn, cc, spid, "2026-05-01 00:00:00+00", "2026-05-01 00:00:00+00")
            self.t_cursor.row(spid, "website", None, ts(self.asof))
            hb = "Hyundai" if bn == "Hyundai N" else bn
            dom = HMG[hb]["dom"]
            lang = lang_of.get(cc, "en")
            loc = cc.lower()
            region = region_of.get(cc, cc)
            prompts = []
            for u in range(3 + (rng.random() < 0.4)):
                file_seq += 1
                base = f"https://www.{dom}/{loc}/"
                n_p = max(4, round(13 * min(1.0, self.scale * 4)))
                for s in range(1, n_p + 1):
                    model = rng.choice(HMG[hb]["models"])
                    path = ["models", "electric", "shopping-tools", "service"][u % 4]
                    tgt = f"{base}{path}/{model.lower().replace(' ', '-')}/"
                    pid = uid("scope_prompt", "w", bn, cc, file_seq, s)
                    text = (f"{HMG[hb]['ko']} {model} {['가격', '사양', '리뷰', '프로모션'][s % 4]}" if lang == "ko"
                            else f"{bn} {model} {['price', 'specs', 'review', 'offers'][s % 4]}")
                    self.t_wprompt.row(uid("wprompt", site_id, file_seq, s), site_id, file_seq, f"www.{dom}", lang, s, tgt, text, base, pid)
                    self.t_iprompt.row(pid, spid, text, None, lang.upper(), None, "single", "2026-05-01 00:00:00+00", "t")
                    engines = ["chatgpt", "gemini"] + (["deepseek"] if rng.random() < 0.4 else [])
                    prompts.append({"pid": pid, "text": text, "lang": "KO" if lang == "ko" else "EN", "brand": hb, "kind": "single",
                                    "slug": self._slug(text), "target_url": tgt, "domain": dom, "units": [(region, e) for e in engines]})

            def measure(rng_, run, ci, anchor, open_cycle, prompts=prompts):
                return self._measure(rng_, run, [(p, r, e) for p in prompts for r, e in p["units"]], anchor, open_cycle)

            self._cycles(rng, "website", spid, anchors, 1, measure, source="scope", origin="summary_cycles", attributed_by="scope",
                         targets=list(ENGINE), regions=[])

    # ── 고객 프로젝트(표면 project, 파생 회차) ─────────────────────────────────
    def _projects(self) -> None:
        rng = random.Random(self.seed * 101 + 3)
        defs = [("Hyundai", "US", "Tucson"), ("Kia", "DE", "EV9"), ("Genesis", "KR", "GV80"), ("Hyundai", "IN", "Creta"),
                ("Kia", "US", "Telluride"), ("Hyundai", "DE", "IONIQ 5"), ("Kia", "GB", "Sportage"), ("Genesis", "US", "GV70"),
                ("Hyundai", "AU", "Santa Fe"), ("Kia", "IT", "EV3"), ("Hyundai", "FR", "Kona"), ("Kia", "KR", "Sorento")]
        for pi, (bn, cc, model) in enumerate(defs[:max(2, round(len(defs) * min(1.0, 0.15 + self.scale)))]):
            pid, spid = uid("project", "cust", pi), uid("scope_project", "cust", pi)
            self.t_project.row(pid, "customer", f"SYNTH · {bn} {model} {cc}", "합성 데이터 프로젝트(고객 데이터 아님)",
                               f"https://www.{HMG[bn]['dom']}/{cc.lower()}/", bn, cc, spid, None, SYS_USER,
                               "2026-04-01 00:00:00+00", "2026-04-01 00:00:00+00")
            self.t_cursor.row(spid, "project", pg_arr([cc]), ts(self.asof))
            self.t_tbrand.row(pid, bn, pg_arr([HMG[bn]["ko"]]))
            boost = MARKET_BOOST.get(cc, {})   # 추적 경쟁사 = 그 시장 상위 5(첫째 = 비교 대상)
            for j, c in enumerate(sorted(COMPETITORS, key=lambda n: -COMPETITORS[n][0] * boost.get(n, 1.0))[:5]):
                self.t_tcomp.row(pid, c, "{}", b(j == 0))
            self.t_tveh.row(pid, bn, model, "SUV")
            # 자사 base·추적 URL(정규화 = seed-00-fn.sql owned_prefix·norm_match 와 같은 결과가 되도록 www·끝 슬래시만 다르게)
            own_base = f"https://www.{HMG[bn]['dom']}/{cc.lower()}/"
            self.t_obase.row(pid, own_base, f"{HMG[bn]['dom']}/{cc.lower()}", "SYNTH 자사 사이트", SYS_USER)
            tracked = [f"{own_base}{seg}/{model.lower().replace(' ', '-')}/" for seg in ("models", "offers", "test-drive")]
            for u in tracked:
                self.t_turl.row(pid, u, u.split("://", 1)[1].removeprefix("www.").rstrip("/"), None, SYS_USER)
            for kw in (model, f"{model} price", f"{model} review", f"best {model.split()[0]} alternative"):
                self.t_tkw.row(uid("kw", pid, kw), pid, kw, cc)
            lang = "KO" if cc == "KR" else "EN"
            prompts = []
            for i in range(max(10, round(150 * min(1.0, self.scale * 3)))):
                text = self._prompt_text(rng, lang, bn, "SUV")
                ppid = uid("scope_prompt", f"c{pi}", i)
                funnel = rng.choice(FUNNELS)
                self.t_iprompt.row(ppid, spid, text, funnel, lang, pg_arr([cc]), "single", "2026-04-01 00:00:00+00", "t")
                self.t_prompt.row(uid("cprompt", pi, i), pid, text, rng.choice(PROMPT_TYPES), None, None, None, None, None, None, None,
                                  funnel, "single", lang, pg_arr([cc]), ppid, "done", SYS_USER,
                                  "2026-04-01 00:00:00+00", ts(self.asof - timedelta(hours=rng.randint(2, 160))), None)
                engines = ["chatgpt", "gemini"] + (["deepseek"] if rng.random() < 0.4 else [])
                prompts.append({"pid": ppid, "text": text, "lang": lang, "brand": bn, "kind": "single", "slug": self._slug(text),
                                "units": [(cc, e) for e in engines], "own_base": own_base, "tracked": tracked})
            anchors = self._weekly(datetime(2026, 4, 6, 5, 0, tzinfo=UTC) + timedelta(days=pi % 7))

            def measure(rng_, run, ci, anchor, open_cycle, prompts=prompts):
                return self._measure(rng_, run, [(p, r, e) for p in prompts for r, e in p["units"]], anchor, open_cycle)

            self._cycles(rng, "project", spid, anchors, 1, measure, source="derived", origin="loader", attributed_by="derived", open_hours=30,
                         targets=list(ENGINE), regions=[cc])

    # ── 데모 로그인 계정 = E2E 정본(back/tests/support.py ACCOUNTS_SQL, front/e2e/accounts.json 과 같은 합성 계정) ──
    def _accounts_sql(self) -> list[str]:
        src = _read("..", "..", "tests", "support.py")
        m = re.search(r"INSERT INTO app\.user_account .*?status = EXCLUDED\.status;", src, re.S)
        if not m:
            raise SystemExit("back/tests/support.py ACCOUNTS_SQL 의 app.user_account INSERT 를 찾지 못함")
        first = uid("project", "cust", 0)
        return ["-- 데모 계정(E2E 와 같은 합성 계정, 비밀번호는 mock auth 전용 상수). vendor·HQ 는 첫 합성 고객 프로젝트 멤버",
                m.group(0),
                "INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at) VALUES "
                f"('{first}', '11111111-0000-4000-8000-000000000004', 'viewer', 'active', '{ADMIN_USER}', now()), "
                f"('{first}', '11111111-0000-4000-8000-000000000002', 'viewer', 'active', '{ADMIN_USER}', now());"]

    # ── load.sql ────────────────────────────────────────────────────────────
    def _write_load_sql(self) -> dict:
        order = [self.t_project, self.t_prompt, self.t_site, self.t_wprompt, self.t_tbrand, self.t_tcomp, self.t_tkw, self.t_tveh, self.t_obase, self.t_turl,
                 self.t_cursor, self.t_iprompt, self.t_run, self.t_cycle, self.t_cycle_run, self.t_akm, self.t_answer,
                 self.t_mention, self.t_occ, self.t_stance, self.t_cit, self.t_acr, self.t_acr_row, self.t_drop, self.t_pin]
        months = ",".join(f"'{m.isoformat()}'::date" for m in sorted(self.months))
        lines = [
            "-- synth.py 산출(손으로 고치지 않는다). 합성 app·ing 적재. 고객 데이터 0.",
            "\\set ON_ERROR_STOP on", "SET client_min_messages = warning;", "SET TIME ZONE 'UTC';",
            "BEGIN;",
            f"SET LOCAL app.actor_id = '{SYS_USER}';", "SET LOCAL app.actor_type = 'system';",
            # 카탈로그 변경 트리거(judgment_change 큐·감사)는 시드와 무관: 적재 동안 끈다(fixture-00·seed-10 과 같은 처리)
            "ALTER TABLE app.prompt DISABLE TRIGGER prompt_catalog_change;",
            "INSERT INTO ing.load (load_id, kind, rule_ver, status) OVERRIDING SYSTEM VALUE VALUES (1, 'seed', 1, 'committed');",
            "SELECT setval(pg_get_serial_sequence('ing.load', 'load_id'), 1);",
            "DO $l$ DECLARE t text; m date; BEGIN",
            "  FOREACH t IN ARRAY ARRAY['ing.answer','ing.mention','ing.mention_occurrence','ing.answer_stance','ing.citation'] LOOP",
            f"    FOREACH m IN ARRAY ARRAY[{months}] LOOP PERFORM rd.ensure_month_leaf(t::regclass, m); END LOOP;",
            "  END LOOP; END $l$;",
        ]
        lines += [t.copy_stmt() for t in order]
        lines += self._accounts_sql()
        for tbl, col in (("ing.run", "run_key"), ("ing.cycle", "cyc_key"), ("ing.answer_key_map", "answer_key"),
                         ("ing.acr_prompt_run", "acr_cell_key")):
            lines.append(f"SELECT setval(pg_get_serial_sequence('{tbl}', '{col}'), greatest((SELECT max({col}) FROM {tbl}), 1));")
        lines += ["ALTER TABLE app.prompt ENABLE TRIGGER prompt_catalog_change;", "COMMIT;",
                  "ANALYZE ing.answer; ANALYZE ing.mention; ANALYZE ing.mention_occurrence; ANALYZE ing.citation; ANALYZE ing.run;"]
        with open(os.path.join(self.out, "load.sql"), "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
        manifest = {"generator": "back/db/synth/synth.py", "scale": self.scale, "seed": self.seed, "asof": ts(self.asof),
                    "customer_data": False, "catalog_rows": self.n_catalog, "rows": {t.qual: t.n for t in order}}
        with open(os.path.join(self.out, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
        return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--scale", type=float, default=0.02, help="1.0 = 운영 행 수 규모(답변 약 85만)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--asof", default="2026-10-14T12:00:00+00:00", help="생성 기준 시각(이후 측정은 진행 중으로 남긴다)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if not 0 < a.scale <= 3:
        raise SystemExit("--scale 은 (0, 3]")
    m = Gen(a.scale, a.seed, a.out, datetime.fromisoformat(a.asof).astimezone(UTC)).run()
    for k, v in m["rows"].items():
        print(f"{k:32s} {v:>12,d}")


if __name__ == "__main__":
    main()
