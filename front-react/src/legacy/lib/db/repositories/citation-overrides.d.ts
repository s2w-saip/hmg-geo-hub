// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type CitationCategory, type CitationOverrideMap } from "@/lib/citation-categorizer";
import { type CitationDomainCurationRow } from "@/lib/citation-categorizer/curation";
export interface CitationOverrideRow {
    domain: string;
    category: CitationCategory;
    note: string | null;
    updatedBy: string | null;
    updatedAt: string;
}
export type { CitationDomainCurationRow } from "@/lib/citation-categorizer/curation";
export declare const citationOverrideRepository: {
    /** 전체 오버라이드 행 (최근 수정 순). 관리 화면·감사용. */
    list(): Promise<CitationOverrideRow[]>;
    /**
     * 분류기 주입용 맵 (정규화 도메인 → 카테고리). 읽기 경로가 유일하게 쓰는 형태.
     * loadCitationOverrides() 가 이 위에 캐시를 씌운다.
     */
    loadMap(): Promise<CitationOverrideMap>;
    /**
     * 도메인 하나의 분류를 저장(있으면 교체). 도메인은 정규화되고, 택소노미 밖
     * 카테고리는 거부한다(호출부가 잘못된 값을 넣는 것을 여기서 끊는다).
     */
    upsert(input: {
        domain: string;
        category: string;
        note?: string | null;
        updatedBy?: string | null;
    }): Promise<CitationOverrideRow>;
    /** 오버라이드 삭제 = 기본 분류로 원복. 없는 행이면 false. */
    remove(domain: string): Promise<boolean>;
    /**
     * 큐레이션 목록 — 미러(scope_citations) 인용 가중치 상위 도메인 + 현재 분류 +
     * 분류 출처. 쿼리와 행 조립은 lib/citation-categorizer/curation.ts 가 정본이라
     * 관리 화면과 scripts/citations/seed-curation.ts 가 같은 모수·같은 판정을 본다.
     */
    listDomainCuration(limit?: number): Promise<CitationDomainCurationRow[]>;
};
