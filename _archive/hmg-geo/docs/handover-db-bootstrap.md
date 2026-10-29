# 격리 개발용 Supabase 초기화

**기존 운영 DB에는 사용하지 않습니다.** 데이터와 Auth 사용자가 없는 별도 Supabase 프로젝트에서만 사용합니다.
`.env.local`의 DB URL·Auth URL·공개 키·service key를 모두 새 개발 프로젝트의 값으로 맞춥니다.
DB 연결은 postgres 역할의 direct 또는 session pooler를 사용합니다.

```sh
npm run setup:doctor
npm run db:bootstrap -- --dry-run
npm run db:bootstrap -- --preflight
```

위 결과의 대상이 새 빈 프로젝트인지 확인한 후 실행합니다.

```sh
npm run db:bootstrap -- --yes --confirm=<project-ref>
npm run db:verify
npm run setup:doctor -- --connect
```

`<project-ref>`는 새 Supabase URL의 프로젝트 식별자입니다. 로컬 Supabase는 `--confirm=local`을 사용합니다.
새 개발 관리자용 `SETUP_ADMIN_EMAIL`, `SETUP_ADMIN_PASSWORD`를 설정한 뒤 `npm run setup:admin`으로 계획을 확인하고 `npm run setup:admin -- --yes`로 생성합니다.
초기화 기준선은 `scripts/db/bootstrap-schema.json`과 bootstrap 구현에 있습니다. 새 DB에는 운영 측정·프로젝트 데이터가 포함되지 않습니다.
