import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { AudioMixer, CHANNELS, PCM_FRAME_BYTES, SAMPLE_RATE } from './audioMixer.js';
import { config } from './config.js';

const STREAM_VOICE = 0;
const STREAM_SOUNDBOARD = 1;
const streams = new Map();
const server = createServer(async (request, response) => {
  const origin = config.clientOrigin === '*' ? request.headers.origin || '*' : config.clientOrigin;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'content-type,x-listen-token');
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
  return {
    ok: true,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    servers: activeStreams.map(publicStreamStatus),
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
  state: stream.ingestClient ? 'ready' : 'waiting-for-bot',
  listeners: stream.mixer.clientCount(),
  activeSpeakers: stream.mixer.activeSpeakerCount(),
  memberCount: stream.memberCount,
  mutedCount: stream.mutedCount,
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
      ingestClient: null,
      lastIngestAt: 0,
      memberCount: 0,
      mutedCount: 0,
      mixer: new AudioMixer(STREAM_VOICE),
      soundboardMixer: new AudioMixer(STREAM_SOUNDBOARD),
    };
    streams.set(id, stream);
  } else {
    stream.name = name;
    stream.channelId = channelId;
    stream.channelName = channelName;
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

const parseCount = (value) => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) return null;
  return Math.min(count, 100_000);
};

const sendJson = (response, statusCode, body) => {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/audio' && url.pathname !== '/ingest') {
    socket.destroy();
    return;
  }

  const expectedToken = url.pathname === '/ingest' ? config.ingestToken : config.listenToken;
  if (expectedToken && url.searchParams.get('token') !== expectedToken) {
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
    ws.on('message', (message, isBinary) => {
      if (!isBinary) {
        try {
          const payload = JSON.parse(message.toString());
          if (payload.type !== 'voice-status') return;
          const memberCount = parseCount(payload.memberCount);
          const mutedCount = parseCount(payload.mutedCount);
          if (memberCount === null || mutedCount === null) return;
          stream.memberCount = memberCount;
          stream.mutedCount = Math.min(mutedCount, memberCount);
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

  if (url.pathname === '/audio') {
    const stream = resolveAudioStream(url);
    if (!stream) {
      ws.close(1013, 'No Discord server is connected.');
      return;
    }

    stream.mixer.addClient(ws);
    stream.soundboardMixer.addClient(ws);
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
  }
}, 30_000);

const shutdown = async () => {
  clearInterval(heartbeat);
  for (const stream of streams.values()) {
    stream.ingestClient?.close();
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
