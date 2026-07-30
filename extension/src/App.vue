<script setup lang="ts">
import {
  Bot,
  ExternalLink,
  Headphones,
  Mic2,
  Moon,
  Play,
  RefreshCw,
  Square,
  Sun,
  Users,
  Volume2,
  VolumeX,
} from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getInitialTheme, saveTheme, type Theme } from './theme';

type ServerStatus = {
  id: string;
  name: string;
  channelId: string;
  channelName: string;
  state: string;
  listeners: number;
  activeSpeakers: number;
  memberCount: number;
  mutedCount: number;
};

type ApiStatus = {
  servers: ServerStatus[];
};

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'https://kikiweb.onrender.com').replace(
  /\/$/,
  '',
);
const LISTEN_TOKEN = import.meta.env.VITE_LISTEN_TOKEN || '';
const WEBSITE_URL = import.meta.env.VITE_WEBSITE_URL || 'https://kikiweb-seven.vercel.app';
const INVITE_URL = 'https://discord.com/oauth2/authorize?client_id=1498176090072678521';

const status = ref<ApiStatus | null>(null);
const statusError = ref('');
const playerError = ref('');
const playerState = ref<'idle' | 'connecting' | 'playing' | 'stopped' | 'error'>('idle');
const volume = ref(Number(window.localStorage.getItem('kikiweb-extension-volume') || 85));
const soundboardEnabled = ref(
  window.localStorage.getItem('kikiweb-extension-soundboard') !== 'off',
);
const selectedServerId = ref(window.localStorage.getItem('kikiweb-extension-server-id') || '');
const bufferMs = ref(0);
const underruns = ref(0);
const refreshing = ref(false);
const theme = ref<Theme>(getInitialTheme());

let socket: WebSocket | null = null;
let audioContext: AudioContext | null = null;
let voiceNode: AudioWorkletNode | null = null;
let soundboardNode: AudioWorkletNode | null = null;
let statusTimer: number | undefined;

const availableServers = computed(() => status.value?.servers ?? []);
const selectedServer = computed(
  () => availableServers.value.find((server) => server.id === selectedServerId.value) ?? null,
);
const isPlaying = computed(() => playerState.value === 'playing');
const stateLabel = computed(() => {
  if (playerState.value === 'connecting') return '接続中';
  if (playerState.value === 'playing') return '再生中';
  if (playerState.value === 'error') return 'エラー';
  return selectedServer.value?.state === 'ready' ? '再生できます' : 'Bot待機中';
});
const themeButtonLabel = computed(() =>
  theme.value === 'dark' ? 'ライトモードに切り替える' : 'ダークモードに切り替える',
);
const websocketUrl = computed(() => {
  const url = new URL(API_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/audio';
  if (selectedServerId.value) url.searchParams.set('serverId', selectedServerId.value);
  if (LISTEN_TOKEN) url.searchParams.set('token', LISTEN_TOKEN);
  return url.toString();
});

const fetchStatus = async () => {
  refreshing.value = true;
  statusError.value = '';
  try {
    const response = await fetch(`${API_BASE_URL}/status`);
    if (!response.ok) throw new Error(`サーバー応答: ${response.status}`);

    const nextStatus = (await response.json()) as ApiStatus;
    const servers = nextStatus.servers ?? [];
    status.value = { ...nextStatus, servers };

    if (!servers.some((server) => server.id === selectedServerId.value)) {
      selectedServerId.value =
        servers.find((server) => server.state === 'ready')?.id ?? servers[0]?.id ?? '';
    }
  } catch {
    statusError.value = 'KikiWebサーバーに接続できません。しばらく待ってから更新してください。';
  } finally {
    refreshing.value = false;
  }
};

const toggleTheme = () => {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
};

const stopListening = () => {
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  }
  socket = null;
  voiceNode?.disconnect();
  voiceNode?.port.close();
  voiceNode = null;
  soundboardNode?.disconnect();
  soundboardNode?.port.close();
  soundboardNode = null;
  void audioContext?.close();
  audioContext = null;
  bufferMs.value = 0;
  if (playerState.value !== 'idle') playerState.value = 'stopped';
};

const startListening = async () => {
  stopListening();
  playerState.value = 'connecting';
  playerError.value = '';
  underruns.value = 0;

  try {
    if (!selectedServerId.value) throw new Error('Botが接続しているサーバーがありません。');
    if (!('AudioWorkletNode' in window)) {
      throw new Error('このChromeではAudioWorkletを利用できません。');
    }

    audioContext = new AudioContext({ sampleRate: 48_000 });
    if (audioContext.sampleRate !== 48_000) {
      throw new Error(`48kHz再生に対応していません（${audioContext.sampleRate}Hz）。`);
    }

    const workletUrl = new URL('kikiweb-audio-worklet.js', window.location.href).toString();
    await audioContext.audioWorklet.addModule(workletUrl);

    voiceNode = new AudioWorkletNode(audioContext, 'kikiweb-pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    soundboardNode = new AudioWorkletNode(audioContext, 'kikiweb-pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    voiceNode.port.postMessage({ type: 'volume', value: volume.value / 100 });
    soundboardNode.port.postMessage({ type: 'volume', value: volume.value / 100 });
    voiceNode.port.onmessage = (event) => {
      if (event.data?.type !== 'stats') return;
      bufferMs.value = event.data.bufferMs;
      underruns.value = event.data.underruns;
    };
    voiceNode.connect(audioContext.destination);
    soundboardNode.connect(audioContext.destination);
    await audioContext.resume();

    const nextSocket = new WebSocket(websocketUrl.value);
    socket = nextSocket;
    nextSocket.binaryType = 'arraybuffer';
    nextSocket.onopen = () => {
      if (socket === nextSocket) playerState.value = 'playing';
    };
    nextSocket.onmessage = (event) => {
      if (socket !== nextSocket || typeof event.data === 'string') return;

      const packet = event.data as ArrayBuffer;
      const firstByte = new Uint8Array(packet, 0, 1)[0];
      const extendedSoundboard = packet.byteLength === 3_849 && firstByte === 1;
      const tagged = packet.byteLength === 3_841 && (firstByte === 0 || firstByte === 1);
      const streamType = extendedSoundboard || tagged ? firstByte : 0;
      const pcm = extendedSoundboard ? packet.slice(9) : tagged ? packet.slice(1) : packet;
      if (streamType === 1 && !soundboardEnabled.value) return;

      const targetNode = streamType === 1 ? soundboardNode : voiceNode;
      targetNode?.port.postMessage({ type: 'pcm', buffer: pcm }, [pcm]);
    };
    nextSocket.onerror = () => {
      if (socket !== nextSocket) return;
      playerState.value = 'error';
      playerError.value = '音声サーバーに接続できませんでした。';
    };
    nextSocket.onclose = () => {
      if (
        socket === nextSocket &&
        (playerState.value === 'playing' || playerState.value === 'connecting')
      ) {
        playerState.value = 'stopped';
      }
    };
  } catch (error) {
    playerState.value = 'error';
    playerError.value = error instanceof Error ? error.message : String(error);
  }
};

void fetchStatus();
statusTimer = window.setInterval(fetchStatus, 5_000);

watch(volume, (value) => {
  window.localStorage.setItem('kikiweb-extension-volume', String(value));
  voiceNode?.port.postMessage({ type: 'volume', value: value / 100 });
  soundboardNode?.port.postMessage({ type: 'volume', value: value / 100 });
});

watch(soundboardEnabled, (enabled) => {
  window.localStorage.setItem('kikiweb-extension-soundboard', enabled ? 'on' : 'off');
  if (!enabled) soundboardNode?.port.postMessage({ type: 'reset' });
});

watch(selectedServerId, (value, previousValue) => {
  if (value) {
    window.localStorage.setItem('kikiweb-extension-server-id', value);
  } else {
    window.localStorage.removeItem('kikiweb-extension-server-id');
  }

  if (previousValue && value !== previousValue && isPlaying.value) void startListening();
});

watch(theme, saveTheme);

onBeforeUnmount(() => {
  stopListening();
  if (statusTimer) window.clearInterval(statusTimer);
});
</script>

<template>
  <main>
    <header class="app-header">
      <a class="brand" :href="WEBSITE_URL" target="_blank" rel="noreferrer">
        <span class="brand-mark" aria-hidden="true">K</span>
        <span>
          <strong>KikiWeb</strong>
          <small>Chrome Side Panel</small>
        </span>
      </a>
      <div class="header-actions">
        <button
          class="icon-button"
          type="button"
          :title="themeButtonLabel"
          :aria-label="themeButtonLabel"
          :aria-pressed="theme === 'dark'"
          @click="toggleTheme"
        >
          <Sun v-if="theme === 'dark'" :size="18" />
          <Moon v-else :size="18" />
        </button>
        <button
          class="icon-button"
          type="button"
          title="状態を更新"
          aria-label="状態を更新"
          :disabled="refreshing"
          @click="fetchStatus"
        >
          <RefreshCw :class="{ spinning: refreshing }" :size="18" />
        </button>
      </div>
    </header>

    <section class="server-section" aria-labelledby="server-heading">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Discord server</p>
          <h1 id="server-heading">聞くサーバー</h1>
        </div>
        <span class="connection-badge" :class="{ live: isPlaying }">{{ stateLabel }}</span>
      </div>

      <label class="server-select">
        <span>接続先</span>
        <select v-model="selectedServerId" :disabled="availableServers.length === 0">
          <option disabled value="">
            {{ availableServers.length === 0 ? 'Bot接続中のサーバーなし' : 'サーバーを選択' }}
          </option>
          <option v-for="server in availableServers" :key="server.id" :value="server.id">
            {{ server.name }} / {{ server.channelName }}
          </option>
        </select>
      </label>
    </section>

    <section class="player-section" aria-label="音声プレイヤー">
      <div class="voice-visual" :class="{ active: isPlaying }" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div class="now-playing">
        <p>{{ isPlaying ? 'LIVE AUDIO' : 'READY' }}</p>
        <strong>
          {{
            selectedServer
              ? `${selectedServer.name} / ${selectedServer.channelName}`
              : 'BotがVCに接続すると表示されます'
          }}
        </strong>
      </div>

      <div class="transport">
        <button
          class="play-button"
          type="button"
          :disabled="playerState === 'connecting' || !selectedServer"
          @click="startListening"
        >
          <Play :size="18" fill="currentColor" />
          {{ isPlaying ? '再接続' : '聞く' }}
        </button>
        <button type="button" :disabled="!isPlaying" @click="stopListening">
          <Square :size="17" fill="currentColor" />
          停止
        </button>
      </div>
    </section>

    <section class="metrics" aria-label="VCの状態">
      <div>
        <Headphones :size="17" />
        <span>Listeners</span>
        <strong>{{ selectedServer?.listeners ?? 0 }}</strong>
      </div>
      <div>
        <Mic2 :size="17" />
        <span>Speakers</span>
        <strong>{{ selectedServer?.activeSpeakers ?? 0 }}</strong>
      </div>
      <div>
        <Users :size="17" />
        <span>Members</span>
        <strong>{{ selectedServer?.memberCount ?? 0 }}</strong>
      </div>
      <div>
        <VolumeX :size="17" />
        <span>Muted</span>
        <strong>{{ selectedServer?.mutedCount ?? 0 }}</strong>
      </div>
    </section>

    <section class="controls" aria-label="再生設定">
      <label class="volume-control">
        <span><Volume2 :size="18" />音量</span>
        <strong>{{ volume }}%</strong>
        <input v-model="volume" type="range" min="0" max="100" />
      </label>

      <label class="toggle-row">
        <span>
          <Volume2 :size="18" />
          <span>
            <strong>サウンドボード</strong>
            <small>Discordの効果音を再生</small>
          </span>
        </span>
        <input v-model="soundboardEnabled" type="checkbox" role="switch" />
      </label>
    </section>

    <div class="audio-stats" aria-live="polite">
      <span>Buffer {{ bufferMs }}ms</span>
      <span>Underruns {{ underruns }}</span>
    </div>

    <p v-if="playerError" class="error">{{ playerError }}</p>
    <p v-if="statusError" class="error">{{ statusError }}</p>

    <footer>
      <a class="invite-link" :href="INVITE_URL" target="_blank" rel="noreferrer">
        <Bot :size="18" />
        Botを鯖に入れる！
        <ExternalLink :size="15" />
      </a>
      <a :href="WEBSITE_URL" target="_blank" rel="noreferrer">
        KikiWebを開く
        <ExternalLink :size="14" />
      </a>
    </footer>
  </main>
</template>
