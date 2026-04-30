/**
 * Renderer process. Uses @claude-cdk/electron-client to drive a session
 * over IPC and stream events into the DOM.
 *
 * Bundled by esbuild (IIFE) so this file's bare imports resolve at build
 * time. The renderer itself sees only `window.cdk` and `window.app` —
 * no Node, no Electron internals.
 */

import {
  CDKClient,
  type CDKEvent,
  type IpcBridge,
  type Session,
} from '@claude-cdk/electron-client';

interface AppGlobals {
  getDefaults(): Promise<{ cwd: string }>;
}

declare global {
  interface Window {
    cdk: IpcBridge;
    app: AppGlobals;
  }
}

const client = new CDKClient(window.cdk);

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const promptEl = $<HTMLTextAreaElement>('prompt');
const sendBtn = $<HTMLButtonElement>('send');
const abortBtn = $<HTMLButtonElement>('abort');
const newBtn = $<HTMLButtonElement>('new-session');
const outputEl = $<HTMLDivElement>('output');
const statusEl = $<HTMLDivElement>('status');
const sessionInfoEl = $<HTMLSpanElement>('session-info');

let session: Session | null = null;
let inFlight = false;

async function ensureSession(): Promise<Session> {
  if (session) return session;
  setStatus('Starting session…');
  const { cwd } = await window.app.getDefaults();
  session = await client.startSession({
    cwd,
    model: 'claude-haiku-4-5-20251001',
    noSessionPersistence: true,
    permissionMode: 'bypassPermissions',
  });
  sessionInfoEl.textContent = `session: ${session.id.slice(0, 8)}…`;
  setStatus('Session ready.');
  return session;
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function appendBlock(klass: string, text = ''): HTMLDivElement {
  const block = document.createElement('div');
  block.className = `block ${klass}`;
  block.textContent = text;
  outputEl.appendChild(block);
  outputEl.scrollTop = outputEl.scrollHeight;
  return block;
}

function appendUserPrompt(text: string): void {
  const block = appendBlock('user');
  block.textContent = `▸ ${text}`;
}

async function send(): Promise<void> {
  const prompt = promptEl.value.trim();
  if (!prompt || inFlight) return;
  inFlight = true;
  sendBtn.disabled = true;
  abortBtn.disabled = false;
  promptEl.value = '';
  appendUserPrompt(prompt);

  try {
    const s = await ensureSession();
    let textBlock: HTMLDivElement | null = null;
    let thinkingBlock: HTMLDivElement | null = null;

    setStatus('Sending…');
    for await (const ev of s.send(prompt)) {
      handleEvent(ev, {
        getOrCreateText: () => {
          if (!textBlock) textBlock = appendBlock('assistant');
          return textBlock;
        },
        getOrCreateThinking: () => {
          if (!thinkingBlock) thinkingBlock = appendBlock('thinking');
          return thinkingBlock;
        },
        resetMessage: () => {
          textBlock = null;
          thinkingBlock = null;
        },
      });
    }
    setStatus('Done.');
  } catch (err) {
    appendBlock('error', `Error: ${(err as Error).message}`);
    setStatus('Error.');
  } finally {
    inFlight = false;
    sendBtn.disabled = false;
    abortBtn.disabled = true;
  }
}

interface EventHandlers {
  getOrCreateText(): HTMLDivElement;
  getOrCreateThinking(): HTMLDivElement;
  resetMessage(): void;
}

function handleEvent(ev: CDKEvent, h: EventHandlers): void {
  switch (ev.type) {
    case 'session.init':
      setStatus(`init · model=${ev.model} · auth=${ev.authMode} · cli=${ev.cliVersion}`);
      break;
    case 'assistant.text_delta':
      h.getOrCreateText().textContent += ev.delta;
      outputEl.scrollTop = outputEl.scrollHeight;
      break;
    case 'assistant.thinking_delta':
      h.getOrCreateThinking().textContent += ev.delta;
      outputEl.scrollTop = outputEl.scrollHeight;
      break;
    case 'assistant.message_complete':
      h.resetMessage();
      break;
    case 'tool.use_start':
      appendBlock('tool', `↳ ${ev.toolName}(${truncateInput(ev.input)})`);
      break;
    case 'tool.result': {
      const label = ev.isError ? 'error' : 'tool-result';
      const summary = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result);
      appendBlock(label, `← ${summary.slice(0, 200)}${summary.length > 200 ? '…' : ''}`);
      break;
    }
    case 'tool.permission_request':
      appendBlock(
        'permission',
        `⚠ permission denied: ${ev.toolName} (preapproval only in -p mode)`,
      );
      break;
    case 'session.done':
      if (ev.isError) {
        setStatus(`error · ${ev.apiErrorStatus ?? '?'}`);
      } else {
        setStatus(
          `done · ${ev.durationMs}ms · in=${ev.usage.inputTokens} out=${ev.usage.outputTokens}` +
            (ev.costUsd !== undefined ? ` · $${ev.costUsd.toFixed(4)}` : ''),
        );
      }
      break;
    case 'session.aborted':
      setStatus('aborted');
      break;
    case 'system.rate_limit':
      // surface only when not allowed
      if (ev.status !== 'allowed') {
        appendBlock('warning', `rate limit: ${ev.status} (${ev.rateLimitType})`);
      }
      break;
    case 'meta.unknown':
      // ignored in the UI; logged for debugging
      console.log('meta.unknown', ev.rawType, ev.raw);
      break;
    default:
      // hooks, post_turn_summary, etc. — too noisy for the demo
      break;
  }
}

function truncateInput(input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

async function abort(): Promise<void> {
  if (!session) return;
  setStatus('Aborting…');
  await session.abort();
}

async function startNewSession(): Promise<void> {
  if (session) await session.close();
  session = null;
  outputEl.innerHTML = '';
  sessionInfoEl.textContent = '(no session)';
  setStatus('Cleared. Send a prompt to start a new session.');
}

sendBtn.addEventListener('click', () => void send());
abortBtn.addEventListener('click', () => void abort());
newBtn.addEventListener('click', () => void startNewSession());
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
});

abortBtn.disabled = true;
setStatus('Ready. Cmd/Ctrl+Enter to send.');
