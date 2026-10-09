---
name: implement-upload-flow
description: Implements or changes CellWeave large dataset upload/download flows using private R2, multipart/presigned access, quarantine, integrity, and tenant authorization.
---

# Implement Upload Flow

1. Confirm input format/lifecycle requirement.
2. Authorize upload initialization using server-derived tenant/project context.
3. Create upload session metadata.
4. Return signed/multipart upload capability for direct browser → R2 transfer.
5. Never proxy large file bytes through Vercel.
6. Keep objects private and tenant/project scoped.
7. Complete upload idempotently.
8. Move to verification/quarantine flow.
9. Ensure SHA-256, size, actual format, compression metadata are produced by ingest.
10. Do not treat multipart ETag as content checksum.
11. Enforce archive/file safety and never execute upload contents.
12. Download only through permission check → short-lived signed URL.
13. Test interruption/resume, duplicate completion, expired session, unauthorized access, and cross-tenant denial.
