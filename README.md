# Baton

Pass the conversation. Keep the context.

Continue a conversation in another coding agent when you hit a usage limit. A local TypeScript CLI running on Bun, with no runtime dependencies or model API calls. Native Codex hydration and title registration use the installed local app-server; no model turn is started.

Claude Code ↔ Codex CLI use native resumable transcripts. Local Codex Desktop conversations are accepted as input. ChatGPT uses its `conversations.json` export as input and a Markdown handoff as output.

## Start

Clone and build with [Bun](https://bun.sh). The resulting standalone executable runs without installing runtime dependencies:

```sh
git clone https://github.com/tylergibbs1/agent-baton.git
cd agent-baton
bun install --frozen-lockfile
bun run build
```

```sh
./dist/baton list
./dist/baton inspect claude:latest
./dist/baton convert claude:latest --to codex --install --dry-run
./dist/baton convert claude:latest --to codex --install
```

The last command prints a ready-to-run `codex resume ID -C PROJECT` command. For the reverse direction:

```sh
./dist/baton convert codex:latest --to claude --install
```

Use a full session ID, a unique prefix of at least six characters, or a transcript path when you want a specific conversation. `latest` means the most recently modified local transcript for that provider, including potentially active sessions. `list` excludes Claude subagent transcripts; explicit paths can convert one independently. Parent conversion automatically gathers Claude child transcripts and Codex child rollouts identified by recorded agent IDs; children are exported as separate native subagent transcripts with fresh IDs and remapped parent relationships.

## Run from source

```sh
bun install
bun run start --help
bun run start list --source claude --limit 10
bun run build
```

To make the source CLI available on your PATH, run `bun link` from this directory. Its entrypoint is `src/cli.ts` and requires Bun. The compiled executable does not.

## Choose how much history to carry

`--history full` is the default. It transfers the selected conversation branch and recovers older Claude history across compaction boundaries. Source bytes, including alternate branches and unsupported records, are archived unchanged.

For a long-running conversation, `--history active` carries the current post-compaction context and leaves older history in the original archive. It uses Claude's active parent chain or Codex's latest replacement history. This often fits the destination model's context window better:

```sh
baton inspect claude:latest --history active
baton convert claude:latest --to codex --history active --install
```

No history mode silently truncates messages. Full history can exceed a model's context window; the CLI reports large transfers. Some Claude versions rewrite preserved-message parents after compaction. When the original parent is unavailable before the boundary, the converter uses the final main-conversation message recorded before that boundary and reports this reconstruction. Missing ancestors and excluded branches are also reported.

## Commands

Use the current conversation without looking up its ID:

```sh
bun run build
./dist/baton setup
```

Setup installs `/baton` in Claude Code and an explicit Baton skill in Codex. Select Baton from the Codex app skill picker; in Codex CLI invoke `$baton`. Reload skills or restart the client after installation. The command hands the exact current conversation to the other client, installs its full native family, and returns a resume command. It does not launch a destination model turn. Helpers are standalone copies, so moving the source checkout does not break installed commands. Reinstall with `setup` after upgrading; customized or unowned commands are preserved and reported as conflicts.

Slash/skill dispatch can require remaining model quota. The conversion itself does not. If you already reached your limit, run the installed helper from a terminal:

```sh
~/.claude/skills/baton/scripts/baton handoff --from claude --session CURRENT_SESSION_UUID
~/.codex/skills/baton/scripts/baton handoff --from codex --session CURRENT_SESSION_UUID
```

The commands obtain Claude's `${CLAUDE_SESSION_ID}` or Codex's `CODEX_THREAD_ID` from trusted client context. An external terminal requires the explicit UUID. Handoff refuses latest/prefix selectors and ambiguous client environments. Use `--dry-run` to preview, `--history active` for post-compaction context, or `--out` to select a bundle directory. Default bundles live under the source client's `baton/handoffs/`; identical snapshots reuse the completed import. No usage monitor or automatic switch is installed.

Setup accepts `--client claude|codex|all`, `--bin /path/to/baton`, and `--dry-run`. It changes only owned Baton skill/helper files, with conflict checks and atomic directory replacement. It does not edit client settings or existing commands.

| Command | Purpose |
| --- | --- |
| `list` | Discover local sessions; filter by `--source`, `--search`, or `--cwd`; paginate with `--limit` and `--offset` |
| `branches SESSION` | List branch leaves; choose one with `--branch NODE` on inspect/convert |
| `inspect SESSION` | Preview the transfer; optionally choose `--to` and `--history` |
| `convert SESSION --to TARGET` | Create a new conversion bundle |
| `convert … --install` | Also install a new native Claude/Codex session and print its resume command |
| `convert … --dry-run` | Preview paths, message counts, caveats, and resume arguments with no writes |
| `verify BUNDLE` | Check each archived/generated file against its SHA-256 checksum |
| `undo BUNDLE` | Remove the installed session only if it has not changed; preserve the bundle |
| `doctor` | Check installed binaries, stores, versions, and capabilities |
| `handoff` | Hand the exact current session to the other client |
| `setup` | Install Claude/Codex commands and standalone helpers |
| `schema [COMMAND]` | Print JSON Schema input/output contracts and mutation/trust information |
| `read SESSION` | Read a bounded historical message window; private reasoning and inline binary data excluded |

Targets: `claude`, `codex`, `chatgpt`, `portable`. Use `--out NEW_DIRECTORY` to choose the bundle path. Existing directories are never overwritten. A matching idempotency key can reuse a completed bundle at the same output path. `--cwd PROJECT` changes the destination workspace; installed sessions require an existing directory. Project files are not copied. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are respected.

## ChatGPT

```sh
baton list --input /path/to/conversations.json
baton convert /path/to/conversations.json --conversation ID --to claude --install --cwd /path/to/project
baton convert codex:latest --to chatgpt --out ./chatgpt-handoff
```

For ChatGPT output, upload `conversation.md` to a new chat and ask it to continue from the last turn. A multi-conversation export requires `--conversation ID`. The current branch transfers by default. Use `branches` and `--branch NODE` to choose an alternate branch; the complete mapping tree stays archived. Native ChatGPT history insertion remains unsupported.

There is no native ChatGPT desktop/cloud history insertion. Codex native imports are verified with CLI/app-server readers; appearance in the Desktop sidebar is not guaranteed. No desktop database is edited.

## What transfers

- User and assistant text remains in order, including code and user constraints.
- Tool calls, arguments, outputs, error markers, original roles, and call/result IDs survive native round trips in bridge extensions. Destination readers see labeled historical text; tools are never replayed or registered.
- System/developer/tool messages become labeled conversation history. Destination policies, approval settings, credentials, and model selection remain the destination's own.
- Private reasoning is excluded from the resumed context. Original reasoning bytes, if present in the source, remain in the archive.
- Inline and local attachments are copied into checksum-verified `assets/` files. User images map into native Claude and Codex content blocks; PDFs map into Claude document blocks. Other documents/audio/video remain accessible through explicit local file links. Remote URLs and cloud-only asset IDs are reported as unresolved; no authenticated download is attempted.
- Unknown content blocks become labeled text. UI events, usage counters, provider-specific settings, and source metadata remain archived.
- Native message timestamps now preserve valid original timestamps. Destination creation time and IDs are fresh; original identity and creation/update times remain in the metadata.

## Metadata conversion

Version 0.2 introduced typed session/message metadata and an inspectable metadata report. This happens automatically; existing conversion commands continue to work.

| Field | Destination behavior |
| --- | --- |
| Conversation title | Claude custom title; Codex native name registration with `--install`; ChatGPT handoff heading |
| Tags | Latest Claude tag is mapped; all tags survive in the portable/native bridge metadata |
| Git branch | Native Claude and Codex metadata; no checkout is performed |
| Git commit/repository | Native Codex fields when valid; preserved for other destinations |
| Message timestamps | Valid original timestamps mapped to native messages; original representations retained |
| Original IDs/ancestry | Preserved as provenance while fresh native IDs avoid collisions |
| Session creation/update times | Historical times preserved; the imported session has a fresh creation time |
| Historical models | Preserved globally and per message; Claude assistant model attribution is mapped when available |
| Usage and cost | Provider-attributed historical usage is normalized; raw usage/cost fields are preserved. Claude-origin message usage can be restored to Claude history. Foreign totals are not presented as destination billing |
| Reasoning effort/runtime settings | Preserved with source attribution; no cross-provider model or permission settings are activated |
| Provider-specific metadata | Opaque metadata records, per-message fields, and native `session_bridge` extensions retain fields the destination does not interpret |

`metadata.json` contains session-level metadata and a message metadata index. `session.json` carries the same typed data alongside the conversation. Native files embed bridge metadata so original timestamps, IDs, settings, unknown fields, and provenance survive a Claude → Codex → Claude conversion even when only the native transcript is passed to the next conversion.

Claude streamed/repeated message usage is deduplicated by response identity. Codex uses the latest cumulative thread totals when present, rather than adding snapshots together. Usage describes the source's recorded history, including data outside a selected active branch, and is not a promise about the target's context usage or cost.

`inspect --json` and the conversion manifest expose `metadata.native`, `metadata.preserved`, `metadata.fresh`, and explanatory notes. Missing/unsupported fields are preserved rather than guessed. Conversation text, attachments, and file contents are handled separately; the unchanged original source archive is the complete fallback.

Native Codex registration hydrates stored sessions with `thread/resume` and registers titles without starting a model turn. Hydration populates the native history index; destination-added initialization records are included in the bundle checksums. It uses the installed app-server's local storage API and target account configuration; the converter does not inspect credential files or copy credentials into active destination settings. Metadata may contain sensitive source identifiers, so its files use the same private modes as the conversation bundle.

## Context continuity (0.3)

Native Claude/Codex conversions create separate child transcripts and remap parent IDs, nesting depth, names, and supported roles. Codex imports include native subagent-call items in the parent transcript and paginated child history. Claude imports use the native `SESSION_ID/subagents/agent-ID.jsonl` layout, metadata sidecars, and completed historical Agent links. The parent retains each child’s last assistant response and a link to its full transcript, while its final main turn remains the continuation point. Imported agents are historical; conversion never starts their work. Claude task notifications with source system provenance become native Codex agent events when their child or spawn ID resolves, preserving chronological failed/completed outcomes and results. Other recognized task notices become readable historical notices. User-authored XML remains user text. Complete notification XML, worktree details, and unknown fields survive in bridge metadata and the archive; in-progress source work is imported paused. Provider-specific roles are preserved in the archive and mapped to supported destination roles. Claude child discovery uses the parent's `SESSION_ID/subagents/` directory. Codex child discovery uses recorded spawn results and collaboration receiver IDs. Original child transcripts and Claude metadata sidecars are archived under `sources/`; structured child messages remain in `context.json`; native child files retain message provenance in bridge extensions. `manifest.json` exposes `subagents` with source IDs, fresh destination IDs, parent IDs, depth, artifact paths, and installed paths. Portable and ChatGPT targets retain supplemental context. Missing, unreadable, and capped discovery is reported. Discovery follows at most 128 transcripts.

Claude recorded memory, session context, instructions, plans, relevant hook summaries, and edited-file snippets transfer as labeled source history. Codex's latest retained compaction context, verified answers, and readable inter-agent communications transfer alongside the selected main history. Encrypted communications and private reasoning are not restored as active context. Current destination instructions and permissions still apply.

```sh
baton branches /path/to/conversations.json --conversation ID
baton convert /path/to/conversations.json --conversation ID --branch NODE --to claude --install
baton branches claude:SESSION_ID
baton convert claude:SESSION_ID --branch MESSAGE_UUID --to codex --install
```

Choose alternate branches from the original source. Portable/native exports retain the selected branch and an inventory; `source-original.json[l]` holds the other branches. Codex rollouts are sequential; choose another rollout rather than `--branch`.

Workspace checks run on conversion, including dry runs. They record the Git root/branch/commit, hashes of uncommitted and untracked files up to 64 MiB, and existence of paths referenced in tool arguments. Moving between workspaces compares those hashes and reports missing files or different revisions. The source snapshot is preserved for later comparisons. This is a file/reference check, not a semantic build check; files, Git checkouts, and permissions are not changed.

```sh
baton convert claude:latest --to codex --install --cwd /project --workspace-check strict --dry-run
```

`--workspace-check warn` is the default. `strict` rejects mismatches before writing; `off` skips the check. Attachment copying still runs when workspace checks are off. A bundle can be moved and its asset references resolve relative to `session.json`. Native user images carry inline data independently of the bundle; linked documents need the bundle retained. Keep the full bundle when handing off to ChatGPT and upload relevant attachment files separately, since Markdown upload does not attach referenced files automatically.

Attachments are limited to 64 MiB each and 256 MiB total. Invalid/oversized data and changed bundled checksums fail conversion. Missing files and unavailable cloud assets produce explicit warnings. The manifest verifies nested asset and child-source files as well as top-level artifacts.

## Conversion bundle

```text
bridge-exports/NEW_UUID/
  manifest.json          # capabilities/caveats, IDs, paths, resume argv, checksums
  session.json           # typed provider-neutral conversation and metadata
  metadata.json          # source metadata, usage, settings, and message provenance
  source-original.jsonl  # original input bytes (.json for JSON inputs)
  conversation.md        # readable handoff including supplemental context
  context.json           # subagent transcripts, memory, retained context, communications
  branches.json          # branch inventory and selected node
  workspace.json         # Git/dirty-file/reference checks and source comparison
  assets/                # local and inline attachment bytes
  sources/               # original child transcript/metadata bytes
  children/              # separate native child transcripts and Claude sidecars
  codex.jsonl            # native target, or claude.jsonl
```

Bundles have mode `0700`; files have mode `0600`. Conversion creates a fresh UUID and never modifies the source session. Installation uses an exclusive create. Codex titles are registered through local `thread/name/set` storage RPC; failures are reported while the title remains archived. `undo` preflights the parent and every child, refusing the whole operation if any transcript or sidecar changed after installation. Matching idempotent retries reuse the same child IDs and check all installed family members. Registered Codex imports are removed through local `thread/delete` so their native title/index metadata is removed too.

## Agent use (0.4)

The command definitions and input validation share one contract. `schema COMMAND --json` returns JSON Schema for request and full-result shapes, whether the command mutates storage, and the trust boundary. `COMMAND --help --json` returns the same machine-readable contract. Input schemas use literal flag names; positional session/bundle references become `session` or `bundle` in JSON requests. Defaults are published in the schemas. Unknown fields, wrong types, invalid enums, control characters, and invalid selectors fail before writes. Semantic checks such as install capabilities and workspace existence still run after shape validation.

```sh
baton schema convert --json
baton list --json --fields sessions.id,sessions.source,sessions.title,nextOffset,complete
baton read claude:SESSION_ID --offset 0 --limit 5 --max-bytes 8192 --json
baton inspect claude:SESSION_ID --json --fields sourceSha256,messages,warnings
```

JSON is automatic when piped or when `--request` is used. `--json` forces JSON output; `--human` or `--output human` requests readable output. JSON is compact by default; `--pretty` adds indentation. `--output ndjson` emits one result per line, with no indentation. `--fields` selects comma-separated dot paths and projects array elements, for example `messages.blocks.callId`; it does not rewrite or reduce saved bundle artifacts. Unknown selectors fail before mutation. Projected responses contain only selected fields, so choose integrity/truncation indicators when needed.

Pass JSON requests inline, by file, or through stdin. Request input is separate from output formatting; the existing `--json` flag keeps its output-only meaning. Requests cannot be mixed with positional arguments or command-specific flags, avoiding ambiguous overrides. Requests are limited to 1 MiB. `--request -` requires piped stdin and never prompts.

```sh
baton convert --request - --fields sessionId,output,warnings,resumeArgv <<'JSON'
{
  "session": "claude:SESSION_ID",
  "to": "codex",
  "out": "./handoff",
  "install": true,
  "dry-run": true,
  "idempotency-key": "handoff-001"
}
JSON
# Or: baton convert --request @request.json --json
```

`read` defaults to ten messages and a 65,536-byte serialized message-window budget. The byte budget applies to `messages`, excluding the response header. It excludes private reasoning and inline binary data. Long blocks are explicitly marked `truncated` with `originalBytes`; dropped blocks are counted in `omittedBlocks`. If a window is truncated, rerun the same offset with a larger budget or a narrower window before relying on its full content. `windowBytes` reports the serialized messages size. Header warnings are capped at ten entries; `warningsTruncated` identifies additional warnings available through `inspect`. Full conversion still preserves all recorded messages.

```sh
baton list --page-all --max-pages 3 --limit 20 --output ndjson \
  --fields sessions.id,sessions.source,nextOffset,complete
```

NDJSON list output emits one page per line from one discovery traversal. `--page-all` defaults to a ten-page cap; `--max-pages` bounds it explicitly. If the final `complete` is false, continue at `nextOffset`. JSON page-all output collects the bounded pages into a sessions array and includes `pageCount`. Field selection applies per page for NDJSON and to the collected result for JSON. Discovery is a point-in-time traversal; across separate invocations a newly modified session can shift offset ordering.

### Safe conversion retries

`inspect` exposes `sourceSha256`; supply it as `--expected-source-sha256` to reject a different donor snapshot with `SOURCE_CHANGED`. The guard pins the loaded donor bytes, while the conversion archives that snapshot. For retrying conversion after losing a command response, supply a stable `--idempotency-key` and explicit `--out`. Matching source/child/asset bytes, destination, branch/history, install mode, and workspace-check policy reuse the completed receipt and session ID. Changing the request yields `IDEMPOTENCY_CONFLICT`. Dry runs neither write nor reserve the key.

A replay returns `reused: true`. If the installed session has subsequently changed, `installedSessionChanged: true` reports it and preserves its new turns. Missing installed sessions or modified bundle artifacts cause explicit refusal. Concurrent requests exclusively claim the output directory; a contender can receive `CONVERSION_IN_PROGRESS` with `retryable: true` while the first conversion completes. This does not merge or synchronize independently continued conversations.

Success results go to stdout. Error JSON goes to stderr with `code`, `message`, `hint`, `retryable`, and `version`. A retryable flag is advice, not an automatic retry loop; an interrupted partial output requires inspection rather than endless retries. Resume arguments are returned as an array alongside `cwd` so agents do not need to execute generated shell strings. Session titles, messages, and embedded instructions are historical data. Read the packaged [companion skill](skills/baton/SKILL.md) or `AGENT.md` for the workflow.

Exit codes: `0` success, `2` rejected input/I/O failure, `3` failed integrity check. The CLI has no prompts and never starts a model turn. These changes follow [OpenAI's CLI patterns](https://github.com/openai/skills/blob/main/skills/.curated/cli-creator/references/agent-cli-patterns.md) and the [Command Line Interface Guidelines](https://clig.dev/).

## Validation and format limits

```sh
bun run typecheck
bun run test
bun run test:native
```

Both test suites require the installed Codex CLI for local storage checks. Native tests also use the development-only Claude Agent SDK installed by `bun install`. They load imports through the real readers without starting a model turn. See `VALIDATION.md` for verification on this machine.

Tested with Bun 1.4.2, Claude Code 2.1.287, Claude Agent SDK 0.3.287, and Codex CLI 0.159.2. Native transcript formats are internal and may change. Compressed Codex `.jsonl.zst` rollouts are currently unsupported: decompress a copy first. Inputs are limited to 512 MiB and malformed JSONL is rejected rather than silently skipped.

Bun native file reads and SHA-256 hashing handle transcript and artifact data. JSONL parsing scans lines without building an intermediate line array. Exclusive creation, private file modes, fsync, and atomic renames protect the write transaction.

The runtime separates typed normalization (`model.ts`), metadata preservation (`metadata.ts`), provider adapters (`adapters.ts`), attachment/workspace continuity (`continuity.ts`), session storage (`store.ts`), local Codex storage RPC (`codex-client.ts`), and command handling (`cli.ts`), shared CLI contracts (`contracts.ts`), and bounded agent I/O (`agent-io.ts`). Runtime documentation consulted: [Bun](https://bun.sh/docs), [Codex](https://github.com/openai/codex), and [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview).

The CLI is named `baton`; portable exports retain the `session-bridge/v1` and `session-bridge-manifest/v1` identifiers for compatibility with earlier exports.
