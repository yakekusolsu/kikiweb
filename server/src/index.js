import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { AudioMixer, CHANNELS, SAMPLE_RATE } from './audioMixer.js';
import { config } from './config.js';

const mixer = new AudioMixer();
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
let ingestClient = null;
let lastIngestAt = 0;

const publicStatus = () => ({
  ok: true,
  sampleRate: SAMPLE_RATE,
  channels: CHANNELS,
  listeners: mixer.clientCount(),
  mixerActiveSpeakers: mixer.activeSpeakerCount(),
  lastAudioAt: mixer.getLastAudioAt(),
  discord: {
    state: ingestClient ? 'ready' : 'waiting-for-bot',
    error: '',
    activeSpeakers: mixer.activeSpeakerCount(),
    connectedGuildId: null,
    connectedVoiceChannelId: null,
    botUser: null,
  },
  relay: {
    ingestConnected: Boolean(ingestClient),
    lastIngestAt,
  },
  hasListenToken: Boolean(config.listenToken),
  hasIngestToken: Boolean(config.ingestToken),
});

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
    wss.emit('connection', ws, request, url.pathname);
  });
});

wss.on('connection', (ws, _request, pathname) => {
  if (pathname === '/ingest') {
    if (ingestClient) {
      ingestClient.close(1012, 'Another ingest client connected.');
    }

    ingestClient = ws;
    ws.on('message', (message, isBinary) => {
      if (!isBinary || !Buffer.isBuffer(message)) return;
      lastIngestAt = Date.now();
      mixer.feed('python-bot', message);
    });
    ws.on('close', () => {
      if (ingestClient === ws) {
        ingestClient = null;
        mixer.removeInput('python-bot');
      }
    });
    ws.send(
      JSON.stringify({
        type: 'ingest-ready',
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      }),
    );
    return;
  }

  if (pathname === '/audio') {
    mixer.addClient(ws);
    ws.send(
      JSON.stringify({
        type: 'hello',
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      }),
    );
  }
});

const heartbeat = setInterval(() => mixer.heartbeat(), 30_000);

const shutdown = async () => {
  clearInterval(heartbeat);
  ingestClient?.close();
  mixer.close();
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(config.port, async () => {
  console.log(`KikiWeb relay listening on :${config.port}`);
});
