## 1. 집계·뷰모델
- [x] 1.1 `aggregateGeoKpiFromMirror` + `fetchStandardGeoKpi` · `buildGeo` metrics · 브랜드 행 감정 합
- [ ] 1.2 프로덕션 콜드 실측(GEO KPI 집계 3문장)

## 2. 화면
- [x] 2.1 5-KPI 카드(`overview-kpi-cards.tsx`) · 상세 링크(필터 실어 나름)
- [x] 2.2 국가별 GEO(`geo-overview.tsx`): KPI 칩·국가 선택(검색·다중)·지도 채색·트리표
- [x] 2.3 메뉴 라벨 Overview · 페이지 제목
- [ ] 2.4 헤더 "주 1회 측정 | 최근 측정일" 칩(측정 기준일 칩이 필터바에 있어 보류)
- [ ] 2.5 무필터(전 브랜드) 시 권역 뷰 — 브랜드 선택 유도 대신 브랜드별 탭 검토

## 3. 검증
- [x] 3.1 vitest(marketMetrics 4·렌더 9)·구조 가드 갱신·tsc·lint·strings·build
- [ ] 3.2 프리뷰 실측 + 독립 검증(렌즈: GEO KPI 산식 = 카드 산식 국가 좁힘)
