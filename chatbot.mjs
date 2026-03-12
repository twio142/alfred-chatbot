#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename } from 'path';

// --- Utilities ---

function parseArgs(str) {
  const args = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (const ch of str) {
    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === ' ' && !inSingle && !inDouble) {
      if (current) {
        args.push(current); current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current)
    args.push(current);
  return args;
}

// --- Provider Implementations ---

class BaseProvider {
  constructor(model, extraArgs = []) {
    this.model = model;
    this.extraArgs = extraArgs;
  }
}

class GeminiProvider extends BaseProvider {
  name = 'gemini';

  get sessionDir() {
    return `${process.env.HOME}/.gemini/tmp/${basename(process.cwd()).replace(/[^a-z0-9]/gi, '-').toLowerCase()}/chats`;
  }

  findSessionFile(sessionId) {
    if (!existsSync(this.sessionDir))
      return null;
    const prefix = sessionId.slice(0, 8);
    const match = readdirSync(this.sessionDir).find(f => f.endsWith(`-${prefix}.json`));
    return match ? `${this.sessionDir}/${match}` : null;
  }

  findSessionLine(lines) {
    return lines.find(l => l.type === 'init' && l.session_id);
  }

  buildArgs(query, session) {
    const args = ['--output-format', 'stream-json', '-p', query];
    if (this.model)
      args.push('--model', this.model);
    if (session)
      args.push('--resume', session.session_id);
    args.push(...this.extraArgs);
    return args;
  }

  buildEnv = systemPromptFile => ({ ...process.env, GEMINI_SYSTEM_MD: systemPromptFile ? '1' : undefined });

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

  get sessionDir() {
    return `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^a-z0-9]/gi, '-')}`;
  }

  findSessionFile(sessionId) {
    const p = `${this.sessionDir}/${sessionId}.jsonl`;
    return existsSync(p) ? p : null;
  }

  findSessionLine(lines) {
    return lines.find(l => l.type === 'system' && l.subtype === 'init' && l.session_id);
  }

  buildArgs(query, session, systemPromptFile) {
    const args = ['--output-format', 'stream-json', '-p', query, '--verbose', '--include-partial-messages'];
    if (this.model)
      args.push('--model', this.model);
    if (session)
      args.push('--resume', session.session_id);
    if (systemPromptFile)
      args.push('--system-prompt-file', systemPromptFile);
    args.push(...this.extraArgs);
    return args;
  }

  buildEnv = () => process.env;

  extractResponse(lines) {
    const assistantLines = lines.filter(l => l.type === 'assistant');
    const latest = assistantLines.at(-1);
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
    this.systemFile = config.systemPrompt ? this.paths.systemPrompt : null;
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
    const match = this.provider.findSessionLine(lines);
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

  resetChat() {
    this.archiveChat();
    writeFileSync(this.paths.chat, '[]');
    this.deleteFile(this.paths.session);
  }

  archiveChat() {
    let session;
    try {
      session = JSON.parse(readFileSync(this.paths.session, 'utf8'));
    } catch {
      return;
    }
    if (!session?.provider || !session?.session_id)
      return;
    if (!existsSync(this.paths.chat))
      return;
    mkdirSync(this.config.archiveDir, { recursive: true });
    const dest = `${this.config.archiveDir}/${session.provider}_${session.session_id}.json`;
    writeFileSync(dest, readFileSync(this.paths.chat));
  }

  formatContextPrompt(messages) {
    const body = messages.map(m =>
      `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`,
    ).join('\n\n');
    return `The following is a record of a previous conversation. Read it as context and wait for my next message:\n\n${body}`;
  }

  runBlocking(args, env) {
    const result = spawnSync(this.provider.name, args, { env, encoding: 'utf8' });
    return (result.stdout || '').split('\n').filter(Boolean).flatMap((l) => {
      const start = l.indexOf('{');
      if (start === -1)
        return [];
      try {
        return [JSON.parse(l.slice(start))];
      } catch {
        return [];
      }
    });
  }

  restoreSession(archivePath, query) {
    this.archiveChat();
    const base = basename(archivePath, '.json');
    const sep = base.indexOf('_');
    const archiveProvider = base.slice(0, sep);
    let sessionId = base.slice(sep + 1);
    let archiveMessages = [];
    try {
      archiveMessages = JSON.parse(readFileSync(archivePath, 'utf8'));
    } catch {}
    this.saveHistory(archiveMessages);
    this.deleteFile(archivePath);

    const canResume = archiveProvider === this.provider.name && this.provider.findSessionFile(sessionId);
    if (canResume) {
      writeFileSync(this.paths.session, JSON.stringify({ provider: archiveProvider, session_id: sessionId }));
    } else {
      const contextPrompt = this.formatContextPrompt(archiveMessages);
      const args = this.provider.buildArgs(contextPrompt, null, this.systemFile);
      const env = this.provider.buildEnv(this.systemFile);
      const lines = this.runBlocking(args, env);
      const match = this.provider.findSessionLine(lines);
      if (match) {
        sessionId = match.session_id;
        writeFileSync(this.paths.session, JSON.stringify({ provider: this.provider.name, session_id: sessionId }));
      } else {
        return { response: 'Failed to restore session: No session ID found in provider response', behaviour: { response: 'replacelast' } };
      }
    }

    if (query) {
      this.saveHistory([...archiveMessages, { role: 'user', content: query }]);
      return this.start(query);
    }

    return {
      variables: { replace_with_chat: '' },
      response: this.renderMarkdown(archiveMessages, false),
      behaviour: { scroll: 'end' },
    };
  }

  start(query) {
    this.setup();
    const session = this.getSession();
    const args = this.provider.buildArgs(query, session, this.systemFile);
    const env = this.provider.buildEnv(this.systemFile);

    writeFileSync(this.paths.stream, '', 'utf8');
    const fd = openSync(this.paths.stream, 'w');
    const child = spawn(this.provider.name, args, { stdio: ['ignore', fd, 'ignore'], detached: true, env });

    child.unref();
    closeSync(fd);
    writeFileSync(this.paths.pid, String(child.pid));

    const history = [...this.getHistory(), { role: 'user', content: query }];
    this.saveHistory(history);

    return {
      rerun: 0.5,
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
      return { rerun: 0.5, variables: { streaming_now: true }, response: '…', behaviour: { response: 'append' } };
    }

    const lines = streamString.split('\n').filter(Boolean).flatMap((l) => {
      const start = l.indexOf('{');
      if (start === -1)
        return [];
      try {
        return [JSON.parse(l.slice(start))];
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
        const history = [...this.getHistory(), { role: 'assistant', content: responseText }];
        this.saveHistory(history);
      }
      this.cleanup();
      return { response: `${responseText} [Connection Stalled]`, footer: 'Check connection', behaviour: { response: 'replacelast', scroll: 'end' } };
    }

    if (!streamString)
      return { rerun: 0.5, variables: { streaming_now: true } };
    return { rerun: 0.5, variables: { streaming_now: true }, response: responseText, behaviour: { response: 'replacelast', scroll: 'end' } };
  }

  handleError(lines) {
    this.cleanup();
    const errLine = lines.find(l => l.type === 'result' || l.type === 'error');
    const msg = errLine?.error || errLine?.message || 'Unknown Error';
    return { response: typeof msg === 'string' ? msg : JSON.stringify(msg), behaviour: { response: 'replacelast' } };
  }

  handleSuccess(lines, responseText) {
    this.saveSessionFromLines(lines);
    const history = [...this.getHistory(), { role: 'assistant', content: responseText }];
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
const providerName = env('provider');

const provider = providerName === 'gemini'
  ? new GeminiProvider(env('gemini_model'), parseArgs(env('gemini_options')))
  : new ClaudeProvider(env('claude_model'), parseArgs(env('claude_options')));

const config = {
  dataDir: env('alfred_workflow_data'),
  cacheDir: env('alfred_workflow_cache'),
  archiveDir: `${env('alfred_workflow_data')}/archive`,
  timeoutSeconds: Number.parseInt(env('timeout_seconds')) || 10,
  systemPrompt: env('system_prompt'),
  streamingNow: env('streaming_now') === '1',
  streamMarker: env('stream_marker') === '1',
  replaceWithChat: env('replace_with_chat'),
  newChat: env('new_chat') === '1',
  newChatAfterMinutes: Number.parseInt(env('new_chat_after_minutes')) || 0,
};

const bot = new Chatbot(provider, config);
const query = (process.argv[2] || '').trim();

if (!config.streamingNow && !bot.isStreaming()) {
  if (config.newChat) {
    bot.resetChat();
  } else if (bot.getSession() && config.newChatAfterMinutes) {
    let mtime = 0;
    try {
      mtime = statSync(bot.paths.chat).mtimeMs;
    } catch {}
    if (Date.now() - mtime > config.newChatAfterMinutes * 60 * 1000)
      bot.resetChat();
  }
}

if (config.streamingNow) {
  process.stdout.write(JSON.stringify(bot.poll()));
} else if (bot.isStreaming()) {
  if (bot.isProcessAlive()) {
    process.stdout.write(JSON.stringify({
      rerun: 0.5,
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
} else if (config.replaceWithChat) {
  process.stdout.write(JSON.stringify(bot.restoreSession(config.replaceWithChat, query)));
} else if (!query) {
  process.stdout.write(JSON.stringify({
    response: bot.renderMarkdown(bot.getHistory(), false),
    behaviour: { scroll: 'end' },
  }));
} else {
  process.stdout.write(JSON.stringify(bot.start(query)));
}
