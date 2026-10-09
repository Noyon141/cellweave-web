---
trigger: model_decision
description: "Use for dataset upload, R2, presigned URLs, multipart flows, downloads, object paths, retention, or artifact access."
---

# Upload and Object Storage Rules

R2 is private. No dataset bucket is public.

Large upload path:
browser → CellWeave authorization → presigned/multipart upload → browser direct to R2.

Never route large dataset bytes through Vercel functions.

Upload lifecycle:
CREATED → UPLOADING → UPLOADED → VERIFYING → VERIFIED → IMPORTED.

Failure states:
FAILED, ABORTED, EXPIRED, QUARANTINED.

Post-upload integrity:
- compute SHA-256
- record size
- detected format
- compression metadata
- do not use multipart ETag as scientific checksum

Quarantine validation includes:
size, declared/actual format, binary signature, traversal, decompression ratio, file count, structure, schema sanity, dimensions.

Never run uploaded code.

Reject archive traversal, absolute paths, escaping symlinks, zip bombs, unexpected executables.

Object paths remain tenant/project/run scoped according to the design.

Downloads:
request → authorization → short-lived signed URL → direct R2 download.

Never expose permanent public object URLs.

Cross-tenant dedup must never reveal another tenant's identical upload.
