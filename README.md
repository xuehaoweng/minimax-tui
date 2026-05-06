# minimax-tui

Terminal UI for chatting with MiniMax models.

## Install

```bash
npm install -g minimax-tui
```

## Usage

```bash
minimax-tui config
minimax-tui
```

On first launch, `minimax-tui` will open the interactive setup flow if `~/.minimax-tui/setting.json` does not yet have an API key.
Every launch starts a new conversation session. Use `/resume` inside the TUI to open a session picker, or `/resume <session-id>` to jump directly to a saved session.
`/mode agent` switches the chat loop into tool-using agent mode.
In agent mode, the model can inspect files, edit files, and run non-interactive workspace commands.

### Config

You can store settings locally instead of using environment variables each time:

```bash
minimax-tui config set apikey your_key
minimax-tui config set baseurl https://api.minimax.io
minimax-tui config set model MiniMax-M2.7
minimax-tui config list
```

Or launch the interactive setup:

```bash
minimax-tui config
```

To print the path to the settings file:

```bash
minimax-tui config path
```

### History

The TUI saves all conversation sessions locally.

```bash
minimax-tui history clear
minimax-tui sessions list
```

Inside the TUI:

```text
/resume <session-id>
/sessions
```

Typing `/resume` without an argument opens the interactive session picker.
Typing `/` opens the slash-command chooser.
Typing `/skill` opens skill management commands such as install/use/remove/list.
Typing `/plugin` opens plugin management commands such as install/use/remove/list.

### Skills

Install and manage local skills:

```bash
minimax-tui skills list
minimax-tui skills install ./path/to/skill
minimax-tui skills install https://github.com/user/repo
minimax-tui skills remove skill-name
```

Inside the TUI:

```text
/skill
/skill list
/skill install ./path/to/skill
/skill install https://github.com/user/repo
/skill use skill-name
/skill remove skill-name
```

### Plugins

Install and manage local plugins:

```bash
minimax-tui plugins list
minimax-tui plugins install ./path/to/plugin
minimax-tui plugins install https://github.com/user/repo
minimax-tui plugins remove plugin-name
minimax-tui plugins active
minimax-tui plugins use plugin-name
```

Inside the TUI:

```text
/plugin
/plugin list
/plugin install ./path/to/plugin
/plugin install https://github.com/user/repo
/plugin use plugin-name
/plugin remove plugin-name
```

Plugins contribute their `skills`, `hooks`, and `mcpServers` metadata into the current agent session context. In this release, the hooks and MCP definitions are loaded and summarized for the model; they are not yet executed as live external services.

### One-off Flags

CLI flags like `--api-key`, `--base-url`, and `--model` still work for one-off sessions, but the persistent source of truth is `~/.minimax-tui/setting.json`.

## Build

```bash
npm install
npm run build
```
