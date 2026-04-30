# Fixtures — captured stream-json sessions

Real `claude -p --output-format stream-json --verbose` outputs against CLI
**2.1.119**. Source of truth for the parser. Per DESIGN.md, the parser must
be a pure function over fixtures.

## Files

| File | Mode | Prompt | Notes |
| --- | --- | --- | --- |
| `01-simple-text.ndjson` | opus, default | "Reply with: hello" | Baseline event surface |
| `02-single-tool-use.ndjson` | haiku, bypassPermissions | Read README → first heading | One Read call + thinking |
| `03-multi-tool-use.ndjson` | haiku, bypassPermissions | Read README+DESIGN | Multiple tool calls |
| `04-partial-messages.ndjson` | haiku, `--include-partial-messages` | Reply with sequence | Delta-streaming format |
| `05-permission-probe.ndjson` | haiku, default | Bash `echo` | Bash auto-allowed (user config) |
| `06-forced-error.ndjson` | invalid model | "hi" | API error surface |
| `07-permission-denied.ndjson` | haiku, `--tools Read`, default | Force MCP tool use | **Permission denial in -p mode** |

## Observed event taxonomy (CLI 2.1.119)

The wire format **does not match** DESIGN.md's `BaseEvent`. There are no
`turnId`/`seq`/`ts` fields — events have `type` + (sometimes) `subtype` +
`uuid` + `session_id` and otherwise vary freely. We synthesize `seq`/`ts`
in the parser.

### All observed `(type, subtype)` pairs

| Wire shape | Where seen | Maps to design event |
| --- | --- | --- |
| `system/init` | every session | `session.init` (rename `claude_code_version`→`cliVersion`, `mcp_servers`→`mcpServers`) |
| `system/hook_started` | every session start (×4) | new event: `system.hook_started` |
| `system/hook_response` | every session start (×4) | new event: `system.hook_response` |
| `system/post_turn_summary` | every successful turn | new event: `system.post_turn_summary` |
| `system/status` | partial-messages mode | new event: `system.status` (e.g. `status:"requesting"`) |
| `assistant` (no subtype) | one per content block | `assistant.message_complete` (atomic) |
| `user` (no subtype) | tool result | `tool.result` (extracted from content blocks) |
| `stream_event` (no subtype, has nested `event.type`) | with `--include-partial-messages` | `assistant.message_start`, `assistant.text_delta`, `assistant.thinking_delta`, `assistant.message_complete` (mapped from nested SDK events) |
| `rate_limit_event` | every session | new event: `system.rate_limit` |
| `result/success` | end of every session | `session.done` (rich superset) |

### Notable schema details

**1. `assistant` events are content-block-atomic, not turn-atomic.**
Each `assistant` event carries one (or sometimes more) content blocks: a
`thinking`, `tool_use`, or `text` block. A single turn can produce multiple
`assistant` events.

**2. `user` events carry tool results.** Shape:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "tool_use_id": "toolu_...",
      "content": "...",
      "is_error": null | true
    }]
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "...",
  "timestamp": "..."
}
```

**3. Partial messages mode emits standard SDK delta events.** With
`--include-partial-messages`, every `stream_event.event.type` is one of
the standard Anthropic SDK streaming events: `message_start`,
`content_block_start`, `content_block_delta` (with `delta.type` of
`text_delta`, `thinking_delta`, `signature_delta`, or `input_json_delta`),
`content_block_stop`, `message_delta`, `message_stop`. Plus a top-level
`ttft_ms` field on the wrapper.

**4. `init` event** has these fields: `cwd`, `session_id`, `tools` (full
list), `mcp_servers` (with status: `connected`|`failed`|`pending`),
`model`, `permissionMode`, `slash_commands`, `apiKeySource`,
`claude_code_version`, `output_style`, `agents`, `skills`, `plugins`
(with `path` and `source`), `analytics_disabled`, `memory_paths`,
`fast_mode_state`. Field-name drift from DESIGN.md throughout.

**5. `result` event** carries: `is_error`, `api_error_status`,
`duration_ms`, `duration_api_ms`, `num_turns`, `result` (final assistant
text), `stop_reason`, `total_cost_usd`, `usage` (rich), `modelUsage` (per
model), `permission_denials` (array of denied tool calls),
`terminal_reason`, `fast_mode_state`. Even on error,
`result.subtype === "success"` — error state is signaled by
`is_error: true` + `api_error_status` + the textual `result`.

**6. `apiKeySource`** observed values include `"none"` (OAuth/keychain).
Maps cleanly to design's `authMode: "subscription" | "apikey" | "unknown"`.

**7. `--cwd` is NOT a CLI flag.** Set via Node `spawn(..., { cwd })`.

**8. `--print` requires stdin OR a prompt arg.** When piping from a slow
command, redirect stdin explicitly (`< /dev/null`) or you'll get a 3s
warning and possibly the error `Input must be provided either through
stdin or as a prompt argument when using --print`. Empty `--tools ""`
also broke arg parsing in our probes.

## Phase 4 answer: how does `-p` mode handle permission requests?

**Resolved.** Fixture `07-permission-denied.ndjson` shows the actual behavior:

- `-p` mode does **NOT** prompt interactively for permission.
- Tool calls that aren't pre-approved are **denied automatically** with a
  synthetic `tool_result` content block containing
  `is_error: true` and content
  `"Claude requested permissions to use <tool>, but you haven't granted it yet."`
- The model receives the denial as a tool_result and adapts its response.
- The final `result` event's `permission_denials` array lists every denied
  call with `tool_name`, `tool_use_id`, `tool_input`.
- There is **no `permission_request` event** in the wire format. There
  is no stdin protocol for responding to prompts.

### Implications for CDK design

- `Session.respondToPermission()` cannot exist as a runtime API in this CLI
  version — there are no live prompts to respond to.
- DESIGN.md's `tool.permission_request` event becomes informational only,
  synthesized by the parser from denied `tool_result` blocks (or
  retroactively from `permission_denials`).
- The supported permission model in CDK is **preapproval via
  `--allowedTools`/`--allowed-tools` and `--permission-mode`**. Consumers
  configure tools up-front; runtime gating isn't supported.
- This matches DESIGN.md's "Possibility (2)" — pre-approval only.

## Major design tension: `--bare` vs subscription auth (resolved)

**Decision: option C — make `--bare` a `SessionOptions` flag, default off.**
The parser handles hook events as first-class events
(`system.hook_started`, `system.hook_response`). With `--bare` set, those
events don't fire; without it, they do. Either way, downstream consumers
get a typed event stream.

`--bare` requires `ANTHROPIC_API_KEY` (OAuth and keychain are not read).
Subscription users must run without `--bare`.

## Recommended Phase 1 spawn args (revised, evidence-based)

```
claude -p
  --output-format stream-json
  --verbose                              # required for stream events
  --input-format stream-json             # for streaming input (Phase 2+)
  [--include-partial-messages]           # opt-in delta streaming
  [--include-hook-events]                # opt-in (default already includes some hook events)
  [--allowed-tools <list>]
  [--disallowed-tools <list>]
  [--tools <list>]                       # restrict built-in set; "" breaks arg parsing
  [--model <name>]
  [--system-prompt <text>] | [--append-system-prompt <text>]
  [--mcp-config <path-or-json>]
  [--permission-mode default|auto|acceptEdits|bypassPermissions|dontAsk|plan]
  [--no-session-persistence]
  [--session-id <uuid>] | [--resume <id>]
  [--bare]                               # opt-in; forces ANTHROPIC_API_KEY
< /dev/null                              # silence stdin warning when prompt is in argv
```

`cwd` is set on the child process spawn options, **not** a CLI flag.

## Cost discipline

- Each fresh `-p` invocation creates ~30K tokens of cache (hooks + plugins +
  CLAUDE.md). Cost of first prompt with Opus: ~$0.18. With Haiku: ~$0.02.
- Use `--no-session-persistence` for fixtures so they don't pollute the
  user's session list.
- Use `--model claude-haiku-4-5-20251001` for fixture capture; wire format
  is identical to other models.
