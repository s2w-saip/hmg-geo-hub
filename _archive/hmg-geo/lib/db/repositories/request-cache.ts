import "server-only";
import { cache } from "react";
import { projectRepository } from "./projects";
import { projectMemberRepository } from "./project-members";

// Request-scoped memos for the two lookups that every project route performs
// more than once per render.
//
// Why this exists: the (dash) layout resolves the SNB's project meta
// (findMembership → getById), and then the leaf page under it runs the SAME two
// queries for its own membership gate — so a project page paid 4 queries where 2
// suffice. lib/scope/server.ts had a module-private `cache()` for getById, which
// deduped scope's own widget fan-out but could not be shared with the layout or
// the pages. Hoisting it here gives all three callers ONE memo per request.
//
// React's cache() is per-request in the RSC runtime, so this is a memo, not a
// TTL cache — nothing leaks across requests or users.
//
// These are NOT an access-control bypass: they memoize the same unauthorized
// reads the repositories already expose. Callers still gate on membership
// exactly as before (see projects.ts's access-boundary note).

/** Request-scoped memo of `projectRepository.getById`. */
export const cachedProjectById = cache((id: string) =>
  projectRepository.getById(id),
);

/** Request-scoped memo of `projectMemberRepository.findMembership`. */
export const cachedMembership = cache((projectId: string, userId: string) =>
  projectMemberRepository.findMembership(projectId, userId),
);
