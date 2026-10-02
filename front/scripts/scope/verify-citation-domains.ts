/**
 * `scope_citations.domain` 절단 감시 — 저장값이 정본 정규화와 어긋난 행을 센다.
 *
 * 배경(2026-08-24 RCA): domain 은 미러 싱크가 **저장 시점에** 확정하고 읽기 경로에
 * 재계산이 없다. 그래서 정규화가 회귀하면 화면이 아니라 **데이터가** 영구히 상한다.
 * 실제로 하드코딩 접미사 사본이 71,825행(3.04%)을 public suffix 로 접었고,
 * 실호스트 3,122종이 접미사 207종으로 붕괴했다.
 *
 * ⚠️ 술어는 **`recompute(url) != domain` 하나뿐이다.**
 * RCA 초판이 제안했던 "접미사 정규식에 매치되면 절단"은 **틀렸다** — 백필 후 실측에서
 * 그 정규식에 걸리는 1,317행이 남았는데 전부 정당했다:
 *   ⓐ 진짜 등록가능 도메인 576행 — `go.com`(abcnews.go.com) · `ac.fi` · `web.de` ·
 *      `net.hr` · `ind.br`. PSL 상 이것들은 public suffix 가 아니다.
 *   ⓑ host 자체가 public suffix 라 eTLD+1 이 없는 741행 — `gov.uk`(164) ·
 *      `gov.br`(329) · `gov.kr`(294) · `gov.hk`(105) · `gov.si`(60) …
 *      (`https://www.gov.uk/…` 같은 인용). 이 경우 저장값은 host 자신이 정답이다.
 * 화이트리스트로 예외를 관리하는 방식은 같은 실패를 반복한다.
 *
 * 목적지 — 이 검사가 울리면 사람이 **코드를 고쳐야** 해소되므로 GitHub Issue다
 * (라이브 장애가 아니다). 헬스 워크플로가 생기면 이 스크립트를 그 잡에 건다.
 *
 *   npm run verify:citation-domains
 *   (= tsx --env-file=.env.local scripts/scope/verify-citation-domains.ts)
 *
 * exit 0 = PASS · exit 1 = 드리프트 발견(또는 실행 실패). 읽기 전용 — UPDATE 없음.
 */
import postgres from "postgres";
import { registrableDomainOfHost } from "../../lib/public-suffix";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("✗ DATABASE_URL not set in .env.local");
  process.exit(1);
}
const conn = postgres(DATABASE_URL, { prepare: false });

const BATCH = 50_000;
/** 보고에 싣는 예시 개수 — 전량을 쏟지 않는다. */
const SAMPLE = 25;

/**
 * lib/scope/mirror/sync.ts::hostFromUrl 의 사본. 저장 경로와 **같은 순서**여야
 * 한다(선행 www. 제거 → 소문자). 어긋나면 이 검사가 스스로 오탐을 만든다.
 */
function hostFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const [{ total }] = await conn<{ total: string }[]>`
    SELECT count(*)::text AS total FROM scope_citations
  `;
  console.log(`scope_citations 총 ${Number(total).toLocaleString()}행 — 전수 대조`);

  let scanned = 0;
  let drift = 0;
  let unparsable = 0;
  const samples: string[] = [];
  let lastId: string | null = null;

  for (;;) {
    const rows: { id: string; url: string | null; domain: string | null }[] = lastId
      ? await conn`
          SELECT id::text AS id, url, domain FROM scope_citations
          WHERE id::text > ${lastId} ORDER BY id::text LIMIT ${BATCH}
        `
      : await conn`
          SELECT id::text AS id, url, domain FROM scope_citations
          ORDER BY id::text LIMIT ${BATCH}
        `;
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]!.id;

    for (const r of rows) {
      scanned += 1;
      const host = hostFromUrl(r.url);
      if (host === null) {
        // url 이 없거나 파싱 불가 — 저장 경로도 domain 을 null 로 둔다.
        if (r.domain !== null) {
          drift += 1;
          if (samples.length < SAMPLE) {
            samples.push(`id=${r.id} url=${r.url} domain=${r.domain} expected=null`);
          }
        } else {
          unparsable += 1;
        }
        continue;
      }
      const expected = registrableDomainOfHost(host);
      if (r.domain !== expected) {
        drift += 1;
        if (samples.length < SAMPLE) {
          samples.push(`id=${r.id} url=${r.url} domain=${r.domain} expected=${expected}`);
        }
      }
    }
    process.stdout.write(`\r  대조 ${scanned.toLocaleString()} …`);
  }
  process.stdout.write("\n");

  console.log(`  url 없음/파싱불가(정상) : ${unparsable.toLocaleString()}`);
  console.log(`  드리프트                : ${drift.toLocaleString()}`);
  if (drift > 0) {
    console.log("  예시:");
    for (const s of samples) console.log(`    · ${s}`);
    console.error(
      `\n✗ FAIL — ${drift.toLocaleString()}행의 domain 이 정본 정규화와 다르다.` +
        "\n  원인 후보: (a) 정규화 구현이 회귀했다 (b) 배포 이전에 싱크된 행이 남아 있다." +
        "\n  (b)라면 백필 재실행으로 해소된다 — PR #(citation-psl-and-seed) 본문 참조.",
    );
    await conn.end();
    process.exit(1);
  }
  console.log("\n✓ PASS — 저장된 domain 이 전부 lib/public-suffix 산출과 일치한다.");
  await conn.end();
}

main().catch(async (e) => {
  console.error(e);
  await conn.end();
  process.exit(1);
});
