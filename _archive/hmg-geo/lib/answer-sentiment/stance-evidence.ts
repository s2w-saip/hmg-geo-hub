// 답변 단위 브랜드 스탠스의 **근거 인용 대조** (0072 · 검증자 F5).
//
// 코어가 `evidence_start/end` 를 주는 것과, 그 인용이 **미러가 가진 원문에 실제로
// 있는 것**은 다른 명제다. 화면이 "원문에서 확인된 인용"이라고 말하려면 뒤엣것이어야
// 한다 — 앞엣것만 보면 코어 오프셋이 틀렸을 때 사용자가 답변에서 찾을 수 없는 문장을
// "원문"으로 읽는다. 파일럿 실측: 모델이 낸 인용의 완전일치 **79.2%** · 불일치 **8.6%**.
//
// ⚠️ 미러는 **1턴 원문만** 갖는다(`scope_answers.answer_text` 는 답변 1건 = 1턴).
// 그래서 `turn_index > 0` 은 "틀렸다"가 아니라 **대조할 원문이 없다**. 두 상태를 한
// 문구로 뭉치면 "코어가 환각했다"와 "우리가 확인할 수 없다"가 구분되지 않는다.
//
// 오프셋은 **코드포인트** 기준이다(scope#632 · 0061 과 같은 규약). UTF-16 인덱스로
// 자르면 이모지·서러게이트가 있는 구간에서 슬라이스가 밀린다.

export type StanceEvidenceMatch =
  /** 미러 원문과 대조해 일치했다. 화면이 원문 위치를 주장해도 되는 유일한 상태. */
  | "verified"
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

export function verifyStanceEvidence(
  answerText: string | null | undefined,
  s: StanceEvidenceInput,
): StanceEvidenceMatch {
  if (!s.evidenceText) return "unavailable";
  // 미러에 그 턴의 원문이 없다 → 영원히 "미확인". 2턴 답변(ACR 후속)이 라이브의 8.2%.
  if (s.turnIndex !== 0) return "unavailable";
  if (!answerText) return "unavailable";

  const cp = Array.from(answerText);
  const { evidenceStart: st, evidenceEnd: en } = s;
  if (st != null && en != null) {
    // 음수·역순·범위 밖은 **확인됨이 아니다.** 원문은 우리 손에 있으므로 "대조 불가"가
    // 아니라 "대조 실패"로 본다 — 코어가 깨진 오프셋을 보내고 있다는 신호라서, 미확인에
    // 섞으면 turn>0(구조적 한계)과 구분이 안 된다.
    // `Number.isInteger` 를 먼저 본다 — NaN 은 **모든 비교가 false** 라 범위 가드를
    // 그냥 지나가고, 소수는 `slice` 가 조용히 버림해 엉뚱한 구간과 비교된다. 지금은
    // 미러 컬럼이 integer 라 도달하지 않지만, 이 함수의 계약은 입력을 믿지 않는 것이다.
    if (!Number.isInteger(st) || !Number.isInteger(en)) return "mismatch";
    if (st < 0 || en <= st || en > cp.length) return "mismatch";
    return cp.slice(st, en).join("") === s.evidenceText ? "verified" : "mismatch";
  }
  // 오프셋이 없어도(코어가 2회 매치·0회 매치로 NULL 을 준 경우) 원문에 그대로 있으면
  // 확인으로 친다 — 판정 기준은 "미러 원문 대조"이지 "오프셋 존재"가 아니다.
  return answerText.includes(s.evidenceText) ? "verified" : "mismatch";
}
