"use client";

import { useTranslations } from "next-intl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GEO_BRANDS } from "@/lib/geo-catalog";

// HMG canonical brand catalog select (W7 — free-text 오타 방지).
//
// 사용처: 표준 프롬프트/키워드/소스 + 프로젝트 setting의 brand 필드.
// 미사용: tracked_competitors/vehicles — 경쟁사·외부 브랜드 입력 가능해야 하므로 text 유지.
//
// value 표현:
//   - allowAll=true (기본): "all" sentinel = 전역 (DB null로 저장)
//   - allowAll=false: brand 필수, "all" 선택 불가
//
// onChange는 항상 string을 받음 — 호출처에서 "all" → null 변환 (필요 시).

export type BrandSelectProps = {
  id?: string;
  value: string; // "all" 또는 BRANDS 중 하나, 또는 ""(미선택)
  onChange: (value: string) => void;
  allowAll?: boolean;
  disabled?: boolean;
  /** Trigger 사이즈 — 다른 인접 컨트롤과 정렬 시 사용 */
  size?: "sm" | "default";
  /** Trigger에 적용할 클래스 */
  className?: string;
};

export function BrandSelect({
  id,
  value,
  onChange,
  allowAll = true,
  disabled,
  size = "sm",
  className,
}: BrandSelectProps) {
  const t = useTranslations("brandSelect");
  return (
    <Select value={value || (allowAll ? "all" : "")} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} size={size} className={className}>
        <SelectValue placeholder={t(allowAll ? "all" : "placeholder")} />
      </SelectTrigger>
      <SelectContent>
        {allowAll ? <SelectItem value="all">{t("all")}</SelectItem> : null}
        {GEO_BRANDS.map((b) => (
          <SelectItem key={b} value={b}>
            {b}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Helper — "all" sentinel → null 변환 (DB 저장용) */
export function brandSelectValueToDb(value: string): string | null {
  if (!value || value === "all") return null;
  return value;
}
