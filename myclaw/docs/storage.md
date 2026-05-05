# Persistence Hardening

MyClaw uses local files for sessions, L2 memory, approvals, memory proposals, Markdown memory, and audit logs. The storage layer is intentionally simple, but writes now use safer primitives to reduce accidental corruption.

## Atomic JSON and Markdown Writes

`src/storage/atomicJson.js` provides:

- `atomicWriteJson(filePath, data)`
- `atomicWriteText(filePath, text)`
- `readJsonSafe(filePath, defaultValue)`

Atomic writes use:

1. write to a temporary file in the same directory
2. rename the temporary file over the target
3. keep the old target intact if the write or rename fails

This is used for:

- `approvals/approvals.json`
- `memory/proposals/proposals.json`
- session JSON files
- L2 session memory JSON files
- L3/L4 Markdown canonical files

`storage.atomicWrites.enabled` defaults to `true`.

## Corrupt JSON Recovery

`readJsonSafe()` catches invalid JSON, backs up the corrupt file, and returns the caller's default value.

Backup naming:

```text
<file>.corrupt.<timestamp>
```

This is used by ApprovalBroker, MemoryProposalStore, session loading/listing, and L2 memory loading.

## File Locking

`withFileLock(filePath, fn)` uses a small lockfile next to the target file:

```text
<file>.lock
```

The lock protects MyClaw processes from obvious same-file write interleaving. It is a lightweight local lock, not a distributed lock or database transaction.

## Audit JSONL Rotation

`src/storage/jsonl.js` provides:

- `appendJsonl(filePath, event)`
- `readJsonlTail(filePath, lines)`
- `rotateJsonlIfNeeded(filePath, options)`

Audit rotation defaults:

```json
{
  "audit": {
    "rotation": {
      "enabled": true,
      "maxSizeBytes": 10485760,
      "maxFiles": 5
    }
  }
}
```

Rotation naming:

```text
audit.log
audit.log.1
audit.log.2
```

`AuditLog.query()` currently reads only the active `audit.log`; rotated files are retained for manual inspection but not searched.

## Current Limitations

- Not tamper-proof.
- No cryptographic hash chain.
- No distributed locking.
- No database transaction isolation.
- No remote log shipping.
- Rotated audit files are not included in `AuditLog.query()`.

## When to Migrate

Consider migrating to SQLite or another database when MyClaw needs:

- indexed audit queries across rotated history
- concurrent multi-process writers at higher volume
- transactional updates across approvals/proposals/memory
- tamper-evident audit storage
- remote sync or centralized policy/audit review
