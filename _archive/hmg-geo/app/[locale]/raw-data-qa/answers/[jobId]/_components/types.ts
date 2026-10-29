import type {
  QaAcrGranule,
  QaAnswerDetail,
  QaCitationGranule,
  QaMentionGranule,
  QaSectionKey,
} from "@/lib/db/repositories/qa-review";
import type { QaSeverity, QaSurface, QaTargetKind } from "@/lib/qa/filters";

// 서버 → 클라이언트 경계를 넘는 형태. Date 를 전부 ISO 문자열로 굳힌다 —
// 넘어가며 문자열이 되는 것을 컴포넌트가 뒤늦게 발견하는 대신 여기서 못박는다.

export type SerializedDetail = {
  answer: Omit<QaAnswerDetail["answer"], "measuredAt"> & {
    measuredAt: string | null;
    surface: QaSurface;
  };
  prompt: QaAnswerDetail["prompt"];
  mentions: QaMentionGranule[];
  citations: QaCitationGranule[];
  acr: QaAcrGranule[];
  derived: {
    anchor: { anchor: string; sourceMeasuredAt: string | null; reason: string | null } | null;
    drop: { sourceMeasuredAt: string | null; reason: string; droppedAt: string | null } | null;
  };
};

export type SerializedNote = {
  id: string;
  targetKind: QaTargetKind;
  targetKey: string | null;
  targetLabel: string | null;
  severity: QaSeverity;
  body: string;
  reviewerName: string;
  createdAt: string | null;
  resolvedAt: string | null;
};

export type SerializedReview = {
  status: "ok" | "issue";
  sectionFlags: Partial<Record<QaSectionKey, "ok" | "issue">>;
  reviewerName: string;
  reviewedAt: string | null;
} | null;

// 노트를 열 때 어떤 낱알을 지목했는지. targetLabel 은 스냅샷으로 서버에 굳혀진다 —
// 미러 재싱크로 citation id 가 바뀌어도 무엇을 가리켰는지 남기기 위해서다.
export type NoteTarget = {
  kind: QaTargetKind;
  key: string | null;
  label: string | null;
};

export type { QaSectionKey };
