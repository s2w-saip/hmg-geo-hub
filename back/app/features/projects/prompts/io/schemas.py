"""projects.prompts.io 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope(가져오기). 내보내기는 xlsx 바이너리."""
from __future__ import annotations

from pydantic import BaseModel, Field

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_UPLOAD_BYTES = 5 * 1024 * 1024       # 업로드 상한(신규, 현행 미확인)
MAX_ROWS = 5000                          # 데이터 행 상한(모듈-프로젝트 PJ-3 제안 5,000)
MAX_WARNINGS = 200


class ImportSummary(BaseModel):
    """현행 ImportSummary(created·updated·skipped·createdTags·warnings) 계승."""
    created: int
    updated: int
    skipped: int
    created_tags: int = Field(description="헤더에서 자동 생성한 커스텀 태그 수")
    warnings: list[str] = Field(default_factory=list, description=f"행별 경고(최대 {MAX_WARNINGS}건, 넘치면 마지막에 요약 1줄)")
