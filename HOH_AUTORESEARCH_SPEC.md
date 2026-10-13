# HoH v0.2 — autoresearch foundation

This is the revised implementation direction requested after the first POC. The original `HOH_PI_EXTENSION_SPEC.md` and implementation remain available for comparison; the POC is archived in `archive/poc-v0.1`.

Start from `davebcn87/pi-autoresearch` at `04b8a50dac7efe80ffc91648bd00ed9b022e24c2`. Keep its native Pi experiment cycle, readable file persistence, structured measurement output, disk-based resumption, learned hypotheses, and deterministic compaction. Replace SQLite and separate planner/worker/reviewer orchestration with a smaller native extension.

The model proposes one bounded code change. The extension owns commands, measurement repetition, objective selection and keep/discard policy. The model supplies observations, never authoritative metric values or status. Verification runs from controller-owned assets against exact commits in frozen worktrees. Worker capabilities allow only scoped file edits; evaluator processes run with filesystem/network restrictions. User branches are never reset, cleaned, rewritten, merged or pushed.

Persistence uses an immutable JSON run header, one JSON measurement and decision per experiment, an atomic JSON checkpoint and a derived JSONL history. Replaying frozen config and measurements must reproduce every stored verdict exactly. Invalid files, unknown statuses, mismatched hashes, missing outcomes and interrupted measurements cannot become successful decisions.

Each candidate receives at least two measurements with the same fixed seed. The primary metric is aggregated by median; its spread must be within an explicit absolute tolerance. Requirement outcomes must match across repetitions. Previously verified requirements cannot regress. Mandatory backpressure failures block keep. A kept improvement may be partial; completion requires the target and every requirement to pass. Iteration, no-progress and idle-continuation bounds stop the loop.

Pi and CLI operations: start, run, log, status, inspect, pause, resume, stop, and deterministic context. Start freezes operator-reviewed verifier/configuration definitions; changing them requires a new run. The agent may not update acceptance criteria during the loop. No dashboard service, external publishing, remote mutation, arbitrary hooks, cloud deployment or billing automation.

Determinism applies to measured checks, aggregation, policy and replay for the same inputs. Model hypotheses, runtime timing, machine state and Git timestamps are not promised to be identical across separate runs. Seed-aware verifiers and tolerance selection are part of the reviewed experiment contract.
