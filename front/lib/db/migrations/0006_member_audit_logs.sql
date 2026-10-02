-- Hand-written migration: member_audit_logs (Task R3).
-- Append-only ledger of who-did-what-to-whom on a project's Member tab.
-- Indexed on (project_id, created_at desc) to make the Member page's
-- "recent activity" tail-read cheap.

CREATE TYPE "public"."member_audit_action" AS ENUM(
  'invite',
  'cancel_invite',
  'remove',
  'promote',
  'demote',
  'accept',
  'reject'
);--> statement-breakpoint

CREATE TABLE "member_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "actor_id" uuid NOT NULL,
  "target_user_id" uuid NOT NULL,
  "action" "member_audit_action" NOT NULL,
  "context" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "member_audit_logs_project_idx" ON "member_audit_logs" ("project_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "member_audit_logs_actor_idx" ON "member_audit_logs" ("actor_id");--> statement-breakpoint
CREATE INDEX "member_audit_logs_target_idx" ON "member_audit_logs" ("target_user_id");
