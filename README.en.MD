# ask

English · [中文](README.md)

**Auto-execute with no confirmation, so you stay productive.**

**A minimalist CLI for talking to an LLM.** Skip remembering commands and flag combinations for `find`, `du`, `ps aux --sort`, and friends — describe what you need and `ask` picks the right commands and summarizes the result.

Built for the "I know what I want but don't want to read a man page or assemble flags" case:

```bash
$ ask find all files in the current directory and sort them by size
$ ask which process is using the most memory?
$ ask what is using port 8080?
$ ask what dependencies does this project use, and which can be upgraded?
$ ask remove all console.log calls under src
$ ask show ERROR logs from the last hour
$ ask add a /health endpoint to this service, with tests
$ ask write an LRU cache with TTL in TypeScript
```

Under the hood it is a ReAct loop: the model calls shell and file-editing tools as needed, commands and results are shown in real time, and the final conclusion follows a fixed format.

```
$ ask "How much data is in the current directory?"
$ du -sh .
  -> exit 0 · 12ms

## Conclusion
The current directory is about 1.2 GB, mostly node_modules (980 MB).

## Evidence
- `du -sh .` -> 1.2G
- `du -sh ./* | sort -hr | head -5` -> ...

## Notes
None
```

Highlights:

- **Evidence first**: the model decides which commands to run; commands and results are shown in the terminal in real time
- **Multi-turn session**: after each answer you stay in the REPL; follow-ups carry the previous context
- **Three built-in tools**: `bash`, `edit_file`, `write_file`
- **Extensible**: Claude-compatible skills and stdio MCP tools
- **Single-file artifact**: `dist/cli.js` bundles its dependencies and does not depend on the repository directory

## Installation

### One command

```bash
./install.sh
```

The script performs these steps:

1. Detects Node.js (>= 20). If missing, downloads the official binary for the platform from `nodejs.org/dist`, verifies sha256, and extracts it to `~/.ask/node/`
2. Installs dependencies with `npm ci` (when a lockfile exists) or `npm install`; retries once on failure
3. Builds the single-file bundle with tsup
4. Installs the launcher to `~/.local/bin/ask`
5. Prompts for a language from a numbered list on every install (default: Chinese); for an existing config only `language` is updated; creates `~/.ask/` and a config template without overwriting other settings
6. Asks whether to configure the model (`base_url` / `model` / `api_key`) after language selection; when a non-empty `api_key` already exists, skipping is the default and reconfiguration is optional
7. Runs `ask --version` as a self-check

If `~/.local/bin` is not on PATH, the script prints the required `export PATH` line. Before installing it checks for another `ask` on PATH and aborts on conflict instead of overwriting an existing command.

### Install options

| Option | Purpose |
|---|---|
| `--bin-dir DIR` | Custom launcher install directory |
| `--link` | Use `npm link` (changes take effect immediately during development) |
| `--no-bootstrap` | Do not download Node; fail if missing or too old |
| `--uninstall` | Remove the launcher, keep `~/.ask/` |
| `--purge` | Remove the launcher and the entire `~/.ask/` |

Environment variables: `ASK_HOME` (default `~/.ask`), `ASK_LANG`, `ASK_MODEL`, `ASK_BASE_URL`, `ASK_API_KEY`, `NODE_VERSION` (default `22.11.0`), `ASK_NODE_BASE_URL` (default `https://nodejs.org/dist`). Setting any model variable skips the interactive prompt and updates only the fields you provide.

Running `install.sh` again is idempotent and can be used to upgrade; configuration, history, and logs are preserved.

## Configuration

```bash
ask model
```

On macOS the file is opened with the system `open` command; other platforms use `$EDITOR` (falling back to `vi`/`nano`). `ASK_EDITOR` can override the editor. If the file does not exist, a template is written before opening it. The model can also be configured during the first install; use `ask model` afterwards to change it.

```json
{
  "provider": "openai-compatible",
  "language": "zh",
  "base_url": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "api_key": null,
  "max_steps": 12,
  "command_timeout_ms": 30000,
  "max_output_bytes": 262144,
  "temperature": 0,
  "context_window_tokens": 128000,
  "context_evict_ratio": 0.95,
  "skills": { "enabled": true, "project": true },
  "mcp": { "enabled": true, "maxTools": 128 }
}
```

| Field | Default | Description |
|---|---|---|
| `language` | `zh` | Response and UI language. Accepts `en`, `ja`, `fr`, `pt-BR`, etc. Replies use this language; the welcome page and command help only ship Chinese/English, so other languages fall back to English |
| `base_url` | `https://api.openai.com/v1` | API root URL; a mistakenly appended `/chat/completions` is stripped automatically |
| `model` | `gpt-4o-mini` | Model name |
| `api_key` | `null` | The key itself; a missing key fails at startup |
| `max_steps` | `12` | Maximum LLM calls per question; exceeding it ends the turn with an error |
| `command_timeout_ms` | `30000` | Kill the whole process group after a command times out |
| `max_output_bytes` | `262144` | Per-stream stdout/stderr limit; keeps head and tail and marks truncation |
| `temperature` | `0` | Sampling temperature |
| `context_window_tokens` | `128000` | Estimated context window |
| `context_evict_ratio` | `0.95` | Evict the oldest turns once this fraction of the window is used |
| `skills` | `{ enabled: true, project: true }` | Whether local skills are loaded; `project` controls project-level skills |
| `mcp` | `{ enabled: true, maxTools: 128 }` | Whether MCP servers are started, and the MCP tool limit |

`provider` is informational only; the protocol is always OpenAI-compatible. The config file is written with mode 0600; startup warns when permissions are too open. Configuration is reloaded on every question, so edits take effect without restarting the session.

Any OpenAI-compatible service works: DeepSeek, Kimi, local vLLM, Ollama, etc. Just change `base_url` and `model`.

## Usage

```bash
ask "How large is the current directory?"   # answer once, then enter the REPL
ask                                          # enter the REPL directly
ask model                                    # edit model configuration
ask --version                                # print version (-v works too)
ask --help                                   # help
```

Inside the REPL (an interactive terminal shows the colored welcome page and prompt immediately; skills and MCP load concurrently in the background without blocking questions, and loaded tools become available from later turns):

| Input | Behavior |
|---|---|
| A question | Submit it to the model; commands, results, and the answer appear in real time |
| Multi-line paste | Inserted into the prompt with line breaks preserved; nothing runs until you press Enter |
| Ctrl-J | Insert a line break in the input for hand-written multi-line questions (Enter still sends) |
| `exit` / Ctrl-D | Quit |
| `/clear` | Clear the current conversation context (history is untouched) |
| `/history` | Open a filterable history list; the selection fills the input line without running it |
| `/skills` | List loaded skills, their source and description |
| `/skill <name>` | Load the body of a skill into the current conversation |
| `/mcp` | Show MCP server status, tool counts and errors |
| `/expand [number\|list]` | Expand/collapse the latest tool call; use a number or `list` for history |
| Up/Down arrows | Move through previous questions |
| Ctrl-C | Abort the current turn; press again while idle to quit |
| Any other `/xxx` | Reports an unknown command; nothing is sent to the model |

Exit codes: `0` for a normal exit (including after aborting a turn); `1` when configuration is missing or invalid; `ask model` returns the editor's exit code.

Note: `ask model` and `ask "model"` are equivalent at the shell level; when the only argument is `model`, the configuration flow always wins.

### Coding tasks

`ask` is not only for lookups. It handles medium-complexity coding work end to end: read the existing code, create or rewrite files, run tests, and iterate on failures — with no confirmation prompts.

```bash
$ ask write an LRU cache with TTL expiry in TypeScript, plus unit tests
$ ask add a /health endpoint to this Express service returning version and uptime, with a test
$ ask migrate the jest tests under tests/ to vitest, keeping the assertions unchanged
$ ask write a shell script that cleans up logs older than 7 days each night and archives the last 3 days
$ ask this script is too slow, find the bottleneck first, then make it concurrent
$ ask find duplicated error-handling in src and extract it into a shared helper
```

Four things raise the hit rate the most: the goal, the stack and version, the constraints (directories, naming, files not to touch), and how to verify (`npm test` passes, what `curl` should return, a sample output).

Practical tips:

- **Plan first, code second**: ask for "no code yet, just the list of files to change and the steps", then let it implement
- **Ask from a clean git worktree**: every change shows as a line-numbered diff; `git checkout .` undoes it
- **Make it prove itself**: "run the tests when done and fix failures" beats code-only output
- **Tune two settings for long tasks**: raise `max_steps` (default 12) when many files or steps are involved, and `command_timeout_ms` (default 30s) for slow `npm install`, builds, or test suites
- **Keep the blast radius small**: one module per turn is far more reliable than "refactor the whole project"

Boundaries: good for features, scripts, refactors, and test coverage spanning one to a dozen files; not suited to whole-repo architecture rewrites, anything needing GUI interaction, or long interactive debugging sessions.

## Architecture

### Layers

```
argv
  -> cli.ts (commander): dispatch ask [query...] / model / -v
       -> repl/repl.ts: readline, slash commands, Ctrl-C, serial queue
            -> repl/{render,welcome,style,history}
            -> agent/loop.ts: think -> tool_calls -> run -> observe -> ...
                 -> llm/{adapter,openai}.ts
                 -> tools/{registry,bash,files}.ts

Cross-cutting modules (used by upper layers, never depending on them):
  config/{config,model}   zod validation, defaults, key resolution, ask model
  log/writer.ts           JSONL error log (best-effort)
  prompts/system.ts       system prompt and final-answer contract
  version.ts              single source of truth for the version
```

Dependencies flow in one direction: `cli -> repl -> agent -> llm | tools`. `config` and `log` are imported where needed, and `agent` does not depend on readline, colors, or terminal width, so it can be unit-tested without a terminal.

### Data flow for one question

```
User input
  |
  +-> history.append(q)                       write to ~/.ask/history (dedupe adjacent)
  +-> session.addUser(q)
  |
  +-> for step in 1..max_steps:
        session.evictIfNeeded()               drop the oldest turn when over the threshold
        llm.chat({ messages, tools })  --stream--> text deltas --> render to terminal
                                                  +--> tool_calls --> structured calls
        |
        +- no tool_calls --> session.addAssistant(text) --> final event, turn ends
        |
        +- tool_calls present
              +- session.addAssistant(text, toolCalls)
              +- run each: bash / edit_file / write_file (serially; one failure does not stop the others)
              +- wrap each result as observation text, session.addToolResult(...)
              +- loop back and let the model continue from the new evidence
```

The model sees structured `messages` (system / user / assistant / tool). Command output is returned with `exit_code / signal / duration_ms / timed_out / aborted / truncated / stdout / stderr` fields so the model cannot mistake a failed command for success. There are only three termination conditions: the model stops calling tools, the step budget runs out, or the user aborts.

### Key design decisions

| Topic | Approach | Why |
|---|---|---|
| Public interface | `AgentLoop.run()` exposes only `AsyncIterable<AgentEvent>` | The loop knows nothing about the terminal; the CLI can render incrementally and tests stay simple |
| Tool declaration | Native `tool_calls`, not a text-based Thought/Action protocol | No regex parsing and no format drift |
| Command execution | `spawn(shell: true, detached: true)`; `kill(-pid)` on timeout/abort | Kills the entire process group, so grandchildren of `a \| b` do not survive |
| Output cap | Keep half the quota at the head and half at the tail, with a truncation marker in the middle | Avoids blowing up context while keeping the opening conclusion and trailing errors |
| Tool-call parsing | Stream fragments are aggregated by `index` and emitted once at the end | Handles fragmented tool_calls |
| Context management | Anchor on the server's `usage.prompt_tokens`; estimate new content by characters (CJK 1 char ≈ 1 token, others 4 chars ≈ 1 token) | Closer to real usage than pure character counting |
| Eviction unit | Delete one "user question plus all following assistant/tool messages" as a whole; the system message is never evicted | Prevents splitting a tool call from its result and producing an invalid protocol |
| File editing | `edit_file` requires a unique `old_string`, otherwise refuses to write | Deterministic safety instead of guessing intent |
| Logging | Errors only, best-effort, silent on write failure | Low noise and no impact on turn results |
| Rendering | ANSI only on a TTY; `NO_COLOR` / `TERM=dumb` / pipes fall back to plain text | Piped output can be consumed directly by scripts |

### Module responsibilities

| Path | Responsibility |
|---|---|
| `src/cli.ts` | Argument parsing, subcommands, exit codes; reports config errors early |
| `src/repl/repl.ts` | REPL session: serial input handling, slash commands, Ctrl-C abort, config reload per turn |
| `src/repl/render.ts` | Event rendering: status spinner, command lines, result summary, file diffs, final answer |
| `src/repl/welcome.ts` | Welcome page (TTY only) |
| `src/repl/history.ts` | JSONL read/write for `~/.ask/history`, dedupe, 2000-entry cap |
| `src/repl/style.ts` | Display width, ANSI stripping, color enablement |
| `src/agent/loop.ts` | ReAct loop, tool orchestration, error and abort propagation |
| `src/agent/session.ts` | Message array, token estimation, turn eviction |
| `src/agent/types.ts` | `AgentEvent` and related event types |
| `src/llm/adapter.ts` | `LlmAdapter` / `ChatMessage` / `ToolSpec` interfaces |
| `src/llm/openai.ts` | OpenAI-compatible streaming, tool_calls aggregation, errors normalized to `LlmError` |
| `src/tools/registry.ts` | Tool schemas and bash execution context |
| `src/tools/bash.ts` | Process launch, process-group termination, head/tail truncation |
| `src/tools/files.ts` | The two file tools, path resolution, line-level diff generation |
| `src/skills/loader.ts` | Skill scanning, frontmatter parsing and precedence |
| `src/mcp/manager.ts` | MCP server lifecycle and tool discovery |
| `src/config/config.ts` | zod schema, defaults, `ASK_HOME` paths, key resolution, permission warnings |
| `src/config/model.ts` | Template creation and editor selection |
| `src/log/writer.ts` | JSONL error log and anomaly classification |
| `src/prompts/system.ts` | System prompt and final-answer contract |

## Tools

| Tool | Arguments | Purpose |
|---|---|---|
| `bash` | `command` | Run one shell command in the current working directory; returns stdout/stderr/exit code |
| `edit_file` | `path`, `old_string`, `new_string` | Replace the unique occurrence of a snippet; refuses when missing or ambiguous |
| `write_file` | `path`, `content` | Create a new file or fully overwrite an existing one, creating parent directories |

File writes need no confirmation. After execution the terminal shows a line-numbered diff: removed lines are marked `-` (red), added lines `+` (green); `edit_file` includes two lines of context, and `write_file` shows the create/overwrite state plus up to 40 lines of preview. Paths are relative to the current working directory.

## Skills

Skills are local Markdown instructions compatible with Claude Code's `SKILL.md`.

```
~/.ask/skills/<name>/SKILL.md          user level
<project>/.ask/skills/<name>/SKILL.md  project level (overrides user by name)
```

```markdown
---
name: pdf
description: Extract text from PDF files
---
# PDF skill

Use `pdftotext` ...
```

At startup only names and descriptions are injected into the system prompt. When relevant, the model calls the `skill` tool to load the body; the tool also returns the skill directory and file list, and scripts still run through `bash`. You can also use `/skills` and `/skill <name>` manually.

Disable with `skills.enabled=false`; set `skills.project=false` when a repository is not trusted.

## MCP

stdio and HTTP/SSE MCP servers are supported.

```
~/.ask/mcp.json          user level
<project>/.ask/mcp.json  project level (overrides user by server name)
```

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    },
    "sse": {
      "url": "https://example.com/sse"
    }
  }
}
```

Server fields: `command`, `args`, `env`, `cwd`, `url`, `headers`, `transport`, `disabled`, `timeoutMs`, `disabledTools`.

- `command` uses stdio; a `url` ending with `/sse` uses SSE, otherwise Streamable HTTP; `transport` can override
- When transport is not explicit, a failed HTTP transport falls back to the other one
- All enabled servers connect in parallel; one failure only affects that server
- Tools are registered as `mcp__<server>__<tool>`
- `ask mcp` opens/creates the config; `/mcp` shows status
- Text results are returned directly; images are saved under `~/.ask/mcp-artifacts/` and the path is given to the model
- stdio server stderr is written to `~/.ask/logs/mcp/<server>.log`
- Global switch `mcp.enabled`; tool limit `mcp.maxTools`

HTTP authentication only uses URL query parameters or `headers` from the config; there is no interactive OAuth flow.

## Output format

The system prompt asks the model to write the final answer as:

```markdown
## Conclusion
## Evidence
## Notes (optional)
```

It also requires concision: one or two sentences in the conclusion, no restating the question, no preamble or process narration; evidence lists only commands actually run and their key results. Section headings follow the language: Chinese uses 结论/依据/备注; other languages use English headings or a natural translation.

Tool calls and the final answer are rendered separately: the question is shown as a light-gray background block, and the answer is plain text without a background. While waiting for the model or running a command, a single-line status shows elapsed seconds (Chinese `思考中`/`运行中`, English `Thinking`/`Running`); tool results appear under the command as `-> exit 0 · 12ms`. Set `NO_COLOR=1` to disable color; piped output degrades to plain text and omits the welcome page.

## Data and logs

```
~/.ask/
├── config.json          Model configuration (0600)
├── mcp.json             MCP configuration (optional)
├── skills/              User-level skills
├── history              User question history (JSONL, last 2000 entries)
├── logs/error.jsonl     Error log (errors only)
├── logs/mcp/            MCP server stderr
├── mcp-artifacts/       MCP images and other artifacts
├── node/                Private Node downloaded by the installer (if any)
└── app/cli.js           Bundle copy when using a private Node
```

Directories are created with mode 0700. The error log records only: command timeouts, launch failures, signal termination, command not found (126/127), LLM request failures, config/parse errors, and uncaught exceptions. Ordinary non-zero exits such as `grep` returning 1 are not logged, but they are still returned to the model. Each line has the fixed fields `ts / session / kind / tool / command / exit_code / signal / duration_ms / truncated / stderr / message / stack`.

## Security boundary

`bash` and the file tools do **not** ask for confirmation by default. The model can run any command the current user can run and modify any writable file. MCP servers are explicitly configured local processes and skills are local Markdown instructions; neither is fetched remotely. Timeouts, output truncation, and the error log are stop-loss and audit aids, not guardrails.

If accidental changes matter to you:

- Run in a dedicated account or container
- Restrict sensitive directories with filesystem permissions
- Review `~/.ask/history` and `~/.ask/logs/error.jsonl`

## Development

```bash
npm ci
npm run build      # tsup bundles the single file dist/cli.js
npm run typecheck  # tsc --noEmit
npm test           # vitest run (serial, to avoid conflicts over dist and temp HOME)
```

Local debugging: `npm run build && node dist/cli.js "How large is the current directory?"`, with `ASK_HOME=/tmp/ask-dev` to isolate config and history.

Directory structure:

```
src/
├── cli.ts          Entry point and subcommands
├── repl/           REPL, history, rendering, welcome page, terminal styling
├── agent/          ReAct loop and conversation context
├── llm/            Provider adapters (OpenAI-compatible)
├── tools/          bash / edit_file / write_file and the registry
├── skills/         SKILL.md discovery, loading and the skill tool
├── mcp/            stdio client, server manager and tool adapter
├── config/         Config loading and ask model
├── log/            JSONL error log
└── prompts/        System prompt
tests/
├── helpers/        Mock OpenAI-compatible server, temp HOME, build and child-process utilities
└── *.test.ts       Unit tests and end-to-end tests
```

Coverage includes config validation, LLM streaming parsing, bash timeout and process-group cleanup, tool arguments, the agent loop and context eviction, rendering, history, the install script, and end-to-end flows against a local mock service.

## Limitations

- macOS / Linux only
- OpenAI-compatible protocol only (no native Anthropic protocol yet)
- MCP supports stdio, SSE and Streamable HTTP; authentication only uses URL/headers, with no interactive OAuth
- Skills are read from local directories only; no remote downloads
- No command approval, sandbox isolation, or network allowlist
- No multi-user or remote sharing