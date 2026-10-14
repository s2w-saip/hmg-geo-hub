"""projects.settings.overview SQL(app 만). 목록 표(owned base·경쟁사·차종)를 project_id 접두로 읽는다.
프로젝트 행·추적 URL 건수·자사 브랜드 별칭 행·기본 엔진은 service.PROJECT_BUNDLE 한 문장(P3 B022)이라 여기 두지 않는다."""
from __future__ import annotations

from app.features.projects.settings.owned_bases.queries import LIST as OWNED_BASES
from app.features.projects.settings.tracked_targets.queries import LIST_COMPETITORS, LIST_VEHICLES

__all__ = ["LIST_COMPETITORS", "LIST_VEHICLES", "OWNED_BASES"]
