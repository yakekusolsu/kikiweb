import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_HISTORY_LIMIT,
  appendChatMessage,
  normalizeDiscordChatMessage,
} from '../src/chatMessages.js';

const message = (overrides = {}) => ({
  type: 'chat-message',
  id: '100',
  channelId: '200',
  channelName: 'voice-chat',
  authorId: '300',
  authorName: 'Kiki user',
  bot: false,
  webhook: false,
  content: ' hello ',
  timestamp: '2026-08-06T10:00:00.000Z',
  ...overrides,
});

test('normalizes a message only for the configured Discord channel', () => {
  assert.deepEqual(normalizeDiscordChatMessage(message(), '200'), {
    id: '100',
    channelId: '200',
    channelName: 'voice-chat',
    authorId: '300',
    authorName: 'Kiki user',
    bot: false,
    webhook: false,
    content: 'hello',
    timestamp: '2026-08-06T10:00:00.000Z',
  });
  assert.equal(normalizeDiscordChatMessage(message(), '999'), null);
  assert.equal(normalizeDiscordChatMessage(message({ content: '' }), '200'), null);
});

test('deduplicates messages and retains only the newest history', () => {
  const messages = [];
  for (let index = 0; index < CHAT_HISTORY_LIMIT + 5; index += 1) {
    appendChatMessage(messages, {
      ...normalizeDiscordChatMessage(
        message({
          id: String(1_000 + index),
          timestamp: new Date(Date.UTC(2026, 7, 6, 10, 0, index)).toISOString(),
        }),
        '200',
      ),
    });
  }
  appendChatMessage(messages, { ...messages.at(-1), content: 'updated' });

  assert.equal(messages.length, CHAT_HISTORY_LIMIT);
  assert.equal(messages[0].id, '1005');
  assert.equal(messages.at(-1).content, 'updated');
});
