export const CHAT_TIMEOUT_SECONDS = 60;

const validDiscordId = (value) => /^\d{1,20}$/.test(String(value ?? ''));

export const normalizeChatTimeoutCommand = (payload) => {
  const requestId = String(payload?.requestId ?? '');
  const userId = String(payload?.userId ?? '');
  const durationSeconds = Number(payload?.durationSeconds);
  if (
    requestId.length < 8 ||
    requestId.length > 100 ||
    !validDiscordId(userId) ||
    durationSeconds !== CHAT_TIMEOUT_SECONDS
  ) {
    return null;
  }
  return { requestId, userId, durationSeconds };
};

const timeoutKey = (serverId, userId) => `${serverId}:${userId}`;

export const setChatTimeout = (timeouts, serverId, userId, now = Date.now()) => {
  if (!(timeouts instanceof Map) || !validDiscordId(serverId) || !validDiscordId(userId)) {
    return false;
  }
  timeouts.set(timeoutKey(serverId, userId), now + CHAT_TIMEOUT_SECONDS * 1_000);
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
