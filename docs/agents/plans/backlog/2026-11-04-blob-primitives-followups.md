# Blob primitives follow-ups

**Priority:** backlog. Left open by the blob primitives work (`../completed/2026-11-04-blob-primitives.complete.md`).

- **Runtime bundles untested.** `TransactionScopeError` detection loads `AsyncLocalStorage` through a global, `process.getBuiltinModule`, or a guarded dynamic import on Bun and Deno. Node covers context present and absent. Bun, Deno, Expo and browser (sqlocal) bundles were never run against it; an e2e-expo / e2e-web smoke would confirm no bundler pulls `node:async_hooks`.
- **`reconcileBytes` enumeration cost is unbounded.** `limit` caps deletion attempts, not keys inspected, to avoid starvation. A large committed directory is walked in full per call. Consider a resumable cursor over `listKeys`.
- **Postgres lost-release regression never ran red.** The release-row locking fix in the refs/GC change has a Postgres test that was written after the fix and only seen green.
- **`StoreProvider.root` contract.** Post-settlement cleanup needs a lifetime-independent `root` on transaction providers. Custom providers must expose it; document it in the provider reference and add a conformance case.
- **Retried `withLocks` callbacks replay.** A hozon-opened transaction retried on `40P01` runs the callback again, so callers must create fresh input streams per attempt. Documented in the README; a typed hint (callback receives the attempt number) could make it harder to miss.
