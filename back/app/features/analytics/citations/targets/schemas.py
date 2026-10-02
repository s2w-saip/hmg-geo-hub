"""analytics.citations.targets 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

C-4 응답(명세 response 를 core.envelope P3 규칙에 맞춘 것): 비율은 정수 쌍 Ratio{num, den} 로만 내고 퍼센트(rate)는 프론트가 낸다.
- measured      : 분모(측정 단위 A2: 웹 등록 프롬프트의 완료 측정 수. 발행값이면 발행 measured_prompts 합)
- target        : M06 타겟 URL 인용률 Ratio(num = 타겟 URL 적중), 분모 0 이면 null(측정 대기, meta.suppressed 에 사유)
- owned         : M07 자사 URL 인용률 Ratio(num = 자사 URL 적중. 발행값이면 분모 = owned_prompts_den)
meta.source(R09·A5 provenance, 모듈-인용 §2 C-4)
- 발행값: {origin: 'report', publication_slugs: [합산에 실제로 들어간 발행물 slug]}
- 라이브: {origin: 'live', reason: engine_axis|period_range|no_publication|not_website|empty_window}(core R09_* 사유). 현행 프로필 web_url_rate
  켜짐이면 unsupported_axis|period_open_ended|scope_narrower|brand_not_in_publication|vocabulary_split|no_published_sites 도(WU-7)
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from app.core.envelope import Ratio


class TargetsData(BaseModel):
    measured: int = Field(description="분모(측정 수). 억제·측정 없음이면 0")
    target: Ratio | None = Field(description="M06 타겟 URL 인용률(정수 쌍)")
    owned: Ratio | None = Field(description="M07 자사 URL 인용률(정수 쌍, 타겟 ⊂ 자사)")
