# Git-inspired JSON CMS benchmark

This is an external product benchmark, not an implementation request for the HoH extension itself. Run one stage at a time with a controller-owned acceptance suite. Do not claim later stages complete based on earlier tests.

## CMS-1: Collections and document CRUD

Expose an HTTP API backed by durable local persistence. An administrator can create a collection with a typed JSON schema and create, read, update and delete documents. Validate schemas and document types consistently. Reads after process restart preserve content; rejected requests do not partially mutate state.

## CMS-2: Branch isolation

Fork `main` into `beta`. Creating, editing, and deleting documents on `beta` must never affect `main`. Verify isolation through the API and persisted state across restarts. Schema edits must also be isolated. Generate random sequences of create/update/delete/fork/read and compare main to its observed pre-mutation snapshot.

## CMS-3: Immutable commits and merging

Commit a branch revision immutably, read pinned revisions, inspect diffs, and merge with a correct merge base. Verify changed-on-one-side and same-change-on-both-sides behavior, nonconflicting merges, delete/update conflicts, and schema conflicts. A conflict must be returned explicitly without losing either side's changes. Old commits remain immutable after future writes.

## CMS-4: Administrator journeys

Provide browser workflows for collection creation, editing, branch selection, commit/diff inspection and conflict resolution. Test complete journeys with Playwright, screenshots and traces. A successful API test does not establish usability of the browser workflow.

## CMS-5: Audience experiments

Assign visitors deterministically to stable cohorts and pin each variant to an immutable commit. Repeated requests from the same visitor see the same cohort. Updating a branch does not silently change a pinned experiment revision. Administrative changes are auditable.

## CMS-6: Operational behavior

Verify authorization, concurrent updates, meaningful conflict/error responses, persistence recovery and a local deployment smoke. Publishing or deploying to an external service requires a separate explicit instruction. Do not give the worker deployment credentials.

The product goal is an auditable, durable content system whose branch/commit semantics remain correct through realistic API and administrator use. Security, data integrity, and preservation of prior accepted behavior are mandatory throughout.
