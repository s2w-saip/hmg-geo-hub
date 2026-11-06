# 용어 변경 초안: 서버 이름 (2026-11-06)

SSOT `shared/glossary.md`에 넣을 내용이다. SSOT 문서의 BFF(`.md` 24곳, `.html` 15곳)를 '데이터 서버'로 바꾸고, 아래 두 행을 더한다. 검토가 끝나면 SSOT로 옮기고 이 파일을 지운다.

| 용어 | 뜻 | 이전 이름 |
|---|---|---|
| 허브 서버 | 서비스의 입구. 로그인 · 계정 확인을 하고 화면 · 지표 요청을 데이터 서버로 넘긴다. 계정과 입력 편집을 맡는다 | |
| 데이터 서버 | 화면 조립, 지표 정의 · 계산, 사전 집계 · 캐시 DB 읽기를 맡는 내부 서버 | BFF |

- '허브 서버'는 이 프로세스만 가리킨다. 서비스 전체는 '서비스'라고 부른다.
- 화면의 지표 요청은 허브 서버를 지나 데이터 서버로 간다.
- 허브 서버 분리는 서비스 저장소의 할 일 T13이다. 분리 전까지는 한 프로세스가 두 역할을 함께 맡는다.

# 삭제 초안: 지표 API (2026-11-06)

지표 API를 두지 않는다. 지표는 데이터 서버를 거쳐 화면으로만 나간다. 줄 번호와 문구는 BFF 이름을 바꾸기 전 SSOT 기준이다.

| 파일 | 줄 | 고칠 내용 |
|---|---|---|
| `README.md` | 13, 24 | '지표 API' 삭제 |
| `shared/glossary.md` | 12 | '화면을 내는 단계. 서비스' |
| `shared/glossary.md` | 27 | 행 삭제 |
| `shared/project-architecture.md` | 19 | '화면' |
| `shared/project-architecture.md` | 32 | '7. BFF 지표 계산 → 화면 조립 → 웹 화면 `[서비스]`' |
| `shared/project-architecture.md` | 83 | '2. **지표는 BFF를 거쳐 화면으로만 나간다.** 지표 API는 두지 않는다.' |
| `shared/project-architecture.html` | 198 | 그림의 지표 API 상자와 연결선 삭제 |
| `shared/project-architecture.html` | 284, 334 | `.md`와 같게 |
| `service/README.md` | 14 | '화면 조립' |
