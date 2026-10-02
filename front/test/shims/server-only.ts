// Test shim for the `server-only` package. `server-only` is a build-time guard
// with no runtime behavior; it has no module to resolve under vitest, so we
// alias it here (vitest.config.ts) to this empty module. This lets unit tests
// load real server modules (repositories, lib/scope/*) without the guard
// erroring on import.
export {};
