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

The TUI saves your current conversation locally and restores it on the next launch.

```bash
minimax-tui history clear
```

### One-off Flags

CLI flags like `--api-key`, `--base-url`, and `--model` still work for one-off sessions, but the persistent source of truth is `~/.minimax-tui/setting.json`.

## Build

```bash
npm install
npm run build
```
