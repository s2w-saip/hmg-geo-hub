"use client";

import { useTranslations } from "next-intl";
import { SectionVerdict } from "./section-verdict";
import {
  AcrTable,
  CitationTable,
  MentionTable,
  MetaTable,
  PromptTable,
} from "./granule-tables";
import type { NoteTarget, QaSectionKey, SerializedDetail } from "./types";

// 우측 패널 — §7 의 낱알 블록을 순서대로 편다.
// 블록 ↔ section_flags 키는 1:1이다: prompt / mentions / citations / acr / meta.
// (answer 키는 좌측 원문 블록이 갖는다.)
export function GranulePanel({
  detail,
  flags,
  onFlag,
  onNote,
  noteCountFor,
  readOnly,
}: {
  detail: SerializedDetail;
  flags: Partial<Record<QaSectionKey, "ok" | "issue">>;
  onFlag: (key: QaSectionKey, value: "ok" | "issue") => void;
  onNote: (target: NoteTarget) => void;
  noteCountFor: (kind: NoteTarget["kind"], key: string | null) => number;
  readOnly: boolean;
}) {
  const t = useTranslations("qaReview.sections");
  const noteProps = { onNote, noteCountFor, readOnly };

  return (
    <section className="flex flex-col gap-3">
      <Block
        title={t("prompt")}
        sectionKey="prompt"
        flags={flags}
        onFlag={onFlag}
        onNote={() => onNote({ kind: "prompt", key: null, label: null })}
        readOnly={readOnly}
      >
        <PromptTable detail={detail} />
      </Block>

      <Block
        title={`${t("mentions")} (${detail.mentions.length})`}
        sectionKey="mentions"
        flags={flags}
        onFlag={onFlag}
        onNote={() => onNote({ kind: "mention", key: null, label: null })}
        readOnly={readOnly}
      >
        <MentionTable mentions={detail.mentions} {...noteProps} />
      </Block>

      <Block
        title={`${t("citations")} (${detail.citations.length})`}
        sectionKey="citations"
        flags={flags}
        onFlag={onFlag}
        onNote={() => onNote({ kind: "citation", key: null, label: null })}
        readOnly={readOnly}
      >
        <CitationTable citations={detail.citations} {...noteProps} />
      </Block>

      {/* 매칭되는 롤업이 없으면 블록 자체를 그리지 않는다 — 판정할 것이 없는 블록에
          'OK' 를 누르게 하면 판정의 의미가 흐려진다. */}
      {detail.acr.length > 0 ? (
        <Block
          title={`${t("acr")} (${detail.acr.length})`}
          sectionKey="acr"
          flags={flags}
          onFlag={onFlag}
          onNote={() => onNote({ kind: "acr", key: null, label: null })}
          readOnly={readOnly}
        >
          <AcrTable acr={detail.acr} {...noteProps} />
        </Block>
      ) : null}

      <Block
        title={t("meta")}
        sectionKey="meta"
        flags={flags}
        onFlag={onFlag}
        onNote={() => onNote({ kind: "meta", key: null, label: null })}
        readOnly={readOnly}
      >
        <MetaTable detail={detail} />
      </Block>
    </section>
  );
}

function Block({
  title,
  sectionKey,
  flags,
  onFlag,
  onNote,
  readOnly,
  children,
}: {
  title: string;
  sectionKey: QaSectionKey;
  flags: Partial<Record<QaSectionKey, "ok" | "issue">>;
  onFlag: (key: QaSectionKey, value: "ok" | "issue") => void;
  onNote: () => void;
  readOnly: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open className="rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between border-b border-border px-4 py-2">
        <h2 className="font-head text-sm font-semibold text-foreground">{title}</h2>
        {/* 토글이 <summary> 안에 있으므로 클릭이 접기로 새지 않게 막는다. */}
        <span onClick={(e) => e.preventDefault()}>
          <SectionVerdict
            value={flags[sectionKey]}
            onChange={(v) => onFlag(sectionKey, v)}
            onNote={onNote}
            disabled={readOnly}
          />
        </span>
      </summary>
      {children}
    </details>
  );
}
