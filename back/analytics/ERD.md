# HUB GA4·SEO 분리 ERD

원본: 워크스페이스의 `GEO HUB 골드 ERD.html` 및 `docs/reports/부록/골드 ERD 생성기/src/tables/07_ga4.js`, `08_vis.js`.
아래는 `hmg_analytics` 안의 관계입니다. 외부 Gold DB로 향하는 FK나 조회 연결은 없습니다.

```mermaid
erDiagram
    ref_dim_region ||--o{ ref_dim_country : region_key
    ref_dim_country ||--o{ analytics_ga4_property : geo_key
    ref_dim_country ||--o{ ref_dim_project : site_geo_key
    ref_dim_country ||--o{ analytics_page_visibility_daily : geo_key
    ref_dim_category ||--o{ ref_dim_source : category_key
    ref_dim_brand ||--o{ ref_dim_source : competitor_brand_key
    ref_dim_source ||--o{ ref_dim_url : source_key
    ref_dim_owned_base ||--o{ ref_dim_url : owner_key
    ref_dim_url ||--o{ analytics_ga4_value : url_key
    analytics_ga4_property ||--o{ analytics_ga4_row : prop_key
    analytics_ga4_property ||--o{ analytics_ga4_users_window : prop_key
    analytics_ga4_value ||--o{ analytics_ga4_row : "kind + value_key"
    analytics_ga4_value ||--o{ analytics_ga4_users_window : "page + page_key"
    ref_dim_engine ||--o{ analytics_ga4_row : engine_key
    ref_dim_engine ||--o{ analytics_dim_crawl_bot : engine_key
    ref_dim_project ||--o{ analytics_page_visibility_daily : project_key
    ref_dim_url ||--o{ analytics_page_visibility_daily : url_key
    ops_build ||--o{ analytics_page_visibility_daily : build_id
    analytics_page_visibility_daily ||--o{ analytics_page_crawl_daily : "build + site + page + date"
    analytics_dim_crawl_bot ||--o{ analytics_page_crawl_daily : bot_key
    analytics_page_visibility_daily ||--o{ analytics_page_seo_device_daily : "build + site + page + date"
    analytics_ga4_value ||--o{ analytics_page_seo_device_daily : "device + device_key"
    ops_build ||--o{ analytics_page_priority : build_id
    ref_dim_project ||--o{ analytics_page_priority : project_key
    ref_dim_url ||--o{ analytics_page_priority : url_key
    ops_build ||--o{ ops_seo_active_build : validated_build
    ref_dim_project ||--o{ ops_seo_active_build : project_key

    analytics_ga4_property {
        smallint prop_key PK
        text property_id UK
        integer brand_bit
        smallint geo_key FK
        text status
        text source
        smallint conv_basis
    }
    analytics_ga4_value {
        text kind PK
        integer value_key PK
        text value
        integer url_key FK
    }
    analytics_ga4_row {
        smallint prop_key PK,FK
        date date PK
        smallint report PK
        integer channel_key PK,FK
        integer source_key PK,FK
        integer device_key PK,FK
        integer nvr_key PK,FK
        integer page_key PK,FK
        integer event_key PK,FK
        smallint engine_key FK
        boolean is_ai
        boolean is_conv
        integer sessions
        integer users_day
        integer page_views
        integer key_events
        integer event_count
    }
    analytics_ga4_users_window {
        smallint prop_key PK,FK
        date window_end PK
        integer window_days PK
        text cohort PK
        integer engine_mask PK
        integer device_mask PK
        integer nvr_mask PK
        integer page_key PK,FK
        integer users
    }
    analytics_dim_crawl_bot {
        smallint bot_key PK
        text code UK
        smallint engine_key FK
    }
    analytics_page_visibility_daily {
        bigint build_id PK,FK
        smallint project_key PK,FK
        integer url_key PK,FK
        date date PK
        smallint geo_key FK
        integer seo_impressions
        integer ai_crawls
    }
    analytics_page_crawl_daily {
        bigint build_id PK,FK
        smallint project_key PK,FK
        integer url_key PK,FK
        date date PK,FK
        smallint bot_key PK,FK
        integer hits
    }
    analytics_page_seo_device_daily {
        bigint build_id PK,FK
        smallint project_key PK,FK
        integer url_key PK,FK
        date date PK,FK
        integer device_key PK,FK
        integer seo_impressions
    }
    analytics_page_priority {
        bigint build_id PK,FK
        smallint project_key PK,FK
        integer url_key PK,FK
        smallint priority
        text rule_ver
    }
    ops_build {
        bigint build_id PK
        text family "vis"
        text slice_key
        text status
        text rule_ver
    }
    ops_seo_active_build {
        smallint project_key PK,FK
        date date PK
        bigint build_id FK
        bigint version
        timestamptz updated_at
    }
```

도식에서는 가독성을 위해 generated `*_kind` 보조 열과 `ops.data_version`, `ops.schema_migration`은 생략했습니다.
전체 컬럼·제약·인덱스·권한의 정본은 [schema.sql](schema.sql)입니다.
