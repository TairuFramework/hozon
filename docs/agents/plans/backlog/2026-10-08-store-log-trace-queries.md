# `@hozon/store-log`: bounded newest-first trace log queries

Requested by mokei (unified traces design). Mokei's monitor shows the logs of one trace,
optionally filtered to one span, newest first with paging. `getTraceLogs(traceID)` loads
every log of a trace, and the bounded query orders ascending with no span filter, so a
long-lived trace (an MCP context that logs every notification for hours) has no efficient
read. Request: a trace log query taking `{ traceID, spanID?, order: 'asc' | 'desc', limit,
cursor? }` with a stable cursor, backed by an index on `(traceID, spanID, sequence)`.
Until it ships, mokei loads all trace logs and caps the response.
