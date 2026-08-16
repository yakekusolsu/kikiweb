export const CHAT_TIMEOUT_DURATIONS_SECONDS = Object.freeze([
  60,
  5 * 60,
  30 * 60,
  60 * 60,
  24 * 60 * 60,
  3 * 24 * 60 * 60,
]);

const validDuration = (value) => CHAT_TIMEOUT_DURATIONS_SECONDS.includes(value);

const validDiscordId = (value) => /^\d{1,20}$/.test(String(value ?? ''));

export const normalizeChatTimeoutCommand = (payload) => {
  const requestId = String(payload?.requestId ?? '');
  const userId = String(payload?.userId ?? '');
  const durationSeconds = Number(payload?.durationSeconds);
  if (
    requestId.length < 8 ||
    requestId.length > 100 ||
    !validDiscordId(userId) ||
    !validDuration(durationSeconds)
  ) {
    return null;
  }
  return { requestId, userId, durationSeconds };
};

const timeoutKey = (serverId, userId) => `${serverId}:${userId}`;

export const setChatTimeout = (
  timeouts,
  serverId,
  userId,
  durationSeconds,
  now = Date.now(),
) => {
  if (
    !(timeouts instanceof Map) ||
    !validDiscordId(serverId) ||
    !validDiscordId(userId) ||
    !validDuration(durationSeconds)
  ) {
    return false;
  }
  timeouts.set(timeoutKey(serverId, userId), now + durationSeconds * 1_000);
  return true;
};

export const chatTimeoutRetryAfter = (timeouts, serverId, userId, now = Date.now()) => {
  if (!(timeouts instanceof Map)) return 0;
  const key = timeoutKey(serverId, userId);
  const expiresAt = Number(timeouts.get(key));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    timeouts.delete(key);
    return 0;
  }
  return Math.max(1, Math.ceil((expiresAt - now) / 1_000));
};
