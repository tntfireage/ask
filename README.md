# ask

[English](README.en.MD) · 中文

**自动执行，无需确认，加快你的生产效率。**

**极简的命令行大模型交互工具。** 不用记 `find`、`du`、`ps aux --sort` 这类命令和参数组合，直接用自然语言说出需求，`ask` 会自己调用合适的命令并给出结论。

适合“我知道要什么，但不想翻 man page、拼参数”的场景：

```bash
$ ask 找出当前目录的所有文件，并按照文件大小进行排序
$ ask 当前最耗内存的程序是？
$ ask 端口 8080 被哪个进程占用了？
$ ask 这个项目用了哪些依赖？哪些可以升级？
$ ask 把 src 下所有 console.log 删掉
$ ask 过去一小时有哪些 ERROR 日志？
$ ask 给这个服务加个 /health 接口，并补上测试
$ ask 用 TypeScript 写一个带 TTL 的 LRU 缓存
```

底层是一个 ReAct 循环：模型按需调用 shell 与文件编辑工具，命令和结果实时显示在终端，最终结论按固定格式输出。

```
$ ask "当前目录有多大的数据"
$ du -sh .
  -> exit 0 · 12ms

## 结论
当前目录约 1.2 GB，主要是 node_modules（980 MB）。

## 依据
- `du -sh .` -> 1.2G
- `du -sh ./* | sort -hr | head -5` -> ...

## 备注
无
```

核心特征：

- **先取证再回答**：模型自己决定跑哪些命令，命令与结果实时显示在终端
- **多轮会话**：一次提问结束后留在 REPL，追问自动携带上下文
- **三种内置工具**：`bash`、`edit_file`、`write_file`
- **可扩展**：支持 Claude 兼容 Skills 与 stdio MCP 工具
- **单文件产物**：`dist/cli.js` 自包含依赖，安装即用，不依赖仓库目录

## 安装

### 一条命令

```bash
./install.sh
```

脚本会依次完成：

1. 检测 Node.js（>= 20），缺失时从 `nodejs.org/dist` 下载对应平台的官方二进制，校验 sha256 后解压到 `~/.ask/node/`
2. 使用 `npm ci`（有锁文件时）或 `npm install` 安装依赖，失败自动重试一次
3. 用 tsup 构建单文件产物
4. 安装启动器到 `~/.local/bin/ask`
5. 每次安装都以编号列表选择语言（默认中文）；已有配置只更新 `language`，创建 `~/.ask/` 与配置模板（不覆盖其它配置）
6. 语言选择后询问是否配置模型（`base_url` / `model` / `api_key`）；已有非空 `api_key` 时默认跳过，可主动重新配置
7. 运行 `ask --version` 自检

如果 `~/.local/bin` 不在 PATH 中，脚本会打印需要加入的 `export PATH` 行。安装前会检查 PATH 中是否已存在其它 `ask`，冲突时中止，不覆盖用户已有命令。

### 安装选项

| 参数 | 作用 |
|---|---|
| `--bin-dir DIR` | 自定义启动器安装目录 |
| `--link` | 使用 `npm link`（开发时改完即生效） |
| `--no-bootstrap` | 不自动下载 Node，缺失或版本不足时报错 |
| `--uninstall` | 删除启动器，保留 `~/.ask/` |
| `--purge` | 删除启动器与整个 `~/.ask/` |

环境变量：`ASK_HOME`（默认 `~/.ask`）、`ASK_LANG`、`ASK_MODEL`、`ASK_BASE_URL`、`ASK_API_KEY`、`NODE_VERSION`（默认 `22.11.0`）、`ASK_NODE_BASE_URL`（默认 `https://nodejs.org/dist`）。设置模型相关变量时会跳过交互、只更新提供的字段。

重复执行 `install.sh` 是幂等的，可作为升级方式；配置、历史与日志不会被覆盖。

## 配置

```bash
ask model
```

用系统 `open`（macOS）打开 `~/.ask/config.json`；其它平台使用 `$EDITOR`（回退到 `vi`/`nano`）。可用 `ASK_EDITOR` 显式指定编辑器。文件不存在时先写入模板再打开。首次安装时也可以直接配置模型，之后随时用 `ask model` 修改。

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

| 字段 | 默认值 | 说明 |
|---|---|---|
| `language` | `zh` | 回复与界面语言。可填 `en`、`ja`、`fr`、`pt-BR` 等；回复使用该语言，欢迎页与命令说明仅内置中文/英文，其它语言回退英文 |
| `base_url` | `https://api.openai.com/v1` | API 根地址；误填 `/chat/completions` 会自动去掉后缀 |
| `model` | `gpt-4o-mini` | 模型名 |
| `api_key` | `null` | 直接填写密钥；`null` 或空串时启动报错 |
| `max_steps` | `12` | 单次提问最多多少轮 LLM 调用，超限以错误结束该回合 |
| `command_timeout_ms` | `30000` | 单条命令超时后杀掉整个进程组 |
| `max_output_bytes` | `262144` | 单条命令 stdout/stderr 各自的上限，超出保留头尾并标记截断 |
| `temperature` | `0` | 采样温度 |
| `context_window_tokens` | `128000` | 会话上下文窗口估计值 |
| `context_evict_ratio` | `0.95` | 占用达到窗口的该比例时开始淘汰最旧轮次 |
| `skills` | `{ enabled: true, project: true }` | 是否加载本地技能；`project` 控制是否读取项目级技能 |
| `mcp` | `{ enabled: true, maxTools: 128 }` | 是否启动 MCP 服务器，以及注册的 MCP 工具上限 |

`provider` 目前仅作记录，实际协议固定为 OpenAI 兼容。配置文件写入权限为 0600；权限过宽时启动会给出警告。配置在每次提问时重新加载，改完无需重启会话。

任何 OpenAI 兼容服务都可以：DeepSeek、Kimi、本地 vLLM、Ollama 等，只要修改 `base_url` 与 `model`。

## 使用

```bash
ask "当前目录有多大"     # 执行一次问答，然后进入 REPL
ask                      # 直接进入 REPL
ask model                # 编辑模型配置
ask --version            # 打印版本（-v 同义）
ask --help               # 帮助
```

REPL 内（交互式终端会立即显示彩色欢迎页与提示符；技能与 MCP 在后台并发加载，不阻塞提问；加载完成后的工具从后续回合开始可用）：

| 输入 | 行为 |
|---|---|
| 直接输入问题 | 提交给模型，实时显示命令、结果与答案 |
| 粘贴多行文本 | 原样插入提示符并保留换行，按 Enter 确认后才发送，不会立即执行 |
| Ctrl-J | 在输入中插入换行，便于手动编辑多行问题（Enter 仍是发送） |
| `exit` / Ctrl-D | 退出 |
| `/clear` | 清空当前会话上下文（不清空历史提问） |
| `/history` | 打开可筛选的历史提问列表，选中后回填输入行，不自动执行 |
| `/skills` | 列出已加载技能、来源与描述 |
| `/skill <name>` | 把指定技能正文加载到当前会话 |
| `/mcp` | 查看 MCP 服务器状态、工具数与失败原因 |
| `/expand [编号\|list]` | 展开/折叠最近一次工具调用；指定编号或 `list` 查看历史 |
| 上/下箭头 | 在历史提问之间回溯 |
| Ctrl-C | 中止当前回合；空闲时再按一次退出 |
| 其它 `/xxx` | 提示未知命令，不发给模型 |

退出码：正常结束为 `0`（含中止回合后继续使用）；配置缺失或校验失败为 `1`；`ask model` 返回编辑器的退出码。

注意：`ask model` 与 `ask "model"` 在 shell 层面等价，唯一参数为 `model` 时一律进入配置流程。

### 编码任务

`ask` 不只是查询工具，同样能完成中等复杂度的编码需求：读现有代码、新建/改写文件、跑测试、按报错迭代，全程免确认。

```bash
$ ask 用 TypeScript 写一个带 TTL 过期的 LRU 缓存，附单元测试
$ ask 给这个 Express 服务加 /health 接口，返回版本号和运行时长，并补一个测试
$ ask 把 tests 下用 jest 写的用例迁移到 vitest，断言保持不变
$ ask 写一个 shell 脚本，每天清理 7 天前的日志，最近 3 天的压缩归档
$ ask 这个脚本太慢了，先定位瓶颈，再改成并发处理
$ ask 找出 src 里重复的错误处理逻辑，抽成公共函数
```

说清四件事命中率最高：目标、技术栈与版本、必须遵守的约束（目录、命名、哪些文件不要动）、验收方式（`npm test` 通过、`curl` 返回什么、给出示例输出）。

几个实用技巧：

- **先出方案再动手**：先问「不要写代码，给出要改的文件清单和步骤」，确认后再让它实现
- **在 git 干净的工作区提问**：每轮改动都在终端显示逐行 diff，不满意 `git checkout .` 就回滚
- **让它自证**：要求「写完跑一遍测试，失败就修」，比只生成代码可靠
- **长任务调两个参数**：文件或步骤较多时提高 `max_steps`（默认 12）；`npm install`、构建、跑测试较慢时提高 `command_timeout_ms`（默认 30 秒）
- **控制改动范围**：一次改一个模块，比「重构整个项目」稳定得多

边界：适合单文件到十几个文件规模的功能、脚本、重构与测试补齐；不适合整仓架构重写，或需要图形界面交互、长时间调试会话的任务。

## 整体架构

### 分层

```
                    ┌──────────────────────────────────────────┐
   argv ───────────►│ cli.ts   commander                       │
                    │ 参数分发：ask [query...] / model / -v     │
                    └───────────────┬──────────────────────────┘
                                    │ initialQuery
                    ┌───────────────▼──────────────────────────┐
                    │ repl/repl.ts                             │
                    │ readline、斜杠命令、Ctrl-C、串行任务队列   │
                    └───┬───────────────┬──────────────────────┘
                        │               └──► repl/{render,welcome,style,history}
          run(input)    │
                    ┌───▼──────────────────────────────────────┐
                    │ agent/loop.ts   ReAct 循环                │
                    │ 思考 → tool_calls → 执行 → 观察 → 再思考   │
                    └───┬───────────────────────────┬──────────┘
                        │                           │
              ┌─────────▼────────┐      ┌───────────▼──────────────────────┐
              │ llm/             │      │ tools/                           │
              │ adapter.ts 接口  │      │ registry.ts  工具声明与分发       │
              │ openai.ts 流式   │      │ bash.ts      spawn/超时/截断/中止 │
              └──────────────────┘      │ files.ts     edit_file/write_file │
                                        └──────────────────────────────────┘

   横切模块（被上层引用，不反向依赖上层）：
   config/{config,model}   zod 校验、默认值、密钥解析、ask model
   log/writer.ts           JSONL 异常日志（best-effort）
   prompts/system.ts       系统提示与答案格式契约
   version.ts              版本号单一来源
```

依赖方向是单向的：`cli → repl → agent → llm | tools`，`config` 与 `log` 由各层按需引用，`agent` 不依赖 readline、颜色或终端宽度，因此可以脱离终端做单测。

### 一次提问的数据流

```
用户输入
  │
  ├─► history.append(q)                       写入 ~/.ask/history（相邻去重）
  ├─► session.addUser(q)
  │
  └─► for step in 1..max_steps:
        session.evictIfNeeded()               超过阈值则整轮淘汰最旧提问
        llm.chat({ messages, tools })  ──流式──► text 增量  ──► 直接渲染到终端
                                              └► tool_calls ──► 结构化调用
        │
        ├─ 没有 tool_calls ──► session.addAssistant(text) ──► final 事件，回合结束
        │
        └─ 有 tool_calls
              ├─ session.addAssistant(text, toolCalls)
              ├─ 依次执行：bash / edit_file / write_file（串行，单个失败不中断其它）
              ├─ 每条结果封装成 observation 文本，session.addToolResult(...)
              └─ 回到循环开头，让模型基于新证据继续判断
```

模型看到的是结构化 `messages`（system / user / assistant / tool），命令输出以 `exit_code / signal / duration_ms / timed_out / aborted / truncated / stdout / stderr` 字段回传，避免模型把失败命令误判为成功。终止条件只有三个：模型不再发起工具调用、步数用尽、用户中止。

### 关键设计

| 主题 | 做法 | 原因 |
|---|---|---|
| 对外接口 | `AgentLoop.run()` 只暴露 `AsyncIterable<AgentEvent>` | 循环不感知终端，CLI 可增量渲染，也便于测试 |
| 工具声明 | 原生 `tool_calls`，非文本化 Thought/Action 协议 | 无正则解析，格式不漂移 |
| 命令执行 | `spawn(shell: true, detached: true)`，超时/中止时 `kill(-pid)` | 杀掉整个进程组，`a \| b` 的孙进程不会残留 |
| 输出上限 | 头尾各保留一半配额，中间插入截断标记 | 既不爆上下文，也保留开头结论与结尾错误 |
| 工具调用解析 | 流式按 `index` 聚合 name/arguments，结束后统一产出 | 兼容分片返回的 tool_calls |
| 上下文管理 | 服务端 `usage.prompt_tokens` 作锚点，新增内容按字符估算（中文 1 字≈1 token，其它 4 字符≈1 token） | 比纯字符估算更贴近真实占用 |
| 淘汰粒度 | 以“一条用户提问及其后所有 assistant/tool 消息”为一轮整块删除，system 永不淘汰 | 避免工具调用与结果被拆散导致协议非法 |
| 文件编辑 | `edit_file` 要求 `old_string` 唯一匹配，否则拒绝落盘 | 用确定性换安全，不猜模型意图 |
| 日志 | 只写异常，best-effort，写入失败静默 | 不放大噪声，也不影响回合结果 |
| 渲染 | TTY 才启用 ANSI；`NO_COLOR` / `TERM=dumb` / 管道自动退化纯文本 | 管道输出可被脚本直接消费 |

### 模块职责

| 路径 | 职责 |
|---|---|
| `src/cli.ts` | 参数解析、子命令、退出码；配置错误在此提前报告 |
| `src/repl/repl.ts` | REPL 会话：串行处理输入、斜杠命令、Ctrl-C 中止、每回合重载配置 |
| `src/repl/render.ts` | 事件渲染：状态行 spinner、命令行、结果摘要、文件差异、最终答案 |
| `src/repl/welcome.ts` | 欢迎页（仅 TTY） |
| `src/repl/history.ts` | `~/.ask/history` 的 JSONL 读写、去重、2000 条上限 |
| `src/repl/style.ts` | 显示宽度、ANSI 剥离、配色开关 |
| `src/agent/loop.ts` | ReAct 循环、工具编排、错误与中止传播 |
| `src/agent/session.ts` | 消息数组、token 估算、轮次淘汰 |
| `src/agent/types.ts` | `AgentEvent` 等事件类型 |
| `src/llm/adapter.ts` | `LlmAdapter` / `ChatMessage` / `ToolSpec` 接口 |
| `src/llm/openai.ts` | OpenAI 兼容流式实现、tool_calls 聚合、错误归一化为 `LlmError` |
| `src/tools/registry.ts` | 工具 schema 与 bash 执行上下文 |
| `src/tools/bash.ts` | 进程启动、进程组终止、头尾截断 |
| `src/tools/files.ts` | 两个文件工具、路径解析、行级差异生成 |
| `src/skills/loader.ts` | 技能扫描、frontmatter 解析与优先级 |
| `src/mcp/manager.ts` | MCP 服务器生命周期与工具发现 |
| `src/config/config.ts` | zod schema、默认值、`ASK_HOME` 路径、密钥解析与权限警告 |
| `src/config/model.ts` | 模板创建与编辑器选择 |
| `src/log/writer.ts` | JSONL 异常日志与异常分类 |
| `src/prompts/system.ts` | 系统提示、答案格式契约 |

## 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `bash` | `command` | 在当前工作目录执行一条 shell 命令，返回 stdout/stderr/退出码 |
| `edit_file` | `path`、`old_string`、`new_string` | 精确替换文件中唯一的片段；未找到或多处匹配时拒绝执行 |
| `write_file` | `path`、`content` | 创建新文件或完全覆盖已有文件，自动创建父目录 |

文件写入不需要确认，执行后会在终端显示带行号的逐行差异：删除行标 `-`（红色），新增行标 `+`（绿色），`edit_file` 带前后 2 行上下文，`write_file` 显示新建/覆盖状态与最多 40 行预览。路径相对当前工作目录。

## Skills

Skills 是本地 Markdown 指令，格式与 Claude Code 的 `SKILL.md` 兼容。

```
~/.ask/skills/<name>/SKILL.md          用户级
<project>/.ask/skills/<name>/SKILL.md  项目级（同名覆盖用户级）
```

```markdown
---
name: pdf
description: Extract text from PDF files
---
# PDF skill

Use `pdftotext` ...
```

启动时只把名称与描述注入系统提示；模型判断相关后调用 `skill` 工具加载正文，工具会返回技能目录与文件清单，脚本仍通过 `bash` 执行。也可以手动执行 `/skills` 和 `/skill <name>`。

关闭：配置 `skills.enabled=false`；不信任项目仓库时设置 `skills.project=false`。

## MCP

支持 stdio 与 HTTP/SSE MCP 服务器。

```
~/.ask/mcp.json          用户级
<project>/.ask/mcp.json  项目级（同名服务器覆盖用户级）
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

可用字段：`command`、`args`、`env`、`cwd`、`url`、`headers`、`transport`、`disabled`、`timeoutMs`、`disabledTools`。

- 有 `command` 走 stdio；有 `url` 时，路径以 `/sse` 结尾走 SSE，否则走 Streamable HTTP；`transport` 可显式指定
- 未显式指定传输时，首选传输失败会尝试另一种 HTTP 传输
- 启动时并行连接所有启用服务器；单个失败只影响该服务器
- 工具注册为 `mcp__<server>__<tool>`
- `ask mcp` 打开/创建配置；`/mcp` 查看状态
- 文本结果直接回传；图片保存到 `~/.ask/mcp-artifacts/`，把路径给模型
- stdio 服务器 stderr 写入 `~/.ask/logs/mcp/<server>.log`
- 全局开关 `mcp.enabled`，工具上限 `mcp.maxTools`

HTTP 认证仅使用配置中的 URL 查询参数或 `headers`，不提供交互式 OAuth。

## 输出格式

系统提示要求模型把最终答案写成：

```markdown
## 结论
## 依据
## 备注（可选）
```

并要求答案简洁：结论一到两句话、不复述问题、不写开场白或分析过程；依据只列实际执行过的命令与关键结果。章节标题随语言变化：中文使用「结论/依据/备注」，其它语言使用英文标题或对应语言的自然翻译。

工具调用与最终答案分开渲染：提问以浅灰色背景块展示，回答为无背景的纯文本；等待模型或执行命令时显示带秒数的单行状态（中文 `思考中`/`运行中`，英文 `Thinking`/`Running`），工具结果以 `-> exit 0 · 12ms` 形式附在命令下方。设置 `NO_COLOR=1` 可关闭颜色，管道输出自动退化为纯文本，且不显示欢迎页。

## 数据与日志

```
~/.ask/
├── config.json          模型配置（0600）
├── mcp.json             MCP 配置（可选）
├── skills/              用户级技能
├── history              用户提问历史（JSONL，最近 2000 条）
├── logs/error.jsonl     异常日志（仅异常）
├── logs/mcp/            MCP 服务器 stderr
├── mcp-artifacts/       MCP 图片等产物
├── node/                安装脚本下载的私有 Node（如有）
└── app/cli.js           使用私有 Node 时的产物副本
```

目录创建为 0700。异常日志只记录：命令超时、启动失败、信号终止、命令未找到（126/127）、LLM 请求失败、配置/解析错误、未捕获异常。`grep` 返回 1 这类普通非零退出不记录，但仍会回传给模型。每行字段固定为 `ts / session / kind / tool / command / exit_code / signal / duration_ms / truncated / stderr / message / stack`。

## 安全边界

`bash` 与文件工具默认**不请求确认**，模型可以执行当前用户权限内的任意命令，也可以修改任何可写文件。MCP 服务器是显式配置的本地进程，技能是本地 Markdown 指令；两者都不会自动从远程拉取。超时、输出截断与异常日志只是止损和追溯，不是拦截。

如果在意误操作，建议：

- 在专用账户或容器中运行
- 对敏感目录使用文件系统权限限制
- 审阅 `~/.ask/history` 与 `~/.ask/logs/error.jsonl`

## 开发

```bash
npm ci
npm run build      # tsup 打包出单文件 dist/cli.js
npm run typecheck  # tsc --noEmit
npm test           # vitest run（串行执行，避免共享 dist 与临时 HOME 冲突）
```

本地调试：`npm run build && node dist/cli.js "当前目录有多大"`，用 `ASK_HOME=/tmp/ask-dev` 隔离配置与历史。

目录结构：

```
src/
├── cli.ts          入口与子命令
├── repl/           REPL、历史、渲染、欢迎页、终端样式
├── agent/          ReAct 循环与会话上下文
├── llm/            供应商适配（OpenAI 兼容）
├── tools/          bash / edit_file / write_file 与注册表
├── skills/         SKILL.md 发现、加载与 skill 工具
├── mcp/            stdio 客户端、服务器管理与工具适配
├── config/         配置加载与 ask model
├── log/            异常 JSONL
└── prompts/        系统提示
tests/
├── helpers/        mock OpenAI 兼容服务、临时 HOME、构建与子进程工具
└── *.test.ts       单元测试与端到端测试
```

测试覆盖配置校验、LLM 流式解析、bash 超时与进程组回收、工具参数、Agent 循环与上下文淘汰、渲染、历史、安装脚本以及基于本地 mock 服务的端到端流程。

## 限制

- 仅支持 macOS / Linux
- 仅支持 OpenAI 兼容协议（暂不支持 Anthropic 原生协议）
- MCP 支持 stdio、SSE 与 Streamable HTTP；认证仅使用 URL/headers，无交互式 OAuth
- Skills 只从本地目录读取，不支持远程下载
- 不提供命令审批、沙箱隔离、网络白名单
- 不做多用户或远程共享
