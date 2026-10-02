# geo-catalog — Brand · Region · Country 카탈로그

HMG **브랜드 × 권역 × 국가 × 언어 × 웹사이트** 목록의 단일 소스. `region`/`country`
리스트를 하드코딩하지 말고 여기 접근자를 **참조**하세요.

- **출처**: `webgeo_final_list.xlsx` (시트 `Web GEO Final`, 218행)
- **데이터**: [`_data/web-geo-final.json`](./_data/web-geo-final.json) — xlsx를 그대로 추출한 빌드 산출물
- **스키마**: [`types.ts`](./types.ts) (`GeoEntry` 외)
- **접근자**: [`index.ts`](./index.ts)

## 스키마 (`GeoEntry`)
| 필드 | 예 | 비고 |
|------|-----|------|
| `brand` | Hyundai / Genesis / Kia | 3개 |
| `region` | North America / Asia / Europe / … | 8개 (대륙 그룹) |
| `country` | United States / South Korea / … | distinct 136 |
| `languageTag` | `es_MX` | 원본 로케일 태그 |
| `language` | `es` | 실측 본문 언어 |
| `confidence` | HIGH / MED / X-추정 | 언어 판정 신뢰도 |
| `url` | https://… | 정규화 최종 URL |
| `no`, `note` | | 원본 행번호 / 비고 |

## 사용 (참조)
```ts
import {
  GEO_BRANDS, GEO_REGIONS, GEO_COUNTRIES_BY_REGION, GEO_REGIONS_BY_BRAND,
  geoCountries, geoEntries, geoHierarchy,
} from "@/lib/geo-catalog";

GEO_BRANDS;                              // ["Hyundai","Genesis","Kia"]
geoCountries({ brand: "Kia", region: "Europe" });  // Kia 유럽 국가들
geoEntries({ country: "Canada" });       // Canada 전 변형(en/fr) 행
geoHierarchy("Hyundai");                 // Brand▸Region▸Country▸entries 트리
```

## ⚠️ 데이터 품질 (원본 충실 보존 — 필터 옵션으로 쓰기 전 정규화 권장)
- **중복 표기**: `Hong Kong SAR` vs `Hongkong`, `UAE` vs `United Arab Emirates`
- **딜러 하위행**: `Saudi Arabia - Riyadh/Jeddah/Dammam/Al Jabr/NMC` (국가 아님)
- **플레이스홀더**: `-`(Middle East), `Europe`(Europe 권역의 country 칸), Global 권역의 `N Brand`·`Worldwide`
- **멀티 언어 국가**: Canada(en/fr), United States(en/es/ko), Germany(en/de), UAE(ar/en) 등 — 한 country에 여러 `GeoEntry`

## 권한 스코프(`lib/scope/dimensions.ts`)와의 관계
이 카탈로그의 `region`은 **대륙 그룹**(North America/Asia/…)이고, 권한 스코프의
`REGIONS`는 **HMG 영업권역 코드**(KR/US/EU/IN/LATAM)로 **어휘가 다릅니다.**
geo-catalog는 *지리/웹 카탈로그*, dimensions.ts는 *보안 권한 축*이므로 직접
치환하지 말고, 매핑이 필요하면 별도 매핑 테이블을 두세요.

## 재생성 (xlsx 갱신 시)
`webgeo_final_list.xlsx` → JSON 재추출:
```bash
python3 - <<'PY'
import openpyxl, json
ws = openpyxl.load_workbook("webgeo_final_list.xlsx", data_only=True)["Web GEO Final"]
rows = list(ws.iter_rows(values_only=True)); h=[str(c).strip() if c else "" for c in rows[0]]
clean=lambda v:(str(v).strip() or None) if v is not None else None
out=[{"no":int(d["No"]) if d.get("No") not in (None,"") else None,"brand":clean(d.get("Brand")),
 "region":clean(d.get("Region")),"country":clean(d.get("Country")),
 "languageTag":clean(d.get("Language (원본)")),"language":clean(d.get("Language (실측·본문)")),
 "confidence":clean(d.get("언어 신뢰도")),"url":clean(d.get("최종 URL (정규화)")),"note":clean(d.get("URL Note"))}
 for d in (dict(zip(h,r)) for r in rows[1:]) if clean(d.get("Brand"))]
json.dump(out,open("lib/geo-catalog/_data/web-geo-final.json","w",encoding="utf-8"),ensure_ascii=False,indent=2)
print(len(out),"rows")
PY
```
