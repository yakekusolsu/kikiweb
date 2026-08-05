import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_MAX_LENGTH,
  CHAT_WEBHOOK_USERNAME,
  fetchDiscordWebhookMetadata,
  isDiscordWebhookUrl,
  normalizeChatMessage,
  parseChatWebhookUrls,
  postDiscordChatMessage,
  resolveChatWebhookUrl,
} from '../src/chatWebhook.js';

test('normalizes bounded chat messages', () => {
  assert.equal(normalizeChatMessage('  hello\u0000 world  '), 'hello world');
  assert.equal(normalizeChatMessage(''), null);
  assert.equal(normalizeChatMessage('x'.repeat(CHAT_MAX_LENGTH + 1)), null);
});

test('accepts only official Discord webhook URLs', () => {
  assert.equal(isDiscordWebhookUrl('https://discord.com/api/webhooks/123/token'), true);
  assert.equal(isDiscordWebhookUrl('https://canary.discord.com/api/v10/webhooks/123/token'), true);
  assert.equal(isDiscordWebhookUrl('https://example.com/api/webhooks/123/token'), false);
  assert.equal(isDiscordWebhookUrl('http://discord.com/api/webhooks/123/token'), false);
});

test('resolves a server-specific webhook before the fallback', () => {
  const fallback = 'https://discord.com/api/webhooks/100/fallback';
  const specific = 'https://discord.com/api/webhooks/200/specific';
  const urls = parseChatWebhookUrls(JSON.stringify({ 123: specific }), fallback);
  assert.equal(resolveChatWebhookUrl(urls, '123'), specific);
  assert.equal(resolveChatWebhookUrl(urls, '456'), fallback);
});

test('posts a fixed username and disables mentions', async () => {
  let request;
  const delivered = { id: '999', content: 'hello' };
  const result = await postDiscordChatMessage('https://discord.com/api/webhooks/123/token', 'hello', async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => delivered };
  });

  assert.equal(request.url.toString(), 'https://discord.com/api/webhooks/123/token?wait=true');
  assert.equal(result, delivered);
  assert.deepEqual(JSON.parse(request.options.body), {
    username: CHAT_WEBHOOK_USERNAME,
    content: 'hello',
    allowed_mentions: { parse: [] },
  });
});

test('reads the webhook guild and channel metadata', async () => {
  const metadata = await fetchDiscordWebhookMetadata(
    'https://discord.com/api/webhooks/123/token',
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({ guild_id: '111', channel_id: '222' }),
    }),
  );
  assert.deepEqual(metadata, { guildId: '111', channelId: '222' });
});
