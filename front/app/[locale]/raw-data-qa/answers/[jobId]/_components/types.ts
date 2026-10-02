import type {
  QaSectionKey,
  QaSerializedDetail,
  QaSerializedNote,
  QaSerializedReview,
} from "@/lib/qa/types";
import type { QaTargetKind } from "@/lib/qa/filters";

// 서버 → 클라이언트 경계를 넘는 형태. Date 를 전부 ISO 문자열로 굳힌다 —
// 넘어가며 문자열이 되는 것을 컴포넌트가 뒤늦게 발견하는 대신 여기서 못박는다.
// 정의는 lib/qa/types.ts 에 있다(현행 리포지토리·API 어댑터 두 원천이 같은 형태를 만든다).

export type SerializedDetail = QaSerializedDetail;

export type SerializedNote = QaSerializedNote;

export type SerializedReview = QaSerializedReview;

// 노트를 열 때 어떤 낱알을 지목했는지. targetLabel 은 스냅샷으로 서버에 굳혀진다 —
// 미러 재싱크로 citation id 가 바뀌어도 무엇을 가리켰는지 남기기 위해서다.
export type NoteTarget = {
  kind: QaTargetKind;
  key: string | null;
  label: string | null;
};

export type { QaSectionKey };
