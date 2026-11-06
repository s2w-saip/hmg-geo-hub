// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type CitationOverrideMap } from "./index";
/** 이 로더 전용 캐시 태그 — 저장·삭제 액션이 revalidateTag 대상으로 쓴다. */
export declare const CITATION_OVERRIDES_TAG = "citation-overrides";
/**
 * 분류기에 주입할 오버라이드 맵. **실패해도 throw 하지 않는다** — 테이블 미적용
 * (마이그레이션 0043 전)·DB 오류에서 빈 맵으로 접히면 분류가 오버라이드 도입 이전과
 * 100% 동일하게 동작한다. 인용 화면 전체가 오버라이드 테이블 하나에 인질로 잡히면
 * 안 된다(GA4 규율과 다른 판단: 여기서 실패는 기능 부재이지 데이터 오류가 아니다).
 */
export declare function loadCitationOverrides(): Promise<CitationOverrideMap>;
