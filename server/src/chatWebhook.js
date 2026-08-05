export const CHAT_MAX_LENGTH = 1_000;
export const CHAT_WEBHOOK_USERNAME = 'KikiWeb on Chat';

export const normalizeChatMessage = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!normalized || normalized.length > CHAT_MAX_LENGTH) return null;
  return normalized;
};

export const isDiscordWebhookUrl = (value) => {
  try {
    const url = new URL(String(value));
    const trustedHost = url.hostname === 'discord.com' || url.hostname.endsWith('.discord.com');
    return (
      url.protocol === 'https:' &&
      trustedHost &&
      /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+/.test(url.pathname)
    );
  } catch {
    return false;
  }
};

export const parseChatWebhookUrls = (rawMap, fallbackUrl = '') => {
  const urls = new Map();
  if (isDiscordWebhookUrl(fallbackUrl)) urls.set('*', fallbackUrl);

  if (!rawMap) return urls;
  try {
    const parsed = JSON.parse(rawMap);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return urls;
    for (const [serverId, webhookUrl] of Object.entries(parsed)) {
      if (/^\d{1,20}$/.test(serverId) && isDiscordWebhookUrl(webhookUrl)) {
        urls.set(serverId, webhookUrl);
      }
    }
  } catch {
    // Invalid optional mappings are ignored; /chat reports that no webhook is configured.
  }
  return urls;
};

export const resolveChatWebhookUrl = (urls, serverId) => urls.get(serverId) ?? urls.get('*') ?? null;

export const postDiscordChatMessage = async (webhookUrl, content, fetchImpl = fetch) => {
  const result = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: CHAT_WEBHOOK_USERNAME,
      content,
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok) {
    throw new Error(`Discord webhook returned status ${result.status}`);
  }
};
