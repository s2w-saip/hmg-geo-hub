import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useLocale } from "use-intl";
import { CONNECTED, request } from "~/api/client";
import { queryClient } from "~/api/query-client";
import { useSession, sessionUser, type HubUser } from "./session";
import { HghApiError } from "@/lib/hgh/errors";

export function safeNext(raw: string | null, locale: string): string {
  const fallback = `/${locale}/renewal/dashboard`;
  if (!raw || /[\\\u0000-\u0020]/.test(raw) || /%(?:2f|5c|00)/i.test(raw)) return fallback;
  const parsed = new URL(raw, "https://hub.invalid");
  if (parsed.origin !== "https://hub.invalid" || !(parsed.pathname === `/${locale}/renewal` || parsed.pathname.startsWith(`/${locale}/renewal/`))) return fallback;
  return raw;
}
export function AuthPage({ password = false }: { password?: boolean }) {
  const locale = useLocale();
  const en = locale === "en";
  const { search } = useLocation();
  const navigate = useNavigate();
  const { user } = useSession();
  const next = safeNext(new URLSearchParams(search).get("next"), locale);
  const [login, setLogin] = useState("");
  const [current, setCurrent] = useState("");
  const [fresh, setFresh] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!CONNECTED || busy) return;
    if (password && fresh !== confirmation) { setError(en ? "Passwords do not match." : "새 비밀번호가 일치하지 않습니다."); return; }
    setBusy(true); setError(null);
    try {
      const response = await request<{ user: HubUser }>(password ? "/api/hub/password" : "/api/hub/session", { method: "POST", body: password ? { current, new: fresh } : { login, password: current } });
      const signedIn = sessionUser(response.user);
      if (!signedIn) throw new HghApiError(502, "invalid_session_response");
      await queryClient.cancelQueries();
      queryClient.clear();
      queryClient.setQueryData(["session"], signedIn);
      setCurrent(""); setFresh(""); setConfirmation("");
      navigate(signedIn.mustChangePassword ? `/${locale}/change-password?next=${encodeURIComponent(next)}` : next, { replace: true });
    } catch (e) {
      setError(e instanceof HghApiError && e.status === 401 ? (en ? "Check your login and password." : "로그인 정보와 비밀번호를 확인해 주세요.") : (en ? "The request could not be completed. Please try again." : "요청을 처리하지 못했습니다. 다시 시도해 주세요."));
    } finally { setBusy(false); }
  }
  return <main className="flex h-screen items-center justify-center bg-rn-canvas p-8"><section className="w-[420px] rounded-[18px] border border-rn-line bg-white p-9 shadow-rn-1">
    <div className="mb-8 flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-rn-navy text-xl font-bold text-white">G</span><div><strong className="block text-rn-20">HMG GEO</strong><span className="text-rn-12 text-rn-muted">Generative Engine Optimization</span></div></div>
    <h1 className="mb-2 text-rn-24 font-semibold">{password ? (en ? "Change password" : "비밀번호 변경") : (en ? "Sign in" : "로그인")}</h1>
    <p className="mb-7 text-rn-13 leading-relaxed text-rn-muted">{CONNECTED ? (password ? (en ? "Update your account password." : "계정의 비밀번호를 변경합니다.") : (en ? "Sign in with your HUB account." : "HUB 계정으로 로그인해 주세요.")) : (en ? "Sign-in will be available after the server is connected." : "서버 연결 후 HUB 계정으로 로그인할 수 있습니다.")}</p>
    <form onSubmit={submit} className="flex flex-col gap-4">
      {!password && <label className="rn-auth-label">{en ? "Login" : "아이디"}<input autoComplete="username" value={login} onChange={e => setLogin(e.target.value)} required disabled={!CONNECTED || busy} /></label>}
      <label className="rn-auth-label">{password ? (en ? "Current password" : "현재 비밀번호") : (en ? "Password" : "비밀번호")}<input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} required disabled={!CONNECTED || busy} /></label>
      {password && <><label className="rn-auth-label">{en ? "New password" : "새 비밀번호"}<input type="password" autoComplete="new-password" value={fresh} onChange={e => setFresh(e.target.value)} required disabled={!CONNECTED || busy} /></label><label className="rn-auth-label">{en ? "Confirm new password" : "새 비밀번호 확인"}<input type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} required disabled={!CONNECTED || busy} /></label></>}
      {error && <p role="alert" className="text-rn-13 text-rn-danger-ink">{error}</p>}
      <button type="submit" disabled={!CONNECTED || busy} className="mt-2 h-11 rounded-lg bg-rn-navy text-rn-13 font-semibold text-white disabled:opacity-40">{busy ? (en ? "Processing…" : "처리 중…") : password ? (en ? "Save" : "변경 저장") : (en ? "Sign in" : "로그인")}</button>
    </form>
    {!CONNECTED && <Link to={`/${locale}/renewal/dashboard`} className="mt-6 block text-center text-rn-13 font-semibold text-rn-navy">{en ? "Explore prepared pages" : "준비된 화면 살펴보기"}</Link>}
    {CONNECTED && password && !user && <Link to={`/${locale}/login`} className="mt-5 block text-rn-13 text-rn-navy">{en ? "Sign in first" : "로그인으로 이동"}</Link>}
  </section></main>;
}
