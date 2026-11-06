---
'@hozon/blob': patch
---

A write of bytes already held locally restarts their grace, so `collect` cannot delete a blob a writer was just told is stored before it adds a ref.
