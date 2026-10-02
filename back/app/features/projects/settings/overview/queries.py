"""projects.settings.overview SQL(app 만). 프로젝트당 소량 표 5개를 PK·project_id 접두로 읽는다."""
from __future__ import annotations

from app.features.projects.settings.owned_bases.queries import LIST as OWNED_BASES
from app.features.projects.settings.tracked_targets.queries import BRAND_ROW, LIST_COMPETITORS, LIST_VEHICLES
from app.features.projects.settings.tracked_urls.queries import COUNT as TRACKED_URL_COUNT

PROJECT = "SELECT domain, brand_code, ai_engines FROM app.project WHERE project_id = :pid"

__all__ = ["BRAND_ROW", "LIST_COMPETITORS", "LIST_VEHICLES", "OWNED_BASES", "PROJECT", "TRACKED_URL_COUNT"]
