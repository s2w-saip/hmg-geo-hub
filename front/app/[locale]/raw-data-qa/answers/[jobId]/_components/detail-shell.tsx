"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
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

const HEARTBEAT_MS = 30_000;

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

  const [flags, setFlags] = useState<Partial<Record<QaSectionKey, "ok" | "issue">>>(
    review?.sectionFlags ?? {},
  );
  const [notes, setNotes] = useState(initialNotes);
  const [noteTarget, setNoteTarget] = useState<NoteTarget | null>(null);
  const [lockHolder, setLockHolder] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [lockLost, setLockLost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // ── 락 수명 ────────────────────────────────────────────────────────────────
  // 진입 시 획득 → 30초 heartbeat → 이탈 시 해제. sendBeacon 을 함께 쓰는 이유는
  // 언로드 중의 fetch 가 취소되기 때문이다(그러면 락이 TTL 3분 동안 남는다).
  useEffect(() => {
    let alive = true;

    fetch("/api/qa/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          heldBy?: { reviewerName: string };
        };
        if (!alive) return;
        if (res.status === 409 && data.heldBy) {
          setReadOnly(true);
          setLockHolder(data.heldBy.reviewerName);
        }
      })
      .catch(() => {});

    const beat = setInterval(() => {
      fetch("/api/qa/lock", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      })
        .then((r) => r.json())
        .then((d: { held?: boolean }) => {
          if (alive && d.held === false) setLockLost(true);
        })
        .catch(() => {});
    }, HEARTBEAT_MS);

    const release = () => {
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
      alive = false;
      clearInterval(beat);
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [jobId]);

  // ── 판정 저장 ──────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (readOnly || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/qa/review", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, sectionFlags: flags }),
      });
      if (res.status === 409) {
        setLockLost(true);
        setReadOnly(true);
        return;
      }
      if (res.ok) {
        setSavedAt(new Date().toISOString());
        // 목록의 진행률·상태가 이 저장을 반영하도록.
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }, [flags, jobId, readOnly, saving, router]);

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
      } else if (key === "n") {
        e.preventDefault();
        setNoteTarget({ kind: "answer", key: null, label: null });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, save]);

  const setFlag = (key: QaSectionKey, value: "ok" | "issue") =>
    // 같은 값을 다시 누르면 미판정으로 되돌린다 — 잘못 누른 것을 취소할 길이 필요하다.
    setFlags((prev) => ({ ...prev, [key]: prev[key] === value ? undefined : value }));

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

        {lockLost ? (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {t("lock.lost")}
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
        target={noteTarget}
        onClose={() => setNoteTarget(null)}
        onCreated={(note) => setNotes((prev) => [...prev, note])}
      />
    </>
  );
}
