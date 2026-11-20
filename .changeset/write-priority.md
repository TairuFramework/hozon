---
"@hozon/adapter": patch
"@hozon/db": patch
"@hozon/expo": patch
"@hozon/native": patch
---

Add optional high and low transaction priorities, defaulting to high. Native SQLite and Expo admit queued high writes first, preserving FIFO within priorities. Admit one waiting low write after eight consecutive high grants without preempting transactions.
