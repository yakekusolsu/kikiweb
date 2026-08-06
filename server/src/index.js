import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { AudioMixer, CHANNELS, PCM_FRAME_BYTES, SAMPLE_RATE } from './audioMixer.js';
import { appendChatMessage, normalizeDiscordChatMessage } from './chatMessages.js';
import {
  CHAT_MAX_LENGTH,
  createChatTtsMessage,
  fetchDiscordWebhookMetadata,
  normalizeChatMessage,
  parseChatWebhookUrls,
  postDiscordChatMessage,
  resolveChatWebhookUrl,
} from './chatWebhook.js';
import { config } from './config.js';

const STREAM_VOICE = 0;
const STREAM_SOUNDBOARD = 1;
const streams = new Map();
const chatWebhookUrls = parseChatWebhookUrls(config.chatWebhookUrls, config.chatWebhookUrl);
const chatWebhookMetadata = new Map();
const chatRateLimits = new Map();
const server = createServer(async (request, response) => {
  const origin = config.clientOrigin === '*' ? request.headers.origin || '*' : config.clientOrigin;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'content-type,x-listen-token,x-talk-token');
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

  if (request.method === 'POST' && url.pathname === '/chat') {
    if (!config.talkToken) {
      sendJson(response, 503, { ok: false, error: 'Chat is not configured.' });
      return;
    }
    if (request.headers['x-talk-token'] !== config.talkToken) {
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

    const webhookUrl = resolveChatWebhookUrl(chatWebhookUrls, serverId);
    if (!webhookUrl) {
      sendJson(response, 503, { ok: false, error: 'No Discord webhook is configured for this server.' });
      return;
    }
    const rateLimitKey = `${clientAddress(request)}:${serverId}`;
    const retryAfterSeconds = chatRetryAfter(rateLimitKey);
    if (retryAfterSeconds > 0) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
      sendJson(response, 429, { ok: false, error: 'Please wait before sending another message.' });
      return;
    }
    try {
      const metadata = await getChatWebhookMetadata(webhookUrl);
      if (metadata.guildId !== serverId) {
        sendJson(response, 409, { ok: false, error: 'The Discord webhook belongs to a different server.' });
        return;
      }
    } catch (error) {
      console.error('KikiWeb could not validate the Discord webhook:', error instanceof Error ? error.message : error);
      sendJson(response, 502, { ok: false, error: 'The Discord webhook could not be validated.' });
      return;
    }

    try {
      const delivered = await postDiscordChatMessage(webhookUrl, content);
      const deliveredChannelId = String(delivered?.channel_id ?? '');
      const chatMessage = normalizeDiscordChatMessage(
        {
          type: 'chat-message',
          id: delivered?.id,
          channelId: deliveredChannelId,
          channelName: stream.chatChannelName,
          authorId: delivered?.author?.id,
          authorName: delivered?.author?.username ?? 'KikiWeb on Chat',
          bot: true,
          webhook: true,
          content: delivered?.content ?? content,
          timestamp: delivered?.timestamp,
        },
        stream.chatChannelId,
      );
      if (chatMessage) publishChatMessage(stream, chatMessage);
      requestChatTts(stream, delivered?.content ?? content);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      console.error('KikiWeb chat webhook failed:', error instanceof Error ? error.message : error);
      sendJson(response, 502, { ok: false, error: 'Discord webhook delivery failed.' });
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
  appendChatMessage(stream.chatMessages, message);
  const payload = JSON.stringify({ type: 'chat-message', message });
  for (const client of stream.chatClients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
};

const requestChatTts = (stream, content) => {
  if (stream.ingestClient?.readyState !== WebSocket.OPEN) return;
  const message = createChatTtsMessage(content);
  if (!message) return;
  try {
    stream.ingestClient.send(JSON.stringify(message));
  } catch (error) {
    console.warn('KikiWeb could not request chat TTS:', error instanceof Error ? error.message : error);
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

const getChatWebhookMetadata = async (webhookUrl) => {
  let metadata = chatWebhookMetadata.get(webhookUrl);
  if (!metadata) {
    metadata = await fetchDiscordWebhookMetadata(webhookUrl);
    chatWebhookMetadata.set(webhookUrl, metadata);
  }
  return metadata;
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

  const expectedToken =
    url.pathname === '/ingest'
      ? config.ingestToken
      : url.pathname === '/talk' || url.pathname === '/chat-stream'
        ? config.talkToken
        : config.listenToken;
  if (
    ((url.pathname === '/talk' || url.pathname === '/chat-stream') && !expectedToken) ||
    (expectedToken && url.searchParams.get('token') !== expectedToken)
  ) {
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
