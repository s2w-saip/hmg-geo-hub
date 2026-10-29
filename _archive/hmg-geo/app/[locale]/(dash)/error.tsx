"use client";

import { useEffect, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

// (dash) 세그먼트 에러 바운더리 (2026-08-12 피드백 ① 하드닝).
//
// 종전엔 서버 집계가 하드 실패(무거운 필터 조합의 statement timeout 등)하면
// 표면이 없어 화면이 이전 상태로 남았다 — "적용했는데 검색이 안 된다"로 보이는
// 조용한 실패. 이 바운더리가 실패를 명시적으로 보여주고 같은 URL(=같은 필터)로
// 재시도할 수 있게 한다. reset()은 세그먼트 리렌더만 하므로 필터 URL은 보존된다.
export default function DashError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("dashError");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    // 서버 콘솔에는 이미 남는다 — 클라이언트 쪽 추적용(재현 제보 대조).
    console.error("[dash] segment render failed", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{t("description")}</p>
        {error.digest ? (
          <p className="text-xs text-muted-foreground/70">{t("digest", { digest: error.digest })}</p>
        ) : null}
      </div>
      <Button
        type="button"
        onClick={() =>
          startTransition(() => {
            // refresh로 서버 데이터를 다시 받으며 바운더리를 해제한다 — reset()만
            // 하면 캐시된 실패 페이로드로 같은 에러가 재발할 수 있다.
            router.refresh();
            reset();
          })
        }
        disabled={pending}
      >
        <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden />
        {pending ? t("retrying") : t("retry")}
      </Button>
    </div>
  );
}
