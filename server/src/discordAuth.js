import { createHmac, timingSafeEqual } from 'node:crypto';

export const DISCORD_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const cleanDisplayName = (value) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);

const sign = (payload, secret) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export const normalizeDiscordUser = (profile) => {
  const id = String(profile?.id ?? '');
  const name = cleanDisplayName(profile?.global_name) || cleanDisplayName(profile?.username);
  if (!/^\d{1,20}$/.test(id) || !name) return null;
  return { id, name };
};

export const createDiscordSessionToken = (user, secret, nowSeconds = Math.floor(Date.now() / 1_000)) => {
  const normalized = normalizeDiscordUser({ id: user?.id, username: user?.name });
  if (!normalized || typeof secret !== 'string' || secret.length < 32) return null;
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      sub: normalized.id,
      name: normalized.name,
      iat: nowSeconds,
      exp: nowSeconds + DISCORD_SESSION_TTL_SECONDS,
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
};

export const verifyDiscordSessionToken = (
  token,
  secret,
  nowSeconds = Math.floor(Date.now() / 1_000),
) => {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const suppliedSignature = Buffer.from(parts[1], 'base64url');
  const expectedSignature = Buffer.from(sign(parts[0], secret), 'base64url');
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const user = normalizeDiscordUser({ id: payload.sub, username: payload.name });
    if (
      payload.v !== 1 ||
      !user ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat > nowSeconds + 300 ||
      payload.exp <= nowSeconds
    ) {
      return null;
    }
    return user;
  } catch {
    return null;
  }
};
