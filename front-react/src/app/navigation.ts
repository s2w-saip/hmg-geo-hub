import { useMemo, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useParams, type Params } from "react-router-dom";
import { refreshPageData } from "~/api/query-client";

export { useParams };
export type ReadonlyURLSearchParams = URLSearchParams;
const UI_URL_EVENT = "hgh-ui-url";
function subscribeUrl(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(UI_URL_EVENT, listener);
  return () => { window.removeEventListener("popstate", listener); window.removeEventListener(UI_URL_EVENT, listener); };
}
/** A local tab/search change: preserve React Router's history index and avoid refetching the page. */
export function replaceUiHistory(state: unknown, unused: string, url?: string | URL | null) {
  window.history.replaceState(state ?? window.history.state, unused, url);
  window.dispatchEvent(new Event(UI_URL_EVENT));
}
export function usePathname(): string { return useLocation().pathname; }
export function useSearchParams(): URLSearchParams {
  useLocation(); // React Router navigations also update this subscription's consumers.
  const search = useSyncExternalStore(subscribeUrl, () => window.location.search, () => "");
  return useMemo(() => new URLSearchParams(search), [search]);
}
export function useRouter() {
  const navigate = useNavigate();
  return useMemo(() => ({
    push: (href: string, _options?: { scroll?: boolean }) => navigate(href),
    replace: (href: string, _options?: { scroll?: boolean }) => navigate(href, { replace: true }),
    refresh: () => { void refreshPageData(); },
    back: () => navigate(-1),
    forward: () => navigate(1),
    prefetch: (_href: string) => {},
  }), [navigate]);
}
export class PageNavigation extends Error {
  constructor(public readonly href: string, public readonly status = 302) { super(href); }
}
export function redirect(href: string): never { throw new PageNavigation(href); }
export function notFound(): never { throw new PageNavigation("/404", 404); }
