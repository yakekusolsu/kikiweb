export const CHAT_MAX_LENGTH = 1_000;

export const normalizeChatMessage = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!normalized || normalized.length > CHAT_MAX_LENGTH) return null;
  return normalized;
};

export const createChatPostCommand = (requestId, channelId, value) => {
  const content = normalizeChatMessage(value);
  if (
    typeof requestId !== 'string' ||
    requestId.length < 8 ||
    requestId.length > 100 ||
    !/^\d{1,20}$/.test(String(channelId)) ||
    !content
  ) {
    return null;
  }
  return {
    type: 'chat-post',
    requestId,
    channelId: String(channelId),
    content,
  };
};
