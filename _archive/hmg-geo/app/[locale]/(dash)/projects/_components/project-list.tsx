"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Search,
  X,
  FolderOpen,
  MessageSquareText,
  Users,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { useSortableTable } from "@/hooks/use-sortable-table";

// Client-side controls for the project card grid: free-text search, role
// filter (all / owner / viewer), and sort by name / date / prompt count /
// member count, each toggleable ascending/descending.
//
// The data set here is "projects the user can see" — tens to low hundreds at
// the planned scale — so filtering/sorting in memory is well under a frame
// and avoids round-tripping the server for every keystroke. Revisit only if
// the list grows large enough to need server-side pagination.

export type ProjectCardData = {
  id: string;
  name: string;
  domain: string | null;
  role: "owner" | "viewer";
  promptCount: number;
  activeMembers: number;
  createdAt: string; // ISO timestamp — sorted as epoch ms
};

type RoleFilter = "all" | "owner" | "viewer";
type SortKey = "name" | "createdAt" | "prompts" | "members";

export function ProjectList({ projects }: { projects: ProjectCardData[] }) {
  const t = useTranslations("projects");
  const tc = useTranslations("projects.controls");

  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  // Search + role filter first, then sort the survivors. Newest-first is the
  // natural default for a project list; name flips to A→Z on first select.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (roleFilter !== "all" && p.role !== roleFilter) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.domain ?? "").toLowerCase().includes(q)
      );
    });
  }, [projects, query, roleFilter]);

  const { sorted, sortKey, asc, toggleSort } = useSortableTable<
    ProjectCardData,
    SortKey
  >(
    filtered,
    {
      name: (p) => p.name,
      createdAt: (p) => new Date(p.createdAt).getTime(),
      prompts: (p) => p.promptCount,
      members: (p) => p.activeMembers,
    },
    { defaultKey: "createdAt", defaultAsc: false, ascByDefault: ["name"] },
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Search — name or domain substring, case-insensitive. */}
        <div className="relative w-full sm:max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tc("searchPlaceholder")}
            className="h-9 pl-9 pr-9 text-sm"
            aria-label={tc("searchPlaceholder")}
          />
          {query && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setQuery("")}
              aria-label={tc("searchClear")}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Role filter — segmented all / owner / viewer. */}
          <Tabs
            value={roleFilter}
            onValueChange={(v) => setRoleFilter(v as RoleFilter)}
          >
            <TabsList>
              <TabsTrigger value="all">{tc("filter.all")}</TabsTrigger>
              <TabsTrigger value="owner">{tc("filter.owner")}</TabsTrigger>
              <TabsTrigger value="viewer">{tc("filter.viewer")}</TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Sort field + direction toggle. The Select fires only on change,
              so a separate button flips ascending/descending for the active
              key (toggleSort(sortKey) flips when next === current). */}
          <Select
            value={sortKey}
            onValueChange={(v) => toggleSort(v as SortKey)}
          >
            <SelectTrigger size="sm" className="h-9 w-[8.5rem]">
              <SelectValue aria-label={tc("sort.label")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="createdAt">{tc("sort.createdAt")}</SelectItem>
              <SelectItem value="name">{tc("sort.name")}</SelectItem>
              <SelectItem value="prompts">{tc("sort.prompts")}</SelectItem>
              <SelectItem value="members">{tc("sort.members")}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => toggleSort(sortKey)}
            aria-label={asc ? tc("sort.asc") : tc("sort.desc")}
            title={asc ? tc("sort.asc") : tc("sort.desc")}
          >
            {asc ? (
              <ArrowUp className="h-4 w-4" aria-hidden />
            ) : (
              <ArrowDown className="h-4 w-4" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="rounded-md bg-muted/40 px-4 py-6 text-center text-xs text-muted-foreground">
          {tc("noResults")}
        </p>
      ) : (
        <section
          aria-label={t("title")}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {sorted.map((p) => (
            <ProjectCard
              key={p.id}
              id={p.id}
              name={p.name}
              domain={p.domain}
              role={p.role}
              promptCount={p.promptCount}
              activeMembers={p.activeMembers}
              labels={{
                prompts: t("card.prompts"),
                members: t("card.members"),
              }}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function ProjectCard({
  id,
  name,
  domain,
  role,
  promptCount,
  activeMembers,
  labels,
}: {
  id: string;
  name: string;
  domain: string | null;
  role: "owner" | "viewer";
  promptCount: number;
  activeMembers: number;
  labels: {
    prompts: string;
    members: string;
  };
}) {
  return (
    <Link href={`/projects/${id}`} className="group block" aria-label={name}>
      <Card>
        <CardHeader>
          {/* min-w-0 on this row: CardHeader is display:grid (shadcn) with an
              implicit auto column — without it the row's min-width:auto blows the
              column out to the title's max-content, defeating the truncate chain
              below. min-w-0 lets the grid item shrink so the column collapses to
              the card width and the title clips. */}
          <div className="flex min-w-0 items-start justify-between gap-3">
            {/* min-w-0 so a long name truncates instead of pushing the badge
                out; the icon stays fixed-size via shrink-0. */}
            <div className="flex min-w-0 items-center gap-2">
              <FolderOpen className="h-5 w-5 shrink-0 text-brand-700" aria-hidden />
              {/* min-w-0 on the title itself (not just the row) — a flex item's
                  default min-width:auto otherwise refuses to shrink below the
                  text, expanding the row and pushing the badge out of the card. */}
              <CardTitle
                className="min-w-0 truncate font-head text-base font-semibold tracking-tight"
                title={name}
              >
                {name}
              </CardTitle>
            </div>
            <Badge
              variant={role === "owner" ? "default" : "secondary"}
              className="shrink-0"
            >
              {role === "owner" ? "Owner" : "Viewer"}
            </Badge>
          </div>
          {/* domain URLs are single unbreakable tokens — min-w-0 + truncate
              clips to one line with ellipsis (full value on hover) instead of
              overflowing the card. */}
          <CardDescription
            className="mt-1 min-w-0 truncate text-xs text-muted-foreground"
            title={domain ?? undefined}
          >
            {domain ?? "—"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <MessageSquareText
                className="h-3.5 w-3.5 text-brand-700"
                aria-hidden
              />
              <span className="tabular-nums font-medium text-foreground">
                {promptCount}
              </span>
              <span>{labels.prompts}</span>
            </span>
            <span aria-hidden className="text-border">
              ·
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5 text-brand-700" aria-hidden />
              <span className="tabular-nums font-medium text-foreground">
                {activeMembers}
              </span>
              <span>{labels.members}</span>
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
