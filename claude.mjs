#!/usr/bin/env node

import { spawn } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';

const CLAUDE = '/opt/homebrew/bin/claude';

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

function startClaudeStream(model, systemPrompt, sessionId, query, streamFile, pidStreamFile) {
  writeFileSync(streamFile, '', 'utf8');
  const fd = openSync(streamFile, 'w');

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', ''];
  if (model)
    args.push('--model', model);
  if (systemPrompt)
    args.push('--system-prompt', systemPrompt);
  if (sessionId)
    args.push('--resume', sessionId);
  args.push(query);

  const child = spawn(CLAUDE, args, {
    stdio: ['ignore', fd, 'ignore'],
    detached: true,
  });
  child.unref();
  closeSync(fd);

  writeFile(pidStreamFile, String(child.pid));
}

function readStream(streamFile, chatFile, sessionFile, pidStreamFile, timeoutSeconds) {
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

  // Parse NDJSON
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

  // Each assistant message contains the accumulated text so far — take the latest
  const assistantMessages = lines.filter(l => l.type === 'assistant');
  const latestMessage = assistantMessages[assistantMessages.length - 1];
  const responseText = latestMessage
    ? (latestMessage.message?.content || [])
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('')
    : '';

  const resultLine = lines.find(l => l.type === 'result');
  const finishReason = resultLine ? (resultLine.subtype === 'error' ? 'error' : 'stop') : null;

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
        footer: 'You can ask Claude to continue the answer',
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

  if (resultLine.subtype === 'error') {
    deleteFile(streamFile);
    deleteFile(pidStreamFile);
    return JSON.stringify({
      response: resultLine.error || 'An error occurred',
      behaviour: { response: 'replacelast' },
    });
  }

  if (resultLine?.session_id)
    writeFile(sessionFile, JSON.stringify({ session_id: resultLine.session_id }));
  appendChat(chatFile, { role: 'assistant', content: responseText });
  deleteFile(streamFile);
  deleteFile(pidStreamFile);

  const footer = finishReason === 'length' ? 'Maximum number of tokens reached' : undefined;
  return JSON.stringify({
    response: responseText,
    ...(footer ? { footer } : {}),
    behaviour: { response: 'replacelast', scroll: 'end' },
  });
}

(() => {
  const typedQuery = process.argv[2] || '';
  const timeoutSeconds = Number.parseInt(env('timeout_seconds')) || 10;
  const systemPrompt = env('system_prompt');
  const model = env('claude_model');
  const dataDir = env('alfred_workflow_data');
  const cacheDir = env('alfred_workflow_cache');
  const chatFile = `${dataDir}/chat.json`;
  const sessionFile = `${dataDir}/session.json`;
  const pidStreamFile = `${cacheDir}/pid.txt`;
  const streamFile = `${cacheDir}/stream.txt`;
  const streamingNow = env('streaming_now') === '1';

  if (streamingNow) {
    process.stdout.write(readStream(streamFile, chatFile, sessionFile, pidStreamFile, timeoutSeconds));
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

  // If stream file exists, check whether a live claude process is still writing to it
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

  let sessionId = null;
  try {
    if (existsSync(sessionFile))
      sessionId = JSON.parse(readFileSync(sessionFile, 'utf8')).session_id;
  } catch {}

  const appendQuery = { role: 'user', content: typedQuery };
  const ongoingChat = previousChat.concat(appendQuery);

  startClaudeStream(model, systemPrompt, sessionId, typedQuery, streamFile, pidStreamFile);
  appendChat(chatFile, appendQuery);

  process.stdout.write(JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true, stream_marker: true },
    response: markdownChat(ongoingChat),
  }));
})();
