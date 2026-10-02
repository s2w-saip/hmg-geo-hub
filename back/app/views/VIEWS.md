# 화면별 색인(프론트 경로 → 기능 모듈)

프론트는 그대로 두고, 각 화면이 부르던 서버 데이터 함수를 아래 기능의 API 호출로 바꾼다.
생성: `docs/design/taxonomy/build_taxonomy.py`(정본 화면표 VIEWS_CANON) → `gen_back_scaffold.py <repo> --sync`
(views.json·VIEWS.md·back/taxonomy.json·FEATURES.md·기능 README 화면 목록을 함께 맞춘다). 손으로 고치지 않는다.
정합 테스트: back/tests/core/test_views_index.py(생성기 재실행 바이트 재현·README 화면 목록·/v1/qa 카탈로그).

- 정본: 프론트 어댑터 설계 front-adapter-plan.md 3.1 점검 결과와 3.3·3.4 매핑표, 부록 A~F 화면별 대조(2026-09-28).
- 키는 데이터 접근이 있는 프론트 page 경로다. 리다이렉트 전용(/standard/answer-analysis·/projects/[id]/analysis 등)·로그인·정적 샘플은 뺐다.
  `/` 는 역할별 랜딩 리다이렉트(로그인 착지 판정 = GET /v1/auth/me).
- 공용 레이아웃 게이트도 그 화면의 기능으로 적는다: 프로젝트 하위 화면 `projects.project.core`, 검수 콘솔 전 화면 `qa.review.sessions`.
- 답변 원문 모달을 여는 화면은 `analytics.answers.detail` 을 갖는다. 드릴다운의 답변 참조는 각 목록 응답의 AnswerRef 로 온다.
- 예전 파일의 `/`·`/standard` 키는 생성기 파싱 산물이었다(screens 문자열을 ( · , { 에서 잘랐음). 파서는 고쳤고 교차 확인용으로만 쓴다.

| 화면 | 기능 |
| --- | --- |
| `/` | `platform.auth.session` |
| `/admin` | `admin.accounts.users` |
| `/admin/ga4` | `admin.integrations.ga4` |
| `/admin/keyword-tools` | `admin.changes.queue`, `admin.integrations.keyword_tools` |
| `/admin/standards/citation-sources` | `admin.citation_sources.overrides` |
| `/admin/standards/customer-interest` | `admin.interest.keywords`, `admin.interest.sources` |
| `/admin/standards/entities` | `admin.entities.registry` |
| `/admin/standards/prompts` | `admin.catalog.bulk`, `admin.catalog.prompts`, `admin.catalog.reference`, `catalog.prompts.history` |
| `/customer-interest/google-keywords` | `intent.keywords.fetches`, `intent.keywords.research` |
| `/dashboard` | `analytics.citations.domains`, `analytics.filters.dates`, `analytics.filters.options`, `analytics.funnel.conversion`, `analytics.geo.markets`, `analytics.kpi.compare`, `analytics.kpi.summary`, `analytics.mentions.brands`, `analytics.trend.series` |
| `/projects` | `projects.members.invites`, `projects.project.core` |
| `/projects/[id]` | `analytics.citations.domains`, `analytics.filters.dates`, `analytics.filters.options`, `analytics.kpi.engines`, `analytics.kpi.summary`, `analytics.mentions.brands`, `analytics.trend.series`, `projects.members.roster`, `projects.project.core`, `projects.prompts.candidates`, `projects.prompts.crud`, `projects.settings.overview` |
| `/projects/[id]/ai-funnel/acr` | `projects.project.core` |
| `/projects/[id]/ai-funnel/conversion` | `admin.integrations.ga4`, `analytics.funnel.conversion`, `projects.project.core` |
| `/projects/[id]/ai-funnel/visibility` | `projects.project.core` |
| `/projects/[id]/analysis/citation` | `analytics.answers.detail`, `analytics.citations.domain_detail`, `analytics.citations.domains`, `analytics.citations.prompts`, `analytics.citations.sources`, `analytics.filters.dates`, `analytics.filters.options`, `analytics.trend.series`, `projects.project.core` |
| `/projects/[id]/analysis/mention` | `analytics.answers.detail`, `analytics.citations.domain_detail`, `analytics.citations.domains`, `analytics.filters.dates`, `analytics.filters.options`, `analytics.kpi.engines`, `analytics.kpi.summary`, `analytics.mentions.brands`, `analytics.mentions.prompts`, `analytics.mentions.types`, `analytics.trend.series`, `projects.project.core`, `projects.settings.overview` |
| `/projects/[id]/intent/google-keyword` | `intent.candidates.submit`, `intent.keywords.fetches`, `intent.keywords.research`, `intent.keywords.serp_drafts`, `intent.keywords.tracked`, `projects.project.core` |
| `/projects/[id]/intent/social-scraping` | `intent.candidates.submit`, `intent.social.context_map`, `intent.social.prompts`, `projects.project.core`, `projects.prompts.candidates` |
| `/projects/[id]/member` | `projects.members.audit`, `projects.members.roster`, `projects.project.core` |
| `/projects/[id]/prompt` | `projects.project.core`, `projects.prompts.candidates`, `projects.prompts.crud`, `projects.prompts.execute`, `projects.prompts.fields`, `projects.prompts.io`, `projects.prompts.lifecycle` |
| `/projects/[id]/setting` | `projects.project.core`, `projects.settings.engines`, `projects.settings.overview`, `projects.settings.owned_bases`, `projects.settings.scope_link`, `projects.settings.tracked_targets`, `projects.settings.tracked_urls` |
| `/projects/by-scope/[scopeId]` | `projects.project.core` |
| `/projects/new` | `projects.project.core` |
| `/raw-data-qa` | `qa.review.sessions` |
| `/raw-data-qa/answers` | `qa.answers.list`, `qa.review.deltas`, `qa.review.sessions` |
| `/raw-data-qa/answers/[jobId]` | `qa.answers.detail`, `qa.answers.list`, `qa.notes.notes`, `qa.review.lock`, `qa.review.sessions`, `qa.review.verdict` |
| `/raw-data-qa/notes` | `qa.notes.notes`, `qa.review.sessions` |
| `/standard/ai-funnel/acr` | `analytics.filters.dates`, `analytics.filters.options`, `analytics.funnel.acr` |
| `/standard/ai-funnel/conversion` | `analytics.filters.options`, `analytics.funnel.conversion` |
| `/standard/ai-funnel/visibility` | `analytics.filters.options` |
| `/standard/answer-analysis/citation` | `analytics.answers.detail`, `analytics.citations.domain_detail`, `analytics.citations.domains`, `analytics.citations.prompts`, `analytics.citations.sources`, `analytics.filters.dates`, `analytics.filters.options`, `analytics.kpi.compare`, `analytics.kpi.summary`, `analytics.trend.series` |
| `/standard/answer-analysis/citation/prompts` | `analytics.answers.detail`, `analytics.citations.prompts` |
| `/standard/answer-analysis/citation/tone-urls` | `analytics.citations.sources`, `analytics.citations.tone` |
| `/standard/answer-analysis/mention` | `analytics.answers.detail`, `analytics.citations.domain_detail`, `analytics.citations.domains`, `analytics.filters.dates`, `analytics.filters.options`, `analytics.kpi.compare`, `analytics.kpi.engines`, `analytics.kpi.summary`, `analytics.mentions.brands`, `analytics.mentions.prompts`, `analytics.mentions.types`, `analytics.trend.series` |
| `/standard/prompts` | `analytics.filters.dates`, `catalog.prompts.catalog`, `catalog.prompts.history` |
| `/website` | `analytics.citations.domains`, `analytics.filters.dates`, `analytics.filters.options`, `analytics.geo.markets`, `analytics.kpi.compare`, `analytics.kpi.engines`, `analytics.kpi.summary`, `analytics.mentions.brands`, `analytics.trend.series` |
| `/website/ai-funnel/acr` | `analytics.filters.dates`, `analytics.filters.options`, `analytics.funnel.acr` |
| `/website/ai-funnel/conversion` | `admin.integrations.ga4`, `analytics.filters.options`, `analytics.funnel.conversion` |
| `/website/answer-analysis/citation` | `analytics.answers.detail`, `analytics.citations.domain_detail`, `analytics.citations.domains`, `analytics.citations.prompts`, `analytics.citations.sources`, `analytics.citations.targets`, `analytics.filters.dates`, `analytics.filters.options`, `analytics.trend.series` |
| `/website/answer-analysis/mention` | `analytics.answers.detail`, `analytics.citations.domain_detail`, `analytics.citations.domains`, `analytics.filters.dates`, `analytics.filters.options`, `analytics.kpi.engines`, `analytics.kpi.summary`, `analytics.mentions.brands`, `analytics.mentions.prompts`, `analytics.mentions.types`, `analytics.trend.series` |
| `/website/prompts` | `analytics.filters.dates`, `analytics.filters.options`, `catalog.prompts.catalog` |

## 현행 화면 소비자가 없는 기능

운영·워커 전용이거나(새 운영 화면은 범위 밖, 결정 D11) 다른 기능 응답으로 대체된 것.

- `analytics.answers.list`
- `admin.cycles.cycles`
- `admin.cycles.jobs`
