import { useState, type ReactNode } from "react";
import { NavLink, Link, useLocation, useParams } from "react-router-dom";
import { useLocale } from "use-intl";
import { ArrowLeft, BarChart3, BriefcaseBusiness, ChevronDown, Globe2, KeyRound, LogOut, Settings2, Users, Plug } from "lucide-react";
import { CONNECTED } from "~/api/client";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { PAGES, type PageDefinition } from "./pages";
import { useLogout, useSession } from "./session";
import { useSearchParams } from "./navigation";

export function Shell({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const en = locale === "en";
  const { id } = useParams();
  const { pathname } = useLocation();
  const uiQuery = useSearchParams().toString();
  const search = uiQuery ? `?${uiQuery}` : "";
  const { user } = useSession();
  const logout = useLogout();
  const [error, setError] = useState<string | null>(null);
  const language = en ? "ko" : "en";
  const groups = id ? ["Project"] as const : ["Global", "Website", "Project", "Admin"] as const;
  const visible = (p: PageDefinition) => (!id ? !p.path.includes(":id") : p.path.includes(":id")) && (!CONNECTED || (user && canAccessRoute(user.role, `/renewal/${p.path.replace(":id", id ?? "")}`)));
  return <div className="rn-spa-shell">
    <aside className="rn-spa-sidebar" aria-label={en ? "Main navigation" : "주 메뉴"}>
      <Link className="rn-spa-brand" to={`/${locale}/renewal/dashboard`}><span className="rn-spa-brandmark">G</span><span><strong>HMG GEO</strong><small>Generative Engine Optimization</small></span></Link>
      {id && <div className="mx-2 mb-4 rounded-xl border border-rn-line bg-white px-3 py-3"><span className="text-rn-11 font-semibold text-rn-muted">PROJECT</span><div className="mt-1 truncate font-mono text-rn-12">{CONNECTED ? id : (en ? "Page preview" : "프로젝트 화면 미리보기")}</div></div>}
      <nav className="flex-1" aria-label={en ? "Pages" : "화면"}>
        {groups.map(group => {
          const pages = PAGES.filter(p => p.group === group && visible(p) && !["citation-prompts", "citation-tone"].includes(p.kind) && !p.path.endsWith("/visibility"));
          if (!pages.length) return null;
          return <section key={group} className="rn-nav-section"><h2>{group}</h2>{pages.map(p => <NavLink key={p.path} to={`/${locale}/renewal/${p.path.replace(":id", id ?? "")}`} end className={({ isActive }) => `rn-nav-item${isActive ? " active" : ""}`}>
            {p.kind === "overview" ? <BarChart3 size={15} /> : p.kind === "projects" ? <BriefcaseBusiness size={15} /> : p.kind === "accounts" ? <Users size={15} /> : p.kind === "waiting" ? <KeyRound size={15} /> : <span className="rn-nav-tree" aria-hidden />}
            <span>{p.title[en ? 1 : 0]}</span>
          </NavLink>)}</section>;
        })}
        {!CONNECTED && !id && <Link to={`/${locale}/renewal/projects/preview`} className="rn-preview-project">{en ? "Preview project pages" : "프로젝트 상세 화면 미리보기"}</Link>}
      </nav>
      <div className="rn-sidebar-footer">
        {id && <Link to={`/${locale}/renewal/projects`} className="rn-footer-link"><ArrowLeft size={14} />{en ? "Project list" : "프로젝트 목록"}</Link>}
        <div className="rn-connection-indicator"><span className={CONNECTED ? "is-connected" : ""} /><span>{CONNECTED ? (en ? "HUB connection mode" : "HUB 연결 모드") : (en ? "Pages prepared · unconnected" : "화면 준비 · 서버 연결 전")}</span></div>
        <Link className="rn-footer-link" to={pathname.replace(/^\/(ko|en)(?=\/)/, `/${language}`) + search}><Globe2 size={14} />{en ? "한국어" : "English"}</Link>
        {user ? <><div className="px-2 text-rn-12 text-rn-muted truncate">{user.displayName ?? user.email ?? user.login}</div><Link className="rn-footer-link" to={`/${locale}/change-password`}><Settings2 size={14} />{en ? "Change password" : "비밀번호 변경"}</Link><button className="rn-footer-link" onClick={async () => { setError(null); try { await logout(); } catch { setError(en ? "Sign-out failed. Please retry." : "로그아웃하지 못했습니다. 다시 시도해 주세요."); } }}><LogOut size={14} />{en ? "Sign out" : "로그아웃"}</button></> : <Link className="rn-footer-link" to={`/${locale}/login`}><Users size={14} />{en ? "Sign in" : "로그인"}</Link>}
        {error && <p role="alert" className="px-2 text-rn-12 text-rn-danger-ink">{error}</p>}
      </div>
    </aside>
    <main className="min-h-0 min-w-0 overflow-hidden" id="main-content">{children}</main>
  </div>;
}
