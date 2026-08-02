import './style.css';
import { applyTheme, getInitialTheme, saveTheme, type Theme } from './theme';

type PlayerState = 'idle' | 'connecting' | 'playing' | 'stopped' | 'error';

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
const BROWSER_LABEL = import.meta.env.VITE_BROWSER_LABEL || 'Firefox Sidebar';
const INVITE_URL = 'https://discord.com/oauth2/authorize?client_id=1498176090072678521';

const state = {
  status: null as ApiStatus | null,
  statusError: '',
  playerError: '',
  playerState: 'idle' as PlayerState,
  volume: Number(window.localStorage.getItem('kikiweb-extension-volume') || 85),
  soundboardEnabled: window.localStorage.getItem('kikiweb-extension-soundboard') !== 'off',
  selectedServerId: window.localStorage.getItem('kikiweb-extension-server-id') || '',
  bufferMs: 0,
  underruns: 0,
  refreshing: false,
  theme: getInitialTheme(),
};

let socket: WebSocket | null = null;
let audioContext: AudioContext | null = null;
let voiceNode: AudioWorkletNode | null = null;
let soundboardNode: AudioWorkletNode | null = null;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('KikiWeb app root was not found.');

const availableServers = () => state.status?.servers ?? [];
const selectedServer = () =>
  availableServers().find((server) => server.id === state.selectedServerId) ?? null;
const isPlaying = () => state.playerState === 'playing';
const stateLabel = () => {
  if (state.playerState === 'connecting') return '接続中';
  if (state.playerState === 'playing') return '再生中';
  if (state.playerState === 'error') return 'エラー';
  return selectedServer()?.state === 'ready' ? '再生できます' : 'Bot待機中';
};
const themeButtonLabel = () =>
  state.theme === 'dark' ? 'ライトモードに切り替える' : 'ダークモードに切り替える';
const websocketUrl = () => {
  const url = new URL(API_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/audio';
  if (state.selectedServerId) url.searchParams.set('serverId', state.selectedServerId);
  if (LISTEN_TOKEN) url.searchParams.set('token', LISTEN_TOKEN);
  return url.toString();
};

const setText = (selector: string, value: string | number) => {
  const target = document.querySelector(selector);
  if (target) target.textContent = String(value);
};

const setClass = (selector: string, className: string, enabled: boolean) => {
  document.querySelector(selector)?.classList.toggle(className, enabled);
};

const setDisabled = (selector: string, disabled: boolean) => {
  const target = document.querySelector<HTMLButtonElement | HTMLSelectElement>(selector);
  if (target) target.disabled = disabled;
};

const icon = (label: string) => {
  const span = document.createElement('span');
  span.className = 'plain-icon';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = label;
  return span;
};

const renderShell = () => {
  const main = document.createElement('main');

  const header = document.createElement('header');
  header.className = 'app-header';

  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = WEBSITE_URL;
  brand.target = '_blank';
  brand.rel = 'noreferrer';

  const brandMark = document.createElement('span');
  brandMark.className = 'brand-mark';
  brandMark.setAttribute('aria-hidden', 'true');
  brandMark.textContent = 'K';

  const brandText = document.createElement('span');
  const brandName = document.createElement('strong');
  brandName.textContent = 'KikiWeb';
  const browserLabel = document.createElement('small');
  browserLabel.textContent = BROWSER_LABEL;
  brandText.append(brandName, browserLabel);
  brand.append(brandMark, brandText);

  const headerActions = document.createElement('div');
  headerActions.className = 'header-actions';

  const themeButton = document.createElement('button');
  themeButton.id = 'theme-button';
  themeButton.className = 'icon-button';
  themeButton.type = 'button';
  themeButton.addEventListener('click', toggleTheme);

  const refreshButton = document.createElement('button');
  refreshButton.id = 'refresh-button';
  refreshButton.className = 'icon-button';
  refreshButton.type = 'button';
  refreshButton.title = '状態を更新';
  refreshButton.setAttribute('aria-label', '状態を更新');
  refreshButton.append(icon('↻'));
  refreshButton.addEventListener('click', fetchStatus);

  headerActions.append(themeButton, refreshButton);
  header.append(brand, headerActions);

  const serverSection = document.createElement('section');
  serverSection.className = 'server-section';
  serverSection.setAttribute('aria-labelledby', 'server-heading');

  const sectionHeading = document.createElement('div');
  sectionHeading.className = 'section-heading';
  const headingText = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Discord server';
  const heading = document.createElement('h1');
  heading.id = 'server-heading';
  heading.textContent = '聞くサーバー';
  headingText.append(eyebrow, heading);
  const badge = document.createElement('span');
  badge.id = 'connection-badge';
  badge.className = 'connection-badge';
  sectionHeading.append(headingText, badge);

  const serverLabel = document.createElement('label');
  serverLabel.className = 'server-select';
  const serverLabelText = document.createElement('span');
  serverLabelText.textContent = '接続先';
  const serverSelect = document.createElement('select');
  serverSelect.id = 'server-select';
  serverSelect.addEventListener('change', () => {
    const previousValue = state.selectedServerId;
    state.selectedServerId = serverSelect.value;
    persistSelectedServer();
    if (previousValue && state.selectedServerId !== previousValue && isPlaying()) {
      void startListening();
    } else {
      updateView();
    }
  });
  serverLabel.append(serverLabelText, serverSelect);
  serverSection.append(sectionHeading, serverLabel);

  const playerSection = document.createElement('section');
  playerSection.className = 'player-section';
  playerSection.setAttribute('aria-label', '音声プレイヤー');

  const visual = document.createElement('div');
  visual.id = 'voice-visual';
  visual.className = 'voice-visual';
  visual.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 5; index += 1) visual.append(document.createElement('span'));

  const nowPlaying = document.createElement('div');
  nowPlaying.className = 'now-playing';
  const nowState = document.createElement('p');
  nowState.id = 'now-state';
  const nowTitle = document.createElement('strong');
  nowTitle.id = 'now-title';
  nowPlaying.append(nowState, nowTitle);

  const transport = document.createElement('div');
  transport.className = 'transport';
  const playButton = document.createElement('button');
  playButton.id = 'play-button';
  playButton.className = 'play-button';
  playButton.type = 'button';
  playButton.append(icon('▶'), document.createTextNode(' '));
  playButton.addEventListener('click', startListening);
  const stopButton = document.createElement('button');
  stopButton.id = 'stop-button';
  stopButton.type = 'button';
  stopButton.append(icon('■'), document.createTextNode(' 停止'));
  stopButton.addEventListener('click', stopListening);
  transport.append(playButton, stopButton);
  playerSection.append(visual, nowPlaying, transport);

  const metrics = document.createElement('section');
  metrics.className = 'metrics';
  metrics.setAttribute('aria-label', 'VCの状態');
  [
    ['headphones', '◉', 'Listeners'],
    ['speakers', '●', 'Speakers'],
    ['members', '◆', 'Members'],
    ['muted', '◇', 'Muted'],
  ].forEach(([key, mark, label]) => {
    const item = document.createElement('div');
    item.append(icon(mark));
    const itemLabel = document.createElement('span');
    itemLabel.textContent = label;
    const value = document.createElement('strong');
    value.id = `metric-${key}`;
    item.append(itemLabel, value);
    metrics.append(item);
  });

  const controls = document.createElement('section');
  controls.className = 'controls';
  controls.setAttribute('aria-label', '再生設定');

  const volumeLabel = document.createElement('label');
  volumeLabel.className = 'volume-control';
  const volumeCaption = document.createElement('span');
  volumeCaption.append(icon('♪'), document.createTextNode('音量'));
  const volumeValue = document.createElement('strong');
  volumeValue.id = 'volume-value';
  const volumeInput = document.createElement('input');
  volumeInput.id = 'volume-input';
  volumeInput.type = 'range';
  volumeInput.min = '0';
  volumeInput.max = '100';
  volumeInput.addEventListener('input', () => {
    state.volume = Number(volumeInput.value);
    window.localStorage.setItem('kikiweb-extension-volume', String(state.volume));
    voiceNode?.port.postMessage({ type: 'volume', value: state.volume / 100 });
    soundboardNode?.port.postMessage({ type: 'volume', value: state.volume / 100 });
    updateView();
  });
  volumeLabel.append(volumeCaption, volumeValue, volumeInput);

  const toggleRow = document.createElement('label');
  toggleRow.className = 'toggle-row';
  const toggleCaption = document.createElement('span');
  toggleCaption.append(icon('♪'));
  const toggleText = document.createElement('span');
  const toggleTitle = document.createElement('strong');
  toggleTitle.textContent = 'サウンドボード';
  const toggleSub = document.createElement('small');
  toggleSub.textContent = 'Discordの効果音を再生';
  toggleText.append(toggleTitle, toggleSub);
  toggleCaption.append(toggleText);
  const soundboardInput = document.createElement('input');
  soundboardInput.id = 'soundboard-input';
  soundboardInput.type = 'checkbox';
  soundboardInput.role = 'switch';
  soundboardInput.addEventListener('change', () => {
    state.soundboardEnabled = soundboardInput.checked;
    window.localStorage.setItem(
      'kikiweb-extension-soundboard',
      state.soundboardEnabled ? 'on' : 'off',
    );
    if (!state.soundboardEnabled) soundboardNode?.port.postMessage({ type: 'reset' });
    updateView();
  });
  toggleRow.append(toggleCaption, soundboardInput);
  controls.append(volumeLabel, toggleRow);

  const audioStats = document.createElement('div');
  audioStats.className = 'audio-stats';
  audioStats.setAttribute('aria-live', 'polite');
  const bufferStat = document.createElement('span');
  bufferStat.id = 'buffer-stat';
  const underrunStat = document.createElement('span');
  underrunStat.id = 'underrun-stat';
  audioStats.append(bufferStat, underrunStat);

  const playerError = document.createElement('p');
  playerError.id = 'player-error';
  playerError.className = 'error';
  const statusError = document.createElement('p');
  statusError.id = 'status-error';
  statusError.className = 'error';

  const footer = document.createElement('footer');
  const invite = document.createElement('a');
  invite.className = 'invite-link';
  invite.href = INVITE_URL;
  invite.target = '_blank';
  invite.rel = 'noreferrer';
  invite.append(icon('＋'), document.createTextNode('Botを鯖に入れる！'), icon('↗'));
  const website = document.createElement('a');
  website.href = WEBSITE_URL;
  website.target = '_blank';
  website.rel = 'noreferrer';
  website.append(document.createTextNode('KikiWebを開く'), icon('↗'));
  footer.append(invite, website);

  main.append(
    header,
    serverSection,
    playerSection,
    metrics,
    controls,
    audioStats,
    playerError,
    statusError,
    footer,
  );
  app.replaceChildren(main);
};

const updateView = () => {
  applyTheme(state.theme);
  const server = selectedServer();
  const servers = availableServers();

  const themeButton = document.querySelector<HTMLButtonElement>('#theme-button');
  if (themeButton) {
    themeButton.title = themeButtonLabel();
    themeButton.setAttribute('aria-label', themeButtonLabel());
    themeButton.setAttribute('aria-pressed', String(state.theme === 'dark'));
    themeButton.replaceChildren(icon(state.theme === 'dark' ? '☀' : '☾'));
  }

  const refreshButton = document.querySelector<HTMLButtonElement>('#refresh-button');
  refreshButton?.querySelector('.plain-icon')?.classList.toggle('spinning', state.refreshing);

  const serverSelect = document.querySelector<HTMLSelectElement>('#server-select');
  if (serverSelect) {
    const active = document.activeElement === serverSelect;
    serverSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.disabled = true;
    placeholder.value = '';
    placeholder.textContent = servers.length === 0 ? 'Bot接続中のサーバーなし' : 'サーバーを選択';
    serverSelect.append(placeholder);
    servers.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `${item.name} / ${item.channelName}`;
      serverSelect.append(option);
    });
    serverSelect.value = state.selectedServerId;
    serverSelect.disabled = servers.length === 0;
    if (active) serverSelect.focus();
  }

  setText('#connection-badge', stateLabel());
  setClass('#connection-badge', 'live', isPlaying());
  setClass('#voice-visual', 'active', isPlaying());
  setText('#now-state', isPlaying() ? 'LIVE AUDIO' : 'READY');
  setText(
    '#now-title',
    server ? `${server.name} / ${server.channelName}` : 'BotがVCに接続すると表示されます',
  );

  const playButton = document.querySelector<HTMLButtonElement>('#play-button');
  if (playButton) {
    playButton.replaceChildren(icon('▶'), document.createTextNode(isPlaying() ? ' 再接続' : ' 聞く'));
  }
  setDisabled('#play-button', state.playerState === 'connecting' || !server);
  setDisabled('#stop-button', !isPlaying());

  setText('#metric-headphones', server?.listeners ?? 0);
  setText('#metric-speakers', server?.activeSpeakers ?? 0);
  setText('#metric-members', server?.memberCount ?? 0);
  setText('#metric-muted', server?.mutedCount ?? 0);
  setText('#volume-value', `${state.volume}%`);
  const volumeInput = document.querySelector<HTMLInputElement>('#volume-input');
  if (volumeInput) volumeInput.value = String(state.volume);
  const soundboardInput = document.querySelector<HTMLInputElement>('#soundboard-input');
  if (soundboardInput) soundboardInput.checked = state.soundboardEnabled;
  setText('#buffer-stat', `Buffer ${state.bufferMs}ms`);
  setText('#underrun-stat', `Underruns ${state.underruns}`);

  const playerError = document.querySelector<HTMLElement>('#player-error');
  if (playerError) {
    playerError.textContent = state.playerError;
    playerError.hidden = !state.playerError;
  }
  const statusError = document.querySelector<HTMLElement>('#status-error');
  if (statusError) {
    statusError.textContent = state.statusError;
    statusError.hidden = !state.statusError;
  }
};

const persistSelectedServer = () => {
  if (state.selectedServerId) {
    window.localStorage.setItem('kikiweb-extension-server-id', state.selectedServerId);
  } else {
    window.localStorage.removeItem('kikiweb-extension-server-id');
  }
};

async function fetchStatus() {
  state.refreshing = true;
  state.statusError = '';
  updateView();

  try {
    const response = await fetch(`${API_BASE_URL}/status`);
    if (!response.ok) throw new Error(`Server response: ${response.status}`);

    const nextStatus = (await response.json()) as ApiStatus;
    const servers = nextStatus.servers ?? [];
    state.status = { ...nextStatus, servers };

    if (!servers.some((server) => server.id === state.selectedServerId)) {
      state.selectedServerId =
        servers.find((server) => server.state === 'ready')?.id ?? servers[0]?.id ?? '';
      persistSelectedServer();
    }
  } catch {
    state.statusError = 'KikiWebサーバーに接続できません。しばらく待ってから更新してください。';
  } finally {
    state.refreshing = false;
    updateView();
  }
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  saveTheme(state.theme);
  updateView();
}

function stopListening() {
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
  state.bufferMs = 0;
  if (state.playerState !== 'idle') state.playerState = 'stopped';
  updateView();
}

async function startListening() {
  stopListening();
  state.playerState = 'connecting';
  state.playerError = '';
  state.underruns = 0;
  updateView();

  try {
    if (!state.selectedServerId) throw new Error('Botが接続しているサーバーがありません。');
    if (!('AudioWorkletNode' in window)) {
      throw new Error('このFirefoxではAudioWorkletを利用できません。');
    }

    audioContext = new AudioContext({ sampleRate: 48_000 });
    const workletUrl = new URL('/kikiweb-audio-worklet.js', window.location.href).toString();
    await audioContext.audioWorklet.addModule(workletUrl);

    voiceNode = new AudioWorkletNode(audioContext, 'kikiweb-pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sourceSampleRate: 48_000 },
    });
    soundboardNode = new AudioWorkletNode(audioContext, 'kikiweb-pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sourceSampleRate: 48_000 },
    });

    voiceNode.port.postMessage({ type: 'volume', value: state.volume / 100 });
    soundboardNode.port.postMessage({ type: 'volume', value: state.volume / 100 });
    voiceNode.port.onmessage = (event) => {
      if (event.data?.type !== 'stats') return;
      state.bufferMs = event.data.bufferMs;
      state.underruns = event.data.underruns;
      updateView();
    };
    voiceNode.connect(audioContext.destination);
    soundboardNode.connect(audioContext.destination);
    await audioContext.resume();

    const nextSocket = new WebSocket(websocketUrl());
    socket = nextSocket;
    nextSocket.binaryType = 'arraybuffer';
    nextSocket.onopen = () => {
      if (socket !== nextSocket) return;
      state.playerState = 'playing';
      updateView();
    };
    nextSocket.onmessage = (event) => {
      if (socket !== nextSocket || typeof event.data === 'string') return;

      const packet = event.data as ArrayBuffer;
      const firstByte = new Uint8Array(packet, 0, 1)[0];
      const extendedSoundboard = packet.byteLength === 3_849 && firstByte === 1;
      const tagged = packet.byteLength === 3_841 && (firstByte === 0 || firstByte === 1);
      const streamType = extendedSoundboard || tagged ? firstByte : 0;
      const pcm = extendedSoundboard ? packet.slice(9) : tagged ? packet.slice(1) : packet;
      if (streamType === 1 && !state.soundboardEnabled) return;

      const targetNode = streamType === 1 ? soundboardNode : voiceNode;
      targetNode?.port.postMessage({ type: 'pcm', buffer: pcm }, [pcm]);
    };
    nextSocket.onerror = () => {
      if (socket !== nextSocket) return;
      state.playerState = 'error';
      state.playerError = '音声サーバーに接続できませんでした。';
      updateView();
    };
    nextSocket.onclose = () => {
      if (
        socket === nextSocket &&
        (state.playerState === 'playing' || state.playerState === 'connecting')
      ) {
        state.playerState = 'stopped';
        updateView();
      }
    };
  } catch (error) {
    state.playerState = 'error';
    state.playerError = error instanceof Error ? error.message : String(error);
    updateView();
  }
}

applyTheme(state.theme);
renderShell();
updateView();
void fetchStatus();
window.setInterval(fetchStatus, 5_000);
