// Type-only snapshot; no database or server implementation is included.
export type StanceEvidenceMatch =
/** 미러 원문과 대조해 일치했다. 화면이 원문 위치를 주장해도 되는 유일한 상태. */
"verified"
/** 대조했는데 원문에 없다(또는 오프셋이 원문과 안 맞는다) — 코어 인용의 문제. */
 | "mismatch"
/** 대조 자체를 못 했다 — 그 턴의 원문이 미러에 없거나 인용문이 비어 있다. */
 | "unavailable";
export interface StanceEvidenceInput {
    turnIndex: number;
    evidenceText: string | null;
    /** 코드포인트 오프셋. 코어가 1회 매치일 때만 쌍으로 채운다(FR4). */
    evidenceStart: number | null;
    evidenceEnd: number | null;
}
export declare function verifyStanceEvidence(answerText: string | null | undefined, s: StanceEvidenceInput): StanceEvidenceMatch;
