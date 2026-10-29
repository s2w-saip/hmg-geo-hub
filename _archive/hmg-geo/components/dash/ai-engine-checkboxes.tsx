"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AI_ENGINES, type AiEngineId } from "@/lib/scope/engines";
import { cn } from "@/lib/utils";

// 프로젝트 AI 엔진 선택 체크박스 — 생성 폼과 설정 > General 이 같은 컴포넌트를
// 쓴다(어휘·표기 한 곳). 값은 scope target 토큰, 라벨은 카탈로그 상수
// (lib/scope/engines.ts) — 고유명사라 i18n 대상이 아니다. 모델 부표기 없음.
export function AiEngineCheckboxes({
  idPrefix,
  value,
  onChange,
  disabled,
  className,
}: {
  idPrefix: string;
  value: readonly AiEngineId[];
  onChange: (next: AiEngineId[]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const selected = new Set(value);
  function toggle(id: AiEngineId, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    // 카탈로그 순서로 고정 — 이력·비교가 순서에 흔들리지 않게.
    onChange(AI_ENGINES.map((e) => e.id).filter((e) => next.has(e)));
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-x-6 gap-y-3", className)}>
      {AI_ENGINES.map((e) => {
        const id = `${idPrefix}-${e.id}`;
        return (
          <div key={e.id} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={selected.has(e.id)}
              onCheckedChange={(c) => toggle(e.id, c === true)}
              disabled={disabled}
            />
            <Label
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-baseline gap-1.5 font-normal",
                disabled && "cursor-not-allowed opacity-70",
              )}
            >
              <span className="text-sm text-foreground">{e.label}</span>
            </Label>
          </div>
        );
      })}
    </div>
  );
}
