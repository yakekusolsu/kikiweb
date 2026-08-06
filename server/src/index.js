import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { AudioMixer, CHANNELS, PCM_FRAME_BYTES, SAMPLE_RATE } from './audioMixer.js';
import { appendChatMessage, normalizeDiscordChatMessage } from './chatMessages.js';
import {
  CHAT_MAX_LENGTH,
  containsChatUrl,
  createChatPostCommand,
  normalizeChatMessage,
} from './chatPost.js';
import {
  createDiscordSessionToken,
  normalizeDiscordUser,
  verifyDiscordSessionToken,
} from './discordAuth.js';
import { config } from './config.js';

const STREAM_VOICE = 0;
const STREAM_SOUNDBOARD = 1;
const streams = new Map();
const chatRateLimits = new Map();
const pendingChatPosts = new Map();
const server = createServer(async (request, response) => {
  const origin = config.clientOrigin === '*' ? request.headers.origin || '*' : config.clientOrigin;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-listen-token,x-talk-token');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Vary', 'Origin');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/status') {
    sendJson(response, 200, publicStatus());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/auth/discord') {
    if (!discordOAuthConfigured()) {
      sendJson(response, 503, { ok: false, error: 'Discord login is not configured.' });
      return;
    }
    const state = randomBytes(24).toString('base64url');
    const authorizationUrl = new URL('https://discord.com/oauth2/authorize');
    authorizationUrl.searchParams.set('client_id', config.discordOAuthClientId);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('redirect_uri', config.discordOAuthRedirectUri);
    authorizationUrl.searchParams.set('scope', 'identify');
    authorizationUrl.searchParams.set('state', state);
    redirect(response, authorizationUrl, {
      'set-cookie': oauthStateCookie(state),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/auth/discord/callback') {
    const state = String(url.searchParams.get('state') ?? '');
    const expectedState = readCookie(request.headers.cookie, 'kikiweb_oauth_state');
    const clearStateCookie = oauthStateCookie('', 0);
    if (!discordOAuthConfigured() || !state || !expectedState || state !== expectedState) {
      redirect(response, clientAuthRedirect('', 'Discordログインを確認できませんでした。'), {
        'set-cookie': clearStateCookie,
      });
      return;
    }

    const code = String(url.searchParams.get('code') ?? '');
    if (!code) {
      redirect(response, clientAuthRedirect('', 'Discordログインがキャンセルされました。'), {
        'set-cookie': clearStateCookie,
      });
      return;
    }

    try {
      const user = await exchangeDiscordAuthorizationCode(code);
      const token = createDiscordSessionToken(user, config.authTokenSecret);
      if (!token) throw new Error('KikiWeb could not create a login session.');
      redirect(response, clientAuthRedirect(token), { 'set-cookie': clearStateCookie });
    } catch (error) {
      console.error('KikiWeb Discord login failed:', error instanceof Error ? error.message : error);
      redirect(response, clientAuthRedirect('', 'Discordログインに失敗しました。'), {
        'set-cookie': clearStateCookie,
      });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/auth/me') {
    const user = authenticatedDiscordUser(request);
    if (!user) {
      sendJson(response, 401, { ok: false, error: 'Login required.' });
      return;
    }
    sendJson(response, 200, { ok: true, user });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/chat') {
    const authenticatedUser = authenticatedDiscordUser(request);
    const hiddenChatAuthorized =
      Boolean(config.talkToken) && request.headers['x-talk-token'] === config.talkToken;
    if (!config.talkToken && !discordOAuthConfigured()) {
      sendJson(response, 503, { ok: false, error: 'Chat is not configured.' });
      return;
    }
    if (!authenticatedUser && !hiddenChatAuthorized) {
      sendJson(response, 401, { ok: false, error: 'Unauthorized.' });
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      const statusCode = error?.code === 'BODY_TOO_LARGE' ? 413 : 400;
      sendJson(response, statusCode, { ok: false, error: 'Invalid request body.' });
      return;
    }

    const serverId = String(payload?.serverId ?? '');
    const content = normalizeChatMessage(payload?.content);
    const stream = streams.get(serverId);
    if (!/^\d{1,20}$/.test(serverId) || !stream?.ingestClient) {
      sendJson(response, 409, { ok: false, error: 'The selected Discord server is not connected.' });
      return;
    }
    if (!content) {
      sendJson(response, 400, {
        ok: false,
        error: `Message must be between 1 and ${CHAT_MAX_LENGTH} characters.`,
      });
      return;
    }
    if (containsChatUrl(content)) {
      sendJson(response, 400, { ok: false, error: 'URLを含むメッセージは送信できません。' });
      return;
    }

    const rateLimitKey = `${authenticatedUser?.id ?? clientAddress(request)}:${serverId}`;
    const retryAfterSeconds = chatRetryAfter(rateLimitKey);
    if (retryAfterSeconds > 0) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
      sendJson(response, 429, { ok: false, error: 'Please wait before sending another message.' });
      return;
    }
    try {
      await requestBotChatPost(stream, content, authenticatedUser?.name ?? '');
      sendJson(response, 200, { ok: true });
    } catch (error) {
      console.error('KikiWeb Bot chat post failed:', error instanceof Error ? error.message : error);
      const timeout = error?.code === 'CHAT_POST_TIMEOUT';
      sendJson(response, timeout ? 504 : 502, {
        ok: false,
        error: timeout
          ? 'Discord Bot did not respond in time.'
          : error instanceof Error
            ? error.message
            : 'Discord Bot could not send the message.',
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/reconnect') {
    if (config.listenToken && request.headers['x-listen-token'] !== config.listenToken) {
      sendJson(response, 401, { ok: false, error: 'Unauthorized.' });
      return;
    }

    sendJson(response, 410, {
      ok: false,
      error: 'Bot reconnect is handled by the embedded Python bot now.',
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
});
const wss = new WebSocketServer({ noServer: true });

const publicStatus = () => {
  const activeStreams = [...streams.values()].filter((stream) => stream.ingestClient);
  const guildCount = Math.max(0, ...activeStreams.map((stream) => stream.guildCount ?? 0)) || null;
  return {
    ok: true,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    servers: activeStreams.map(publicStreamStatus),
    guildCount,
    authConfigured: discordOAuthConfigured(),
    listeners: activeStreams.reduce((total, stream) => total + stream.mixer.clientCount(), 0),
    mixerActiveSpeakers: activeStreams.reduce(
      (total, stream) => total + stream.mixer.activeSpeakerCount(),
      0,
    ),
    lastAudioAt: Math.max(
      0,
      ...activeStreams.map((stream) =>
        Math.max(stream.mixer.getLastAudioAt(), stream.soundboardMixer.getLastAudioAt()),
      ),
    ),
    discord: {
      state: activeStreams.length > 0 ? 'ready' : 'waiting-for-bot',
      error: '',
      activeSpeakers: activeStreams.reduce(
        (total, stream) => total + stream.mixer.activeSpeakerCount(),
        0,
      ),
      connectedGuildId: null,
      connectedVoiceChannelId: null,
      botUser: null,
    },
    relay: {
      ingestConnected: activeStreams.length > 0,
      lastIngestAt: Math.max(0, ...activeStreams.map((stream) => stream.lastIngestAt)),
    },
    hasListenToken: Boolean(config.listenToken),
    hasIngestToken: Boolean(config.ingestToken),
  };
};

const publicStreamStatus = (stream) => ({
  id: stream.id,
  name: stream.name,
  channelId: stream.channelId,
  channelName: stream.channelName,
  voiceStatus: stream.voiceStatus,
  state: stream.ingestClient ? 'ready' : 'waiting-for-bot',
  listeners: stream.mixer.clientCount(),
  activeSpeakers: stream.mixer.activeSpeakerCount(),
  memberCount: stream.memberCount,
  mutedCount: stream.mutedCount,
  users: stream.users,
  lastAudioAt: Math.max(stream.mixer.getLastAudioAt(), stream.soundboardMixer.getLastAudioAt()),
  lastIngestAt: stream.lastIngestAt,
});

const safeLabel = (value, fallback) => {
  const normalized = String(value ?? '').trim().slice(0, 100);
  return normalized || fallback;
};

const streamFromIngestUrl = (url) => {
  const id = safeLabel(url.searchParams.get('serverId'), '');
  const name = safeLabel(url.searchParams.get('serverName'), '');
  const channelId = safeLabel(url.searchParams.get('channelId'), '');
  const channelName = safeLabel(url.searchParams.get('channelName'), '');
  const voiceStatus = String(url.searchParams.get('voiceStatus') ?? '').trim().slice(0, 500);
  if (!id || !name || !channelId || !channelName) {
    return null;
  }

  let stream = streams.get(id);
  if (!stream) {
    stream = {
      id,
      name,
      channelId,
      channelName,
      voiceStatus,
      ingestClient: null,
      talkClient: null,
      chatClients: new Set(),
      chatMessages: [],
      chatChannelId: channelId,
      chatChannelName: channelName,
      lastIngestAt: 0,
      memberCount: 0,
      mutedCount: 0,
      guildCount: null,
      users: [],
      mixer: new AudioMixer(STREAM_VOICE),
      soundboardMixer: new AudioMixer(STREAM_SOUNDBOARD),
    };
    streams.set(id, stream);
  } else {
    const channelChanged = stream.channelId !== channelId;
    stream.name = name;
    stream.channelId = channelId;
    stream.channelName = channelName;
    stream.voiceStatus = voiceStatus;
    if (channelChanged) {
      stream.chatMessages = [];
      setStreamChatChannel(stream, channelId, channelName);
    }
  }
  return stream;
};

const resolveAudioStream = (url) => {
  const requestedId = url.searchParams.get('serverId');
  if (requestedId) {
    const stream = streams.get(requestedId);
    return stream?.ingestClient ? stream : null;
  }
  return [...streams.values()].find((stream) => stream.ingestClient) ?? null;
};

const sendChatSnapshot = (client, stream) => {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(
    JSON.stringify({
      type: 'chat-snapshot',
      channelId: stream.chatChannelId,
      channelName: stream.chatChannelName,
      messages: stream.chatMessages,
    }),
  );
};

const publishChatMessage = (stream, message) => {
  const alreadyPublished = stream.chatMessages.some((candidate) => candidate.id === message.id);
  appendChatMessage(stream.chatMessages, message);
  if (alreadyPublished) return;
  const payload = JSON.stringify({ type: 'chat-message', message });
  for (const client of stream.chatClients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
};

const requestBotChatPost = (stream, content, authorName = '') =>
  new Promise((resolve, reject) => {
    if (stream.ingestClient?.readyState !== WebSocket.OPEN) {
      reject(new Error('The selected Discord Bot is not connected.'));
      return;
    }

    const requestId = randomUUID();
    const command = createChatPostCommand(requestId, stream.chatChannelId, content, authorName);
    if (!command) {
      reject(new Error('The Discord chat request is invalid.'));
      return;
    }

    const timeout = setTimeout(() => {
      pendingChatPosts.delete(requestId);
      const error = new Error('Discord Bot did not respond in time.');
      error.code = 'CHAT_POST_TIMEOUT';
      reject(error);
    }, 12_000);
    pendingChatPosts.set(requestId, { stream, resolve, reject, timeout });

    try {
      stream.ingestClient.send(JSON.stringify(command));
    } catch (error) {
      clearTimeout(timeout);
      pendingChatPosts.delete(requestId);
      reject(error);
    }
  });

const resolveBotChatPost = (stream, payload) => {
  const requestId = String(payload?.requestId ?? '');
  const pending = pendingChatPosts.get(requestId);
  if (!pending || pending.stream !== stream) return;

  clearTimeout(pending.timeout);
  pendingChatPosts.delete(requestId);
  if (payload.ok === true) {
    pending.resolve();
    return;
  }
  pending.reject(
    new Error(
      safeLabel(
        payload.error,
        'Discord Bot could not send the message. Check its View Channel and Send Messages permissions.',
      ),
    ),
  );
};

const rejectBotChatPosts = (stream, reason) => {
  for (const [requestId, pending] of pendingChatPosts) {
    if (pending.stream !== stream) continue;
    clearTimeout(pending.timeout);
    pendingChatPosts.delete(requestId);
    pending.reject(new Error(reason));
  }
};

const setStreamChatChannel = (stream, channelId, channelName = '') => {
  if (!/^\d{1,20}$/.test(channelId)) return;
  const changed = stream.chatChannelId !== channelId;
  stream.chatChannelId = channelId;
  stream.chatChannelName = safeLabel(channelName, stream.chatChannelName || 'Discord chat');
  if (changed) stream.chatMessages = [];

  if (stream.ingestClient?.readyState === WebSocket.OPEN) {
    stream.ingestClient.send(JSON.stringify({ type: 'chat-channel', channelId }));
  }
  for (const client of stream.chatClients) sendChatSnapshot(client, stream);
};

const configureStreamChatChannel = async (stream) => {
  setStreamChatChannel(stream, stream.channelId, stream.channelName);
};

const parseCount = (value) => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) return null;
  return Math.min(count, 100_000);
};

const parseVoiceUsers = (value) => {
  if (!Array.isArray(value)) return [];

  const users = [];
  const seenIds = new Set();
  for (const candidate of value.slice(0, 100)) {
    const id = String(candidate?.id ?? '');
    if (!/^\d{1,20}$/.test(id) || seenIds.has(id)) continue;
    seenIds.add(id);
    users.push({
      id,
      name: safeLabel(candidate?.name, 'Discord user'),
      bot: candidate?.bot === true,
      muted: candidate?.muted === true,
    });
  }
  return users;
};

const parseSourceGains = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();

  const sourceGains = new Map();
  for (const [userId, rawGain] of Object.entries(value).slice(0, 100)) {
    if (!/^\d{1,20}$/.test(userId)) continue;
    const gain = Number(rawGain);
    if (!Number.isFinite(gain)) continue;
    sourceGains.set(`voice-${userId}`, Math.max(0, Math.min(2, gain)));
  }
  return sourceGains;
};

const readJsonBody = (request, limit = 16_384) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error('Request body is too large.');
        error.code = 'BODY_TOO_LARGE';
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', fail);
  });

const validHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const discordOAuthConfigured = () =>
  /^\d{1,20}$/.test(config.discordOAuthClientId) &&
  config.discordOAuthClientSecret.length > 0 &&
  validHttpUrl(config.discordOAuthRedirectUri) &&
  validHttpUrl(config.clientOrigin) &&
  config.clientOrigin !== '*' &&
  config.authTokenSecret.length >= 32;

const bearerToken = (request) => {
  const match = String(request.headers.authorization ?? '').match(/^Bearer ([A-Za-z0-9._-]+)$/);
  return match?.[1] ?? '';
};

const authenticatedDiscordUser = (request) =>
  verifyDiscordSessionToken(bearerToken(request), config.authTokenSecret);

const webSocketSessionToken = (request) => {
  const protocol = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .find((value) => value.startsWith('kikiweb.auth.'));
  return protocol?.slice('kikiweb.auth.'.length) ?? '';
};

const readCookie = (header, name) => {
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
};

const oauthStateCookie = (value, maxAge = 600) => {
  const secure = config.discordOAuthRedirectUri.startsWith('https:') ? '; Secure' : '';
  return `kikiweb_oauth_state=${encodeURIComponent(value)}; Path=/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
};

const redirect = (response, location, headers = {}) => {
  response.writeHead(302, { location: String(location), 'cache-control': 'no-store', ...headers });
  response.end();
};

const clientAuthRedirect = (token = '', error = '') => {
  let destination;
  try {
    destination = new URL(config.clientOrigin);
  } catch {
    destination = new URL('http://localhost:5173');
  }
  destination.hash = token
    ? `auth=${token}`
    : `auth_error=${encodeURIComponent(error || 'Discordログインに失敗しました。')}`;
  return destination;
};

const exchangeDiscordAuthorizationCode = async (code) => {
  const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.discordOAuthClientId,
      client_secret: config.discordOAuthClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.discordOAuthRedirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) throw new Error(`Discord token exchange returned ${tokenResponse.status}.`);
  const tokenPayload = await tokenResponse.json();
  const accessToken = String(tokenPayload?.access_token ?? '');
  if (!accessToken) throw new Error('Discord did not return an access token.');

  const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'KikiWeb (https://kikiweb-seven.vercel.app, 1.0)',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userResponse.ok) throw new Error(`Discord user lookup returned ${userResponse.status}.`);
  const user = normalizeDiscordUser(await userResponse.json());
  if (!user) throw new Error('Discord returned an invalid user profile.');
  return user;
};

const clientAddress = (request) => {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
};

const chatRetryAfter = (key) => {
  const now = Date.now();
  const windowMs = 10_000;
  const timestamps = (chatRateLimits.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
  if (timestamps.length >= 5) {
    chatRateLimits.set(key, timestamps);
    return Math.max(1, Math.ceil((windowMs - (now - timestamps[0])) / 1_000));
  }
  timestamps.push(now);
  chatRateLimits.set(key, timestamps);
  return 0;
};

const sendJson = (response, statusCode, body) => {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (
    url.pathname !== '/audio' &&
    url.pathname !== '/ingest' &&
    url.pathname !== '/talk' &&
    url.pathname !== '/chat-stream'
  ) {
    socket.destroy();
    return;
  }

  if (
    (url.pathname === '/talk' || url.pathname === '/chat-stream') &&
    config.clientOrigin !== '*' &&
    request.headers.origin !== config.clientOrigin
  ) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  let authorized = true;
  if (url.pathname === '/ingest') {
    authorized = !config.ingestToken || url.searchParams.get('token') === config.ingestToken;
  } else if (url.pathname === '/talk') {
    authorized = Boolean(config.talkToken) && url.searchParams.get('token') === config.talkToken;
  } else if (url.pathname === '/chat-stream') {
    const sessionUser = verifyDiscordSessionToken(
      webSocketSessionToken(request),
      config.authTokenSecret,
    );
    const hiddenChatAuthorized =
      Boolean(config.talkToken) && url.searchParams.get('token') === config.talkToken;
    authorized = Boolean(sessionUser || hiddenChatAuthorized);
  } else if (url.pathname === '/audio') {
    authorized = !config.listenToken || url.searchParams.get('token') === config.listenToken;
  }
  if (!authorized) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, url);
  });
});

wss.on('connection', (ws, _request, url) => {
  if (url.pathname === '/ingest') {
    const stream = streamFromIngestUrl(url);
    if (!stream) {
      ws.close(1008, 'Discord server metadata is required. Update kikiweb_voice.py.');
      return;
    }

    if (stream.ingestClient) {
      rejectBotChatPosts(stream, 'The Discord Bot connection was replaced. Please try again.');
      stream.ingestClient.close(1012, 'Another ingest client connected for this server.');
    }

    stream.ingestClient = ws;
    stream.memberCount = 0;
    stream.mutedCount = 0;
    stream.guildCount = null;
    stream.users = [];
    void configureStreamChatChannel(stream);
    ws.on('message', (message, isBinary) => {
      if (!isBinary) {
        try {
          const payload = JSON.parse(message.toString());
          if (payload.type === 'voice-status') {
            const guildCount = parseCount(payload.guildCount);
            const memberCount = parseCount(payload.memberCount);
            const mutedCount = parseCount(payload.mutedCount);
            if (memberCount === null || mutedCount === null) return;
            stream.memberCount = memberCount;
            stream.mutedCount = Math.min(mutedCount, memberCount);
            stream.users = parseVoiceUsers(payload.users);
            if (guildCount !== null) stream.guildCount = guildCount;
          } else if (payload.type === 'chat-message') {
            const chatMessage = normalizeDiscordChatMessage(payload, stream.chatChannelId);
            if (chatMessage) {
              stream.chatChannelName = chatMessage.channelName;
              publishChatMessage(stream, chatMessage);
            }
          } else if (payload.type === 'chat-post-result') {
            resolveBotChatPost(stream, payload);
          }
        } catch {
          // Ignore malformed status messages while keeping the audio stream alive.
        }
        return;
      }

      if (!Buffer.isBuffer(message)) return;
      let streamType = STREAM_VOICE;
      let sourceId = 'python-bot';
      let pcm = message;
      if (
        message.length === PCM_FRAME_BYTES + 9 &&
        (message[0] === STREAM_VOICE || message[0] === STREAM_SOUNDBOARD)
      ) {
        streamType = message[0];
        const sourcePrefix = streamType === STREAM_SOUNDBOARD ? 'soundboard' : 'voice';
        sourceId = `${sourcePrefix}-${message.readBigUInt64BE(1)}`;
        pcm = message.subarray(9);
      } else if (
        message.length === PCM_FRAME_BYTES + 1 &&
        (message[0] === STREAM_VOICE || message[0] === STREAM_SOUNDBOARD)
      ) {
        streamType = message[0];
        sourceId = streamType === STREAM_SOUNDBOARD ? 'discord-soundboard' : 'python-bot';
        pcm = message.subarray(1);
      }
      if (pcm.length === 0 || pcm.length % PCM_FRAME_BYTES !== 0) return;

      stream.lastIngestAt = Date.now();
      if (streamType === STREAM_SOUNDBOARD) {
        stream.soundboardMixer.feed(sourceId, pcm);
      } else {
        stream.mixer.feed(sourceId, pcm);
      }
    });
    ws.on('close', () => {
      if (stream.ingestClient === ws) {
        rejectBotChatPosts(stream, 'The Discord Bot disconnected before sending the message.');
        stream.ingestClient = null;
        stream.mixer.clearInputs();
        stream.soundboardMixer.clearInputs();
        stream.talkClient?.close(1012, 'The Discord Bot disconnected.');
        stream.talkClient = null;
      }
    });
    ws.send(
      JSON.stringify({
        type: 'ingest-ready',
        serverId: stream.id,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      }),
    );
    return;
  }

  if (url.pathname === '/chat-stream') {
    const stream = resolveAudioStream(url);
    if (!stream) {
      ws.close(1013, 'No Discord server is connected.');
      return;
    }

    stream.chatClients.add(ws);
    sendChatSnapshot(ws, stream);
    ws.on('close', () => stream.chatClients.delete(ws));
    return;
  }

  if (url.pathname === '/talk') {
    const stream = resolveAudioStream(url);
    if (!stream) {
      ws.close(1013, 'No Discord server is connected.');
      return;
    }

    if (stream.talkClient) {
      stream.talkClient.close(1012, 'Another microphone session started.');
    }
    stream.talkClient = ws;

    ws.on('message', (message, isBinary) => {
      if (!stream.ingestClient || stream.ingestClient.readyState !== WebSocket.OPEN) return;

      if (!isBinary) {
        try {
          const payload = JSON.parse(message.toString());
          if (payload.type === 'talk-stop') {
            stream.ingestClient.send(JSON.stringify({ type: 'talk-stop' }));
          }
        } catch {
          // Ignore malformed control messages.
        }
        return;
      }

      if (!Buffer.isBuffer(message) || message.length !== PCM_FRAME_BYTES) return;
      stream.ingestClient.send(message, { binary: true });
    });

    ws.on('close', () => {
      if (stream.talkClient !== ws) return;
      stream.talkClient = null;
      if (stream.ingestClient?.readyState === WebSocket.OPEN) {
        stream.ingestClient.send(JSON.stringify({ type: 'talk-stop' }));
      }
    });

    ws.send(
      JSON.stringify({
        type: 'talk-ready',
        serverId: stream.id,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      }),
    );
    return;
  }

  if (url.pathname === '/audio') {
    const stream = resolveAudioStream(url);
    if (!stream) {
      ws.close(1013, 'No Discord server is connected.');
      return;
    }

    stream.mixer.addClient(ws);
    stream.soundboardMixer.addClient(ws);
    ws.on('message', (message, isBinary) => {
      if (isBinary) return;
      try {
        const payload = JSON.parse(message.toString());
        if (payload.type !== 'user-volumes') return;
        stream.mixer.setClientSourceGains(ws, parseSourceGains(payload.volumes));
      } catch {
        // Ignore malformed listener controls while keeping audio connected.
      }
    });
    ws.send(
      JSON.stringify({
        type: 'hello',
        server: publicStreamStatus(stream),
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      }),
    );
  }
});

const heartbeat = setInterval(() => {
  for (const stream of streams.values()) {
    stream.mixer.heartbeat();
    for (const client of stream.chatClients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }
}, 30_000);

const shutdown = async () => {
  clearInterval(heartbeat);
  for (const stream of streams.values()) {
    stream.ingestClient?.close();
    stream.talkClient?.close();
    for (const client of stream.chatClients) client.close();
    stream.mixer.close();
    stream.soundboardMixer.close();
  }
  streams.clear();
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(config.port, async () => {
  console.log(`KikiWeb relay listening on :${config.port}`);
});
