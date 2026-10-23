# omp-elixir-workbench

Ash + Elixir coding-workflow enforcement for [oh-my-pi](https://github.com/oh-my-pi/pi).
One routing layer that makes the right capability unavoidable at the right
moment — for both Ash DSL code and plain Elixir:

| Question | Route |
|---|---|
| Ash DSL (resources, actions, policies, attributes…) | `ash_inspect` / `ash_search` / `ash_validate` / `ash_forbidden` (ash_agent_tools daemon) |
| DSL entity edits (add/replace/remove an action, attribute…) | `ash_edit` — semantic, dry-run → digest handshake → write, post-edit gate |
| Plain Elixir symbols (definitions, references, rename) | OMP native `lsp` tool (Expert) — or serena when configured |
| Runtime behavior of the running app | Tidewave (`project_eval`) |
| Verification before done | `ex_check` levels `fast` / `focused` / `complete` + iron-laws judge |
| Whole-stack health | `ex_doctor` |

The plugin does not replace those tools; it nudges (or, for Ash DSL edits,
optionally blocks) until they were used, and records verification evidence at
session stop.

## Install

Marketplace (any machine):

```
omp plugin marketplace add lukegalea/omp-elixir-workbench
omp plugin install omp-elixir-workbench@omp-elixir-workbench
```

Path entry (sibling checkout, e.g. next to your Elixir project):

```yaml
# <project>/.omp/config.yml
extensions:
  - ../omp-elixir-workbench
```

Entries that do not resolve are skipped, so cloners without the sibling
checkout are unaffected. Disable per project with
`disabledExtensions: ["extension-module:omp-elixir-workbench"]`.

## Configuration

Project file `<project>/.omp/ex-workbench.json` (all keys optional, unknown
keys ignored; malformed JSON falls back to defaults):

```jsonc
{
  "daemonUrl": "http://127.0.0.1:4197",
  "symbolRoute": "lsp",            // "lsp" | "serena" — nudge wording + doctor reporting
  "editGate": "nudge",             // "nudge" | "block" | "off" (Ash-declaring files only)
  "sessionGate": true,             // session-stop verification gate
  "usageLookback": 15,             // tool calls considered "recent"
  "checks": {
    "complete": ["mix", "precommit"] // argv array (or a single string split on spaces)
  }
}
```

Environment overrides (highest precedence):

- `OMP_EXWB_DAEMON_URL` — daemon base URL
- `OMP_EXWB_SYMBOL_ROUTE` — `lsp` | `serena`
- `OMP_EXWB_EDIT_GATE` — `nudge` | `block` | `off`
- `OMP_EXWB_SESSION_GATE` — `0`/`false` disables
- `OMP_EXWB_DISABLE` — any value kills the extension at load (registers nothing)

## Gates

- **DSL search nudge** (trusted context): grepping/finding over Ash DSL
  markers (`actions do`, `policies do`, `use Ash.Resource`, …) steers to
  `ash_inspect`/`ash_search` — text search cannot see transformer-injected
  declarations or the compiled contract.
- **Edit nudge/block**: editing an Ash-declaring `.ex` file without recent
  `ash_*` tool usage → nudge naming `ash_inspect` + `ash_edit`; editing a
  `lib/**/*.ex` file without recent symbol-tool usage → nudge toward
  `lsp` references/symbols. `editGate: "block"` hardens the Ash branch into
  a block. Test files are low-risk (never nudged).
- **Session-stop completion gate** (main sessions only): blocks finishing
  when `.ex` files were edited but no matching `ex_check` evidence exists
  (evidence must be at level `focused`/`complete`, for the same HEAD and
  dirty count, taken after the last edit). After 2 blocks for the same
  digest the block downgrades to advisory context — the session can never
  be wedged.

## Daemon lifecycle

`ash_inspect`/`ash_edit`/`ex_doctor` talk to the ash_agent_tools MCP daemon
(`mix ash_agent.serve --port 4197`, loopback, compile-only VM — keep it out
of the `iex -S mix phx.server` VM).

- `/ash-daemon start` — starts it (tmux session when inside tmux, else nohup;
  log at `~/.cache/omp-elixir-workbench/daemon-4197.log`)
- `/ash-daemon status` / `/ash-daemon stop`
- or a service manager: `devenv run ash-agent` equivalent

`ex_doctor` reports daemon reachability, source-freshness (`ash_reload`
when stale), tidewave, the `expert` LSP binary, serena config, `mix`,
the `ash_agent_tools` dep, and usage-rules sync drift
(`MIX_ENV=dev mix usage_rules.sync --check` — the same gate keystone CI
runs, surfaced before an agent reasons from stale AGENTS.md text). It
never boots the application itself.

## Development

```
bun install
bun test
```

Typecheck (`tsc --noEmit`) is advisory — see `.github/workflows/ci.yml`.
