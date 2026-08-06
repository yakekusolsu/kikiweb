export const CHAT_MAX_LENGTH = 1_000;
const CHAT_URL_PATTERN = /(?:\b(?:https?|ftp):\/\/|\bwww\.|(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?:[/:?#][^\s]*)?|(?:\d{1,3}\.){3}\d{1,3}(?:[/:?#][^\s]*)?)/iu;

export const normalizeChatMessage = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!normalized || normalized.length > CHAT_MAX_LENGTH) return null;
  return normalized;
};

export const containsChatUrl = (value) =>
  typeof value === 'string' && CHAT_URL_PATTERN.test(value.normalize('NFKC'));

export const createChatPostCommand = (requestId, channelId, value, authorName = '') => {
  const content = normalizeChatMessage(value);
  const normalizedAuthorName = String(authorName ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  if (
    typeof requestId !== 'string' ||
    requestId.length < 8 ||
    requestId.length > 100 ||
    !/^\d{1,20}$/.test(String(channelId)) ||
    !content ||
    containsChatUrl(content)
  ) {
    return null;
  }
  return {
    type: 'chat-post',
    requestId,
    channelId: String(channelId),
    content,
    ...(normalizedAuthorName ? { authorName: normalizedAuthorName } : {}),
  };
};
