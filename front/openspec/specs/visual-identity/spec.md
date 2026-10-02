# visual-identity Specification

## Purpose
TBD - created by archiving change apply-hyundai-bi. Update Purpose after archive.
## Requirements
### Requirement: 디자인 토큰 단일 진실의 원천

시스템은 색·타이포·반경·그림자·모션의 시각 토큰을 한 곳(`app/globals.css`의 `@theme` 블록)에서 정의하고 모든 UI가 그 토큰을 참조해야 한다(SHALL). HMG 정체성 토큰(`--color-brand-*`, `--color-ink-*`, `--color-bg-*`, `--color-accent-*`, `--color-danger`, `--font-head`, `--font-text`, `--radius-*`)과 컴포넌트 라이브러리가 요구하는 시멘틱 토큰(`--color-primary`, `--color-background`, `--color-muted`, `--color-border` 등) 모두 이 단일 블록 안에서 정의되며, 시멘틱 토큰은 정체성 토큰을 가리키는 alias로 도출된다. 토큰 값 교체만으로 전 UI의 시각 톤이 일관되게 변경되며, 컴포넌트 코드는 토큰 외 하드코딩된 색·폰트 값을 직접 가지지 않는다.

#### Scenario: 색 토큰 값 교체가 전 UI에 반영됨

- **WHEN** 디자인 토큰의 브랜드 색 값(예: `--color-brand-700`)을 변경하면
- **THEN** 해당 토큰을 직접 참조하는 화면(헤더, 액티브 메뉴, 워드마크 색)뿐 아니라 시멘틱 alias(`--color-primary`)를 거쳐 참조하는 컴포넌트(버튼 default, 포커스 링 등)까지 전 UI의 색이 컴포넌트 코드 변경 없이 갱신된다

#### Scenario: 컴포넌트에 색 hex가 하드코딩되지 않음

- **WHEN** UI 컴포넌트 코드에서 hex 색 리터럴(`#xxxxxx`)을 검색하면
- **THEN** 토큰 정의 파일(`app/globals.css`) 외에는 hex 리터럴이 발견되지 않는다(예외는 SVG 자산 내부)

### Requirement: 한국어가 깨지지 않는 폰트 스택과 fallback
시스템은 1순위 Hyundai Sans, 2순위 Pretendard, 그 다음 Noto Sans KR과 시스템 폰트로 구성된 fallback 스택을 사용해야 한다(SHALL).
1순위 폰트 자산이 부재한 환경에서도 한국어 화면이 정상 렌더되어야 하며, 자형 미응답으로
빈 글자(`tofu`)나 잘린 글자가 보이지 않아야 한다.

#### Scenario: 1순위 폰트 자산 없이도 한국어가 렌더됨
- **WHEN** 개발 환경에 Hyundai Sans woff2 파일이 부재한 상태로 페이지를 열면
- **THEN** Pretendard 또는 Noto Sans KR로 한국어 텍스트가 정상 렌더된다

#### Scenario: 헤드라인과 본문 폰트가 분리됨
- **WHEN** 헤드라인 요소와 본문 요소가 같은 페이지에 함께 렌더되면
- **THEN** 헤드라인은 head 폰트 스택, 본문은 text 폰트 스택을 사용한다

### Requirement: 폰트 자산의 라이선스 위생
시스템은 사수가 제공한 코퍼릿 폰트 파일을 공개 코드 저장소에 커밋해서는 안 된다(MUST NOT).
폰트 파일은 `.gitignore`로 제외되며, 디렉터리 구조와 자리표시 마커(`.gitkeep` 등)만
저장소에 포함된다. 오픈 라이선스 폰트(Pretendard 등)는 자유롭게 커밋하거나 npm 패키지로 가져올 수 있다.

#### Scenario: 코퍼릿 폰트 파일이 저장소에 없음
- **WHEN** 저장소에서 `HyundaiSans*` 파일을 검색하면
- **THEN** 어떤 매치도 발견되지 않는다(추적 대상에서 제외됨)

#### Scenario: 폰트 디렉터리 자체는 보존됨
- **WHEN** 신규 클론한 저장소에서 `public/fonts/` 디렉터리를 확인하면
- **THEN** 디렉터리는 존재하고 `.gitkeep` 같은 마커가 있어 추후 자산 배치가 가능하다

### Requirement: 로고/워드마크 자리표시 정책
시스템은 사수가 실제 로고 자산을 제공하기 전까지 자체 SVG 워드마크 stub을 사용해야 한다(SHALL).
워드마크 stub은 실제 로고가 들어갈 자리, 크기, 색 정책을 결정하므로 실제 로고 도착 시 파일
교체만으로 정합되어야 한다.

#### Scenario: 워드마크 자리표시가 헤더에 표시됨
- **WHEN** 인증 뒤 헤더가 렌더되면
- **THEN** 좌측에 워드마크 SVG가 표시되고 토큰 색(브랜드 또는 잉크)을 따른다

#### Scenario: 자산 교체가 단일 파일 교체로 끝남
- **WHEN** 사수가 제공한 로고를 `public/brand/wordmark-{ko,en}.svg` 경로에 배치하면
- **THEN** 추가 코드 변경 없이 헤더의 워드마크가 새 자산으로 표시된다

### Requirement: 시멘틱 시각 토큰을 HMG 토큰에서 도출

시스템은 컴포넌트 라이브러리가 요구하는 시멘틱 시각 토큰(`--color-primary`, `--color-primary-foreground`, `--color-background`, `--color-foreground`, `--color-muted`, `--color-muted-foreground`, `--color-accent`, `--color-accent-foreground`, `--color-border`, `--color-input`, `--color-ring`, `--color-destructive`, `--color-card`, `--color-card-foreground`, `--color-popover`, `--color-popover-foreground`)을 HMG 정체성 토큰(`--color-brand-*`, `--color-ink-*`, `--color-bg-*`, `--color-accent-*`, `--color-danger`)을 가리키는 alias로 정의해야 한다(SHALL). 두 종류의 토큰은 동일한 `@theme` 블록 안에서 정의되어 단일 진실 원천 원칙이 유지된다.

#### Scenario: 시멘틱 변수가 HMG 토큰을 참조

- **WHEN** `app/globals.css`의 `@theme` 블록을 확인하면
- **THEN** `--color-primary: var(--color-brand-700);` 형태로 시멘틱 변수가 HMG 토큰을 참조하는 라인이 존재한다

#### Scenario: 시멘틱 변수와 HMG 토큰이 동일 파일에서 정의

- **WHEN** 시멘틱 변수와 HMG 정체성 변수의 정의 위치를 확인하면
- **THEN** 둘 다 `app/globals.css`의 같은 `@theme` 블록 안에서 정의되어 있다

### Requirement: 그림자/모션 토큰

시스템은 색·타이포·반경에 더해 그림자 단계(`shadow-soft`, `shadow-soft-lg`, `shadow-soft-xl`)와 모션 기본값(트랜지션 duration 150~250ms, ease-out)에 해당하는 토큰을 정의해야 한다(SHALL). 컴포넌트는 직접 `box-shadow` CSS 리터럴이나 `transition-duration` 임의 값 대신 이 토큰을 통해 그림자/모션을 적용한다.

#### Scenario: shadow-soft 단계가 정의됨

- **WHEN** `app/globals.css`를 검색하면
- **THEN** `.shadow-soft`, `.shadow-soft-lg`, `.shadow-soft-xl` 유틸 클래스가 정의돼 있다

#### Scenario: 카드/버튼 hover 트랜지션이 표준 duration을 사용

- **WHEN** 카드와 버튼 컴포넌트의 트랜지션 클래스를 확인하면
- **THEN** Tailwind 기본 duration 클래스(`duration-200` 등) 또는 정의된 모션 토큰만 사용되고, 임의 인라인 값은 없다

### Requirement: 다크모드 변수 페어 정의

시스템은 모든 시멘틱 시각 토큰에 대해 `:root`(라이트)와 `.dark`(다크) 두 벌의 값 페어를 `app/globals.css`에 정의해야 한다(SHALL). 단, 라이트/다크를 전환하는 트리거(테마 토글 라이브러리, UI 컨트롤)는 본 변경의 범위가 아니며 도입하지 않는다(MUST NOT). 변수 페어는 향후 토글이 추가되었을 때 즉시 작동하도록 준비된 상태여야 한다.

#### Scenario: 다크 변수 블록이 존재

- **WHEN** `app/globals.css`를 검색하면
- **THEN** `.dark` 셀렉터 또는 `[data-theme="dark"]` 셀렉터 아래에 시멘틱 변수의 다크 값이 모두 정의돼 있다

#### Scenario: 다크 토글 트리거 코드가 없음

- **WHEN** 저장소에서 `next-themes` 패키지, `ThemeProvider`, 테마 토글 UI 컴포넌트를 검색하면
- **THEN** 어떤 import도 발견되지 않고 토글 UI도 렌더되지 않는다

#### Scenario: 임시로 .dark 클래스 부여 시 다크 색상 적용

- **WHEN** 개발자가 `html` 또는 `body` 요소에 `.dark` 클래스를 임시로 부여하면
- **THEN** 시멘틱 변수가 다크 값으로 전환되고 페이지가 다크 톤으로 렌더된다

