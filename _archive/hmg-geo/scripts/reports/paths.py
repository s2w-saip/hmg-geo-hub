#!/usr/bin/env python3
"""리포트 파이프라인 경로 정본 (파이썬 쪽 로더).

값은 scripts/paths.json 하나에서만 온다 — 노드 스크립트(paths.cjs)도 같은 파일을
읽으므로 디렉터리를 옮길 때 두 곳이 어긋나지 않는다.

발행본은 배치 디렉터리(3-publish/citation-v1.1_20260812/ 같은)로 나뉘므로
스캔은 반드시 재귀 glob 을 쓴다 — publish_glob() 참조.
"""
import glob as _glob
import json
import os

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_P = json.load(open(os.path.join(REPO, "scripts", "paths.json"), encoding="utf-8"))


def p(key):
    return os.path.join(REPO, _P[key])


DATA = p("data")
SOURCE = p("source")
EXTRACT = p("extract")
CITATION_DATA = p("citationData")
RAW = p("raw")
GA4 = p("ga4")
PUBLISH = p("publish")
ARCHIVE = p("archive")
TMP = p("tmp")
MANIFEST = p("manifest")
INDEX_TMP = p("indexTmp")
LOGOS = p("logos")
TEMPLATES = p("templates")


def publish_glob(pattern):
    """발행 디렉터리 전체(배치 하위 폴더 포함)를 재귀 스캔한다."""
    return sorted(_glob.glob(os.path.join(PUBLISH, "**", pattern), recursive=True))


def publish_batch(name):
    """배치 발행 디렉터리(없으면 생성)를 돌려준다. 예: publish_batch('citation-v1.1_20260812')"""
    d = os.path.join(PUBLISH, name)
    os.makedirs(d, exist_ok=True)
    return d
