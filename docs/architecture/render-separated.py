"""Generate the code-native SVG architecture diagram (no secrets or runtime data)."""
from pathlib import Path
from html import escape

HERE = Path(__file__).resolve().parent
parts = ['''<svg xmlns="http://www.w3.org/2000/svg" width="1740" height="1000" viewBox="0 0 1740 1000" role="img" aria-labelledby="title desc">
<title id="title">HMG GEO HUB — 운영 DB와 데이터 DB 분리</title>
<desc id="desc">Next.js 화면, FastAPI BFF, 독립 HUB 운영 DB와 데이터 DB, 읽기 전용 외부 Gold DB. 외부 소비자는 승인된 데이터 뷰만 읽도록 준비되어 있으며 아직 연결되지 않았다.</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#63758b"/></marker></defs>
<style>text{font-family:'Malgun Gothic','Segoe UI',sans-serif;fill:#1d3046}.label{font-size:16px;fill:#52657b}.code{font-family:Consolas,monospace;font-size:16px;fill:#52657b}.edge{fill:none;stroke:#63758b;stroke-width:2.4;marker-end:url(#arrow)}.dash{stroke-dasharray:7 6}</style>
<rect width="1740" height="1000" fill="#f5f7fb"/>
<rect x="240" y="150" width="1050" height="630" rx="24" fill="#edf2f9" stroke="#c4d0df"/>
''']


def text(x, y, value, size=19, weight=400, cls=None):
    parts.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}"' +
                 (f' class="{cls}"' if cls else '') + f'>{escape(value)}</text>')


def box(x,y,w,h,title,lines,color='#ffffff',stroke='#9cb0ca'):
    parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="{color}" stroke="{stroke}" stroke-width="1.5"/>')
    text(x+24,y+38,title,24,700)
    for i,line in enumerate(lines):
        text(x+24,y+74+30*i,line,17)


def edge(path, dashed=False):
    parts.append(f'<path d="{path}" class="edge{" dash" if dashed else ""}"/>')


text(40,65,'HMG GEO HUB',34,800)
text(40,105,'서비스 아키텍처 · 운영 DB / 데이터 DB 분리 적용',21)
text(1510,65,'2026.10.27',18,cls='label')
text(268,187,'HUB 서버',23,700)
text(885,187,'로컬 조회 모드 · DB 자격증명은 FastAPI에만 전달',16,cls='label')
box(40,240,160,140,'브라우저',['대시보드 UI','GeoJSON 지도'])
box(280,220,320,170,'Next.js  :3200',['화면 렌더링 · 상호작용','FastAPI API 호출','DB 직접 연결 없음'])
box(710,220,520,170,'FastAPI  :18091',['BFF: 화면 데이터 조합 · 계산','조회 API · 원천별 DB 연결','각 DB에 독립된 읽기 전용 계정'])
box(1340,220,350,200,'외부 Gold DB',['GEO · 응답 · 언급 · 인용 · ACR','원천 프롬프트 · 키워드 · 소셜','gold / 10.0.20.126:8097','읽기 전용 원천'], '#edf7f3','#7eb39e')
box(280,520,350,210,'HUB 운영 DB',['hmg_operations  :55437','사용자 · 프로젝트 멤버십 · 권한','SW 설정 버전 · 연동 설정','감사 이력 · 프로젝트 UUID 참조'], '#f5effc','#b19bce')
box(760,520,470,210,'HUB 데이터 DB',['hmg_analytics  :55436','GA4 · SEO · 발행 빌드','프로젝트 · 프롬프트 정의와 버전','catalog / analytics / published'], '#eaf3ff','#7da9d7')
box(1340,530,350,200,'외부 소비자 연결 준비',['published.* 뷰만 SELECT','프로젝트·데이터 종류별 명시 승인','운영 DB · 내부 기본 테이블 차단','외부 연결은 아직 미개방'], '#ffffff','#9cb0ca')
edge('M200 305H274')
edge('M600 305H704')
text(623,286,'API 호출',15,cls='label')
edge('M1230 305H1334')
text(1248,286,'SELECT',15,cls='label')
edge('M860 390V445H455V514')
text(480,432,'운영 DB 조회',16,cls='label')
edge('M1070 390V514')
text(1084,465,'데이터 DB 조회',16,cls='label')
edge('M1340 640H1236',True)
text(1244,619,'승인 뷰',15,cls='label')
text(268,761,'각 DB는 별도 PostgreSQL 컨테이너 · 볼륨 · 계정 · Docker 네트워크로 격리',17,cls='label')
parts.append('<rect x="40" y="820" width="1650" height="138" rx="16" fill="#fff" stroke="#d5dfeb"/>')
text(66,854,'정의 동기화',20,700)
text(230,854,'관리 명령이 Gold 정의를 데이터 DB에 버전 기록 → 존재를 확인한 UUID만 운영 DB에 등록',18)
text(66,889,'데이터 상태',20,700)
text(230,889,'실제 원천 정의만 기록 · GA4 / SEO 수집기는 아직 미연결 · 미관측 지표는 “데이터 없음”',18)
text(66,926,'접근 경계',20,700)
text(230,926,'DB 포트는 127.0.0.1에만 바인딩 · 실선: 현재 조회 경로 · 점선: 외부 연결 준비',18)
parts.append('</svg>')
(HERE/'hmg-geo-hub-current.svg').write_text('\n'.join(parts),encoding='utf8')
(HERE/'hmg-geo-hub-current.mmd').write_text((HERE/'hmg-geo-hub-separated.mmd').read_text(encoding='utf8'),encoding='utf8')
print('Updated current SVG and Mermaid architecture')
