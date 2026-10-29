import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// 대시보드 내비게이션 링크는 프리페치를 끈다 — 회귀 가드.
//
// 2026-08-27 프로덕션 실측: next/link 기본 auto 프리페치로 사이드바가 보이는
// 순간 (dash) leaf 라우트 7개가 같은 초에 요청됐고(Vercel 로그), 그 렌더들이
// Suspense 안에서 미러 집계 트랜잭션을 연 채 셸만 응답했다. 이후 Vercel 이
// 인스턴스를 정지시키면 그 트랜잭션이 문장 사이에서 얼어 scope_* 테이블에
// AccessShareLock 을 215~1,430초 쥔다 — 마이그레이션 0046 의 ALTER TABLE 이
// 55P03(lock timeout)으로 거부된 직접 원인이다.
//
// 이 파일들에 <Link 를 새로 추가할 때 prefetch={false} 를 빠뜨리면 그 경로가
// 되살아나므로, 파일 안의 모든 <Link 가 가드를 갖는지 기계로 고정한다.

const FILES = ["components/dash/sidebar.tsx", "components/dash/gnb-rail.tsx"];

describe("대시보드 내비 링크 prefetch 가드", () => {
  for (const file of FILES) {
    it(`${file} 의 모든 <Link 는 prefetch={false} 를 갖는다`, () => {
      const src = readFileSync(file, "utf-8");
      const opens = [...src.matchAll(/<Link\b/g)];
      expect(opens.length).toBeGreaterThan(0);
      for (const m of opens) {
        // 이 <Link 태그의 끝(첫 '>')까지가 속성 구간이다.
        const attrs = src.slice(m.index!, src.indexOf(">", m.index!));
        expect(attrs, `${file} @${m.index} 의 <Link 에 prefetch={false} 없음`).toContain(
          "prefetch={false}",
        );
      }
    });
  }
});
