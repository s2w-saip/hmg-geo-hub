# 지역·사이트 카탈로그

브랜드·권역·국가·언어·웹사이트의 데이터는 `_data/web-geo-final.json`, 타입은 `types.ts`, 접근자는 `index.ts`에 있습니다.
화면별 목록을 복제하지 않고 `geoEntries`, `geoCountries`, `geoHierarchy` 등 공통 접근자를 사용합니다.

카탈로그의 지리 권역과 `lib/scope/dimensions.ts`의 보안 권역 코드는 다릅니다. 직접 치환하지 않습니다.
한 국가에 여러 언어·URL이 존재할 수 있고 원본의 국가 별칭·딜러 하위행·placeholder도 있으므로 변경 시 필터와 URL 귀속 테스트를 함께 확인합니다.
