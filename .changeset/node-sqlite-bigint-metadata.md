---
"@hozon/node-sqlite": patch
---

Return statement metadata beyond JavaScript's safe integer range as bigint. Previously a row ID above 2^53 made `run()` throw `ERR_OUT_OF_RANGE`, and because SQLite keeps the connection's last-insert row ID, every later statement on that connection, `BEGIN` included, threw as well. Safe values are still returned as numbers.
