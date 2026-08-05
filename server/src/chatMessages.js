export const CHAT_HISTORY_LIMIT = 50;

const safeText = (value, maximumLength) =>
  String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maximumLength);

export const normalizeDiscordChatMessage = (payload, expectedChannelId) => {
  if (payload?.type !== 'chat-message') return null;

  const id = String(payload.id ?? '');
  const channelId = String(payload.channelId ?? '');
  const authorId = String(payload.authorId ?? '');
  const authorName = safeText(payload.authorName, 100);
  const content = safeText(payload.content, 2_000);
  const timestamp = Date.parse(String(payload.timestamp ?? ''));
  if (
    !/^\d{1,20}$/.test(id) ||
    !/^\d{1,20}$/.test(channelId) ||
    channelId !== expectedChannelId ||
    !/^\d{1,20}$/.test(authorId) ||
    !authorName ||
    !content ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }

  return {
    id,
    channelId,
    channelName: safeText(payload.channelName, 100) || 'Discord chat',
    authorId,
    authorName,
    bot: payload.bot === true,
    webhook: payload.webhook === true,
    content,
    timestamp: new Date(timestamp).toISOString(),
  };
};

export const appendChatMessage = (messages, message) => {
  const existingIndex = messages.findIndex((candidate) => candidate.id === message.id);
  if (existingIndex >= 0) messages.splice(existingIndex, 1);
  messages.push(message);
  messages.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  if (messages.length > CHAT_HISTORY_LIMIT) {
    messages.splice(0, messages.length - CHAT_HISTORY_LIMIT);
  }
  return messages;
};
