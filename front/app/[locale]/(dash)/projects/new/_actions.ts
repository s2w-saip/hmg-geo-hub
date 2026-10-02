"use server";

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { projectCreationOptions } from "@/lib/auth/scope-policy";
import { canCreateProject } from "@/lib/auth/operator-policy";
import { projectRepository } from "@/lib/db/repositories/projects";
import { addProjectOwnedBase } from "@/lib/db/repositories/project-owned-bases";
import { isDimensionLockedByRole } from "@/lib/auth/scope-policy";
import { createScopeMirror, attachScopeMirror } from "@/lib/scope/project-sync";
import { normalizeUrlForMatch } from "@/lib/scope/url-match";
import { normalizeAiEngines } from "@/lib/scope/engines";
import * as api from "@/lib/hgh/adapters/projects";

// Server action backing the /projects/new simple form (v23 resolution
// 2026-06-02 — wizard dropped). Validates:
//   - name (required, non-empty)
//   - country (required, must be in the user's scope-derived allowed list)
//   - brand (optional, must be in allowed list when provided)
//   - description / domain (free text, no validation)
//   - aiEngines (required, >= 1 of lib/scope/engines.ts catalog) — 답변을 수집할
//     AI 엔진. 저장 + 이력 첫 행 + scope schedule targets 로 전파.
//
// On success: inserts a Project row + an Owner ProjectMember row (via
// projectRepository.insert) and redirects to the new project's Intent tab.

export type ActionResult =
  | { ok: true; projectId: string }
  | { ok: false; error: string };

export async function createProject(formData: FormData): Promise<ActionResult> {
  // HGH_SOURCE_G6=api: POST /v1/projects. Scope/vocabulary validation, domain canonicalization,
  // owned-base seed, Scope mirror and schedule are one server transaction + outbox
  // (lib/hgh/adapters/projects.ts, U9-N3). Same messages, same redirect.
  if (api.isProjectsApi()) {
    const r = await api.createProject(formData);
    if (!r.ok) return r;
    const locale = String(formData.get("locale") ?? "ko");
    redirect(`/${locale}/projects/${r.projectId}/intent`);
  }

  const session = await getSession();
  if (!session) throw new UnauthorizedError();

  // Cost gate (운영자, GGMD scenario 3-2): project creation requires
  // operator=global (or admin). Route access (PROJECT_CREATORS) keeps vendor
  // out; this is the binding check — never trust that the CTA was hidden.
  if (!canCreateProject(session.user)) {
    return { ok: false, error: "프로젝트 생성 권한(운영자)이 없습니다" };
  }

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  // canonical 정규화 저장 (KPI ⑥ 분모 프리픽스 + scope-sync 호스트가 여기서
  // 파생). 정책: docs/kpi6-domain-url-normalization-policy.md.
  const domain = normalizeUrlForMatch(formData.get("domain") as string | null);
  const brand = String(formData.get("brand") ?? "").trim();
  const country = String(formData.get("country") ?? "").trim();
  // 체크박스는 같은 키로 여러 값 — getAll. 미지값·중복은 normalize 가 버린다.
  const aiEngines = normalizeAiEngines(
    formData.getAll("aiEngines").map((v) => String(v)),
  );

  if (!name) return { ok: false, error: "제목을 입력해주세요" };
  if (!country) return { ok: false, error: "국가를 선택해주세요" };
  if (aiEngines.length === 0) return { ok: false, error: "AI 엔진을 1개 이상 선택해주세요" };

  const options = projectCreationOptions(session.user);
  if (!options.countries.includes(country)) {
    return {
      ok: false,
      error: "선택한 국가에 대한 권한이 없습니다",
    };
  }
  if (brand && !options.brands.includes(brand)) {
    return {
      ok: false,
      error: "선택한 브랜드에 대한 권한이 없습니다",
    };
  }
  // Defense in depth: when the role locks the brand dimension AND the scope
  // actually pins brands, the selected brand must be one of them. An
  // unrestricted scope (scope.all / empty brands — e.g. hq with 전체 권한) is
  // already validated by the options.brands check above; the previous
  // "exactly one pinned brand" requirement rejected every brand pick for
  // such accounts (geo@score.test, 2026-08-18).
  if (brand && isDimensionLockedByRole(session.user.role, "brand")) {
    const scopeBrands = session.user.scope.brands ?? [];
    const unrestricted = session.user.scope.all || scopeBrands.length === 0;
    if (!unrestricted && !scopeBrands.includes(brand)) {
      return { ok: false, error: "브랜드는 본인 권한 내에서만 선택 가능합니다" };
    }
  }

  const created = await projectRepository.insert({
    name,
    description: description || null,
    domain: domain || null,
    brand: brand || null,
    country,
    aiEngines,
    createdBy: session.user.id,
  });

  // owned base 를 domain 과 함께 생성 시점에 심어둔다 — 그러지 않으면
  // project_owned_bases 가 0개인 채로 projects.domain 만 채워진 상태가 되어,
  // 새로 만든 프로젝트에서도 KPI ⑥ "legacy domain fallback" 이관 안내가 즉시
  // 뜨는 문제(생성 직후인데 마이그레이션이 필요한 것처럼 보임)가 있었다.
  if (domain) {
    await addProjectOwnedBase({
      projectId: created.id,
      baseUrl: domain,
      label: null,
      createdBy: session.user.id,
    });
  }

  // Mirror into the scope "Hyundai Motor Group" workspace so this project
  // becomes a scope project too (1:1 link). mock 모드·데모는 미러가 없는 것이
  // 정상(skipped)이라 그대로 진행한다.
  const outcome = await createScopeMirror(created);
  if (outcome.status === "created") {
    // 링크 저장 + 선택 엔진을 scope schedule targets 로(attachScopeMirror). 미러
    // 직후에 걸어야 프롬프트가 들어왔을 때 기본 엔진으로 도는 일이 없고, 링크
    // 저장 뒤라야 게이트(assertProjectInScope)가 scope id 를 로컬 행으로 되찾는다.
    // best-effort — 실패해도 로컬 값이 정본, 다음 저장 때 재전파.
    await attachScopeMirror(created.id, outcome.scopeProjectId, aiEngines);
  } else if (outcome.status === "failed") {
    // scope 장애를 **삼키지 않는다.** 예전에는 여기서 그대로 성공 리다이렉트를
    // 태워, 사용자는 정상 생성으로 알지만 scope_project_id 가 영구 NULL 로 남는
    // 조용한 부패가 됐다(2026-08-15~19 scope POST /projects 전건 400 장애 때
    // 고아 6건). 로컬 행은 정본이므로 지우지 않고(=재제출로 중복이 생기지 않게)
    // 실패를 명시적으로 돌려준다 — 폼이 toast.error 로 띄운다.
    return {
      ok: false,
      error:
        "프로젝트는 저장됐지만 측정 엔진(scope) 연결에 실패했습니다. 다시 제출하지 마세요 — 프로젝트 목록에서 이 프로젝트를 열어 프롬프트 탭의 '저장 + 실행'으로 재시도하면 연결됩니다.",
    };
  }

  // Locale is passed in as a hidden form field from the client so the
  // redirect stays in the active locale (avoids /ko hardcoding).
  const locale = String(formData.get("locale") ?? "ko");
  redirect(`/${locale}/projects/${created.id}/intent`);
}
