# LM Studio Chat

A VS Code extension that brings a full agentic chat panel for your local [LM Studio](https://lmstudio.ai) models. Talk to any model running in LM Studio, give it access to your workspace, and let it read, write, and run commands — all without leaving VS Code.

## Features

- **Streaming chat** with any model loaded in LM Studio
- **Agentic tool system** — the model can act on your workspace using XML-tag–based tool calls
- **MCP support** — connect Model Context Protocol servers to extend the agent with external tools
- **Permission modes** — `ask` (approve every change) or `edit` (auto-execute with result cards)
- **Workspace context** — current file tree and workspace path are injected into every conversation
- **History trimming** — keeps conversations within token limits automatically
- **Shell access** — optional `run_bash` tool for running terminal commands (disabled by default)

## Tools

| Tool | What it does |
|---|---|
| `read_file` | Read any file in the workspace |
| `write_file` | Create or overwrite a file (creates parent dirs) |
| `patch_file` | Precise search-and-replace within a file |
| `list_dir` | List directory contents |
| `search_files` | Grep across the workspace with optional glob filter |
| `delete_file` | Send a file to trash |
| `create_dir` | Create a directory tree |
| `rename_file` | Move or rename a file |
| `run_bash` | Run a shell command (Windows: cmd.exe) |
| `mcp_call` | Call a tool on a connected MCP server |

## Requirements

- [LM Studio](https://lmstudio.ai) running locally with the API server enabled (default: `http://127.0.0.1:1234`)
- VS Code 1.85+

## Installation

1. Download the latest `.vsix` from [Releases](https://github.com/hlinkavl/lm-studio-chat/releases)
2. In VS Code: `Extensions` → `...` → `Install from VSIX...`
3. Open the **LM Studio Chat** panel from the bottom panel bar

## Configuration

| Setting | Default | Description |
|---|---|---|
| `lmStudioChat.endpoint` | `http://127.0.0.1:1234` | LM Studio API URL |
| `lmStudioChat.model` | _(empty)_ | Model ID — leave empty to use the currently loaded model |
| `lmStudioChat.maxTokens` | `2048` | Max tokens per response |
| `lmStudioChat.temperature` | `0.7` | Sampling temperature (0.0 – 2.0) |
| `lmStudioChat.maxHistoryMessages` | `50` | Conversation messages kept in context |
| `lmStudioChat.maxToolIterations` | `10` | Max consecutive tool cycles per turn |
| `lmStudioChat.systemPrompt` | _(built-in)_ | Override the default system prompt |

## MCP Servers

MCP servers are configured via a `mcp.json` file. Open it with:

```
Ctrl+Shift+P → LM Studio Chat: Open MCP Config File
```

The format is identical to VS Code and Claude Code:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@scope/server-pkg"]
    },
    "my-sse-server": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

Optional `env` object can be added to any server entry for environment variables.

The file is watched — changes apply without restarting VS Code.

## License

MIT
