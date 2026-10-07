# Verify `@hozon/blob-node-fs` on Windows

`FSBlobBackend` commits by hard-linking staging into `content/` (no replacement of an
existing blob), then removing staging. POSIX and NTFS support this, but it was only
tested on macOS; Windows-specific tests are skipped on other platforms. Run the backend
suite on a Windows CI runner and document that filesystems without hard links (FAT,
some network shares) are unsupported, or add a fallback. Context:
[the completed summary](../completed/2026-10-07-store-blob.complete.md).
