import { hasGlobalSurface } from "@/lib/scope/website-virtual-geo";
import type { MenuGroup } from "./types";

const VALID_GROUPS: readonly MenuGroup[] = ["standard", "website", "project", "admin"];

/**
 * 계정의 유효 메뉴 그룹(좁히기 전용). 세션(lib/auth/session)과 로그인 착지
 * (lib/auth/actions)가 **같은 값**을 봐야 한다 — 로그인이 역할만 보고 착지를 정하면
 * 메뉴가 좁혀진 계정이 없는 화면으로 보내졌다가 /no-access 로 튕긴다(2026-09-29
 * 스테이징 실측: 글로벌 탭이 숨겨진 CPO 계정).
 *
 *   - 저장값의 유효 그룹만 통과(오타·레거시 값이 축소를 깨지 않게). 비면 null = 제한 없음.
 *   - 전용 사이트 계정 중 글로벌 시장이 없는 계정(WW 3사·현대 CPO)은 standard 를 뺀다
 *     (제품 책임자 사양표 — 어드민 콘솔은 menu_groups 를 못 바꾸므로 국가 설정에서 파생).
 *     결과가 비면 원래 값을 둔다 — 빈 배열은 route-policy 에서 "제한 없음"이라 넓어진다.
 */
export function effectiveMenuGroups(
  stored: readonly string[] | null | undefined,
  scope: { all: boolean; countries?: string[] },
): MenuGroup[] | null {
  let groups: MenuGroup[] | null = stored?.length
    ? stored.filter((g): g is MenuGroup => (VALID_GROUPS as readonly string[]).includes(g))
    : null;
  if (groups && !groups.length) groups = null;
  if (!hasGlobalSurface(scope)) {
    const narrowed = (groups ?? [...VALID_GROUPS]).filter((g) => g !== "standard");
    if (narrowed.length) groups = narrowed;
  }
  return groups;
}
