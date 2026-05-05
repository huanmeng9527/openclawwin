# Stable Fact Candidates and L3 Memory Proposals

MyClaw can derive stable-fact candidates from L2 session summaries, but it does **not** automatically promote L2 content into L3 Semantic Memory.

## Why L2 Does Not Automatically Become L3

L2 session memory is conversational and episodic. It may contain temporary plans, mistakes, tool output, approval events, or short-lived task state. L3 semantic memory is long-term knowledge, preferences, project notes, and decisions. Moving information from L2 to L3 requires explicit review.

The proposal flow creates a review queue instead of writing semantic memory directly.

## Candidate Extraction

`StableFactExtractor` uses deterministic heuristics. It does not call a real model.

It looks for sentences containing stable-memory keywords such as:

- `remember`
- `preference`
- `always`
- `never`
- `project`
- `decision`
- `fact`
- `用户偏好`
- `决定`
- `长期`
- `记住`

It skips obvious noise such as tool calls, tool errors, approval/audit logs, workspace sandbox errors, and temporary error text.

Each candidate includes:

- `type`: `semantic_fact`, `preference`, `project_note`, or `decision`
- `content`
- `confidence`
- `reason`
- `sourceSessionId`
- `sourceSummaryId`
- `sourceEventIds`
- target hint: `facts`, `preferences`, `project_notes`, or `decisions`

## Proposal Lifecycle

Candidates become `MemoryProposal` records stored with atomic JSON writes at:

```text
$MYCLAW_HOME/memory/proposals/proposals.json
```

If the proposals file is corrupt, MyClaw backs it up as `proposals.json.corrupt.<timestamp>` and safely starts with an empty proposal set.

Lifecycle:

1. `createProposal(candidate, context)` creates a pending proposal and does not write L3.
2. `approveProposal(id, context, reason)` marks it approved after permission checks.
3. `rejectProposal(id, context, reason)` marks it rejected and blocks future L3 write.
4. `writeApprovedProposal(id, context)` writes approved content to L3 through `MemoryRouter.write(..., "semantic")`.
5. A written proposal is idempotent; repeated writes do not create duplicate semantic records.

Statuses:

- `pending`
- `approved`
- `rejected`
- `written`

## Permissions

Approving/rejecting proposals requires one of:

- `approval.memory.write`
- `memory.write`
- `policy.change`
- `approval.admin`

Writing an approved proposal to L3 still goes through `MemoryRouter` and `MemoryPolicyGate`. Semantic writes require `memory.write` or an equivalent approval permission. Procedural memory never grants memory-write permission.

## SessionCompactor Integration

`SessionCompactor` can create proposals after generating an L2 summary when enabled:

```json
{
  "memory": {
    "proposals": {
      "enabled": true,
      "autoCreateFromCompaction": false,
      "minConfidence": 0.7,
      "maxCandidatesPerSummary": 5
    }
  }
}
```

`autoCreateFromCompaction` defaults to `false`. Even when it is enabled, compaction creates pending proposals only; it does not write L3.

## CLI

```bash
myclaw memory proposals list
myclaw memory proposals show proposal_123
myclaw memory proposals approve proposal_123 --reason "Stable preference"
myclaw memory proposals reject proposal_123 --reason "Too temporary"
myclaw memory proposals write proposal_123
```

The CLI does not bypass the proposal store, `MemoryRouter`, memory policy, or audit logging.

## Audit Events

Proposal lifecycle events are written to AuditLog:

- `memory.proposal.created`
- `memory.proposal.approved`
- `memory.proposal.rejected`
- `memory.proposal.written`
- `memory.proposal.write_denied`

Audit metadata is sanitized and truncated.

## Current Limitations

- No real LLM extractor.
- No UI review queue.
- No embedding/vector index.
- No daemon/background worker.
- No automatic promotion into L3.
- Heuristics may miss nuanced stable facts or produce false positives.

Future work can add a model-backed extractor, UI review, deduplication against existing L3 records, and human-reviewed stable fact promotion.
