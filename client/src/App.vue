<script setup lang="ts">
import { Moon, Sun } from '@lucide/vue';
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
  lastAudioAt: number;
  lastIngestAt: number;
};

type ApiStatus = {
  servers: ServerStatus[];
  listeners: number;
  mixerActiveSpeakers: number;
  lastAudioAt: number;
  hasListenToken: boolean;
  discord: {
    state: string;
    error: string;
    activeSpeakers: number;
    connectedVoiceChannelId: string | null;
    botUser: { username: string } | null;
  };
  relay?: {
    ingestConnected: boolean;
    lastIngestAt: number;
  };
};

const apiBaseUrl = ref(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787');
const listenToken = ref(import.meta.env.VITE_LISTEN_TOKEN || '');
const talkToken = ref(import.meta.env.VITE_TALK_TOKEN || '');
const status = ref<ApiStatus | null>(null);
const statusError = ref('');
const playerState = ref<'idle' | 'connecting' | 'playing' | 'stopped' | 'error'>('idle');
const playerError = ref('');
const volume = ref(85);
const bufferMs = ref(0);
const underruns = ref(0);
const soundboardEnabled = ref(window.localStorage.getItem('kikiweb-soundboard') !== 'off');
const selectedServerId = ref(window.localStorage.getItem('kikiweb-server-id') || '');
const route = ref(window.location.hash || '#/');
const theme = ref<Theme>(getInitialTheme());
const talkUnlocked = ref(
  window.sessionStorage.getItem('kikiweb-talk-unlocked') === '1' ||
    window.localStorage.getItem('kikiweb-talk-unlocked') === '1',
);
const talkState = ref<'idle' | 'connecting' | 'talking' | 'stopped' | 'error'>('idle');
const talkError = ref('');

const secretSequence = [
  'home',
  'links',
  'theme',
  'theme',
  'terms',
  'links',
  'theme',
  'theme',
  'terms',
  'theme',
  'theme',
  'theme',
  'theme',
  'home',
];
const secretTimeoutMs = 30_000;
let secretSequenceIndex = 0;
let secretSequenceStartedAt = 0;

let socket: WebSocket | null = null;
let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let soundboardWorkletNode: AudioWorkletNode | null = null;
let statusTimer: number | undefined;
let talkSocket: WebSocket | null = null;
let talkAudioContext: AudioContext | null = null;
let talkSourceNode: MediaStreamAudioSourceNode | null = null;
let talkCaptureNode: AudioWorkletNode | null = null;
let talkMicStream: MediaStream | null = null;
let talkRemainder = new Uint8Array(0);

const resumeAudio = () => {
  if (audioContext && audioContext.state !== 'running' && audioContext.state !== 'closed') {
    void audioContext.resume().catch(() => undefined);
  }
  if (talkAudioContext && talkAudioContext.state !== 'running' && talkAudioContext.state !== 'closed') {
    void talkAudioContext.resume().catch(() => undefined);
  }
};

const normalizedApiUrl = computed(() => apiBaseUrl.value.replace(/\/$/, ''));
const currentPage = computed(() => {
  if (route.value === '#/terms') return 'terms';
  if (route.value === '#/privacy') return 'privacy';
  if (route.value === '#/links') return 'links';
  return 'home';
});
const availableServers = computed(() => status.value?.servers ?? []);
const selectedServer = computed(
  () => availableServers.value.find((server) => server.id === selectedServerId.value) ?? null,
);
const stateLabel = computed(() => {
  const state = selectedServer.value?.state;
  if (state === 'ready') return 'VC 接続中';
  if (state === 'waiting-for-bot') return 'Bot 接続待ち';
  if (state === 'starting') return '起動中';
  if (state === 'missing-config') return '環境変数待ち';
  if (state === 'error') return 'エラー';
  if (state === 'disconnected') return '切断';
  return '未確認';
});
const themeButtonLabel = computed(() =>
  theme.value === 'dark' ? 'ライトモードに切り替える' : 'ダークモードに切り替える',
);

const recordSecretAction = (action: string) => {
  if (talkUnlocked.value) return;

  const now = Date.now();
  if (
    secretSequenceIndex > 0 &&
    now - secretSequenceStartedAt > secretTimeoutMs
  ) {
    secretSequenceIndex = 0;
    secretSequenceStartedAt = 0;
  }

  if (action === secretSequence[secretSequenceIndex]) {
    if (secretSequenceIndex === 0) secretSequenceStartedAt = now;
    secretSequenceIndex += 1;
    if (secretSequenceIndex === secretSequence.length) {
      talkUnlocked.value = true;
      window.sessionStorage.setItem('kikiweb-talk-unlocked', '1');
      window.localStorage.setItem('kikiweb-talk-unlocked', '1');
      secretSequenceIndex = 0;
      secretSequenceStartedAt = 0;
    }
    return;
  }

  secretSequenceIndex = action === secretSequence[0] ? 1 : 0;
  secretSequenceStartedAt = secretSequenceIndex === 1 ? now : 0;
};

const toggleTheme = () => {
  recordSecretAction('theme');
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
};

const wsUrl = computed(() => {
  const url = new URL(normalizedApiUrl.value);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/audio';
  if (selectedServerId.value) {
    url.searchParams.set('serverId', selectedServerId.value);
  }
  if (listenToken.value) {
    url.searchParams.set('token', listenToken.value);
  }
  return url.toString();
});

const talkWsUrl = computed(() => {
  const url = new URL(normalizedApiUrl.value);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/talk';
  if (selectedServerId.value) {
    url.searchParams.set('serverId', selectedServerId.value);
  }
  if (talkToken.value) {
    url.searchParams.set('token', talkToken.value);
  }
  return url.toString();
});

const fetchStatus = async () => {
  statusError.value = '';
  try {
    const response = await fetch(`${normalizedApiUrl.value}/status`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const nextStatus = (await response.json()) as ApiStatus;
    const serverList = nextStatus.servers ?? [];
    status.value = { ...nextStatus, servers: serverList };

    const currentExists = serverList.some((server) => server.id === selectedServerId.value);
    if (!currentExists) {
      selectedServerId.value =
        serverList.find((server) => server.state === 'ready')?.id ?? serverList[0]?.id ?? '';
    }
  } catch (error) {
    statusError.value = error instanceof Error ? error.message : String(error);
  }
};

const startListening = async () => {
  stopListening();
  playerState.value = 'connecting';
  playerError.value = '';
  bufferMs.value = 0;
  underruns.value = 0;

  try {
    if (!selectedServerId.value) {
      throw new Error('接続中のDiscordサーバーがありません。');
    }
    if (!('AudioWorkletNode' in window)) {
      throw new Error('このブラウザは AudioWorklet に対応していません。');
    }

    audioContext = new AudioContext({ sampleRate: 48_000 });
    await audioContext.audioWorklet.addModule('/kikiweb-audio-worklet.js?v=5');
    workletNode = new AudioWorkletNode(audioContext, 'kikiweb-pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sourceSampleRate: 48_000 },
    });
    soundboardWorkletNode = new AudioWorkletNode(audioContext, 'kikiweb-pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sourceSampleRate: 48_000 },
    });
    workletNode.port.postMessage({ type: 'volume', value: volume.value / 100 });
    soundboardWorkletNode.port.postMessage({ type: 'volume', value: volume.value / 100 });
    workletNode.port.onmessage = (event) => {
      if (event.data?.type !== 'stats') return;
      bufferMs.value = event.data.bufferMs;
      underruns.value = event.data.underruns;
    };
    workletNode.connect(audioContext.destination);
    soundboardWorkletNode.connect(audioContext.destination);
    await audioContext.resume();

    const nextSocket = new WebSocket(wsUrl.value);
    socket = nextSocket;
    nextSocket.binaryType = 'arraybuffer';

    nextSocket.onopen = () => {
      if (socket !== nextSocket) return;
      playerState.value = 'playing';
    };

    nextSocket.onmessage = async (event) => {
      if (socket !== nextSocket) return;
      if (typeof event.data === 'string') return;

      const packet = event.data as ArrayBuffer;
      const firstByte = new Uint8Array(packet, 0, 1)[0];
      const extendedSoundboard = packet.byteLength === 3_849 && firstByte === 1;
      const tagged = packet.byteLength === 3_841 && (firstByte === 0 || firstByte === 1);
      const streamType = extendedSoundboard || tagged ? firstByte : 0;
      const pcm = extendedSoundboard ? packet.slice(9) : tagged ? packet.slice(1) : packet;
      if (streamType === 1 && !soundboardEnabled.value) return;

      const targetNode = streamType === 1 ? soundboardWorkletNode : workletNode;
      targetNode?.port.postMessage(
        {
          type: 'pcm',
          buffer: pcm,
        },
        [pcm],
      );
    };

    nextSocket.onerror = () => {
      if (socket !== nextSocket) return;
      playerState.value = 'error';
      playerError.value = '音声サーバーに接続できませんでした。URL とトークンを確認してください。';
    };

    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      if (playerState.value === 'playing' || playerState.value === 'connecting') {
        playerState.value = 'stopped';
      }
    };
  } catch (error) {
    playerState.value = 'error';
    playerError.value = error instanceof Error ? error.message : String(error);
  }
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
  workletNode?.disconnect();
  workletNode?.port.close();
  workletNode = null;
  soundboardWorkletNode?.disconnect();
  soundboardWorkletNode?.port.close();
  soundboardWorkletNode = null;
  void audioContext?.close();
  audioContext = null;
  bufferMs.value = 0;
  if (playerState.value !== 'idle') {
    playerState.value = 'stopped';
  }
};

const releaseTalkResources = () => {
  talkCaptureNode?.disconnect();
  talkCaptureNode?.port.close();
  talkCaptureNode = null;
  talkSourceNode?.disconnect();
  talkSourceNode = null;
  talkMicStream?.getTracks().forEach((track) => track.stop());
  talkMicStream = null;
  void talkAudioContext?.close();
  talkAudioContext = null;
  talkRemainder = new Uint8Array(0);
};

const stopTalking = () => {
  const closingSocket = talkSocket;
  talkSocket = null;
  if (closingSocket) {
    if (closingSocket.readyState === WebSocket.OPEN) {
      closingSocket.send(JSON.stringify({ type: 'talk-stop' }));
    }
    closingSocket.onopen = null;
    closingSocket.onmessage = null;
    closingSocket.onerror = null;
    closingSocket.onclose = null;
    closingSocket.close();
  }
  releaseTalkResources();
  if (talkState.value !== 'idle') talkState.value = 'stopped';
};

const sendTalkPcm = (buffer: ArrayBuffer) => {
  if (!talkSocket || talkSocket.readyState !== WebSocket.OPEN) return;

  const incoming = new Uint8Array(buffer);
  const combined = new Uint8Array(talkRemainder.length + incoming.length);
  combined.set(talkRemainder);
  combined.set(incoming, talkRemainder.length);

  let offset = 0;
  while (offset + 3_840 <= combined.length) {
    talkSocket.send(combined.slice(offset, offset + 3_840));
    offset += 3_840;
  }
  talkRemainder = combined.slice(offset);
};

const startTalking = async () => {
  stopTalking();
  talkState.value = 'connecting';
  talkError.value = '';

  try {
    if (!selectedServerId.value || !selectedServer.value) {
      throw new Error('接続中のDiscordサーバーを選択してください。');
    }
    if (!talkToken.value) {
      throw new Error('送話用トークンが設定されていません。');
    }
    if (!navigator.mediaDevices?.getUserMedia || !('AudioWorkletNode' in window)) {
      throw new Error('このブラウザではマイク送話を利用できません。');
    }

    talkMicStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 2,
        sampleRate: 48_000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    talkAudioContext = new AudioContext({ sampleRate: 48_000 });
    if (talkAudioContext.sampleRate !== 48_000) {
      throw new Error('この端末のマイクは 48kHz 送話に対応していません。');
    }
    await talkAudioContext.audioWorklet.addModule('/kikiweb-audio-worklet.js?v=6');
    talkSourceNode = talkAudioContext.createMediaStreamSource(talkMicStream);
    talkCaptureNode = new AudioWorkletNode(talkAudioContext, 'kikiweb-pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    talkCaptureNode.port.onmessage = (event) => {
      if (event.data?.type === 'pcm' && event.data.buffer) {
        sendTalkPcm(event.data.buffer as ArrayBuffer);
      }
    };
    talkSourceNode.connect(talkCaptureNode);
    talkCaptureNode.connect(talkAudioContext.destination);
    await talkAudioContext.resume();

    const nextSocket = new WebSocket(talkWsUrl.value);
    talkSocket = nextSocket;
    nextSocket.binaryType = 'arraybuffer';
    nextSocket.onopen = () => {
      if (talkSocket === nextSocket) talkState.value = 'talking';
    };
    nextSocket.onerror = () => {
      if (talkSocket !== nextSocket) return;
      talkError.value = 'マイク送話サーバーへ接続できませんでした。';
      talkState.value = 'error';
    };
    nextSocket.onclose = () => {
      if (talkSocket !== nextSocket) return;
      talkSocket = null;
      releaseTalkResources();
      if (talkState.value === 'talking' || talkState.value === 'connecting') {
        talkState.value = 'stopped';
      }
    };
  } catch (error) {
    releaseTalkResources();
    talkSocket?.close();
    talkSocket = null;
    talkState.value = 'error';
    talkError.value = error instanceof Error ? error.message : String(error);
  }
};

const syncRoute = () => {
  route.value = window.location.hash || '#/';
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

fetchStatus();
statusTimer = window.setInterval(fetchStatus, 5_000);
window.addEventListener('hashchange', syncRoute);
window.addEventListener('pointerdown', resumeAudio, { passive: true });
window.addEventListener('pageshow', resumeAudio);
document.addEventListener('visibilitychange', resumeAudio);

watch(volume, (value) => {
  workletNode?.port.postMessage({ type: 'volume', value: value / 100 });
  soundboardWorkletNode?.port.postMessage({ type: 'volume', value: value / 100 });
});

watch(soundboardEnabled, (enabled) => {
  window.localStorage.setItem('kikiweb-soundboard', enabled ? 'on' : 'off');
  if (!enabled) {
    soundboardWorkletNode?.port.postMessage({ type: 'reset' });
  }
});

watch(selectedServerId, (value, previousValue) => {
  if (value) {
    window.localStorage.setItem('kikiweb-server-id', value);
  } else {
    window.localStorage.removeItem('kikiweb-server-id');
  }

  if (
    previousValue &&
    value !== previousValue &&
    (playerState.value === 'playing' || playerState.value === 'connecting')
  ) {
    if (value) {
      void startListening();
    } else {
      stopListening();
      playerError.value = '';
    }
  }

  if (
    previousValue &&
    value !== previousValue &&
    (talkState.value === 'talking' || talkState.value === 'connecting')
  ) {
    stopTalking();
  }
});

watch(theme, saveTheme);

watch(currentPage, (page) => {
  if (page !== 'home' && (talkState.value === 'talking' || talkState.value === 'connecting')) {
    stopTalking();
  }
});

onBeforeUnmount(() => {
  stopListening();
  stopTalking();
  if (statusTimer) window.clearInterval(statusTimer);
  window.removeEventListener('hashchange', syncRoute);
  window.removeEventListener('pointerdown', resumeAudio);
  window.removeEventListener('pageshow', resumeAudio);
  document.removeEventListener('visibilitychange', resumeAudio);
});
</script>

<template>
  <main class="app-shell" :class="{ 'document-layout': currentPage !== 'home' }">
    <nav class="top-nav" aria-label="ページ">
      <a href="#/" :aria-current="currentPage === 'home' ? 'page' : undefined" @click="recordSecretAction('home')">KikiWeb</a>
      <div>
        <a href="#/links" :aria-current="currentPage === 'links' ? 'page' : undefined" @click="recordSecretAction('links')">リンク</a>
        <a href="#/terms" :aria-current="currentPage === 'terms' ? 'page' : undefined" @click="recordSecretAction('terms')">利用規約</a>
        <a href="#/privacy" :aria-current="currentPage === 'privacy' ? 'page' : undefined">プライバシーポリシー</a>
        <button
          class="theme-toggle"
          type="button"
          :title="themeButtonLabel"
          :aria-label="themeButtonLabel"
          :aria-pressed="theme === 'dark'"
          @click="toggleTheme"
        >
          <Sun v-if="theme === 'dark'" :size="18" />
          <Moon v-else :size="18" />
        </button>
      </div>
    </nav>

    <section v-if="currentPage === 'home'" class="listen-panel">
      <div class="brand-row" @click="recordSecretAction('home')">
        <img class="mark" src="/favicon.svg" alt="" aria-hidden="true" />
        <div>
          <p class="eyebrow">Discord VC listen-only relay</p>
          <h1>KikiWeb</h1>
        </div>
      </div>

      <div class="server-picker">
        <label class="field">
          <span>Discord server</span>
          <select v-model="selectedServerId" :disabled="availableServers.length === 0">
            <option disabled value="">
              {{ availableServers.length === 0 ? '接続中のサーバーなし' : 'サーバーを選択' }}
            </option>
            <option v-for="server in availableServers" :key="server.id" :value="server.id">
              {{ server.name }}
            </option>
          </select>
        </label>
        <p>
          {{
            selectedServer
              ? `${selectedServer.channelName} / ${selectedServer.state === 'ready' ? '配信中' : 'Bot接続待ち'}`
              : 'Botからの接続を待っています'
          }}
        </p>
      </div>

      <div class="status-strip">
        <div>
          <span>Bot</span>
          <strong>{{ stateLabel }}</strong>
        </div>
        <div>
          <span>Listeners</span>
          <strong>{{ selectedServer?.listeners ?? 0 }}</strong>
        </div>
        <div>
          <span>Speakers</span>
          <strong>{{ selectedServer?.activeSpeakers ?? 0 }}</strong>
        </div>
        <div>
          <span>Muted</span>
          <strong>{{ selectedServer?.mutedCount ?? 0 }} / {{ selectedServer?.memberCount ?? 0 }}</strong>
        </div>
      </div>

      <div class="player-surface">
        <div class="pulse" :class="{ active: playerState === 'playing' }" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div>
          <p class="player-label">{{ playerState === 'playing' ? 'Live audio' : 'Ready to listen' }}</p>
          <p class="player-copy">
            {{
              selectedServer
                ? `${selectedServer.name} の ${selectedServer.channelName} を再生します。`
                : 'Bot が接続している VC を選択すると再生できます。'
            }}
          </p>
        </div>
      </div>

      <div class="actions">
        <button
          class="primary"
          type="button"
          :disabled="playerState === 'connecting' || !selectedServer"
          @click="startListening"
        >
          {{ playerState === 'playing' ? '再接続' : '聞く' }}
        </button>
        <button type="button" @click="stopListening">停止</button>
        <button type="button" @click="fetchStatus">状態更新</button>
        <button
          v-if="talkUnlocked"
          class="primary"
          type="button"
          :disabled="talkState === 'connecting' || !selectedServer"
          @click="talkState === 'talking' || talkState === 'connecting' ? stopTalking() : startTalking()"
        >
          {{ talkState === 'talking' || talkState === 'connecting' ? 'マイクオフ' : 'マイクオン' }}
        </button>
        <a
          class="invite-link"
          href="https://discord.com/oauth2/authorize?client_id=1498176090072678521"
          target="_blank"
          rel="noreferrer"
        >
          Botを鯖に入れる！
        </a>
      </div>

      <label class="field">
        <span>音量</span>
        <input v-model="volume" min="0" max="100" type="range" />
      </label>

      <label class="soundboard-toggle">
        <span>サウンドボード</span>
        <input v-model="soundboardEnabled" type="checkbox" role="switch" />
        <strong>{{ soundboardEnabled ? 'ON' : 'OFF' }}</strong>
      </label>

      <div class="audio-meter" aria-live="polite">
        <span>Buffer {{ bufferMs }}ms</span>
        <span>Underruns {{ underruns }}</span>
      </div>

      <p v-if="playerError" class="error">{{ playerError }}</p>
      <p v-if="talkUnlocked && talkError" class="error">{{ talkError }}</p>
      <p v-if="statusError" class="error">Status API: {{ statusError }}</p>
      <p v-if="status?.discord.error" class="error">Discord: {{ status.discord.error }}</p>
    </section>

    <article v-if="currentPage === 'links'" class="document-panel links-panel">
      <p class="eyebrow">Links</p>
      <h1>リンク</h1>
      <p class="updated">KikiWeb の連絡先と関連リンクです。</p>

      <div class="link-list">
        <a href="mailto:kobaka2424@gmail.com">
          <span>メールアドレス</span>
          <strong>kobaka2424@gmail.com</strong>
        </a>
        <a href="https://github.com/yakekusolsu" target="_blank" rel="noreferrer">
          <span>GitHub</span>
          <strong>github.com/yakekusolsu</strong>
        </a>
        <div>
          <span>Discord</span>
          <strong>@yakekusolsu</strong>
        </div>
        <a href="https://dsc.gg/naraku" target="_blank" rel="noreferrer">
          <span>奈落鯖</span>
          <strong>dsc.gg/naraku</strong>
        </a>
        <a href="https://x.com/nagetobasi2nd" target="_blank" rel="noreferrer">
          <span>Twitter(現X)</span>
          <strong>x.com/nagetobasi2nd</strong>
        </a>
      </div>
    </article>

    <article v-if="currentPage === 'terms'" class="document-panel">
      <p class="eyebrow">Terms of Service</p>
      <h1>利用規約</h1>
      <p class="updated">最終更新日: 2026年7月29日</p>

      <h2>1. サービスの内容</h2>
      <p>
        KikiWeb は、設定された Discord Bot が参加しているボイスチャンネルの音声を、Web ブラウザで聞くための音声配信サービスです。
      </p>

      <h2>2. 利用条件</h2>
      <p>
        利用者は、Discord の利用規約、参加サーバーのルール、適用される法令を守って本サービスを利用するものとします。ボイスチャンネル参加者に対して、Bot による音声中継およびWebマイク音声の送話の目的と範囲を事前に説明してください。
      </p>

      <h2>3. 禁止事項</h2>
      <p>
        無断での盗聴、録音、第三者への再配信、嫌がらせ、なりすまし、不正アクセス、送話機能の不正利用、LISTEN_TOKEN や Bot トークンの共有、サービスの運用を妨げる行為を禁止します。
      </p>

      <h2>4. 認証情報の管理</h2>
      <p>
        Discord Bot トークン、LISTEN_TOKEN、Render や Vercel の環境変数は利用者の責任で管理してください。これらの漏えいにより発生した損害について、サービス提供者は責任を負いません。
      </p>

      <h2>5. サービスの停止・変更</h2>
      <p>
        メンテナンス、外部サービスの仕様変更、障害、または必要な運用判断により、本サービスの全部または一部を予告なく変更・停止する場合があります。
      </p>

      <h2>6. 免責事項</h2>
      <p>
        本サービスは現状有姿で提供されます。音声品質、接続安定性、Discord・Render・Vercel など外部サービスの継続性について保証しません。
      </p>

      <h2>7. 規約の変更</h2>
      <p>
        必要に応じて本規約を変更する場合があります。変更後も本サービスを利用した場合、変更後の規約に同意したものとみなします。
      </p>
    </article>

    <article v-if="currentPage === 'privacy'" class="document-panel">
      <p class="eyebrow">Privacy Policy</p>
      <h1>プライバシーポリシー</h1>
      <p class="updated">最終更新日: 2026年7月29日</p>

      <h2>1. 取得する情報</h2>
      <p>
        KikiWeb は、サービス運用に必要な範囲で Discord Bot の接続状態、ボイスチャンネル ID、接続リスナー数、アクティブスピーカー数、エラー情報を扱います。
      </p>

      <h2>2. 音声データの扱い</h2>
      <p>
        ボイスチャンネルの音声と、利用者が送話ボタンを押した後にブラウザから取得するマイク音声は、Discord VCへリアルタイム中継するためにサーバー上で一時的に処理されます。この実装では音声データをファイルとして保存しません。
      </p>

      <h2>3. 利用目的</h2>
      <p>
        取得した情報は、音声配信、接続状態の表示、障害調査、不正利用の防止、サービス改善のために利用します。
      </p>

      <h2>4. 第三者サービス</h2>
      <p>
        本サービスは Discord、Render、Vercel などの外部サービスを利用します。各サービス上で扱われる情報は、それぞれのプライバシーポリシーや利用規約に従って処理されます。
      </p>

      <h2>5. ログと環境変数</h2>
      <p>
        サーバーログには接続状態やエラーが記録される場合があります。Discord Bot トークンや LISTEN_TOKEN などの秘密情報をログや公開リポジトリに含めないよう管理してください。
      </p>

      <h2>6. 情報の共有</h2>
      <p>
        法令に基づく場合、サービス保護のために必要な場合、または利用者の同意がある場合を除き、取得した情報を第三者へ提供しません。
      </p>

      <h2>7. お問い合わせ</h2>
      <p>
        本ポリシーに関する問い合わせ先は、サービス運営者が管理する Discord サーバー、Web サイト、またはリポジトリ上で案内される連絡先とします。
      </p>
    </article>
  </main>
</template>
