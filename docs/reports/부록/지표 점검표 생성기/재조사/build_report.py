"""Build one PC-only topic report from its evidence record. No app or DB calls.

Usage: python build_report.py [T001] [output.html]
Default output is the workspace root; an explicit output keeps links relative
to that file so repository snapshots can live in docs/reports as well.
"""
import hashlib
import html
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
REPO = next(p for p in HERE.parents if (p / 'back/app/core/measure.py').exists())
WORKSPACE = REPO.parent
topic = sys.argv[1] if len(sys.argv) > 1 else 'T001'
folder = HERE / topic
d = json.loads((folder / 'audit.json').read_text(encoding='utf-8'))
target = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else WORKSPACE / d['report_file']
esc = html.escape
symbols = {'x': '', 'u': '☐ 미확인', 'n': '☒ 미충족', 'y': '☑ 확인 범위 충족'}
hashes = {}


def link(path, label):
    rel = os.path.relpath(path, target.parent).replace(os.sep, '/')
    return f'<a href="{esc(quote(rel, safe="/"))}">{esc(label)}</a>'


def evidence(text):
    m = re.match(r'^(before|after): (.+?):([0-9,]+)$', text)
    if m:
        side, file, lines = m.groups()
        root = WORKSPACE / 'hmg-geo-hub-share' if side == 'before' else REPO
        path = root / file
        assert path.exists(), path
        hashes[f'{side}:{file}'] = hashlib.sha256(path.read_bytes()).hexdigest()
        if side == 'before' and target.is_relative_to(REPO):
            # The baseline lives in the upstream repository, outside this checkout.
            url = (f'https://github.com/Kongventures/hmg-geo-hub-share/blob/{d["before_commit"]}/'
                   f'{quote(file, safe="/")}#L{lines.split(",")[0]}')
            return f'<a href="{esc(url)}">{esc(f"{side} · {file}:{lines}")}</a>'
        return link(path, f'{side} · {file}:{lines}')
    local = folder / text
    if local.is_file():
        return link(local, text)
    return esc(text)


rows, details = [], []
mandatory_section = ''
for code, f in d['factors'].items():
    sources = ''.join(f'<li>{evidence(e)}</li>' for e in f['evidence'])
    if code == 'F5':
        if f['after']['status'] == 'n':
            outcome = '전환 차단 · 수정 필수'
        elif f['after']['status'] == 'y' and f.get('verification_complete') is True:
            outcome = '명시한 전체 범위의 동일성 검증 완료'
        else:
            outcome = '동일성 검증 미완료 · 전환 완료 처리 불가'
        mandatory_section = (
            f'<section id="F5"><h2>필수 전제 · 지표 계산 방식과 표시 규칙 동일성 (구 F5)</h2>'
            f'<div class="finding"><strong>{esc(outcome)}</strong></div><p>{esc(f["finding"])}</p>'
            '<p>소스코드 최적화는 계산 방식이나 표시 규칙을 바꿀 수 없습니다. 차이를 수용할지 선택하는 절차는 없습니다. '
            '미검증·일부 시험 통과를 전체 동일성 통과로 취급하지 않으며, 개선 점수에도 합산하지 않습니다.</p>'
            f'<p><b>Before:</b> {esc(f["before"]["note"])}</p><p><b>After:</b> {esc(f["after"]["note"])}</p>'
            f'<ul class="sources">{sources}</ul></section>')
        continue
    cells = []
    for side in ('before', 'after'):
        s = f[side]
        cells.append(f'<td class="{s["status"]}" title="{esc(s["note"])}">{symbols[s["status"]]}</td>')
    rows.append(f'<tr><th><a href="#{code}">{code} {esc(f["name"])}</a></th>{"".join(cells)}<td>{esc(f["finding"])}</td></tr>')
    details.append(f'<section id="{code}"><h2>{code} {esc(f["name"])}</h2><p>{esc(f["finding"])}</p>'
                   f'<p><b>Before:</b> {esc(f["before"]["note"])}</p><p><b>After:</b> {esc(f["after"]["note"])}</p>'
                   f'<ul class="sources">{sources}</ul></section>')

test_rows = ''.join(f'<tr><th>{esc(t["name"])}</th><td>{esc(t["result"])}</td><td><code>{esc(t["command"])}</code></td></tr>' for t in d['tests'])
pending = ''.join(f'<li>{esc(p)}</li>' for p in d['pending'])
checklist = link(target.parent / '★ 리뉴얼·최적화 지표 점검표.html', '화면별 점검표로 돌아가기')
environment_rows = ''.join(
    f'<tr><th>{esc(side.title())}</th><td><a href="{esc(env["url"])}">{esc(env["url"])}</a>'
    f'<br><code>{esc(env["source_folder"])}</code></td><td>{esc(env["observed"])}</td></tr>'
    for side, env in d.get('environments', {}).items()
)
browser_section = ''
if environment_rows:
    observed = ''.join(f'<li>{esc(item)}</li>' for item in d.get('browser_observations', []))
    sources = ''.join(f'<li>{evidence(item)}</li>' for item in d.get('browser_evidence', []))
    browser_section = (
        '<section><h2>지정한 실제 사이트·소스 확인</h2>'
        '<table><colgroup><col style="width:8%"><col style="width:30%"><col style="width:62%"></colgroup>'
        '<thead><tr><th>구분</th><th>비교 기준</th><th>직접 확인한 상태</th></tr></thead>'
        f'<tbody>{environment_rows}</tbody></table><ul>{observed}</ul>'
        f'<p>화면·요청·실행 파일 근거:</p><ul class="sources">{sources}</ul></section>'
    )
comparison_section = ''
if d.get('paired_live'):
    pair = json.loads((folder / d['paired_live']['file']).read_text(encoding='utf-8'))
    pair_rows = []
    country = d['paired_live']['country']
    for metric in pair['before']['metrics']:
        values = []
        for side in ('before', 'after'):
            row = next(r for r in pair[side]['metrics'][metric]['rows'] if r['kind'] == 'country' and r['cells'][0] == country)
            rival = row['cells'][2].replace('\n', ' ')
            values.append(f'<td>{esc(row["cells"][1])}<small>최대 경쟁사: {esc(rival)}</small></td>')
        pair_rows.append(f'<tr><th>{esc(metric)}</th>{"".join(values)}</tr>')
    condition_rows = ''.join(
        '<tr>' + ''.join(f'<td>{esc(r[k])}</td>' for k in ('item', 'before', 'after', 'meaning')) + '</tr>'
        for r in d['comparison']['rows']
    )
    photos = []
    for side in ('before', 'after'):
        photo = folder / d['paired_live'][side + '_image']
        photo_url = quote(os.path.relpath(photo, target.parent).replace(os.sep, '/'), safe='/')
        photos.append(f'<figure><figcaption>{side.title()} · 국가별 GEO 현황</figcaption>'
                      f'<a href="{esc(photo_url)}"><img class="evidence-photo" src="{esc(photo_url)}" alt="{side.title()} Hyundai 미국 GEO 실제 화면"></a></figure>')
    comparison_section = (
        '<section id="paired-comparison"><h2>Before / After 실제 화면 관측값 · 참고</h2>'
        f'<p><b>양쪽 적용 조건:</b> {esc(d["paired_live"]["filters_label"])}</p>'
        '<p>Before는 사용자 제공 시스템 관리자, After는 프로젝트에 저장된 ADMIN으로 로그인했습니다. '
        '운영 데이터 차이는 허용된 비교 조건입니다. 아래 숫자와 행 수는 화면 동작의 참고 기록이며 그 차이로 합격 여부를 판정하지 않습니다. '
        '계산·필터·표시 규칙은 지정 폴더의 코드와 같은 작은 입력의 실행 결과로 검증합니다.</p>'
        '<table><thead><tr><th>지표 · 미국</th><th>Before · hmg-geo.vercel.app</th><th>After · 127.0.0.1:3130</th></tr></thead>'
        f'<tbody>{"".join(pair_rows)}</tbody></table>'
        '<p>양쪽 모두 북아메리카 권역 행은 미국 행과 같은 값을 표시했습니다. '
        'AI 인용 점유율의 최대 경쟁사 표시는 양쪽 모두 “—”입니다.</p>'
        f'<div class="paired-photos">{"".join(photos)}</div>'
        '<h2 style="margin-top:24px">실제 비교 조건과 해석 범위</h2>'
        '<table><thead><tr><th>항목</th><th>Before</th><th>After</th><th>해석</th></tr></thead>'
        f'<tbody>{condition_rows}</tbody></table>'
        '<p><b>환경별 참고 — After DB·캐시:</b> 실행 중인 API의 연결 DB를 읽기 전용으로 조회한 결과 '
        '<code>rd.answer</code> 전체는 19행이었습니다. 결과 캐시는 꺼져 있고 <code>legacy_profile=off</code>입니다. '
        '데이터 규모 차이는 조사 중단 사유가 아닙니다. 캐시 설정은 로컬 실행 환경의 관측이며 Before 운영 설정을 뜻하지 않습니다.</p>'
        f'<p>{link(folder / d["paired_live"]["file"], "양쪽 필터·5개 지표·경쟁사 관측 원문")} · '
        f'{link(folder / d["paired_live"]["runtime_file"], "After 읽기 전용 DB·캐시 확인 결과")}</p></section>'
    )
live_section = ''
if d.get('before_live'):
    live = json.loads((folder / d['before_live']['file']).read_text(encoding='utf-8'))
    metrics = list(live['metrics'])
    samples = d['before_live']['sample_countries']
    indexed = {
        metric: {(row['kind'], row['cells'][0]): row for row in data['rows']}
        for metric, data in live['metrics'].items()
    }
    keys = list(indexed[metrics[0]])
    assert all(list(indexed[m]) == keys for m in metrics), 'Actual UI row sets differ between metrics'
    sample_rows = ''.join(
        '<tr><th>' + esc(metric) + '</th>' + ''.join(
            f'<td>{esc(indexed[metric][("country", country)]["cells"][1])}</td>' for country in samples
        ) + '</tr>' for metric in metrics
    )
    full_rows = []
    for key in keys:
        cells = []
        for metric in metrics:
            row = indexed[metric][key]['cells']
            rival = f'<small>경쟁사 {esc(row[2]).replace(chr(10), " ")}</small>' if row[2] != '—' else ''
            cells.append(f'<td>{esc(row[1])}{rival}</td>')
        kind = '권역' if key[0] == 'region' else '국가'
        full_rows.append(f'<tr><th>{esc(key[1])}<small>{kind}</small></th>{"".join(cells)}</tr>')
    photo = folder / d['before_live']['image_file']
    photo_rel = quote(os.path.relpath(photo, target.parent).replace(os.sep, '/'), safe='/')
    live_section = (
        '<section><h2>Before 실제 화면 표시값</h2>'
        '<p><b>조건:</b> Kia · 국가·언어·AI 엔진 전체 · 기간 미선택 · 표시 측정 회차 2026-10-12. '
        '6개 권역·47개 국가, 5개 지표를 확인했습니다. 아래는 앞서 확인한 Kia 기록입니다. '
        'After에서 Kia는 데이터 없음으로 표시되어, 위 실제 비교는 양쪽에 값이 있는 Hyundai·미국 조건을 사용했습니다.</p>'
        '<table><thead><tr><th>지표</th>' + ''.join(f'<th>{esc(c)} · Kia</th>' for c in samples) + '</tr></thead>'
        f'<tbody>{sample_rows}</tbody></table>'
        '<p>상단 국가 필터를 독일로 좁힌 뒤에도 독일 행의 5개 지표와 경쟁사 표시는 모두 일치했습니다.</p>'
        '<details><summary>6개 권역·47개 국가의 실제 표시값 전체 보기</summary>'
        '<table class="observed"><thead><tr><th>권역/국가</th>' + ''.join(f'<th>{esc(m)}</th>' for m in metrics) + '</tr></thead>'
        f'<tbody>{"".join(full_rows)}</tbody></table></details>'
        '<h2 style="margin-top:28px">GEO 내부 국가 선택과 상단 국가 필터의 차이</h2>'
        '<p>GEO 내부에서 독일만 선택하면 권역 행·지도 툴팁은 Europe(W) 전체 값 <b>66.7%</b>를 유지하고, '
        '독일 행은 <b>64.8%</b>를 표시합니다. 상단 디멘션의 국가를 독일로 적용하면 권역 값도 <b>64.8%</b>로 바뀝니다. '
        '따라서 지도색과 툴팁을 개별 국가의 측정값으로 해석하면 안 됩니다.</p>'
        f'<a href="{esc(photo_rel)}"><img class="evidence-photo" src="{esc(photo_rel)}" alt="Before 실제 화면: 독일 1개 선택, Europe(W) 툴팁 66.7%, 독일 표 64.8%"></a>'
        f'<p>{link(folder / d["before_live"]["file"], "전체 관측 원문·조건·브라우저 정보")} · '
        f'{link(folder / d["before_live"]["global_filter_image"], "상단 국가 필터를 독일로 적용한 화면")}</p>'
        '<p class="meta">화면 표시를 직접 관측한 결과입니다. DB 원본의 정확성, 배포 코드와 share 커밋의 일치, '
        '현재 renewal과의 전후 일치를 증명한 결과는 아닙니다.</p></section>'
    )
body = f'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>{esc(d['id'])} · {esc(d['label'])} 재조사</title>
<style>
*{{box-sizing:border-box}}body{{margin:0;background:#f3f6fa;color:#172b3b;font:15px/1.75 "Malgun Gothic",Arial,sans-serif;min-width:1280px}}
main{{max-width:1720px;min-width:1200px;margin:32px auto;padding:0 36px 60px}}header,section{{background:#fff;border:1px solid #d5dfe7;border-radius:10px;padding:24px 30px;margin-bottom:20px}}
h1{{font-size:27px;line-height:1.45;margin:8px 0 12px}}h2{{font-size:20px;margin:0 0 14px}}p{{margin:9px 0}}.meta{{color:#51687a}}.finding{{border-left:5px solid #b44c36;background:#fff5ef;padding:15px 20px;margin:18px 0}}
table{{border-collapse:collapse;width:100%;table-layout:fixed}}th,td{{border:1px solid #ccd8e2;padding:13px 15px;text-align:left;vertical-align:top}}thead th{{background:#e9f0f5}}th{{font-weight:600}}
.x{{background:#fafbfd}}.u{{background:#fff8e5;color:#775400}}.n{{background:#fff0ec;color:#9b3325}}.y{{background:#ecf7ef;color:#24623a}}
a{{color:#12608c;text-decoration:underline;text-underline-offset:3px}}code{{font:12px/1.6 Consolas,monospace;overflow-wrap:anywhere;white-space:pre-wrap}}.sources{{font-size:12px;overflow-wrap:anywhere}}li{{margin:7px 0}}.tests td{{font-size:13px}}
small{{display:block;font-size:11px;font-weight:400;color:#51687a}}summary{{cursor:pointer;font-weight:600;margin:20px 0 12px}}.observed{{font-size:13px}}.evidence-photo{{display:block;max-width:100%;height:auto;border:1px solid #d5dfe7;margin-top:16px}}
.paired-photos{{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px}}figure{{margin:0;min-width:0}}figcaption{{font-weight:600}}
@media print{{body,main{{min-width:0}}main{{margin:0;padding:0}}section{{break-inside:avoid}}}}
</style></head><body><main>
<header><p class="meta">{esc(d['id'])} · {esc(d['date'])} · PC 기준 · {checklist}</p>
<h1>{esc(d['menu'])} · {esc(d['label'])}</h1><p><code>{esc(d['route'])}</code></p>
<p><b>{esc(d.get('verification_status_label', '코드·시험 조사'))}</b></p>
<p>{esc(d['scope'])}</p><div class="finding"><b>{esc(d['conclusion'])}</b></div>
<p class="meta">Before <code>{d['before_commit']}</code> · After 조사 시작 <code>{d['after_commit_at_start']}</code>. 실제 읽은 파일 지문은 {link(folder / 'source_manifest.json', '근거 파일 지문')}에 기록했습니다.</p>
<p>{esc(d['limits'])}</p><p><b>진행 방식:</b> {esc(d['workflow'])}</p></header>
<section><h2>로직과 성능의 검증 기준</h2><p>운영 데이터가 달라도 조사를 진행합니다. 계산식·분모·필터·표시 단위는 소스 및 동일한 작은 입력의 시험으로 확인하고, SQL 경로·재집계·중복 조회·미사용 계산·불필요한 전송을 추적해 구조상 개선을 판단합니다.</p><p>데이터가 다른 사이트의 표시값·행 수·전체 응답 크기 차이는 그 자체로 실패나 개선의 근거가 아닙니다. 응답 시간은 각 환경의 참고값이며, 통제되지 않은 측정값으로 속도 개선율을 계산하지 않습니다.</p></section>
{mandatory_section}
{comparison_section}
{browser_section}
{live_section}
<section><h2>점검 항목 조사 결과와 남은 확인</h2><p>구 F5는 위 필수 동일성 검증으로 분리했으며, 근거 연결을 위해 다른 항목의 번호는 유지합니다. 운영 데이터 일치를 요구하지 않습니다. 두 사이트의 화면 동작, After DB·설정, 지정 폴더의 소스 분석과 합성 시험을 항목별로 구분했습니다. 빈칸은 해당 없음, ☐는 근거 부족, ☒는 잔여 문제 확인입니다. ☑는 명시한 확인 범위의 충족이며 모든 경로의 검증을 뜻하지 않습니다.</p>
<table><colgroup><col style="width:22%"><col style="width:10%"><col style="width:12%"><col style="width:56%"></colgroup><thead><tr><th>점검 기준</th><th>Before</th><th>After</th><th>이번에 확인한 내용</th></tr></thead><tbody>{''.join(rows)}</tbody></table></section>
<section><h2>AI 우선 노출도: 전환을 차단하는 계산 방식 불일치 결함</h2><p><b>합성 답변 1개:</b> Toyota의 본문 위치 3, Kia의 본문 위치 7. Kia 관점의 독일(DE) 행을 비교했습니다. Before의 계산 방식과 표시 규칙으로 수정한 뒤 동일성을 재검증해야 합니다.</p>
<table><thead><tr><th>기존 GEO</th><th>리뉴얼 GEO</th><th>해석</th></tr></thead><tbody><tr><td>7.0번째</td><td>2.0번째</td><td>기존은 본문 위치, 리뉴얼은 경쟁 브랜드 사이의 순위입니다. 운영값이 아니라 실제 코드로 재현한 합성 반례입니다.</td></tr></tbody></table>
<p>{link(folder / 'position_counterexample.json', '입력·결과·실행 범위')} · {link(folder / 'frontend_probe.ts', '재현 스크립트')}</p></section>
{''.join(details)}
<section><h2>실행한 검증</h2><table class="tests"><colgroup><col style="width:20%"><col style="width:40%"><col style="width:40%"></colgroup><thead><tr><th>검증</th><th>결과·범위</th><th>실행 방법</th></tr></thead><tbody>{test_rows}</tbody></table>
<p>기존 SQL 생성 시 DB 컬럼 가용성 조회를 하지 않아 comp_rank_sum 폴백 경고가 발생했습니다. SQL 점수는 이 명시된 생성 조건의 결과입니다. 실제 운영 SQL·실행 계획으로 취급하지 않습니다.</p></section>
<section><h2>남은 검증·수정</h2><ul>{pending}</ul><p><b>현재 진행 상태:</b> {esc(d['workflow'])}</p><p>{esc(d.get('revision_note', ''))}</p></section>
</main></body></html>'''
(folder / 'source_manifest.json').write_text(json.dumps({'before_commit': d['before_commit'], 'after_commit_at_start': d['after_commit_at_start'], 'sha256': hashes}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
target.write_text(body, encoding='utf-8', newline='\n')
print(target)
