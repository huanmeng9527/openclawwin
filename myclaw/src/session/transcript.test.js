import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRouter } from '../memory/index.js';
import { SessionTranscriptRecorder } from './transcript.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-transcript-'));
  const router = new MemoryRouter({ memory: { root } });
  const recorder = new SessionTranscriptRecorder(router);
  return { router, recorder, session: { id: 's1' } };
}

test('transcript recorder writes user, assistant, tool events to L2', () => {
  const { router, recorder, session } = setup();
  const toolCall = { id: 'tool-1', function: { name: 'read' } };

  recorder.recordUserMessage({ session, content: 'hello', messageId: 'm1' });
  recorder.recordAssistantMessage({ session, content: 'hi', messageId: 'm2' });
  recorder.recordToolCall({ session, toolCall, args: { path: 'a.txt' } });
  recorder.recordToolResult({ session, toolCall, result: 'ok' });
  recorder.recordToolError({ session, toolCall: { id: 'tool-2', function: { name: 'exec' } }, error: new Error('boom') });

  const records = router.session.list({ session_id: 's1' }, 20);
  assert.deepEqual(records.map(r => r.key).sort(), [
    'assistant_message',
    'tool_call',
    'tool_error',
    'tool_result',
    'user_message',
  ].sort());
});

test('transcript recorder is idempotent and redacts secrets/truncates content', () => {
  const { router, recorder, session } = setup();
  const long = 'x'.repeat(4500);

  recorder.recordUserMessage({ session, content: { api_key: 'secret', text: long }, messageId: 'dup' });
  recorder.recordUserMessage({ session, content: { api_key: 'secret2', text: long }, messageId: 'dup' });

  const records = router.session.list({ session_id: 's1' }, 20);
  assert.equal(records.length, 1);
  assert.match(records[0].content, /\[redacted\]/);
  assert.ok(records[0].content.length < 4300);
});
