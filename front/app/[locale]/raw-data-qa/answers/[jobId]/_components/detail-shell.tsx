"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { createReviewSession, initialReviewState } from "@/lib/qa/review-session";
import { AnswerPane } from "./answer-pane";
import { GranulePanel } from "./granule-panel";
import { NoteDialog } from "./note-dialog";
import { VerdictBar } from "./verdict-bar";
import type {
  NoteTarget,
  QaSectionKey,
  SerializedDetail,
  SerializedNote,
  SerializedReview,
} from "./types";

export function DetailShell({
  detail,
  review,
  initialNotes,
  prevHref,
  nextHref,
  listHref,
}: {
  detail: SerializedDetail;
  review: SerializedReview;
  initialNotes: SerializedNote[];
  prevHref: string | null;
  nextHref: string | null;
  listHref: string;
}) {
  const t = useTranslations("qaReview");
  const router = useRouter();
  const jobId = detail.answer.jobId;

  const initialFlags = useRef(review?.sectionFlags ?? {});
  const [sessionState, setSessionState] = useState(() => initialReviewState(initialFlags.current));
  const sessionRef = useRef<ReturnType<typeof createReviewSession> | null>(null);
  const { flags, lockHolder, saving, savedAt } = sessionState;
  const readOnly = sessionState.lock !== "held";
  const lockLost = sessionState.lock === "lost";
  const [notes, setNotes] = useState(initialNotes);
  const [noteTarget, setNoteTarget] = useState<NoteTarget | null>(null);

  // ── 락 수명 ────────────────────────────────────────────────────────────────
  // 진입 시 획득 → 30초 heartbeat → 이탈 시 해제. sendBeacon 을 함께 쓰는 이유는
  // 언로드 중의 fetch 가 취소되기 때문이다(그러면 락이 TTL 3분 동안 남는다).
  useEffect(() => {
    const session = createReviewSession(jobId, initialFlags.current, setSessionState, () => router.refresh());
    sessionRef.current = session;
    void session.start();

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const payload = JSON.stringify({ jobId });
      const sent = navigator.sendBeacon?.(
        "/api/qa/lock?release=1",
        new Blob([payload], { type: "application/json" }),
      );
      if (!sent) {
        void fetch("/api/qa/lock", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    };

    window.addEventListener("pagehide", release);
    return () => {
      session.dispose();
      sessionRef.current = null;
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [jobId, router]);

  // ── 판정 저장 ──────────────────────────────────────────────────────────────
  const save = useCallback(() => sessionRef.current?.save(), []);

  // ── 키보드 ─────────────────────────────────────────────────────────────────
  // 대량 검수라 손이 마우스를 떠나지 않는 편이 빠르다. 입력 요소에 포커스가 있으면
  // 단축키를 무시한다 — 노트를 쓰다가 'n' 을 치면 다이얼로그가 또 열려선 안 된다.
  const navRef = useRef({ prevHref, nextHref });
  navRef.current = { prevHref, nextHref };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing =
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key === "j" && navRef.current.nextHref) {
        e.preventDefault();
        router.push(navRef.current.nextHref);
      } else if (key === "k" && navRef.current.prevHref) {
        e.preventDefault();
        router.push(navRef.current.prevHref);
      } else if (key === "o") {
        e.preventDefault();
        void save();
      } else if (key === "n" && sessionRef.current?.getState().lock === "held") {
        e.preventDefault();
        setNoteTarget({ kind: "answer", key: null, label: null });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, save]);

  const setFlag = (key: QaSectionKey, value: "ok" | "issue") =>
    // 같은 값을 다시 누르면 미판정으로 되돌린다 — 잘못 누른 것을 취소할 길이 필요하다.
    sessionRef.current?.setFlag(key, value);

  const noteCountFor = (kind: NoteTarget["kind"], key: string | null) =>
    notes.filter((n) => n.targetKind === kind && n.targetKey === key && !n.resolvedAt).length;

  return (
    <>
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <Link
            href={listHref}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {t("detail.backToList")}
          </Link>
        </div>

        {lockLost || sessionState.error ? (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {lockLost
              ? t("lock.lost")
              : sessionState.error === "lock"
                ? t("lock.unavailable")
                : t("detail.saveFailed")}
          </p>
        ) : readOnly && lockHolder ? (
          <p className="rounded-lg bg-accent-gold/10 px-3 py-2 text-sm text-accent-gold">
            {t("lock.readOnly")}
          </p>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2">
          <AnswerPane
            detail={detail}
            flags={flags}
            onFlag={setFlag}
            onNote={() => setNoteTarget({ kind: "answer", key: null, label: null })}
            readOnly={readOnly}
          />
          <GranulePanel
            detail={detail}
            flags={flags}
            onFlag={setFlag}
            onNote={setNoteTarget}
            noteCountFor={noteCountFor}
            readOnly={readOnly}
          />
        </div>
      </main>

      <VerdictBar
        flags={flags}
        onSave={save}
        onNote={() => setNoteTarget({ kind: "answer", key: null, label: null })}
        prevHref={prevHref}
        nextHref={nextHref}
        readOnly={readOnly}
        lockHolder={lockHolder}
        saving={saving}
        savedAt={savedAt}
        reviewedBy={
          review ? { name: review.reviewerName, at: review.reviewedAt?.slice(0, 16) ?? "" } : null
        }
      />

      <NoteDialog
        jobId={jobId}
        readOnly={readOnly}
        target={noteTarget}
        onClose={() => setNoteTarget(null)}
        onCreated={(note) => setNotes((prev) => [...prev, note])}
      />
    </>
  );
}
