import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { AudioMixer, CHANNELS, SAMPLE_RATE } from './audioMixer.js';
import { config, hasDiscordConfig } from './config.js';

const app = express();
const server = createServer(app);
const mixer = new AudioMixer();
const wss = new WebSocketServer({ noServer: true });
let bridge = {
  getStatus: () => ({
    state: hasDiscordConfig ? 'starting' : 'missing-config',
    error: '',
    activeSpeakers: 0,
    connectedGuildId: config.discordGuildId || null,
    connectedVoiceChannelId: config.discordVoiceChannelId || null,
    botUser: null,
  }),
  reconnect: async () => {
    throw new Error('Discord bridge is not ready yet.');
  },
  close: async () => {},
};

app.use(
  cors({
    origin: config.clientOrigin === '*' ? true : config.clientOrigin,
  }),
);
app.use(express.json());

const publicStatus = () => ({
  ok: true,
  sampleRate: SAMPLE_RATE,
  channels: CHANNELS,
  listeners: mixer.clientCount(),
  mixerActiveSpeakers: mixer.activeSpeakerCount(),
  lastAudioAt: mixer.getLastAudioAt(),
  discord: bridge.getStatus(),
  hasListenToken: Boolean(config.listenToken),
});

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

app.get('/status', (_request, response) => {
  response.json(publicStatus());
});

app.post('/reconnect', async (request, response) => {
  if (!hasDiscordConfig) {
    response.status(400).json({ ok: false, error: 'Discord env vars are missing.' });
    return;
  }

  if (config.listenToken && request.header('x-listen-token') !== config.listenToken) {
    response.status(401).json({ ok: false, error: 'Unauthorized.' });
    return;
  }

  try {
    await bridge.reconnect();
    response.json(publicStatus());
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/audio') {
    socket.destroy();
    return;
  }

  if (config.listenToken && url.searchParams.get('token') !== config.listenToken) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  mixer.addClient(ws);
  ws.send(
    JSON.stringify({
      type: 'hello',
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    }),
  );
});

const heartbeat = setInterval(() => mixer.heartbeat(), 30_000);

const shutdown = async () => {
  clearInterval(heartbeat);
  mixer.close();
  await bridge.close();
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(config.port, async () => {
  console.log(`KikiWeb API listening on :${config.port}`);
  if (!hasDiscordConfig) {
    console.warn('Discord env vars are missing. Set DISCORD_TOKEN, DISCORD_GUILD_ID, and DISCORD_VOICE_CHANNEL_ID.');
    return;
  }

  try {
    const { DiscordVoiceBridge } = await import('./discordVoice.js');
    bridge = new DiscordVoiceBridge(mixer);
    await bridge.start();
  } catch (error) {
    console.error(error);
  }
});
