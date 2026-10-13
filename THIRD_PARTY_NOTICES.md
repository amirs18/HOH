# pi-autoresearch

This rewrite starts from https://github.com/davebcn87/pi-autoresearch at commit
`04b8a50dac7efe80ffc91648bd00ed9b022e24c2` (package version 1.9.0).
An unmodified download is preserved under `vendor/pi-autoresearch/`, including its MIT license.

`src/autoresearch/jsonl.ts`, `compaction.ts`, and `paths.ts` are adapted from that
extension. The structured METRIC parser in `src/measurement.ts` is derived from
its index.ts. The native tool cycle, file-based session memory, deterministic
compaction and disk rehydration are retained. HoH replaces model-selected status
and metric values with verifier-derived decisions, uses isolated worktrees, and
does not inherit upstream's reset/clean commands on the user's checkout.

Original attribution: Copyright (c) 2026 Tobi Lutke, David Cortés. MIT license
text is included in LICENSE and vendor/pi-autoresearch/LICENSE.
