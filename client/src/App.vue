<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

type ApiStatus = {
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
const status = ref<ApiStatus | null>(null);
const statusError = ref('');
const playerState = ref<'idle' | 'connecting' | 'playing' | 'stopped' | 'error'>('idle');
const playerError = ref('');
const volume = ref(85);
const route = ref(window.location.hash || '#/');

let socket: WebSocket | null = null;
let audioContext: AudioContext | null = null;
let nextPlayTime = 0;
let statusTimer: number | undefined;

const normalizedApiUrl = computed(() => apiBaseUrl.value.replace(/\/$/, ''));
const currentPage = computed(() => {
  if (route.value === '#/terms') return 'terms';
  if (route.value === '#/privacy') return 'privacy';
  return 'home';
});
const stateLabel = computed(() => {
  const state = status.value?.discord.state;
  if (state === 'ready') return 'VC 接続中';
  if (state === 'waiting-for-bot') return 'Bot 接続待ち';
  if (state === 'starting') return '起動中';
  if (state === 'missing-config') return '環境変数待ち';
  if (state === 'error') return 'エラー';
  if (state === 'disconnected') return '切断';
  return '未確認';
});

const wsUrl = computed(() => {
  const url = new URL(normalizedApiUrl.value);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/audio';
  if (listenToken.value) {
    url.searchParams.set('token', listenToken.value);
  }
  return url.toString();
});

const fetchStatus = async () => {
  statusError.value = '';
  try {
    const response = await fetch(`${normalizedApiUrl.value}/status`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    status.value = await response.json();
  } catch (error) {
    statusError.value = error instanceof Error ? error.message : String(error);
  }
};

const playPcmFrame = async (data: ArrayBuffer) => {
  if (!audioContext) return;
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const input = new Int16Array(data);
  const channels = 2;
  const frameCount = input.length / channels;
  const audioBuffer = audioContext.createBuffer(channels, frameCount, 48_000);
  const gain = volume.value / 100;

  for (let channel = 0; channel < channels; channel += 1) {
    const output = audioBuffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i += 1) {
      output[i] = (input[i * channels + channel] / 32768) * gain;
    }
  }

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);

  const now = audioContext.currentTime;
  if (nextPlayTime < now + 0.04) {
    nextPlayTime = now + 0.08;
  }

  source.start(nextPlayTime);
  nextPlayTime += audioBuffer.duration;
};

const startListening = async () => {
  stopListening();
  playerState.value = 'connecting';
  playerError.value = '';

  try {
    audioContext = new AudioContext({ sampleRate: 48_000 });
    await audioContext.resume();
    socket = new WebSocket(wsUrl.value);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      playerState.value = 'playing';
    };

    socket.onmessage = async (event) => {
      if (typeof event.data === 'string') return;
      await playPcmFrame(event.data);
    };

    socket.onerror = () => {
      playerState.value = 'error';
      playerError.value = '音声サーバーに接続できませんでした。URL とトークンを確認してください。';
    };

    socket.onclose = () => {
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
  socket?.close();
  socket = null;
  void audioContext?.close();
  audioContext = null;
  nextPlayTime = 0;
  if (playerState.value !== 'idle') {
    playerState.value = 'stopped';
  }
};

const syncRoute = () => {
  route.value = window.location.hash || '#/';
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

fetchStatus();
statusTimer = window.setInterval(fetchStatus, 5_000);
window.addEventListener('hashchange', syncRoute);

onBeforeUnmount(() => {
  stopListening();
  if (statusTimer) window.clearInterval(statusTimer);
  window.removeEventListener('hashchange', syncRoute);
});
</script>

<template>
  <main class="app-shell" :class="{ 'document-layout': currentPage !== 'home' }">
    <nav class="top-nav" aria-label="ページ">
      <a href="#/" :aria-current="currentPage === 'home' ? 'page' : undefined">KikiWeb</a>
      <div>
        <a href="#/terms" :aria-current="currentPage === 'terms' ? 'page' : undefined">利用規約</a>
        <a href="#/privacy" :aria-current="currentPage === 'privacy' ? 'page' : undefined">プライバシーポリシー</a>
      </div>
    </nav>

    <section v-if="currentPage === 'home'" class="listen-panel">
      <div class="brand-row">
        <div class="mark" aria-hidden="true">K</div>
        <div>
          <p class="eyebrow">Discord VC listen-only relay</p>
          <h1>KikiWeb</h1>
        </div>
      </div>

      <div class="status-strip">
        <div>
          <span>Bot</span>
          <strong>{{ stateLabel }}</strong>
        </div>
        <div>
          <span>Listeners</span>
          <strong>{{ status?.listeners ?? 0 }}</strong>
        </div>
        <div>
          <span>Speakers</span>
          <strong>{{ status?.discord.activeSpeakers ?? 0 }}</strong>
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
            Bot が接続している VC の音声だけを、このページで再生します。
          </p>
        </div>
      </div>

      <div class="actions">
        <button class="primary" type="button" :disabled="playerState === 'connecting'" @click="startListening">
          {{ playerState === 'playing' ? '再接続' : '聞く' }}
        </button>
        <button type="button" @click="stopListening">停止</button>
        <button type="button" @click="fetchStatus">状態更新</button>
      </div>

      <label class="field">
        <span>音量</span>
        <input v-model="volume" min="0" max="100" type="range" />
      </label>

      <p v-if="playerError" class="error">{{ playerError }}</p>
      <p v-if="statusError" class="error">Status API: {{ statusError }}</p>
      <p v-if="status?.discord.error" class="error">Discord: {{ status.discord.error }}</p>
    </section>

    <section v-if="currentPage === 'home'" class="settings-panel">
      <h2>接続設定</h2>
      <label class="field">
        <span>Render API URL</span>
        <input v-model="apiBaseUrl" type="url" placeholder="https://your-service.onrender.com" />
      </label>
      <label class="field">
        <span>Listen token</span>
        <input v-model="listenToken" type="password" placeholder="LISTEN_TOKEN を設定した場合のみ" />
      </label>
      <div class="deploy-notes">
        <p>Vercel では <code>VITE_API_BASE_URL</code> に Render の URL を入れてください。</p>
        <p>Render 側で <code>LISTEN_TOKEN</code> を入れた場合、Vercel 側の <code>VITE_LISTEN_TOKEN</code> も同じ値にします。</p>
      </div>
    </section>

    <article v-if="currentPage === 'terms'" class="document-panel">
      <p class="eyebrow">Terms of Service</p>
      <h1>利用規約</h1>
      <p class="updated">最終更新日: 2026年7月29日</p>

      <h2>1. サービスの内容</h2>
      <p>
        KikiWeb は、設定された Discord Bot が参加しているボイスチャンネルの音声を、Web ブラウザで聞くための listen-only 配信サービスです。
      </p>

      <h2>2. 利用条件</h2>
      <p>
        利用者は、Discord の利用規約、参加サーバーのルール、適用される法令を守って本サービスを利用するものとします。ボイスチャンネル参加者に対して、Bot による音声中継の目的と範囲を事前に説明してください。
      </p>

      <h2>3. 禁止事項</h2>
      <p>
        無断での盗聴、録音、第三者への再配信、嫌がらせ、なりすまし、不正アクセス、LISTEN_TOKEN や Bot トークンの共有、サービスの運用を妨げる行為を禁止します。
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
        ボイスチャンネルの音声は、ブラウザへリアルタイム配信するためにサーバー上で一時的に処理されます。この実装では音声データをファイルとして保存しません。
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
