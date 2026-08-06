<script setup lang="ts">
import { ChevronDown, ExternalLink, MessageCircle, Moon, Send, Sun } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { getInitialTheme, saveTheme, type Theme } from './theme';

type VoiceUser = {
  id: string;
  name: string;
  bot: boolean;
  muted: boolean;
};

type ServerStatus = {
  id: string;
  name: string;
  channelId: string;
  channelName: string;
  voiceStatus: string;
  state: string;
  listeners: number;
  activeSpeakers: number;
  memberCount: number;
  mutedCount: number;
  users?: VoiceUser[];
  lastAudioAt: number;
  lastIngestAt: number;
};

type ApiStatus = {
  servers: ServerStatus[];
  guildCount: number | null;
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

type ChatItem = {
  id: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  bot: boolean;
  webhook: boolean;
  content: string;
  timestamp: string;
};

type ChatContentPart = {
  kind: 'text' | 'link' | 'image';
  value: string;
};

type TalkVoicePreset =
  | 'normal'
  | 'feminine'
  | 'masculine'
  | 'robot'
  | 'minions'
  | 'chorus'
  | 'natural-low'
  | 'bright'
  | 'radio'
  | 'boy'
  | 'asmr';

type TalkVoicePresetSettings = {
  highpass: number;
  lowpass: number;
  bodyFrequency: number;
  bodyGain: number;
  presenceFrequency: number;
  presenceGain: number;
};

const talkVoicePresets: TalkVoicePreset[] = [
  'normal',
  'feminine',
  'masculine',
  'robot',
  'minions',
  'chorus',
  'natural-low',
  'bright',
  'radio',
  'boy',
  'asmr',
];
const talkVoicePresetLabels: Record<TalkVoicePreset, string> = {
  normal: '通常',
  feminine: '女声',
  masculine: '男声',
  robot: 'ロボット',
  minions: 'ミニオンズ',
  chorus: 'コーラス',
  'natural-low': '自然な低音',
  bright: '明るい声',
  radio: 'ラジオ',
  boy: '少年',
  asmr: 'ASMR',
};
const talkVoicePresetSettings: Record<
  TalkVoicePreset,
  TalkVoicePresetSettings
> = {
  normal: { highpass: 25, lowpass: 18_000, bodyFrequency: 240, bodyGain: 0, presenceFrequency: 3_200, presenceGain: 0 },
  feminine: { highpass: 125, lowpass: 16_000, bodyFrequency: 240, bodyGain: -5, presenceFrequency: 3_200, presenceGain: 4 },
  masculine: { highpass: 45, lowpass: 15_000, bodyFrequency: 180, bodyGain: 5, presenceFrequency: 2_800, presenceGain: -2 },
  robot: { highpass: 80, lowpass: 8_000, bodyFrequency: 300, bodyGain: -2, presenceFrequency: 3_600, presenceGain: 5 },
  minions: { highpass: 180, lowpass: 15_000, bodyFrequency: 300, bodyGain: -7, presenceFrequency: 4_200, presenceGain: 6 },
  chorus: { highpass: 55, lowpass: 15_000, bodyFrequency: 220, bodyGain: 1, presenceFrequency: 3_200, presenceGain: 3 },
  'natural-low': { highpass: 30, lowpass: 15_000, bodyFrequency: 150, bodyGain: 4, presenceFrequency: 2_800, presenceGain: 1 },
  bright: { highpass: 75, lowpass: 18_000, bodyFrequency: 280, bodyGain: -2, presenceFrequency: 4_200, presenceGain: 5 },
  radio: { highpass: 180, lowpass: 4_800, bodyFrequency: 900, bodyGain: 3, presenceFrequency: 2_400, presenceGain: 3 },
  boy: { highpass: 100, lowpass: 17_000, bodyFrequency: 850, bodyGain: 2, presenceFrequency: 3_600, presenceGain: 4 },
  asmr: { highpass: 30, lowpass: 16_000, bodyFrequency: 140, bodyGain: 4, presenceFrequency: 6_500, presenceGain: 6 },
};

const storedToggle = (key: string, fallback: boolean) => {
  const value = window.localStorage.getItem(key);
  return value === null ? fallback : value === 'on';
};

const apiBaseUrl = ref(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787');
const listenToken = ref(import.meta.env.VITE_LISTEN_TOKEN || '');
const talkToken = ref(import.meta.env.VITE_TALK_TOKEN || '');
const status = ref<ApiStatus | null>(null);
const statusError = ref('');
const playerState = ref<'idle' | 'connecting' | 'playing' | 'stopped' | 'error'>('idle');
const playerError = ref('');
const volume = ref(85);
const userVolumes = ref<Record<string, number>>({});
const userVolumesOpen = ref(false);
const voicePresetOpen = ref(false);
const talkProcessingOpen = ref(false);
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
const chatMessage = ref('');
const chatState = ref<'idle' | 'sending' | 'sent' | 'error'>('idle');
const chatError = ref('');
const chatConnectionState = ref<'idle' | 'connecting' | 'connected' | 'error'>('idle');
const chatMessages = ref<ChatItem[]>([]);
const chatChannelName = ref('');
const chatListElement = ref<HTMLElement | null>(null);
const storedTalkGain = Number(window.localStorage.getItem('kikiweb-talk-gain'));
const talkGain = ref(Number.isFinite(storedTalkGain) ? Math.min(8.5, Math.max(1, storedTalkGain)) : 2.5);
const storedTalkSensitivity = Number(window.localStorage.getItem('kikiweb-talk-sensitivity'));
const talkSensitivity = ref(
  Number.isFinite(storedTalkSensitivity) ? Math.min(10, Math.max(1, storedTalkSensitivity)) : 8,
);
const talkNoiseGateThreshold = computed(() => Math.max(0.002, 0.018 - talkSensitivity.value * 0.0018));
const storedTalkPitch = Number(window.localStorage.getItem('kikiweb-talk-pitch'));
const talkPitch = ref(Number.isFinite(storedTalkPitch) ? Math.min(1.5, Math.max(0.7, storedTalkPitch)) : 1);
const storedTalkVoicePreset = window.localStorage.getItem('kikiweb-talk-voice-preset');
const talkVoicePreset = ref<TalkVoicePreset>(
  talkVoicePresets.includes(storedTalkVoicePreset as TalkVoicePreset)
    ? (storedTalkVoicePreset as TalkVoicePreset)
    : 'normal',
);
const talkEchoEnabled = ref(window.localStorage.getItem('kikiweb-talk-echo') === 'on');
const storedTalkEchoAmount = Number(window.localStorage.getItem('kikiweb-talk-echo-amount'));
const talkEchoAmount = ref(
  Number.isFinite(storedTalkEchoAmount) ? Math.min(100, Math.max(0, storedTalkEchoAmount)) : 45,
);
const talkCallOptimization = ref(storedToggle('kikiweb-talk-call-optimization', true));
const talkNoiseReduction = ref(storedToggle('kikiweb-talk-noise-reduction', true));
const talkMicBoost = ref(storedToggle('kikiweb-talk-mic-boost', false));
const talkEchoCancellation = ref(storedToggle('kikiweb-talk-echo-cancellation', true));
const talkLimiter = ref(storedToggle('kikiweb-talk-limiter', true));
const talkAutoVolume = ref(storedToggle('kikiweb-talk-auto-volume', true));
const talkVoicePresetLabel = computed(() => talkVoicePresetLabels[talkVoicePreset.value]);
const talkProcessingEnabledCount = computed(
  () =>
    [
      talkCallOptimization.value,
      talkNoiseReduction.value,
      talkMicBoost.value,
      talkEchoCancellation.value,
      talkLimiter.value,
      talkAutoVolume.value,
    ].filter(Boolean).length,
);

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
const hideSequence = ['links', 'terms', 'theme', 'theme', 'home'];
const secretTimeoutMs = 30_000;
let secretSequenceIndex = 0;
let secretSequenceStartedAt = 0;
let hideSequenceIndex = 0;
let hideSequenceStartedAt = 0;

let socket: WebSocket | null = null;
let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let soundboardWorkletNode: AudioWorkletNode | null = null;
let statusTimer: number | undefined;
let chatStatusTimer: number | undefined;
let chatReconnectTimer: number | undefined;
let chatSocket: WebSocket | null = null;
let talkSocket: WebSocket | null = null;
let talkAudioContext: AudioContext | null = null;
let talkSourceNode: MediaStreamAudioSourceNode | null = null;
let talkCaptureNode: AudioWorkletNode | null = null;
let talkHighpassNode: BiquadFilterNode | null = null;
let talkBodyNode: BiquadFilterNode | null = null;
let talkPresenceNode: BiquadFilterNode | null = null;
let talkLowpassNode: BiquadFilterNode | null = null;
let talkDryNode: GainNode | null = null;
let talkEchoDelayNode: DelayNode | null = null;
let talkEchoFeedbackNode: GainNode | null = null;
let talkEchoWetNode: GainNode | null = null;
let talkBoostNode: GainNode | null = null;
let talkCompressorNode: DynamicsCompressorNode | null = null;
let talkLimiterNode: DynamicsCompressorNode | null = null;
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

const applyTalkVoicePreset = () => {
  const settings = talkVoicePresetSettings[talkVoicePreset.value];
  const now = talkAudioContext?.currentTime ?? 0;
  const optimizedHighpass = talkCallOptimization.value ? Math.max(45, settings.highpass) : settings.highpass;
  const optimizedLowpass = talkCallOptimization.value ? Math.min(14_000, settings.lowpass) : settings.lowpass;
  talkHighpassNode?.frequency.setTargetAtTime(optimizedHighpass, now, 0.02);
  talkBodyNode?.frequency.setTargetAtTime(settings.bodyFrequency, now, 0.02);
  talkBodyNode?.gain.setTargetAtTime(settings.bodyGain, now, 0.02);
  talkPresenceNode?.frequency.setTargetAtTime(settings.presenceFrequency, now, 0.02);
  talkPresenceNode?.gain.setTargetAtTime(settings.presenceGain, now, 0.02);
  talkLowpassNode?.frequency.setTargetAtTime(optimizedLowpass, now, 0.02);
  talkCaptureNode?.port.postMessage({ type: 'voice-preset', value: talkVoicePreset.value });
  applyTalkDynamics();
};

const setCompressor = (
  node: DynamicsCompressorNode | null,
  settings: { threshold: number; knee: number; ratio: number; attack: number; release: number },
) => {
  const now = talkAudioContext?.currentTime ?? 0;
  node?.threshold.setTargetAtTime(settings.threshold, now, 0.02);
  node?.knee.setTargetAtTime(settings.knee, now, 0.02);
  node?.ratio.setTargetAtTime(settings.ratio, now, 0.02);
  node?.attack.setTargetAtTime(settings.attack, now, 0.02);
  node?.release.setTargetAtTime(settings.release, now, 0.02);
};

function applyTalkDynamics() {
  const now = talkAudioContext?.currentTime ?? 0;
  const boostMultiplier = talkMicBoost.value ? 2 : 1;
  talkBoostNode?.gain.setTargetAtTime(talkGain.value * boostMultiplier, now, 0.02);

  if (talkVoicePreset.value === 'radio') {
    setCompressor(talkCompressorNode, {
      threshold: talkAutoVolume.value ? -24 : -20,
      knee: 8,
      ratio: talkAutoVolume.value ? 4 : 3,
      attack: 0.008,
      release: 0.16,
    });
  } else if (talkVoicePreset.value === 'asmr') {
    setCompressor(talkCompressorNode, {
      threshold: talkAutoVolume.value ? -30 : -26,
      knee: 14,
      ratio: talkAutoVolume.value ? 3.5 : 2.5,
      attack: 0.012,
      release: 0.34,
    });
  } else if (talkAutoVolume.value) {
    setCompressor(talkCompressorNode, { threshold: -24, knee: 12, ratio: 4, attack: 0.006, release: 0.25 });
  } else {
    setCompressor(talkCompressorNode, { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.1 });
  }

  setCompressor(
    talkLimiterNode,
    talkLimiter.value
      ? { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.12 }
      : { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.1 },
  );
}

type TalkMediaConstraints = MediaTrackConstraints & { voiceIsolation?: boolean };
type TalkSupportedConstraints = MediaTrackSupportedConstraints & { voiceIsolation?: boolean; latency?: boolean };

const createTalkMediaConstraints = (includeOptimization = true): TalkMediaConstraints => {
  const supported = navigator.mediaDevices?.getSupportedConstraints() as TalkSupportedConstraints | undefined;
  const optimize = includeOptimization && talkCallOptimization.value;
  return {
    channelCount: 1,
    sampleRate: 48_000,
    echoCancellation: talkEchoCancellation.value,
    noiseSuppression: talkNoiseReduction.value,
    autoGainControl: talkAutoVolume.value,
    ...(optimize && supported?.voiceIsolation ? { voiceIsolation: true } : {}),
    ...(optimize && supported?.latency ? { latency: { ideal: 0.02 } } : {}),
  };
};

const applyTalkMediaConstraints = async () => {
  const track = talkMicStream?.getAudioTracks()[0];
  if (!track) return;

  try {
    await track.applyConstraints(createTalkMediaConstraints());
  } catch {
    try {
      await track.applyConstraints(createTalkMediaConstraints(false));
    } catch {
      talkError.value = 'この端末では一部のマイク補正を変更できませんでした。';
    }
  }
};

const applyTalkNoiseGate = () => {
  talkCaptureNode?.port.postMessage({
    type: 'noise-gate',
    value: talkNoiseReduction.value ? talkNoiseGateThreshold.value : 0,
  });
};

const applyTalkEcho = () => {
  const now = talkAudioContext?.currentTime ?? 0;
  const amount = Math.min(1, Math.max(0, talkEchoAmount.value / 100));
  const enabledAmount = talkEchoEnabled.value ? amount : 0;
  talkEchoWetNode?.gain.setTargetAtTime(enabledAmount * 0.62, now, 0.02);
  talkEchoFeedbackNode?.gain.setTargetAtTime(enabledAmount * 0.55, now, 0.02);
};

const normalizedApiUrl = computed(() => apiBaseUrl.value.replace(/\/$/, ''));
const currentPage = computed(() => {
  if (route.value === '#/guide') return 'guide';
  if (route.value === '#/extensions') return 'extensions';
  if (route.value === '#/terms') return 'terms';
  if (route.value === '#/privacy') return 'privacy';
  if (route.value === '#/links') return 'links';
  return 'home';
});
const availableServers = computed(() => status.value?.servers ?? []);
const selectedServer = computed(
  () => availableServers.value.find((server) => server.id === selectedServerId.value) ?? null,
);
const selectedVoiceUsers = computed(() => selectedServer.value?.users ?? []);
const hasVoiceUserMetadata = computed(() => Array.isArray(selectedServer.value?.users));
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
  const now = Date.now();
  if (talkUnlocked.value) {
    if (hideSequenceIndex > 0 && now - hideSequenceStartedAt > secretTimeoutMs) {
      hideSequenceIndex = 0;
      hideSequenceStartedAt = 0;
    }

    if (action === hideSequence[hideSequenceIndex]) {
      if (hideSequenceIndex === 0) hideSequenceStartedAt = now;
      hideSequenceIndex += 1;
      if (hideSequenceIndex === hideSequence.length) {
        stopTalking();
        chatMessage.value = '';
        chatState.value = 'idle';
        chatError.value = '';
        voicePresetOpen.value = false;
        talkProcessingOpen.value = false;
        talkUnlocked.value = false;
        window.sessionStorage.removeItem('kikiweb-talk-unlocked');
        window.localStorage.removeItem('kikiweb-talk-unlocked');
        hideSequenceIndex = 0;
        hideSequenceStartedAt = 0;
      }
      return;
    }

    hideSequenceIndex = action === hideSequence[0] ? 1 : 0;
    hideSequenceStartedAt = hideSequenceIndex === 1 ? now : 0;
    return;
  }

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

const chatWsUrl = computed(() => {
  const url = new URL(normalizedApiUrl.value);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/chat-stream';
  if (selectedServerId.value) url.searchParams.set('serverId', selectedServerId.value);
  if (talkToken.value) url.searchParams.set('token', talkToken.value);
  return url.toString();
});

const scrollChatToEnd = () => {
  void nextTick(() => {
    const element = chatListElement.value;
    if (element) element.scrollTop = element.scrollHeight;
  });
};

const acceptChatMessage = (message: ChatItem) => {
  if (!message?.id || !message.content) return;
  const messages = chatMessages.value.filter((candidate) => candidate.id !== message.id);
  messages.push(message);
  messages.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  chatMessages.value = messages.slice(-50);
  chatChannelName.value = message.channelName || chatChannelName.value;
  scrollChatToEnd();
};

const closeChatStream = (clearMessages = false) => {
  if (chatReconnectTimer) window.clearTimeout(chatReconnectTimer);
  chatReconnectTimer = undefined;
  const closingSocket = chatSocket;
  chatSocket = null;
  if (closingSocket) {
    closingSocket.onopen = null;
    closingSocket.onmessage = null;
    closingSocket.onerror = null;
    closingSocket.onclose = null;
    closingSocket.close();
  }
  chatConnectionState.value = 'idle';
  if (clearMessages) {
    chatMessages.value = [];
    chatChannelName.value = '';
  }
};

const connectChatStream = () => {
  closeChatStream(true);
  if (!talkUnlocked.value || currentPage.value !== 'home' || !selectedServerId.value) return;
  if (!talkToken.value) {
    chatConnectionState.value = 'error';
    return;
  }

  chatConnectionState.value = 'connecting';
  const nextSocket = new WebSocket(chatWsUrl.value);
  chatSocket = nextSocket;
  nextSocket.onopen = () => {
    if (chatSocket === nextSocket) chatConnectionState.value = 'connected';
  };
  nextSocket.onmessage = (event) => {
    if (chatSocket !== nextSocket || typeof event.data !== 'string') return;
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'chat-snapshot') {
        chatChannelName.value = String(payload.channelName || 'Discord chat');
        chatMessages.value = [];
        for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
          acceptChatMessage(message as ChatItem);
        }
      } else if (payload.type === 'chat-message') {
        acceptChatMessage(payload.message as ChatItem);
      }
    } catch {
      // Ignore malformed relay messages while keeping the live chat connected.
    }
  };
  nextSocket.onerror = () => {
    if (chatSocket === nextSocket) chatConnectionState.value = 'error';
  };
  nextSocket.onclose = () => {
    if (chatSocket !== nextSocket) return;
    chatSocket = null;
    chatConnectionState.value = 'error';
    chatReconnectTimer = window.setTimeout(connectChatStream, 3_000);
  };
};

const chatTime = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
};

const chatInitial = (name: string) => Array.from(name.trim())[0]?.toUpperCase() || '?';
const chatUrlPattern = /(?:\b(?:https?|ftp):\/\/|\bwww\.|(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?:[/:?#][^\s]*)?|(?:\d{1,3}\.){3}\d{1,3}(?:[/:?#][^\s]*)?)/iu;
const chatContainsUrl = (content: string) => chatUrlPattern.test(content.normalize('NFKC'));

const chatContentParts = (content: string): ChatContentPart[] =>
  content.split('\n').map((line) => {
    const value = line.trim();
    try {
      const url = new URL(value);
      const discordAttachment =
        url.protocol === 'https:' &&
        (url.hostname === 'cdn.discordapp.com' || url.hostname === 'media.discordapp.net') &&
        url.pathname.startsWith('/attachments/');
      if (discordAttachment) {
        const image = /\.(?:avif|gif|jpe?g|png|webp)$/i.test(url.pathname);
        return { kind: image ? 'image' : 'link', value };
      }
    } catch {
      // Regular chat text is rendered without URL handling.
    }
    return { kind: 'text', value: line };
  });

const sendChatMessage = async () => {
  if (chatState.value === 'sending') return;

  const content = chatMessage.value.trim();
  chatError.value = '';

  if (!selectedServerId.value || !selectedServer.value) {
    chatState.value = 'error';
    chatError.value = '接続中のDiscordサーバーを選択してください。';
    return;
  }
  if (!talkToken.value) {
    chatState.value = 'error';
    chatError.value = 'チャット用トークンが設定されていません。';
    return;
  }
  if (!content) {
    chatState.value = 'error';
    chatError.value = 'メッセージを入力してください。';
    return;
  }
  if (chatContainsUrl(content)) {
    chatState.value = 'error';
    chatError.value = 'URLを含むメッセージは送信できません。';
    return;
  }

  chatState.value = 'sending';
  try {
    const response = await fetch(`${normalizedApiUrl.value}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-talk-token': talkToken.value,
      },
      body: JSON.stringify({ serverId: selectedServerId.value, content }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(result?.error || `送信に失敗しました (${response.status})。`);
    }

    chatMessage.value = '';
    chatState.value = 'sent';
    if (chatStatusTimer) window.clearTimeout(chatStatusTimer);
    chatStatusTimer = window.setTimeout(() => {
      chatState.value = 'idle';
    }, 2_500);
  } catch (error) {
    chatState.value = 'error';
    chatError.value = error instanceof Error ? error.message : 'Discordへの送信に失敗しました。';
  }
};

const sendChatMessageWithShortcut = (event: KeyboardEvent) => {
  if (
    event.key !== 'Enter' ||
    (!event.metaKey && !event.ctrlKey) ||
    event.isComposing
  ) {
    return;
  }

  event.preventDefault();
  void sendChatMessage();
};

const userVolumeStorageKey = (userId: string) => `kikiweb-user-volume-${userId}`;

const ensureUserVolumes = (users: VoiceUser[]) => {
  for (const user of users) {
    if (user.id in userVolumes.value) continue;
    const storedValue = window.localStorage.getItem(userVolumeStorageKey(user.id));
    const stored = storedValue === null ? Number.NaN : Number(storedValue);
    userVolumes.value[user.id] = Number.isFinite(stored)
      ? Math.min(200, Math.max(0, Math.round(stored)))
      : 100;
  }
};

const sendUserVolumes = () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  const volumes = Object.fromEntries(
    selectedVoiceUsers.value.map((user) => [user.id, (userVolumes.value[user.id] ?? 100) / 100]),
  );
  socket.send(JSON.stringify({ type: 'user-volumes', volumes }));
};

const setUserVolume = (userId: string, event: Event) => {
  const target = event.target as HTMLInputElement;
  const normalized = Math.min(200, Math.max(0, Math.round(Number(target.value) || 0)));
  userVolumes.value[userId] = normalized;
  window.localStorage.setItem(userVolumeStorageKey(userId), String(normalized));
  sendUserVolumes();
};

const fetchStatus = async () => {
  statusError.value = '';
  try {
    const response = await fetch(`${normalizedApiUrl.value}/status`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const nextStatus = (await response.json()) as ApiStatus;
    const serverList = nextStatus.servers ?? [];
    for (const server of serverList) ensureUserVolumes(server.users ?? []);
    status.value = { ...nextStatus, servers: serverList };

    const currentExists = serverList.some((server) => server.id === selectedServerId.value);
    if (!currentExists) {
      selectedServerId.value =
        serverList.find((server) => server.state === 'ready')?.id ?? serverList[0]?.id ?? '';
    }
    sendUserVolumes();
    if (talkUnlocked.value && !chatSocket && currentPage.value === 'home') {
      connectChatStream();
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
      sendUserVolumes();
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
  talkHighpassNode?.disconnect();
  talkHighpassNode = null;
  talkBodyNode?.disconnect();
  talkBodyNode = null;
  talkPresenceNode?.disconnect();
  talkPresenceNode = null;
  talkLowpassNode?.disconnect();
  talkLowpassNode = null;
  talkDryNode?.disconnect();
  talkDryNode = null;
  talkEchoDelayNode?.disconnect();
  talkEchoDelayNode = null;
  talkEchoFeedbackNode?.disconnect();
  talkEchoFeedbackNode = null;
  talkEchoWetNode?.disconnect();
  talkEchoWetNode = null;
  talkBoostNode?.disconnect();
  talkBoostNode = null;
  talkCompressorNode?.disconnect();
  talkCompressorNode = null;
  talkLimiterNode?.disconnect();
  talkLimiterNode = null;
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

    const audioConstraints = createTalkMediaConstraints();
    talkMicStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    talkAudioContext = new AudioContext({ sampleRate: 48_000 });
    if (talkAudioContext.sampleRate !== 48_000) {
      throw new Error('この端末のマイクは 48kHz 送話に対応していません。');
    }
    await talkAudioContext.audioWorklet.addModule('/kikiweb-audio-worklet.js?v=14');
    talkSourceNode = talkAudioContext.createMediaStreamSource(talkMicStream);
    talkCaptureNode = new AudioWorkletNode(talkAudioContext, 'kikiweb-pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        noiseGateThreshold: talkNoiseReduction.value ? talkNoiseGateThreshold.value : 0,
        speechGain: 1,
        pitch: talkPitch.value,
        voicePreset: talkVoicePreset.value,
      },
    });
    talkCaptureNode.port.onmessage = (event) => {
      if (event.data?.type === 'pcm' && event.data.buffer) {
        sendTalkPcm(event.data.buffer as ArrayBuffer);
      }
    };
    talkHighpassNode = talkAudioContext.createBiquadFilter();
    talkHighpassNode.type = 'highpass';
    talkHighpassNode.Q.value = 0.7;
    talkBodyNode = talkAudioContext.createBiquadFilter();
    talkBodyNode.type = 'peaking';
    talkBodyNode.frequency.value = 240;
    talkBodyNode.Q.value = 0.9;
    talkPresenceNode = talkAudioContext.createBiquadFilter();
    talkPresenceNode.type = 'peaking';
    talkPresenceNode.frequency.value = 3_200;
    talkPresenceNode.Q.value = 0.8;
    talkLowpassNode = talkAudioContext.createBiquadFilter();
    talkLowpassNode.type = 'lowpass';
    talkLowpassNode.Q.value = 0.7;
    talkDryNode = talkAudioContext.createGain();
    talkEchoDelayNode = talkAudioContext.createDelay(1);
    talkEchoDelayNode.delayTime.value = 0.22;
    talkEchoFeedbackNode = talkAudioContext.createGain();
    talkEchoWetNode = talkAudioContext.createGain();
    talkBoostNode = talkAudioContext.createGain();
    talkCompressorNode = talkAudioContext.createDynamicsCompressor();
    talkLimiterNode = talkAudioContext.createDynamicsCompressor();
    talkSourceNode.connect(talkHighpassNode);
    talkHighpassNode.connect(talkBodyNode);
    talkBodyNode.connect(talkPresenceNode);
    talkPresenceNode.connect(talkLowpassNode);
    talkLowpassNode.connect(talkDryNode);
    talkDryNode.connect(talkBoostNode);
    talkLowpassNode.connect(talkEchoDelayNode);
    talkEchoDelayNode.connect(talkEchoFeedbackNode);
    talkEchoFeedbackNode.connect(talkEchoDelayNode);
    talkEchoDelayNode.connect(talkEchoWetNode);
    talkEchoWetNode.connect(talkBoostNode);
    talkBoostNode.connect(talkCompressorNode);
    talkCompressorNode.connect(talkLimiterNode);
    talkLimiterNode.connect(talkCaptureNode);
    applyTalkVoicePreset();
    applyTalkEcho();
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

  if (talkUnlocked.value && value !== previousValue) connectChatStream();
});

watch(talkUnlocked, (unlocked) => {
  if (unlocked) connectChatStream();
  else closeChatStream(true);
});

watch(theme, saveTheme);

watch(talkGain, (value) => {
  const normalized = Math.min(8.5, Math.max(1, Number(value) || 1));
  if (value !== normalized) {
    talkGain.value = normalized;
    return;
  }
  window.localStorage.setItem('kikiweb-talk-gain', String(normalized));
  applyTalkDynamics();
});

watch(talkSensitivity, (value) => {
  const normalized = Math.min(10, Math.max(1, Math.round(Number(value) || 1)));
  if (value !== normalized) {
    talkSensitivity.value = normalized;
    return;
  }
  window.localStorage.setItem('kikiweb-talk-sensitivity', String(normalized));
  applyTalkNoiseGate();
});

watch(talkPitch, (value) => {
  const normalized = Math.min(1.5, Math.max(0.7, Number(value) || 1));
  if (value !== normalized) {
    talkPitch.value = normalized;
    return;
  }
  window.localStorage.setItem('kikiweb-talk-pitch', String(normalized));
  talkCaptureNode?.port.postMessage({ type: 'pitch', value: normalized });
});

watch(talkVoicePreset, (value) => {
  window.localStorage.setItem('kikiweb-talk-voice-preset', value);
  applyTalkVoicePreset();
});

watch(talkEchoEnabled, (enabled) => {
  window.localStorage.setItem('kikiweb-talk-echo', enabled ? 'on' : 'off');
  applyTalkEcho();
});

watch(talkEchoAmount, (value) => {
  const normalized = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  if (value !== normalized) {
    talkEchoAmount.value = normalized;
    return;
  }
  window.localStorage.setItem('kikiweb-talk-echo-amount', String(normalized));
  applyTalkEcho();
});

watch(talkCallOptimization, (enabled) => {
  window.localStorage.setItem('kikiweb-talk-call-optimization', enabled ? 'on' : 'off');
  applyTalkVoicePreset();
  void applyTalkMediaConstraints();
});

watch(talkNoiseReduction, (enabled) => {
  window.localStorage.setItem('kikiweb-talk-noise-reduction', enabled ? 'on' : 'off');
  applyTalkNoiseGate();
  void applyTalkMediaConstraints();
});

watch(talkMicBoost, (enabled) => {
  window.localStorage.setItem('kikiweb-talk-mic-boost', enabled ? 'on' : 'off');
  applyTalkDynamics();
});

watch(talkEchoCancellation, (enabled) => {
  window.localStorage.setItem('kikiweb-talk-echo-cancellation', enabled ? 'on' : 'off');
  void applyTalkMediaConstraints();
});

watch(talkLimiter, (enabled) => {
  window.localStorage.setItem('kikiweb-talk-limiter', enabled ? 'on' : 'off');
  applyTalkDynamics();
});

watch(talkAutoVolume, (enabled) => {
  window.localStorage.setItem('kikiweb-talk-auto-volume', enabled ? 'on' : 'off');
  applyTalkDynamics();
  void applyTalkMediaConstraints();
});

watch(currentPage, (page) => {
  if (page !== 'home' && (talkState.value === 'talking' || talkState.value === 'connecting')) {
    stopTalking();
  }
  if (page === 'home' && talkUnlocked.value) connectChatStream();
  else closeChatStream(false);
});

onBeforeUnmount(() => {
  stopListening();
  stopTalking();
  closeChatStream();
  if (statusTimer) window.clearInterval(statusTimer);
  if (chatStatusTimer) window.clearTimeout(chatStatusTimer);
  window.removeEventListener('hashchange', syncRoute);
  window.removeEventListener('pointerdown', resumeAudio);
  window.removeEventListener('pageshow', resumeAudio);
  document.removeEventListener('visibilitychange', resumeAudio);
});
</script>

<template>
  <main
    class="app-shell"
    :class="{
      'document-layout': currentPage !== 'home',
      'chat-layout': currentPage === 'home' && talkUnlocked,
    }"
  >
    <nav class="top-nav" aria-label="ページ">
      <a href="#/" :aria-current="currentPage === 'home' ? 'page' : undefined" @click="recordSecretAction('home')">KikiWeb</a>
      <div>
        <a href="#/guide" :aria-current="currentPage === 'guide' ? 'page' : undefined">Bot導入・使い方</a>
        <a href="#/extensions" :aria-current="currentPage === 'extensions' ? 'page' : undefined">拡張機能</a>
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
        <div class="server-summary">
          <p>
            {{
              selectedServer
                ? `${selectedServer.channelName} / ${selectedServer.state === 'ready' ? '配信中' : 'Bot接続待ち'}`
                : 'Botからの接続を待っています'
            }}
          </p>
          <span v-if="selectedServer?.voiceStatus" class="voice-status">{{ selectedServer.voiceStatus }}</span>
        </div>
      </div>

      <div class="status-strip">
        <div>
          <span>導入サーバー</span>
          <strong>{{ status?.guildCount ?? '未取得' }}</strong>
        </div>
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
          href="https://discord.com/oauth2/authorize?client_id=1531898882286551130"
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

      <section v-if="selectedServer" class="user-volumes">
        <button
          class="user-volumes-summary"
          type="button"
          :aria-expanded="userVolumesOpen"
          @click="userVolumesOpen = !userVolumesOpen"
        >
          <span>ユーザー別音量</span>
          <small>{{ selectedVoiceUsers.length > 0 ? `${selectedVoiceUsers.length}人` : '未取得' }}</small>
          <ChevronDown :size="18" aria-hidden="true" />
        </button>
        <div v-if="userVolumesOpen && selectedVoiceUsers.length > 0" class="user-volume-list">
          <label v-for="user in selectedVoiceUsers" :key="user.id" class="user-volume-row">
            <span class="user-volume-name">
              <strong>{{ user.name }}</strong>
              <small v-if="user.bot">BOT</small>
              <small v-if="user.muted">ミュート中</small>
            </span>
            <input
              type="range"
              min="0"
              max="200"
              step="5"
              :value="userVolumes[user.id] ?? 100"
              :aria-label="`${user.name}の音量`"
              @input="setUserVolume(user.id, $event)"
            />
            <output>{{ userVolumes[user.id] ?? 100 }}%</output>
          </label>
        </div>
        <p v-else-if="userVolumesOpen" class="user-volume-empty">
          {{
            hasVoiceUserMetadata
              ? 'VC参加者情報を待っています。Botを最新版へ更新して再接続してください。'
              : 'Relayを最新版へ更新すると、VC参加者ごとの音量スライダーが表示されます。'
          }}
        </p>
      </section>

      <label class="soundboard-toggle">
        <span>サウンドボード</span>
        <input v-model="soundboardEnabled" type="checkbox" role="switch" />
        <strong>{{ soundboardEnabled ? 'ON' : 'OFF' }}</strong>
      </label>

      <label v-if="talkUnlocked" class="field">
        <span>マイク送話音量 {{ talkGain.toFixed(1) }}x</span>
        <input v-model.number="talkGain" min="1" max="8.5" step="0.1" type="range" />
      </label>

      <label v-if="talkUnlocked" class="field">
        <span>マイク感度 {{ talkSensitivity }}</span>
        <input v-model.number="talkSensitivity" min="1" max="10" step="1" type="range" />
      </label>

      <label v-if="talkUnlocked" class="field">
        <span>マイク送話ピッチ {{ talkPitch.toFixed(2) }}x</span>
        <input v-model.number="talkPitch" min="0.7" max="1.5" step="0.05" type="range" />
      </label>

      <section v-if="talkUnlocked" class="setting-dropdown">
        <button
          class="setting-dropdown-summary"
          type="button"
          :aria-expanded="voicePresetOpen"
          @click="voicePresetOpen = !voicePresetOpen"
        >
          <span>ボイスチェンジャー</span>
          <small>{{ talkVoicePresetLabel }}</small>
          <ChevronDown :size="18" aria-hidden="true" />
        </button>
        <fieldset v-if="voicePresetOpen" class="voice-preset">
          <legend>プリセット</legend>
          <div>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'normal' }"
            :aria-pressed="talkVoicePreset === 'normal'"
            @click="talkVoicePreset = 'normal'"
          >
            通常
          </button>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'feminine' }"
            :aria-pressed="talkVoicePreset === 'feminine'"
            @click="talkVoicePreset = 'feminine'"
          >
            女声
          </button>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'masculine' }"
            :aria-pressed="talkVoicePreset === 'masculine'"
            @click="talkVoicePreset = 'masculine'"
          >
            男声
          </button>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'robot' }"
            :aria-pressed="talkVoicePreset === 'robot'"
            @click="talkVoicePreset = 'robot'"
          >
            ロボット
          </button>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'minions' }"
            :aria-pressed="talkVoicePreset === 'minions'"
            @click="talkVoicePreset = 'minions'"
          >
            ミニオンズ
          </button>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'chorus' }"
            :aria-pressed="talkVoicePreset === 'chorus'"
            @click="talkVoicePreset = 'chorus'"
          >
            コーラス
          </button>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'natural-low' }"
            :aria-pressed="talkVoicePreset === 'natural-low'"
            @click="talkVoicePreset = 'natural-low'"
          >
            自然な低音
          </button>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'bright' }"
            :aria-pressed="talkVoicePreset === 'bright'"
            @click="talkVoicePreset = 'bright'"
          >
            明るい声
          </button>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'radio' }"
            :aria-pressed="talkVoicePreset === 'radio'"
            @click="talkVoicePreset = 'radio'"
          >
            ラジオ
          </button>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'boy' }"
            :aria-pressed="talkVoicePreset === 'boy'"
            @click="talkVoicePreset = 'boy'"
          >
            少年
          </button>
          <button
            type="button"
            :class="{ active: talkVoicePreset === 'asmr' }"
            :aria-pressed="talkVoicePreset === 'asmr'"
            @click="talkVoicePreset = 'asmr'"
          >
            ASMR
          </button>
          </div>
        </fieldset>
      </section>

      <label v-if="talkUnlocked" class="soundboard-toggle">
        <span>マイクエコー</span>
        <input v-model="talkEchoEnabled" type="checkbox" role="switch" />
        <strong>{{ talkEchoEnabled ? 'ON' : 'OFF' }}</strong>
      </label>

      <label v-if="talkUnlocked && talkEchoEnabled" class="field">
        <span>エコー量 {{ talkEchoAmount }}%</span>
        <input v-model.number="talkEchoAmount" min="0" max="100" step="1" type="range" />
      </label>

      <section v-if="talkUnlocked" class="setting-dropdown">
        <button
          class="setting-dropdown-summary"
          type="button"
          :aria-expanded="talkProcessingOpen"
          @click="talkProcessingOpen = !talkProcessingOpen"
        >
          <span>Discord向け音声補正</span>
          <small>{{ talkProcessingEnabledCount }} / 6 ON</small>
          <ChevronDown :size="18" aria-hidden="true" />
        </button>
        <fieldset v-if="talkProcessingOpen" class="talk-processing">
          <legend>音声補正</legend>
          <div class="talk-processing-grid">
          <label class="soundboard-toggle">
            <span>通話品質最適化</span>
            <input v-model="talkCallOptimization" type="checkbox" role="switch" />
            <strong>{{ talkCallOptimization ? 'ON' : 'OFF' }}</strong>
          </label>
          <label class="soundboard-toggle">
            <span>ノイズ除去</span>
            <input v-model="talkNoiseReduction" type="checkbox" role="switch" />
            <strong>{{ talkNoiseReduction ? 'ON' : 'OFF' }}</strong>
          </label>
          <label class="soundboard-toggle">
            <span>マイクブースト</span>
            <input v-model="talkMicBoost" type="checkbox" role="switch" />
            <strong>{{ talkMicBoost ? 'ON' : 'OFF' }}</strong>
          </label>
          <label class="soundboard-toggle">
            <span>エコーキャンセル</span>
            <input v-model="talkEchoCancellation" type="checkbox" role="switch" />
            <strong>{{ talkEchoCancellation ? 'ON' : 'OFF' }}</strong>
          </label>
          <label class="soundboard-toggle">
            <span>リミッター</span>
            <input v-model="talkLimiter" type="checkbox" role="switch" />
            <strong>{{ talkLimiter ? 'ON' : 'OFF' }}</strong>
          </label>
          <label class="soundboard-toggle">
            <span>ボリューム自動調整</span>
            <input v-model="talkAutoVolume" type="checkbox" role="switch" />
            <strong>{{ talkAutoVolume ? 'ON' : 'OFF' }}</strong>
          </label>
          </div>
        </fieldset>
      </section>

      <div class="audio-meter" aria-live="polite">
        <span>Buffer {{ bufferMs }}ms</span>
        <span>Underruns {{ underruns }}</span>
      </div>

      <p v-if="playerError" class="error">{{ playerError }}</p>
      <p v-if="talkUnlocked && talkError" class="error">{{ talkError }}</p>
      <p v-if="statusError" class="error">Status API: {{ statusError }}</p>
      <p v-if="status?.discord.error" class="error">Discord: {{ status.discord.error }}</p>
    </section>

    <aside v-if="currentPage === 'home' && talkUnlocked" class="chat-panel" aria-label="Discordチャット">
      <header class="chat-panel-header">
        <MessageCircle :size="21" aria-hidden="true" />
        <div>
          <p>Discord chat</p>
          <h2>{{ chatChannelName || selectedServer?.channelName || '接続待ち' }}</h2>
        </div>
        <span class="chat-live-state" :class="chatConnectionState">
          {{ chatConnectionState === 'connected' ? 'LIVE' : chatConnectionState === 'connecting' ? '接続中' : '待機中' }}
        </span>
      </header>

      <div ref="chatListElement" class="chat-message-list" aria-live="polite">
        <p v-if="chatMessages.length === 0" class="chat-empty">
          Discordのメッセージを待っています。
        </p>
        <article v-for="message in chatMessages" :key="message.id" class="chat-message">
          <span class="chat-avatar" aria-hidden="true">{{ chatInitial(message.authorName) }}</span>
          <div>
            <div class="chat-message-meta">
              <strong>{{ message.authorName }}</strong>
              <small v-if="message.webhook">WEBHOOK</small>
              <small v-else-if="message.bot">BOT</small>
              <time :datetime="message.timestamp">{{ chatTime(message.timestamp) }}</time>
            </div>
            <div class="chat-message-content">
              <template v-for="(part, index) in chatContentParts(message.content)" :key="`${message.id}-${index}`">
                <a
                  v-if="part.kind === 'image'"
                  class="chat-attachment-link"
                  :href="part.value"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Discord添付画像を開く"
                >
                  <img
                    class="chat-attachment-image"
                    :src="part.value"
                    alt="Discord添付画像"
                    loading="lazy"
                    referrerpolicy="no-referrer"
                  />
                </a>
                <a
                  v-else-if="part.kind === 'link'"
                  class="chat-attachment-file"
                  :href="part.value"
                  target="_blank"
                  rel="noreferrer"
                >
                  添付ファイルを開く
                </a>
                <p v-else class="chat-message-text">{{ part.value }}</p>
              </template>
            </div>
          </div>
        </article>
      </div>

      <form class="chat-composer" @submit.prevent="sendChatMessage">
        <div class="chat-composer-heading">
          <div>
            <span>Discord Bot</span>
            <strong>KikiWeb on Chat</strong>
          </div>
          <small>{{ chatMessage.length }} / 1000</small>
        </div>
        <textarea
          v-model="chatMessage"
          maxlength="1000"
          rows="3"
          placeholder="Discordへ送るメッセージ"
          aria-label="Discordへ送るメッセージ"
          @keydown="sendChatMessageWithShortcut"
        />
        <div class="chat-composer-actions">
          <p aria-live="polite">
            <span v-if="chatState === 'sent'">送信しました。</span>
            <span v-else-if="selectedServer">{{ selectedServer.name }} へ投稿</span>
            <span v-else>接続中のサーバーを選択してください。</span>
          </p>
          <button
            class="primary"
            type="submit"
            :disabled="chatState === 'sending' || !selectedServer || !chatMessage.trim()"
          >
            <Send :size="17" aria-hidden="true" />
            {{ chatState === 'sending' ? '送信中' : '送信' }}
          </button>
        </div>
        <p v-if="chatError" class="chat-error" role="alert">{{ chatError }}</p>
      </form>
    </aside>

    <article v-if="currentPage === 'guide'" class="document-panel guide-panel">
      <p class="eyebrow">Getting Started</p>
      <h1>Bot導入・使い方</h1>
      <p class="updated">KikiWeb Botの導入、VC中継、自動参加、サイトでの再生手順です。</p>

      <h2>1. Botをサーバーに追加</h2>
      <p>下のボタンからDiscordを開き、追加先のサーバーを選択して認証します。</p>
      <a
        class="invite-link guide-invite"
        href="https://discord.com/oauth2/authorize?client_id=1531898882286551130"
        target="_blank"
        rel="noreferrer"
      >
        この鯖にBotを入れる！
      </a>

      <ol class="guide-steps">
        <li>
          <strong>VC権限を確認</strong>
          <span>Botに「チャンネルを見る」「接続」「発言」「メッセージを送信」「メッセージ履歴を読む」「ボイスチャンネルステータスを設定」権限を付けます。</span>
        </li>
        <li>
          <strong>チャット読み取りを許可</strong>
          <span>Discord Developer PortalのBot設定で「Message Content Intent」をONにします。</span>
        </li>
      </ol>

      <h2>2. VCの中継を開始</h2>
      <ol class="guide-steps">
        <li>
          <strong>VCへ参加</strong>
          <span>KikiWebで聞きたいボイスチャンネルへ、自分が先に参加します。</span>
        </li>
        <li>
          <strong>中継を開始</strong>
          <span>Discordで <code>/kikiweb_join</code> を実行すると、Botが同じVCへ接続します。</span>
        </li>
      </ol>

      <h2>3. 自動参加を設定</h2>
      <ol class="guide-steps">
        <li>
          <strong>自動参加を有効化</strong>
          <span><code>/kikiweb_auto enabled:true channel:&lt;VC&gt;</code>を実行し、Discordの候補から対象VCを選びます。</span>
        </li>
        <li>
          <strong>サーバーごとに保存</strong>
          <span>設定したサーバーとVCの組み合わせが保存され、Bot起動時や切断後に自動で再接続します。</span>
        </li>
        <li>
          <strong>対象VCを変更</strong>
          <span>別のVCを指定して同じコマンドを再実行すると、そのサーバーの自動参加先を変更できます。</span>
        </li>
      </ol>

      <h2>4. サイトで音声を聞く</h2>
      <ol class="guide-steps">
        <li>
          <strong>サーバーを選択</strong>
          <span>トップページのDiscord serverメニューから、Botを接続したサーバーを選びます。</span>
        </li>
        <li>
          <strong>再生を開始</strong>
          <span>「聞く」を押します。ブラウザから音声再生を求められた場合は許可してください。</span>
        </li>
        <li>
          <strong>音量を調節</strong>
          <span>全体音量を調節できます。「ユーザー別音量」を開くと、VC参加者ごとに0〜200%で変更できます。</span>
        </li>
      </ol>

      <h2>5. 中継・自動参加を終了</h2>
      <ol class="guide-steps">
        <li>
          <strong>自動参加を解除</strong>
          <span><code>/kikiweb_auto enabled:false</code>を実行すると、実行したサーバーだけ自動参加が無効になります。</span>
        </li>
        <li>
          <strong>現在の中継を終了</strong>
          <span><code>/kikiweb_leave</code>を実行するとBotがVCから退出します。自動参加中は先に無効化してください。</span>
        </li>
      </ol>

      <h2>うまく接続できない場合</h2>
      <ul class="guide-checks">
        <li>Botがオンラインで、対象VCに接続しているか確認します。</li>
        <li>Botの「チャンネルを見る」「接続」「発言」「メッセージを送信」「メッセージ履歴を読む」「ステータスを設定」権限を確認します。</li>
        <li>チャットが出ない場合はDeveloper Portalの「Message Content Intent」をONにしてBotを再起動します。</li>
        <li>スラッシュコマンドが出ない場合は、Botを再起動してコマンドツリーの同期を待ちます。</li>
        <li>サーバーメニューに出ない場合は「状態更新」を押します。</li>
        <li>ユーザー別音量が未取得の場合は、RelayとBotを最新版へ更新してBotをVCへ再接続します。</li>
        <li>音が出ない場合はブラウザのタブと端末の音量・ミュートを確認します。</li>
      </ul>
    </article>

    <article v-if="currentPage === 'extensions'" class="document-panel extensions-panel">
      <p class="eyebrow">Browser Extensions</p>
      <h1>拡張機能を導入</h1>
      <p class="updated">KikiWebをブラウザのサイドパネルから利用できます。</p>

      <div class="store-links">
        <a
          class="store-link chrome-store-link"
          href="https://chromewebstore.google.com/detail/kikiweb/ebddappocfjldcclnmbmapbmligjdlaj?authuser=0&amp;hl=ja"
          target="_blank"
          rel="noreferrer"
        >
          <span>
            <small>Google Chrome</small>
            Chrome ウェブストアで追加
          </span>
          <ExternalLink :size="19" aria-hidden="true" />
        </a>
        <a
          class="store-link firefox-store-link"
          href="https://addons.mozilla.org/ja/firefox/addon/kikiweb-for-firefox/"
          target="_blank"
          rel="noreferrer"
        >
          <span>
            <small>Mozilla Firefox</small>
            Firefoxへ追加
          </span>
          <ExternalLink :size="19" aria-hidden="true" />
        </a>
      </div>

      <h2>導入後の開き方</h2>
      <ol class="guide-steps">
        <li>
          <strong>ストアから追加</strong>
          <span>使用中のブラウザに合うストアを開き、拡張機能の追加を承認します。</span>
        </li>
        <li>
          <strong>KikiWebを開く</strong>
          <span>ブラウザの拡張機能メニューからKikiWebを選ぶと、サイドパネルが開きます。</span>
        </li>
        <li>
          <strong>サーバーを選んで聞く</strong>
          <span>BotがVCへ接続しているサーバーを選び、「聞く」を押します。</span>
        </li>
      </ol>
    </article>

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
      <p class="updated">最終更新日: 2026年8月6日</p>

      <h2>1. サービスの内容</h2>
      <p>
        KikiWeb は、設定された Discord Bot が参加しているボイスチャンネルの音声をWebブラウザで聞き、設定されたDiscordチャンネルのメッセージを表示・投稿するサービスです。
      </p>

      <h2>2. 利用条件</h2>
      <p>
        利用者は、Discord の利用規約、参加サーバーのルール、適用される法令を守って本サービスを利用するものとします。対象チャンネルの参加者に対して、Botによる音声中継、Webマイク音声の送話、チャット表示の目的と範囲を事前に説明してください。
      </p>

      <h2>3. 禁止事項</h2>
      <p>
        無断での盗聴、録音、チャット閲覧、第三者への再配信、嫌がらせ、なりすまし、不正アクセス、送話・投稿機能の不正利用、LISTEN_TOKEN や Bot トークンの共有、サービスの運用を妨げる行為を禁止します。
      </p>

      <h2>4. 認証情報の管理</h2>
      <p>
        Discord Bot トークン、LISTEN_TOKEN、TALK_TOKEN、Render や Vercel の環境変数は利用者の責任で管理してください。これらの漏えいにより発生した損害について、サービス提供者は責任を負いません。
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
      <p class="updated">最終更新日: 2026年8月6日</p>

      <h2>1. 取得する情報</h2>
      <p>
        KikiWeb は、サービス運用に必要な範囲で Discord Bot の接続状態、ボイスチャンネル ID、接続リスナー数、アクティブスピーカー数、エラー情報を扱います。ユーザー別音量機能では、接続中のDiscordユーザーID、表示名、Bot判定、ミュート状態を一時的に扱います。チャット表示では、Discordのメッセージ本文、送信者ID、表示名、Bot・Webhook判定、送信時刻を一時的に扱います。個別音量の設定値は利用者のブラウザ内に保存されます。
      </p>

      <h2>2. 音声・チャットデータの扱い</h2>
      <p>
        ボイスチャンネルの音声と、利用者が送話ボタンを押した後にブラウザから取得するマイク音声は、Discord VCへリアルタイム中継するためにサーバー上で一時的に処理されます。チャット機能で受信・入力したメッセージは、Web表示とKikiWeb BotによるDiscordへの送信のために処理され、直近50件のみRelayのメモリ上に一時保持されます。KikiWeb on ChatのVC読み上げが有効な場合、投稿本文は音声生成のためMicrosoftのオンライン音声合成サービスへ送信されます。この実装では音声やメッセージをKikiWebのファイルまたはデータベースへ保存しません。Discordへ送信されたメッセージはDiscord上に保存されます。
      </p>

      <h2>3. 利用目的</h2>
      <p>
        取得した情報は、音声配信、接続状態の表示、障害調査、不正利用の防止、サービス改善のために利用します。
      </p>

      <h2>4. 第三者サービス</h2>
      <p>
        本サービスは Discord、Render、Vercel、Microsoftのオンライン音声合成サービスなどの外部サービスを利用します。各サービス上で扱われる情報は、それぞれのプライバシーポリシーや利用規約に従って処理されます。
      </p>

      <h2>5. ログと環境変数</h2>
      <p>
        サーバーログには接続状態やエラーが記録される場合があります。Discord Bot トークン、LISTEN_TOKEN、TALK_TOKEN などの秘密情報をログや公開リポジトリに含めないよう管理してください。
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
