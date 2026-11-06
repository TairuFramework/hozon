---
'@hozon/expo': patch
---

`ExpoDriver.destroy` waits for the connection holder before closing, so a running transaction does not fail on a closed handle.
