import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_TIMEOUT_SECONDS,
  chatTimeoutRetryAfter,
  normalizeChatTimeoutCommand,
  setChatTimeout,
} from '../src/chatTimeout.js';

test('normalizes a one-minute chat timeout command', () => {
  assert.deepEqual(
    normalizeChatTimeoutCommand({
      requestId: 'request-123',
      userId: '300',
      durationSeconds: 60,
    }),
    { requestId: 'request-123', userId: '300', durationSeconds: 60 },
  );
  assert.equal(
    normalizeChatTimeoutCommand({ requestId: 'request-123', userId: 'bad', durationSeconds: 60 }),
    null,
  );
  assert.equal(
    normalizeChatTimeoutCommand({ requestId: 'request-123', userId: '300', durationSeconds: 30 }),
    null,
  );
});

test('keeps chat timeouts separate per Discord server and expires them', () => {
  const timeouts = new Map();
  const now = 2_000_000_000_000;
  assert.equal(setChatTimeout(timeouts, '100', '300', now), true);
  assert.equal(chatTimeoutRetryAfter(timeouts, '100', '300', now), CHAT_TIMEOUT_SECONDS);
  assert.equal(chatTimeoutRetryAfter(timeouts, '200', '300', now), 0);
  assert.equal(chatTimeoutRetryAfter(timeouts, '100', '300', now + 30_500), 30);
  assert.equal(chatTimeoutRetryAfter(timeouts, '100', '300', now + 60_000), 0);
});
