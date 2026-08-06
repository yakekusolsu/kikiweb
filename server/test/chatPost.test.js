import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_MAX_LENGTH,
  createChatPostCommand,
  normalizeChatMessage,
} from '../src/chatPost.js';

test('normalizes bounded chat messages', () => {
  assert.equal(normalizeChatMessage('  hello\u0000 world  '), 'hello world');
  assert.equal(normalizeChatMessage(''), null);
  assert.equal(normalizeChatMessage('x'.repeat(CHAT_MAX_LENGTH + 1)), null);
});

test('creates a command for the connected Discord Bot', () => {
  assert.deepEqual(createChatPostCommand('request-123', '1234567890', ' KikiWebからこんにちは '), {
    type: 'chat-post',
    requestId: 'request-123',
    channelId: '1234567890',
    content: 'KikiWebからこんにちは',
  });
  assert.equal(createChatPostCommand('short', '1234567890', 'hello'), null);
  assert.equal(createChatPostCommand('request-123', 'invalid', 'hello'), null);
});
