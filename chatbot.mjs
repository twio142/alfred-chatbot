#!/usr/bin/env node

import { spawn } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';


function env(name) {
  return process.env[name] || '';
}

function deleteFile(p) {
  try {
    unlinkSync(p);
  } catch {}
}

function writeFile(p, text) {
  writeFileSync(p, text, 'utf8');
}

function readChat(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function appendChat(p, message) {
  writeFile(p, JSON.stringify(readChat(p).concat(message)));
}

function markdownChat(messages, ignoreLastInterrupted = true) {
  return messages.reduce((acc, cur, i, all) => {
    if (cur.role === 'assistant')
      return `${acc}${cur.content}\n\n`;
    if (cur.role === 'user') {
      const msg = `# 􀉪 You\n\n${cur.content}\n\n# 􀙫 Assistant`;
      const userTwice = all[i + 1]?.role === 'user';
      const isLast = i === all.length - 1;
      return userTwice || (isLast && !ignoreLastInterrupted)
        ? `${acc}${msg}\n\n[Answer Interrupted]\n\n`
        : `${acc}${msg}\n\n`;
    }
    return acc;
  }, '');
}

function buildArgs(provider, model, systemPrompt, session, query) {
  const args = ['--output-format', 'stream-json'];
  if (provider === 'gemini') {
    args.push('--sandbox');
    // NOTE: gemini's --model arg doesn't work with -p
    // if (model) args.push('--model', model);
    if (session) args.push('--resume', 'latest');
  } else {
    args.push('--verbose', '--include-partial-messages', '--tools', '');
    if (model) args.push('--model', model);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    if (session) args.push('--resume', session.session_id);
  }
  args.push('-p', query);
  return args;
}

function startStream(provider, model, systemPrompt, session, query, streamFile, pidStreamFile) {
  writeFileSync(streamFile, '', 'utf8');
  const fd = openSync(streamFile, 'w');

  const args = buildArgs(provider, model, systemPrompt, session, query);
  const child = spawn(provider === 'gemini' ? 'gemini' : 'claude', args, {
    stdio: ['ignore', fd, 'ignore'],
    detached: true,
  });
  child.unref();
  closeSync(fd);

  writeFile(pidStreamFile, String(child.pid));
}

function extractResponse(lines, provider) {
  if (provider === 'gemini') {
    const messages = lines.filter(l => l.type === 'message' && l.role === 'assistant');
    return messages[messages.length - 1]?.content || '';
  } else {
    // claude: each assistant message contains the accumulated text so far — take the latest
    const messages = lines.filter(l => l.type === 'assistant');
    const latest = messages[messages.length - 1];
    return latest
      ? (latest.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('')
      : '';
  }
}

function extractFinishReason(lines, provider) {
  const resultLine = lines.find(l => l.type === 'result');
  if (resultLine) return resultLine[provider === 'gemini' ? 'status' : 'subtype'] === 'error' ? 'error' : 'stop';
  if (lines.some(l => l.type === 'error')) return 'error';
  return null;
}

function extractError(lines) {
  const errLine = lines.find(l => l.type === 'result' || l.type === 'error');
  const err = errLine?.error || errLine?.message;
  if (!err) return 'An error occurred';
  return typeof err === 'string' ? err : (err.message || JSON.stringify(err));
}

function saveSession(sessionFile, provider, lines) {
  if (provider === 'gemini') {
    const initLine = lines.find(l => l.type === 'init');
    if (initLine?.session_id) writeFile(sessionFile, JSON.stringify({ provider, session_id: initLine.session_id }));
  } else {
    const resultLine = lines.find(l => l.type === 'result');
    if (resultLine?.session_id) writeFile(sessionFile, JSON.stringify({ provider, session_id: resultLine.session_id }));
  }
}

function readStream(provider, streamFile, chatFile, sessionFile, pidStreamFile, timeoutSeconds) {
  const streamMarker = env('stream_marker') === '1';

  let streamString = '';
  try {
    streamString = readFileSync(streamFile, 'utf8');
  } catch {}

  if (streamMarker) {
    return JSON.stringify({
      rerun: 0.1,
      variables: { streaming_now: true },
      response: '…',
      behaviour: { response: 'append' },
    });
  }

  const lines = streamString
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

  const responseText = extractResponse(lines, provider);
  const finishReason = extractFinishReason(lines, provider);

  if (!finishReason) {
    let mtime = 0;
    try {
      mtime = statSync(streamFile).mtimeMs;
    } catch {}
    const stalled = streamString.length > 0 && Date.now() - mtime > timeoutSeconds * 1000;

    if (stalled) {
      if (responseText.length > 0)
        appendChat(chatFile, { role: 'assistant', content: responseText });
      deleteFile(streamFile);
      deleteFile(pidStreamFile);
      return JSON.stringify({
        response: `${responseText} [Connection Stalled]`,
        footer: 'You can ask to continue the answer',
        behaviour: { response: 'replacelast', scroll: 'end' },
      });
    }

    if (!streamString) {
      return JSON.stringify({
        rerun: 0.1,
        variables: { streaming_now: true },
      });
    }

    return JSON.stringify({
      rerun: 0.1,
      variables: { streaming_now: true },
      response: responseText,
      behaviour: { response: 'replacelast', scroll: 'end' },
    });
  }

  if (finishReason === 'error') {
    deleteFile(streamFile);
    deleteFile(pidStreamFile);
    return JSON.stringify({
      response: extractError(lines),
      behaviour: { response: 'replacelast' },
    });
  }

  saveSession(sessionFile, provider, lines);
  appendChat(chatFile, { role: 'assistant', content: responseText });
  deleteFile(streamFile);
  deleteFile(pidStreamFile);

  return JSON.stringify({
    response: responseText,
    behaviour: { response: 'replacelast', scroll: 'end' },
  });
}

(() => {
  const typedQuery = process.argv[2] || '';
  const timeoutSeconds = Number.parseInt(env('timeout_seconds')) || 10;
  const systemPrompt = env('system_prompt');
  const provider = env('provider') || 'claude';
  const model = provider === 'gemini' ? env('gemini_model') : env('claude_model');
  const dataDir = env('alfred_workflow_data');
  const cacheDir = env('alfred_workflow_cache');
  const chatFile = `${dataDir}/chat.json`;
  const sessionFile = `${dataDir}/session.json`;
  const pidStreamFile = `${cacheDir}/pid.txt`;
  const streamFile = `${cacheDir}/stream.txt`;
  const streamingNow = env('streaming_now') === '1';

  if (streamingNow) {
    process.stdout.write(readStream(provider, streamFile, chatFile, sessionFile, pidStreamFile, timeoutSeconds));
    return;
  }

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  let previousChat = [];
  try {
    previousChat = readChat(chatFile);
  } catch {
    writeFile(chatFile, '[]');
  }

  // If stream file exists, check whether a live process is still writing to it
  if (existsSync(streamFile)) {
    const pidAlive = (() => {
      try {
        const pid = Number.parseInt(readFileSync(pidStreamFile, 'utf8'));
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (!pidAlive) {
      deleteFile(streamFile);
      deleteFile(pidStreamFile);
    } else {
      process.stdout.write(JSON.stringify({
        rerun: 0.1,
        variables: { streaming_now: true, stream_marker: true },
        response: markdownChat(previousChat, true),
        behaviour: { scroll: 'end' },
      }));
      return;
    }
  }

  if (!typedQuery) {
    process.stdout.write(JSON.stringify({
      response: markdownChat(previousChat, false),
      behaviour: { scroll: 'end' },
    }));
    return;
  }

  // Load session only if it's from the same provider
  let session = null;
  try {
    if (existsSync(sessionFile)) {
      const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
      if (saved.provider === provider) session = saved;
    }
  } catch {}

  const appendQuery = { role: 'user', content: typedQuery };
  const ongoingChat = previousChat.concat(appendQuery);

  startStream(provider, model, systemPrompt, session, typedQuery, streamFile, pidStreamFile);
  appendChat(chatFile, appendQuery);

  process.stdout.write(JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true, stream_marker: true },
    response: markdownChat(ongoingChat),
  }));
})();
