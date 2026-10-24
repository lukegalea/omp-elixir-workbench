---
name: ex-routing
description: Use when writing or reviewing Elixir or Ash code in this project — routes Ash DSL questions to ash_agent_tools daemon tools, plain Elixir symbols to the lsp tool (Expert), runtime behavior to Tidewave, and verification to ex_check. Includes the ash_edit dry-run → digest → write handshake.
---

# Ash/Elixir routing (oh-my-pi sessions)

**Scope:** this skill is loaded in oh-my-pi (omp) sessions. Claude Code
sessions follow `.claude/skills/ash-discipline` instead — its serena rule
is the right one there. omp defaults to the native `lsp` tool (Expert runs
with the session); set `symbolRoute: "serena"` in `.omp/ex-workbench.json`
to steer omp's nudges to serena's `find_symbol` /
`find_referencing_symbols` instead.

Pick the tool by question type, not habit. Text search cannot see
transformer-injected DSL declarations (defaults, computed actions) or the
compiled contract — never grep Ash DSL when a semantic tool exists.

| Question | Tool |
|---|---|
| "What fields/actions/policies/relationships does X have?" | `ash_inspect` with target `Module` |
| "What inputs does action X accept?" | `ash_inspect` with target `Module/action` (required/optional/private + types) |
| "What's the Ash context at this file position?" | `ash_inspect` with target `path.ex:LINE` |
| "Where is this symbol? Lost the full name?" | `ash_inspect` with a bare fragment (semantic search) |
| "Would this actor be forbidden?" | `ash_inspect Module` include `policies` (static view); `ash_can` for a verdict with an actor |
| "Add/replace/remove a DSL entity (action, attribute, policy…)" | `ash_edit` — never hand-splice DSL text |
| Plain Elixir symbol: definition, references, rename, hover | `lsp` tool (Expert) — definition / references / symbols / rename |
| Runtime behavior of the running app (eval, inspect state) | Tidewave `project_eval` |
| "Is my edit done?" | `ex_check` — `fast` (iron-laws on diff, seconds) → `focused` (compile + mapped tests + laws) → `complete` (mix precommit) |
| Something daemon-backed fails | `ex_doctor` first |

## Name paths

Every DSL entity is addressable: `Module/section/name`
(`VendorpmKeystone.Lineage.Run/actions/digest` →
`Run/actions/digest`; dot-boundary suffix matching works: `User/actions/read`).
Policies are unnamed — address by occurrence: `Module/policies/policy[0]`.
`ash_inspect` targets accept `Module`, `Module/action`, `path.ex:LINE`, or a
search fragment; unknown actions come back with `did_you_mean`.

## The ash_edit handshake (mandatory)

1. **Inspect** the entity first (`ash_inspect`) — you need its current shape.
2. **Dry-run** `ash_edit` (default): returns the planned diff + `current_digest`; nothing is written.
3. **Write**: repeat with `write: true` and `expected_digest` from step 2. Any file change in between refuses the write (`stale_file`).
4. **Gate**: the CLI recompiles and runs a validate canary; failure auto-reverts the file. Read the gate report verbatim.

Constraints: `body` is the full entity source (`update :check_in do accept [] end`).
Transformer-injected entities (e.g. from `defaults [:read]`) are refused —
edit the declaring construct. `create` takes a section path
(`Module/actions`); placement via `anchor` + `position`.

## Daemon lifecycle

The ash_agent_tools daemon is a compile-only VM on 127.0.0.1:4197 —
separate from `iex-server`; never share the VM. `/ash-daemon start|status|stop`
or `devenv run ash-agent`. Stale sources → call `ash_reload` (or the daemon
self-reloads on file events). `ex_doctor` reports reachability + freshness.
