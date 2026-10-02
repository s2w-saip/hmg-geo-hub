"""analytics.kpi.compare 테스트 공용 픽스처: 가짜 core(test_compare_service.fake)를 test_legacy_switches 도 쓴다."""
from app.features.analytics.kpi.compare.tests.test_compare_service import fake  # noqa: F401  (픽스처 등록)
