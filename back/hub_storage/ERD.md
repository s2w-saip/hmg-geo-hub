# HUB DB 분리 ERD

실선 관계는 같은 DB의 FK이다. 두 DB 사이는 서비스/가져오기 명령이 UUID 존재를 검증하며 PostgreSQL FK가 아니다.

```mermaid
erDiagram
    DATA_project ||--o{ DATA_project_version : versions
    DATA_project ||--o{ DATA_prompt : owns
    DATA_prompt ||--o{ DATA_prompt_version : versions
    DATA_project ||--o| DATA_project_access : approval
    DATA_project ||--o{ DATA_project_ga4_property : maps
    DATA_ga4_property ||--o{ DATA_project_ga4_property : maps
    OPS_project_reference ||--o{ OPS_project_member : access
    OPS_user_account ||--o{ OPS_project_member : member
    OPS_project_reference ||--o{ OPS_project_setting_version : versions
    OPS_user_account o|--o{ OPS_project_setting_version : changed_by
    OPS_project_reference ||--o{ OPS_integration : config
    OPS_project_reference o|--o{ OPS_audit_event : history
    OPS_user_account o|--o{ OPS_audit_event : actor
    DATA_project {
        uuid project_id PK
        text origin
        uuid source_id UK
    }
    DATA_project_version {
        uuid project_id PK,FK
        integer version PK
        jsonb definition
        text sha256
        timestamptz recorded_at
    }
    DATA_prompt {
        uuid prompt_id PK
        uuid project_id FK
        text origin
        uuid source_id UK
    }
    DATA_prompt_version {
        uuid prompt_id PK,FK
        integer version PK
        text text
        jsonb definition
        text sha256
        timestamptz recorded_at
    }
    OPS_project_reference {
        uuid project_id PK "DATA_project와 같은 UUID; DB 간 FK 없음"
        timestamptz validated_at
    }
    OPS_user_account {
        uuid user_id PK
        text subject UK
        text email
        text status
    }
    OPS_project_member {
        uuid project_id PK,FK
        uuid user_id PK,FK
        text role
    }
    OPS_project_setting_version {
        uuid project_id PK,FK
        integer version PK
        jsonb settings
        uuid changed_by FK
    }
    OPS_integration {
        uuid integration_id PK
        uuid project_id FK
        text provider
        jsonb config
        text credential_ref "비밀값이 아닌 저장소 참조"
        boolean enabled
    }
    OPS_audit_event {
        bigint event_id PK
        uuid actor_id FK
        uuid project_id FK
        text action
        jsonb details
    }
```

`DATA_*`는 `hmg_analytics`의 `catalog`, `publication`, `analytics` 객체다. `OPS_*`는 `hmg_operations.system` 객체다.
GA4·SEO 상세 ERD는 [기존 ERD](../analytics/ERD.md)를 유지한다. 외부 SELECT는 `published.*` 뷰에만 허용한다.
