import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCORD_SESSION_TTL_SECONDS,
  createDiscordSessionToken,
  normalizeDiscordUser,
  verifyDiscordSessionToken,
} from '../src/discordAuth.js';

const secret = 'test-secret-that-is-at-least-thirty-two-characters';

test('normalizes the Discord global display name', () => {
  assert.deepEqual(
    normalizeDiscordUser({ id: '1234567890', username: 'login_name', global_name: ' Display\n Name ' }),
    { id: '1234567890', name: 'Display Name' },
  );
  assert.equal(normalizeDiscordUser({ id: 'invalid', username: 'name' }), null);
});

test('signs and verifies a bounded Discord session', () => {
  const now = 2_000_000_000;
  const token = createDiscordSessionToken({ id: '1234567890', name: 'Kiki user' }, secret, now);
  assert.deepEqual(verifyDiscordSessionToken(token, secret, now + 60), {
    id: '1234567890',
    name: 'Kiki user',
  });
  assert.equal(verifyDiscordSessionToken(token, `${secret}x`, now + 60), null);
  assert.equal(verifyDiscordSessionToken(token, secret, now + DISCORD_SESSION_TTL_SECONDS), null);
});
