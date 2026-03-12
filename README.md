# Chatbot

An Alfred workflow for chatting with AI directly from your keyboard — powered by [Claude Code](https://github.com/anthropics/claude-code) or [Gemini CLI](https://github.com/google-gemini/gemini-cli).

Inspired by and derived from [openai-workflow](https://github.com/alfredapp/openai-workflow/).

## Requirements

`node` (for running the script) and `jq` (for parsing JSON) must be installed and available in your system's PATH.

Install and authenticate at least one of the following CLI tools:

- [Claude Code](https://github.com/anthropics/claude-code) — `npm install -g @anthropic-ai/claude-code`
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `npm install -g @google/gemini-cli`

## Setup

In the workflow's configuration, select your **Provider** (Claude or Gemini) and optionally choose a model.

## Usage

### Starting a chat

- **Keyword** (default: `chat`) — type your question directly
- **Universal Action** — select any text, trigger Alfred's Universal Action, and choose "Ask Chatbot"
- **Fallback Search** — set this workflow as a fallback to trigger it from any Alfred search

### Keyboard shortcuts

| Key   | Action                              |
| ----- | ----------------------------------- |
| `↩`   | Send message                        |
| `⌘↩`  | Start a new chat                    |
| `⌥↩`  | Copy last reply to clipboard        |
| `⇧⌥↩` | Copy full conversation to clipboard |
| `⌃↩`  | Delete current chat                 |
| `⇧↩`  | Stop generating                     |

### Chat history

From the main keyword, press `⌥↩` to browse past conversations. Each entry shows the first message as the title and the most recent as the subtitle.

- `↩` — load a past chat (current chat is archived first)
- `Delete` Universal Action — move a chat to Trash

## Configuration

| Setting                       | Description                                             |
| ----------------------------- | ------------------------------------------------------- |
| Chat Keyword                  | Alfred keyword to open the chat (default: `chat`)       |
| Provider                      | Claude Code or Gemini CLI                               |
| Claude / Gemini Model         | Model to use (leave blank for default)                  |
| Claude / Gemini Extra Options | Additional CLI flags passed to the provider             |
| System Prompt                 | Custom instructions prepended to every conversation     |
| Start a New Chat After        | Minutes of inactivity before auto-starting a fresh chat |
| Keep History                  | Whether to archive chats when starting a new one        |
| Context                       | How many messages to display in the Alfred UI           |
| Timeout                       | Seconds to wait before marking a connection as stalled  |
