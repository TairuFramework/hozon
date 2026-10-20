# Batch loading follow-ups

Low-priority work left after store batch loading. Context: [the completed summary](../completed/2026-10-20-batch-loading.complete.md).

- **Lint rule for sequential per-ID reads.** Flag `await store.getX(id)` inside loops, and suggest the batch read or `Promise.all`. A loader cannot batch these loops, because each call waits for the previous one.
- **Browser scheduling latency.** The loader schedules a dispatch with `setImmediate`, or `setTimeout(fn, 0)` where `setImmediate` is missing. In browsers this adds about 1–4 ms per sequential read. A `MessageChannel` fallback would remove it.
- **Program order across store instances.** A write dispatches only its own store instance's pending reads. A scoped read still pending when a write goes through another provider can observe that write. Decide whether this needs a guarantee.
- **Postgres transaction end with an unawaited query in flight.** A read dispatched as the transaction ends can queue behind that query and run after commit on the released connection. This is an existing Kysely hazard for unawaited queries. Document it or guard against it.
- **Optional `iterateBatches` window.** Parallel chunk queries help only postgres with a pool. Add a `window` option, for example via `prefetchOrdered` from `@sozai/async`, if a consumer needs it.
- **More adopters.** Batch other per-ID reads when consumers loop over them. `store-log` and `store-telemetry` do not need it today. kubun gets this when it adopts hozon stores, and its `createAPI` wrappers must then pass the store context.
