CREATE TYPE "public"."role" AS ENUM('hq', 'region', 'country', 'admin');--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"role" "role" NOT NULL,
	"scope_all" boolean DEFAULT false NOT NULL,
	"brands" text[],
	"regions" text[],
	"countries" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
