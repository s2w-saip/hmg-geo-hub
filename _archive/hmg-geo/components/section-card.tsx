import type { ReactNode } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";

// Dashboard section container. Thin wrapper over shadcn Card so pages can
// pass title/description as data rather than composing slots — keeps the
// page-level JSX flat and consistent across the four dashboard routes.
//
// The base Card is now borderless (see components/ui/card.tsx) and relies
// on shadow-soft for separation, matching the Hyundai BI pattern. We add
// the display font on the title here so SectionCards read as editorial
// "panels" rather than form sections.
export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-head text-lg font-semibold tracking-tight">
          {title}
        </CardTitle>
        {description ? (
          <CardDescription className="mt-1">{description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
