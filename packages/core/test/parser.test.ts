import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNdjson, StreamParser, type CDKEvent, type CDKEventType } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

function parse(name: string): CDKEvent[] {
  // Deterministic ts for snapshot-friendly assertions.
  let ts = 1000;
  return parseNdjson(loadFixture(name), { now: () => ts++ });
}

function typesOf(events: CDKEvent[]): CDKEventType[] {
  return events.map((e) => e.type);
}

describe('StreamParser — fixture coverage', () => {
  const allFixtures = [
    '01-simple-text.ndjson',
    '02-single-tool-use.ndjson',
    '03-multi-tool-use.ndjson',
    '04-partial-messages.ndjson',
    '05-permission-probe.ndjson',
    '06-forced-error.ndjson',
    '07-permission-denied.ndjson',
  ];

  for (const fixture of allFixtures) {
    it(`${fixture}: parses every line without throwing`, () => {
      expect(() => parse(fixture)).not.toThrow();
    });

    it(`${fixture}: every event has sessionId/turnId/seq/ts populated`, () => {
      const events = parse(fixture);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.sessionId).toBeTruthy();
        expect(typeof e.turnId).toBe('string');
        expect(typeof e.seq).toBe('number');
        expect(typeof e.ts).toBe('number');
        expect(e.type).toBeTruthy();
      }
    });

    it(`${fixture}: seq is monotonic per session`, () => {
      const events = parse(fixture);
      let prevSeq = -1;
      for (const e of events) {
        expect(e.seq).toBeGreaterThan(prevSeq);
        prevSeq = e.seq;
      }
    });
  }
});

describe('StreamParser — fixture 01 simple text', () => {
  const events = parse('01-simple-text.ndjson');

  it('emits expected event sequence', () => {
    const types = typesOf(events);
    // 4 hook_started + 4 hook_response + init + 1 message (start+text+complete) +
    // rate_limit + post_turn_summary + session.done = 14 events
    expect(types).toContain('session.init');
    expect(types).toContain('assistant.message_start');
    expect(types).toContain('assistant.text_delta');
    expect(types).toContain('assistant.message_complete');
    expect(types).toContain('system.rate_limit');
    expect(types).toContain('system.post_turn_summary');
    expect(types).toContain('session.done');
    expect(types.filter((t) => t === 'system.hook_started')).toHaveLength(4);
    expect(types.filter((t) => t === 'system.hook_response')).toHaveLength(4);
  });

  it('synthesizes authMode from apiKeySource', () => {
    const init = events.find((e) => e.type === 'session.init');
    expect(init).toBeDefined();
    if (init && init.type === 'session.init') {
      // apiKeySource was "none" → subscription
      expect(init.apiKeySource).toBe('none');
      expect(init.authMode).toBe('subscription');
      expect(init.cliVersion).toBe('2.1.119');
      expect(init.tools.length).toBeGreaterThan(0);
    }
  });

  it('captures session.done with cost and usage', () => {
    const done = events.find((e) => e.type === 'session.done');
    expect(done).toBeDefined();
    if (done && done.type === 'session.done') {
      expect(done.stopReason).toBe('end_turn');
      expect(done.result).toBe('hello');
      expect(done.isError).toBe(false);
      expect(done.costUsd).toBeGreaterThan(0);
      expect(done.usage.inputTokens).toBe(6);
      expect(done.usage.outputTokens).toBe(6);
      expect(done.permissionDenials).toEqual([]);
    }
  });

  it('emits no meta.unknown events', () => {
    const unknowns = events.filter((e) => e.type === 'meta.unknown');
    expect(unknowns).toEqual([]);
  });
});

describe('StreamParser — fixture 02 single tool use', () => {
  const events = parse('02-single-tool-use.ndjson');

  it('emits a tool.use_start (Read) and matching tool.result', () => {
    const useStart = events.find((e) => e.type === 'tool.use_start');
    expect(useStart).toBeDefined();
    if (useStart && useStart.type === 'tool.use_start') {
      expect(useStart.toolName).toBe('Read');
      expect(useStart.input).toHaveProperty('file_path');
    }
    const toolResult = events.find((e) => e.type === 'tool.result');
    expect(toolResult).toBeDefined();
    if (
      toolResult &&
      toolResult.type === 'tool.result' &&
      useStart &&
      useStart.type === 'tool.use_start'
    ) {
      expect(toolResult.toolUseId).toBe(useStart.toolUseId);
      expect(toolResult.isError).toBe(false);
    }
  });

  it('emits assistant.thinking_delta blocks', () => {
    const thinkings = events.filter((e) => e.type === 'assistant.thinking_delta');
    expect(thinkings.length).toBeGreaterThan(0);
  });
});

describe('StreamParser — fixture 03 multi-tool use', () => {
  const events = parse('03-multi-tool-use.ndjson');

  it('emits multiple tool.use_start and matching tool.result events', () => {
    const useStarts = events.filter((e) => e.type === 'tool.use_start');
    const results = events.filter((e) => e.type === 'tool.result');
    expect(useStarts.length).toBeGreaterThanOrEqual(2);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});

describe('StreamParser — fixture 04 partial messages (delta streaming)', () => {
  const events = parse('04-partial-messages.ndjson');

  it('emits text_delta and thinking_delta events from stream_event lines', () => {
    const textDeltas = events.filter((e) => e.type === 'assistant.text_delta');
    const thinkingDeltas = events.filter((e) => e.type === 'assistant.thinking_delta');
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(thinkingDeltas.length).toBeGreaterThan(0);
  });

  it('content_block_start/stop and message_delta are emitted as meta.unknown (no typed events yet)', () => {
    // Phase 2 deliberate scope: we don't yet have first-class events for these
    // structural deltas. They flow through meta.unknown so they're not lost.
    const unknowns = events.filter((e) => e.type === 'meta.unknown');
    const rawTypes = new Set(unknowns.map((e) => (e as { rawType: string }).rawType));
    expect(rawTypes.has('stream_event/content_block_start')).toBe(true);
    expect(rawTypes.has('stream_event/content_block_stop')).toBe(true);
    expect(rawTypes.has('stream_event/message_delta')).toBe(true);
  });

  it('emits a system.status event for the "requesting" status', () => {
    const status = events.find((e) => e.type === 'system.status');
    expect(status).toBeDefined();
  });
});

describe('StreamParser — fixture 06 forced error', () => {
  const events = parse('06-forced-error.ndjson');

  it('session.done carries isError + apiErrorStatus', () => {
    const done = events.find((e) => e.type === 'session.done');
    expect(done).toBeDefined();
    if (done && done.type === 'session.done') {
      expect(done.isError).toBe(true);
      expect(done.apiErrorStatus).toBe(404);
      expect(done.terminalReason).toBe('completed');
    }
  });
});

describe('StreamParser — fixture 07 permission denied', () => {
  const events = parse('07-permission-denied.ndjson');

  it('synthesizes a tool.permission_request event when seeing a denied tool_result', () => {
    const permReqs = events.filter((e) => e.type === 'tool.permission_request');
    expect(permReqs.length).toBeGreaterThanOrEqual(1);
    if (permReqs[0] && permReqs[0].type === 'tool.permission_request') {
      expect(permReqs[0].toolName).toContain('mcp__plugin_claude-mem');
      expect(permReqs[0].toolUseId).toBeTruthy();
    }
  });

  it('session.done carries permissionDenials matching the synthesized event', () => {
    const done = events.find((e) => e.type === 'session.done');
    expect(done).toBeDefined();
    if (done && done.type === 'session.done') {
      expect(done.permissionDenials?.length).toBeGreaterThanOrEqual(1);
      const denial = done.permissionDenials?.[0];
      expect(denial?.toolName).toContain('mcp__plugin_claude-mem');
    }
  });
});

describe('StreamParser — meta.unknown forward-compat', () => {
  it('wraps unrecognized top-level types verbatim', () => {
    const parser = new StreamParser({ now: () => 0 });
    const out = parser.parseLine({
      type: 'totally_new_event_type',
      session_id: 'sess-123',
      payload: { hello: 'world' },
    });
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    expect(ev.type).toBe('meta.unknown');
    if (ev.type === 'meta.unknown') {
      expect(ev.rawType).toBe('totally_new_event_type');
      expect(ev.raw).toMatchObject({ payload: { hello: 'world' } });
      expect(ev.sessionId).toBe('sess-123');
    }
  });

  it('non-JSON strings also flow through meta.unknown', () => {
    const parser = new StreamParser({ now: () => 0 });
    const out = parser.parseLine('not json {');
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('meta.unknown');
  });

  it('skips empty lines silently', () => {
    const parser = new StreamParser({ now: () => 0 });
    expect(parser.parseLine('')).toEqual([]);
    expect(parser.parseLine('   \n')).toEqual([]);
  });
});
