// tsc-only fixture (never imported, never run): pins the compile-time contract of the
// typed backend client. Each `@ts-expect-error` line MUST fail to type-check; if a
// change to lib/hgh/client.ts loosens the types, the directive becomes unused and
// `npx tsc --noEmit` fails. The unmarked calls must keep compiling.
import { hghDelete, hghGet, hghPatch, hghPost, hghRaw } from "./client";
import { withParams, type CommonFilterParams } from "./query";
import { relayDownload, relayUpload } from "./relay";

declare const common: CommonFilterParams;
declare const file: Blob;

export async function queryContract() {
  // Accepted: required `surface` present, feature params typed, cf with CommonFilters.
  await hghGet("/v1/kpi/summary", { query: { surface: "global", engine: ["chatgpt"], cycle_offset: 1 } });
  await hghGet("/v1/kpi/summary", { query: { ...common.query, cycle_offset: 0 }, cf: common.cf });
  await hghGet("/v1/kpi/summary", { query: withParams(common.query, { cycle_offset: 1 }), cf: common.cf });
  await hghGet("/v1/auth/me");

  // @ts-expect-error required query (surface) cannot be omitted
  await hghGet("/v1/kpi/summary");
  // @ts-expect-error required query (surface) cannot be omitted
  await hghGet("/v1/kpi/summary", {});
  // @ts-expect-error surface is required inside the query
  await hghGet("/v1/kpi/summary", { query: { engine: ["chatgpt"] } });
  // @ts-expect-error surface is an enum
  await hghGet("/v1/kpi/summary", { query: { surface: "globl" } });
  // @ts-expect-error misspelled parameter name
  await hghGet("/v1/kpi/summary", { query: { surface: "global", engin: ["chatgpt"] } });
  // @ts-expect-error misspelled parameter name after the common spread
  await hghGet("/v1/kpi/summary", { query: { ...common.query, cycle_ofset: 1 } });
  // @ts-expect-error wrong value type (cycle_offset is a number)
  await hghGet("/v1/kpi/summary", { query: { surface: "global", cycle_offset: "1" } });
  // @ts-expect-error list parameter takes an array
  await hghGet("/v1/kpi/summary", { query: { surface: "global", country: "US" } });
  // @ts-expect-error cf.* is not a query key; custom fields go in `cf`
  await hghGet("/v1/kpi/summary", { query: { surface: "global", "cf.7c9e6679-7425-40de-944b-e07fc1f90ae7": ["a"] } });
  // @ts-expect-error cf only on CommonFilters paths
  await hghGet("/v1/auth/me", { cf: { x: ["a"] } });
  // @ts-expect-error this path has no query parameters
  await hghGet("/v1/auth/me", { query: { surface: "global" } });
  // @ts-expect-error URLSearchParams bypasses the typed query and is refused
  await hghGet("/v1/kpi/summary", { query: new URLSearchParams("surface=global") });
  // @ts-expect-error withParams refuses a common axis
  withParams(common.query, { country: ["US"] });
}

export async function pathAndBodyContract() {
  await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: "p" } });
  await hghPatch("/v1/projects/{project_id}", { pathParams: { project_id: "p" }, body: { name: "n" } });
  await hghDelete("/v1/projects/{project_id}", { pathParams: { project_id: "p" }, body: { confirm_name: "n" } });
  const accepted: undefined = await hghPost("/v1/projects/{project_id}/members/me/accept", { pathParams: { project_id: "p" } });

  // @ts-expect-error path params are required
  await hghGet("/v1/projects/{project_id}");
  // @ts-expect-error unknown path
  await hghGet("/v1/nope");
  // @ts-expect-error POST-only path through GET
  await hghGet("/v1/admin/catalog/prompts/bulk/apply");
  // @ts-expect-error body is required
  await hghPost("/v1/admin/catalog/prompts/bulk/apply");
  // @ts-expect-error body shape is checked
  await hghPost("/v1/admin/catalog/prompts", { body: { nope: 1 } });
  // @ts-expect-error GET has no body
  await hghGet("/v1/auth/me", { body: {} });
  return accepted;
}

export async function relayContract() {
  await hghRaw("get", "/v1/qa/notes/export", { query: { surface: ["global"] }, accept: "text/csv" });
  await relayDownload("/v1/projects/{project_id}/prompts/export", { pathParams: { project_id: "p" } });
  await relayUpload("/v1/projects/{project_id}/prompts/import", file, { pathParams: { project_id: "p" } });
  await relayUpload("/v1/admin/catalog/prompts/import/preview", file, { mode: "raw" });
  await relayUpload("/v1/admin/catalog/prompts/import/preview", file);

  // @ts-expect-error raw path must support the method
  await hghRaw("get", "/v1/admin/catalog/prompts/bulk/apply");
  // @ts-expect-error download query is typed too
  await relayDownload("/v1/qa/notes/export", { query: { surfac: "global" } });
  // @ts-expect-error uploads only to file-taking paths
  await relayUpload("/v1/admin/catalog/prompts/bulk/apply", file, {});
  // @ts-expect-error upload path params are required
  await relayUpload("/v1/projects/{project_id}/prompts/import", file, {});
  // @ts-expect-error upload options cannot be omitted when path params are required
  await relayUpload("/v1/projects/{project_id}/prompts/import", file);
}
