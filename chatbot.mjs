#!/usr/bin/env node

import { spawn } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';

// --- Provider Implementations ---

class BaseProvider {
  constructor(model) {
    this.model = model;
  }
}

class GeminiProvider extends BaseProvider {
  name = 'gemini';
  sessionKey = 'init';

  buildArgs(query, session) {
    const args = ['--output-format', 'stream-json', '-p', query, '--sandbox'];
    if (this.model)
      args.push('--model', this.model);
    if (session)
      args.push('--resume', session.session_id);
    return args;
  }

  extractResponse(lines) {
    return lines
      .filter(l => l.type === 'message' && l.role === 'assistant')
      .map(m => m.content)
      .join('');
  }

  extractFinishReason(lines) {
    const res = lines.find(l => l.type === 'result');
    if (res)
      return res.status === 'error' ? 'error' : 'stop';
    return lines.some(l => l.type === 'error') ? 'error' : null;
  }
}

class ClaudeProvider extends BaseProvider {
  name = 'claude';
  sessionKey = 'result';

  buildArgs(query, session, systemPromptFile) {
    const args = ['--output-format', 'stream-json', '-p', query, '--verbose', '--include-partial-messages'];
    if (this.model)
      args.push('--model', this.model);
    if (session)
      args.push('--resume', session.session_id);
    if (systemPromptFile)
      args.push('--system-prompt-file', systemPromptFile);
    return args;
  }

  extractResponse(lines) {
    const assistantLines = lines.filter(l => l.type === 'assistant');
    const latest = assistantLines[assistantLines.length - 1];
    return latest?.message?.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
  }

  extractFinishReason(lines) {
    const res = lines.find(l => l.type === 'result');
    if (res)
      return res.subtype === 'error' ? 'error' : 'stop';
    return lines.some(l => l.type === 'error') ? 'error' : null;
  }
}

// --- Main Chatbot Orchestrator ---

class Chatbot {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.paths = {
      chat: `${config.dataDir}/chat.json`,
      session: `${config.dataDir}/session.json`,
      pid: `${config.cacheDir}/pid.txt`,
      stream: `${config.cacheDir}/stream.txt`,
      systemPrompt: '.gemini/system.md',
    };
  }

  setup() {
    mkdirSync(this.config.dataDir, { recursive: true });
    mkdirSync(this.config.cacheDir, { recursive: true });
    if (this.config.systemPrompt)
      writeFileSync(this.paths.systemPrompt, this.config.systemPrompt);
  }

  deleteFile(p) {
    try {
      unlinkSync(p);
    } catch {}
  }

  getHistory() {
    try {
      return JSON.parse(readFileSync(this.paths.chat, 'utf8'));
    } catch {
      writeFileSync(this.paths.chat, '[]'); return [];
    }
  }

  saveHistory(messages) {
    writeFileSync(this.paths.chat, JSON.stringify(messages), 'utf8');
  }

  getSession() {
    try {
      if (existsSync(this.paths.session)) {
        const saved = JSON.parse(readFileSync(this.paths.session, 'utf8'));
        return saved.provider === this.provider.name ? saved : null;
      }
    } catch {}
    return null;
  }

  saveSessionFromLines(lines) {
    const match = lines.find(l => l.type === this.provider.sessionKey && l.session_id);
    if (match) {
      writeFileSync(this.paths.session, JSON.stringify({
        provider: this.provider.name,
        session_id: match.session_id,
      }));
    }
  }

  isStreaming() {
    return existsSync(this.paths.stream);
  }

  isProcessAlive() {
    try {
      const pid = Number.parseInt(readFileSync(this.paths.pid, 'utf8'));
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  start(query) {
    this.setup();
    const session = this.getSession();
    const systemFile = this.config.systemPrompt ? this.paths.systemPrompt : null;
    const args = this.provider.buildArgs(query, session, systemFile);

    writeFileSync(this.paths.stream, '', 'utf8');
    const fd = openSync(this.paths.stream, 'w');
    const child = spawn(this.provider.name, args, { stdio: ['ignore', fd, 'ignore'], detached: true });

    child.unref();
    closeSync(fd);
    writeFileSync(this.paths.pid, String(child.pid));

    const history = this.getHistory().concat({ role: 'user', content: query });
    this.saveHistory(history);

    return {
      rerun: 0.1,
      variables: { streaming_now: true, stream_marker: true },
      response: this.renderMarkdown(history),
    };
  }

  poll() {
    let streamString = '';
    try {
      streamString = readFileSync(this.paths.stream, 'utf8');
    } catch {}

    if (this.config.streamMarker) {
      return { rerun: 0.1, variables: { streaming_now: true }, response: '…', behaviour: { response: 'append' } };
    }

    const lines = streamString.split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

    const responseText = this.provider.extractResponse(lines);
    const finishReason = this.provider.extractFinishReason(lines);

    if (!finishReason)
      return this.handleIncomplete(streamString, responseText);
    if (finishReason === 'error')
      return this.handleError(lines);

    return this.handleSuccess(lines, responseText);
  }

  handleIncomplete(streamString, responseText) {
    let mtime = 0;
    try {
      mtime = statSync(this.paths.stream).mtimeMs;
    } catch {}
    const stalled = streamString.length > 0 && Date.now() - mtime > this.config.timeoutSeconds * 1000;

    if (stalled) {
      if (responseText) {
        const history = this.getHistory().concat({ role: 'assistant', content: responseText });
        this.saveHistory(history);
      }
      this.cleanup();
      return { response: `${responseText} [Connection Stalled]`, footer: 'Check connection', behaviour: { response: 'replacelast', scroll: 'end' } };
    }

    if (!streamString)
      return { rerun: 0.1, variables: { streaming_now: true } };
    return { rerun: 0.1, variables: { streaming_now: true }, response: responseText, behaviour: { response: 'replacelast', scroll: 'end' } };
  }

  handleError(lines) {
    this.cleanup();
    const errLine = lines.find(l => l.type === 'result' || l.type === 'error');
    const msg = errLine?.error || errLine?.message || 'Unknown Error';
    return { response: typeof msg === 'string' ? msg : JSON.stringify(msg), behaviour: { response: 'replacelast' } };
  }

  handleSuccess(lines, responseText) {
    this.saveSessionFromLines(lines);
    const history = this.getHistory().concat({ role: 'assistant', content: responseText });
    this.saveHistory(history);
    this.cleanup();
    return { response: responseText, behaviour: { response: 'replacelast', scroll: 'end' } };
  }

  cleanup() {
    this.deleteFile(this.paths.stream);
    this.deleteFile(this.paths.pid);
  }

  renderMarkdown(messages, ignoreLastInterrupted = true) {
    return messages.reduce((acc, cur, i, all) => {
      if (cur.role === 'assistant')
        return `${acc}${cur.content}\n\n`;
      if (cur.role === 'user') {
        const msg = `---\n#### 􀉪 You\n\n${cur.content}\n\n---\n#### 􀙫 Assistant`;
        const userTwice = all[i + 1]?.role === 'user';
        const isLast = i === all.length - 1;
        return userTwice || (isLast && !ignoreLastInterrupted)
          ? `${acc}${msg}\n\n[Answer Interrupted]\n\n`
          : `${acc}${msg}\n\n`;
      }
      return acc;
    }, '');
  }
}

// --- Bootstrap ---

const env = n => process.env[n] || '';
const providerName = env('provider') || 'claude';
const model = providerName === 'gemini' ? env('gemini_model') : env('claude_model');

const provider = providerName === 'gemini'
  ? new GeminiProvider(model)
  : new ClaudeProvider(model);

const config = {
  dataDir: env('alfred_workflow_data'),
  cacheDir: env('alfred_workflow_cache'),
  timeoutSeconds: Number.parseInt(env('timeout_seconds')) || 10,
  systemPrompt: env('system_prompt'),
  streamingNow: env('streaming_now') === '1',
  streamMarker: env('stream_marker') === '1',
};

const bot = new Chatbot(provider, config);
const query = process.argv[2] || '';

if (config.streamingNow) {
  process.stdout.write(JSON.stringify(bot.poll()));
} else if (bot.isStreaming()) {
  if (bot.isProcessAlive()) {
    process.stdout.write(JSON.stringify({
      rerun: 0.1,
      variables: { streaming_now: true, stream_marker: true },
      response: bot.renderMarkdown(bot.getHistory(), true),
      behaviour: { scroll: 'end' },
    }));
  } else {
    bot.cleanup();
    if (query) {
      process.stdout.write(JSON.stringify(bot.start(query)));
    } else {
      process.stdout.write(JSON.stringify({
        response: bot.renderMarkdown(bot.getHistory(), false),
        behaviour: { scroll: 'end' },
      }));
    }
  }
} else if (!query) {
  process.stdout.write(JSON.stringify({
    response: bot.renderMarkdown(bot.getHistory(), false),
    behaviour: { scroll: 'end' },
  }));
} else {
  process.stdout.write(JSON.stringify(bot.start(query)));
}
