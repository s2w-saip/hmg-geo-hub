import "server-only";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  projectTrackedUrls,
  type ProjectTrackedUrlRow,
} from "@/lib/db/schema";

// 프로젝트별 추적 URL 리스트 — KPI ⑥ AI 타겟 URL 인용률의 분자 도메인. UI는
// /projects/[id]/setting 의 '추적 URL' 섹션에서 CRUD; 측정 wiring (KPI 활성)은
// 다음 작업.

export interface NewTrackedUrl {
  projectId: string;
  url: string;
  label: string | null;
  createdBy: string;
}

export async function listProjectTrackedUrls(
  projectId: string,
): Promise<ProjectTrackedUrlRow[]> {
  const db = getDb();
  try {
    return await db
      .select()
      .from(projectTrackedUrls)
      .where(eq(projectTrackedUrls.projectId, projectId))
      .orderBy(desc(projectTrackedUrls.createdAt));
  } catch (err) {
    // Migration 0015 가 prod 에 미적용된 환경에서 KPI ⑥ wiring 이 먼저
    // deploy 됐을 때 'relation "project_tracked_urls" does not exist' 로
    // 프로젝트 페이지가 500 으로 떨어졌음. fallback: 테이블 없으면 빈 list
    // (= 라벨 0개 = KPI '측정 대기'). 0015 적용 후엔 정상 경로로 동작.
    const code = (err as { cause?: { code?: string }; code?: string } | null)
      ?.cause?.code ?? (err as { code?: string } | null)?.code;
    if (code === "42P01") {
      console.warn(
        "[project_tracked_urls] table not found — returning empty list (migration 0015 not applied?)",
      );
      return [];
    }
    throw err;
  }
}

export async function addProjectTrackedUrl(
  row: NewTrackedUrl,
): Promise<ProjectTrackedUrlRow> {
  const db = getDb();
  // Uniqueness on (project_id, url) is DB-enforced; rely on a unique-violation
  // throw at the action layer rather than racing a SELECT-then-INSERT.
  const [created] = await db
    .insert(projectTrackedUrls)
    .values({
      projectId: row.projectId,
      url: row.url,
      label: row.label,
      createdBy: row.createdBy,
    })
    .returning();
  return created;
}

export async function updateProjectTrackedUrl(
  id: string,
  projectId: string,
  patch: { url?: string; label?: string | null },
): Promise<ProjectTrackedUrlRow | undefined> {
  const db = getDb();
  // Scope the update to the project so a stale id from another project can
  // never write here even if the action layer slipped. Uniqueness on
  // (project_id, url) is DB-enforced — rely on the unique-violation throw.
  const [updated] = await db
    .update(projectTrackedUrls)
    .set(patch)
    .where(
      and(
        eq(projectTrackedUrls.id, id),
        eq(projectTrackedUrls.projectId, projectId),
      ),
    )
    .returning();
  return updated;
}

export async function removeProjectTrackedUrl(
  id: string,
  projectId: string,
): Promise<void> {
  const db = getDb();
  // Belt-and-braces: scope the delete to the project so a stale id from
  // another project can never delete here even if the action layer slipped.
  await db
    .delete(projectTrackedUrls)
    .where(
      and(
        eq(projectTrackedUrls.id, id),
        eq(projectTrackedUrls.projectId, projectId),
      ),
    );
}
