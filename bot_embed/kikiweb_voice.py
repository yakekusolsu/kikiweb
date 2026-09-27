from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import queue
import re
import secrets
import sys
import threading
import time
import unicodedata
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import aiohttp
import davey
import discord
from discord.ext import voice_recv
from discord.ext.voice_recv.reader import AudioReader

try:
    import imageio_ffmpeg
except ImportError:
    imageio_ffmpeg = None

try:
    import edge_tts
except ImportError:
    edge_tts = None

try:
    from langdetect import DetectorFactory, detect_langs
    from langdetect.lang_detect_exception import LangDetectException

    DetectorFactory.seed = 0
except ImportError:
    detect_langs = None
    LangDetectException = ValueError

LOGGER = logging.getLogger(__name__)


class _UnexpectedRtcpInfoFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not (
            record.levelno == logging.INFO
            and record.getMessage().startswith("Received unexpected rtcp packet:")
        )


logging.getLogger("discord.ext.voice_recv.reader").addFilter(_UnexpectedRtcpInfoFilter())

SAMPLE_RATE = 48_000
CHANNELS = 2
FRAME_MS = 20
BYTES_PER_SAMPLE = 2
FRAME_BYTES = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * FRAME_MS // 1000
PCM_SILENCE = b"\x00" * FRAME_BYTES
OPUS_SILENCE = b"\xf8\xff\xfe"
STREAM_VOICE = 0
STREAM_SOUNDBOARD = 1
MAX_SOUNDBOARD_BYTES = 10 * 1024 * 1024
MAX_CHAT_TTS_BYTES = 5 * 1024 * 1024
MAX_CHAT_TTS_LENGTH = 500
MAX_CHAT_TTS_DURATION_SECONDS = 180
CHAT_TTS_OMISSION_TEXT = "以下略"
COLLAB_INVITE_TTL_SECONDS = 10 * 60
CHAT_TIMEOUT_DURATIONS = {
    60: "1分",
    5 * 60: "5分",
    30 * 60: "30分",
    60 * 60: "1時間",
    24 * 60 * 60: "1日",
    3 * 24 * 60 * 60: "3日",
}
JAPANESE_KANA_PATTERN = re.compile(r"[\u3040-\u30ff\uff66-\uff9f]")
HANGUL_TEXT_PATTERN = re.compile(r"[\uac00-\ud7af]")
HAN_TEXT_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
ARABIC_TEXT_PATTERN = re.compile(r"[\u0600-\u06ff]")
CYRILLIC_TEXT_PATTERN = re.compile(r"[\u0400-\u04ff]")
DEVANAGARI_TEXT_PATTERN = re.compile(r"[\u0900-\u097f]")
GREEK_TEXT_PATTERN = re.compile(r"[\u0370-\u03ff]")
HEBREW_TEXT_PATTERN = re.compile(r"[\u0590-\u05ff]")
THAI_TEXT_PATTERN = re.compile(r"[\u0e00-\u0e7f]")
LATIN_TEXT_PATTERN = re.compile(r"[A-Za-z]")
ENGLISH_HINT_PATTERN = re.compile(
    r"\b(?:hello|thanks|thank\s+you|please|good\s+(?:morning|afternoon|evening))\b",
    re.IGNORECASE,
)
FALLBACK_SCRIPT_LANGUAGES = (
    (HANGUL_TEXT_PATTERN, "ko"),
    (HAN_TEXT_PATTERN, "zh-cn"),
    (ARABIC_TEXT_PATTERN, "ar"),
    (CYRILLIC_TEXT_PATTERN, "ru"),
    (DEVANAGARI_TEXT_PATTERN, "hi"),
    (GREEK_TEXT_PATTERN, "el"),
    (HEBREW_TEXT_PATTERN, "he"),
    (THAI_TEXT_PATTERN, "th"),
    (LATIN_TEXT_PATTERN, "en"),
)
EDGE_TTS_LOCALE_PREFERENCES = {
    "af": "af-ZA",
    "ar": "ar-EG",
    "bg": "bg-BG",
    "bn": "bn-BD",
    "ca": "ca-ES",
    "cs": "cs-CZ",
    "cy": "cy-GB",
    "da": "da-DK",
    "de": "de-DE",
    "el": "el-GR",
    "es": "es-ES",
    "et": "et-EE",
    "fa": "fa-IR",
    "fi": "fi-FI",
    "fr": "fr-FR",
    "gu": "gu-IN",
    "he": "he-IL",
    "hi": "hi-IN",
    "hr": "hr-HR",
    "hu": "hu-HU",
    "id": "id-ID",
    "it": "it-IT",
    "kn": "kn-IN",
    "ko": "ko-KR",
    "lt": "lt-LT",
    "lv": "lv-LV",
    "mk": "mk-MK",
    "ml": "ml-IN",
    "mr": "mr-IN",
    "ne": "ne-NP",
    "nl": "nl-NL",
    "no": "nb-NO",
    "pa": "hi-IN",
    "pl": "pl-PL",
    "pt": "pt-BR",
    "ro": "ro-RO",
    "ru": "ru-RU",
    "sk": "sk-SK",
    "sl": "sl-SI",
    "so": "so-SO",
    "sq": "sq-AL",
    "sv": "sv-SE",
    "sw": "sw-KE",
    "ta": "ta-IN",
    "te": "te-IN",
    "th": "th-TH",
    "tl": "fil-PH",
    "tr": "tr-TR",
    "uk": "uk-UA",
    "ur": "ur-PK",
    "vi": "vi-VN",
    "zh-cn": "zh-CN",
    "zh-tw": "zh-TW",
}
EDGE_TTS_NATURAL_VOICE_PREFERENCES = {
    "ar": "ar-EG-SalmaNeural",
    "de": "de-DE-SeraphinaMultilingualNeural",
    "es": "es-ES-XimenaNeural",
    "fr": "fr-FR-VivienneMultilingualNeural",
    "hi": "hi-IN-SwaraNeural",
    "it": "it-IT-GiuseppeMultilingualNeural",
    "ko": "ko-KR-HyunsuMultilingualNeural",
    "pt": "pt-BR-ThalitaMultilingualNeural",
    "ru": "ru-RU-SvetlanaNeural",
    "zh-cn": "zh-CN-XiaoxiaoNeural",
    "zh-tw": "zh-TW-HsiaoChenNeural",
}
CHAT_URL_PATTERN = re.compile(
    r"(?:\b(?:https?|ftp)://|\bwww\.|(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+"
    r"(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?:[/:?#]\S*)?|"
    r"(?:\d{1,3}\.){3}\d{1,3}(?:[/:?#]\S*)?)",
    re.IGNORECASE,
)


def contains_chat_url(value: str) -> bool:
    return CHAT_URL_PATTERN.search(unicodedata.normalize("NFKC", value)) is not None


def chat_tts_language(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    if JAPANESE_KANA_PATTERN.search(normalized):
        return "ja"
    if ENGLISH_HINT_PATTERN.search(normalized):
        return "en"

    if detect_langs is not None:
        try:
            candidates = detect_langs(normalized)
            if candidates and candidates[0].prob >= 0.45:
                language = candidates[0].lang.lower()
                if HAN_TEXT_PATTERN.search(normalized) and language not in {
                    "ja",
                    "zh-cn",
                    "zh-tw",
                }:
                    return "ja"
                return language
        except LangDetectException:
            pass

    for pattern, language in FALLBACK_SCRIPT_LANGUAGES:
        if pattern.search(normalized):
            return language
    return "ja"


def truncate_chat_tts_text(value: str) -> str:
    if len(value) <= MAX_CHAT_TTS_LENGTH:
        return value
    return f"{value[:MAX_CHAT_TTS_LENGTH]}、{CHAT_TTS_OMISSION_TEXT}"


@dataclass(slots=True)
class KikiWebConfig:
    relay_url: str
    ingest_token: str = ""
    voice_status: str = "試聴完全自由！"
    reconnect_delay: float = 3.0
    listen_restart_delay: float = 1.0
    listen_watchdog_interval: float = 5.0
    listen_inactivity_timeout: float = 90.0
    relay_connection_max_age: float = 5.5 * 60 * 60
    status_interval: float = 1.0
    queue_size: int = 160
    chat_tts_enabled: bool = True
    chat_tts_voice: str = "ja-JP-NanamiNeural"
    chat_tts_english_voice: str = "en-US-AvaMultilingualNeural"

    def websocket_url(
        self,
        *,
        server_id: int,
        server_name: str,
        channel_id: int,
        channel_name: str,
    ) -> str:
        parts = urlsplit(self.relay_url)
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        query.update(
            {
                "serverId": str(server_id),
                "serverName": server_name,
                "channelId": str(channel_id),
                "channelName": channel_name,
                "voiceStatus": self.voice_status,
            }
        )
        if self.ingest_token:
            query["token"] = self.ingest_token
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


@dataclass(slots=True)
class KikiWebCollabInvite:
    code: str
    guild_id: int
    channel_id: int
    expires_at: float


class KikiWebDAVEAudioReader(AudioReader):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.relay = getattr(args[0], "relay", None) if args else None
        self._transport_decrypt_rtp = self.decryptor.decrypt_rtp
        self._last_packet_error_log_at = 0.0
        self.decryptor.decrypt_rtp = self._decrypt_rtp

    def _decrypt_rtp(self, packet) -> bytes:
        try:
            payload = self._transport_decrypt_rtp(packet)
        except Exception as error:
            self._log_packet_error("KikiWeb skipped a malformed Discord voice packet: %s", error)
            return OPUS_SILENCE

        if packet.padding:
            if not payload:
                return OPUS_SILENCE
            padding_size = payload[-1]
            if padding_size == 0 or padding_size > len(payload):
                self._log_packet_error("KikiWeb dropped an RTP packet with invalid padding.")
                return OPUS_SILENCE
            payload = payload[:-padding_size]

        connection = self.voice_client._connection
        if getattr(connection, "dave_protocol_version", 0) == 0:
            return payload

        dave_session = getattr(connection, "dave_session", None)
        user_id = self.voice_client._get_id_from_ssrc(packet.ssrc)
        if dave_session is None or not dave_session.ready or user_id is None:
            return OPUS_SILENCE

        try:
            return dave_session.decrypt(user_id, davey.MediaType.audio, payload)
        except Exception as error:
            if self.relay is not None:
                self.relay.note_dave_decrypt_failure(user_id)
            self._log_packet_error("KikiWeb dropped a DAVE packet that could not be decrypted: %s", error)
            return OPUS_SILENCE

    def _log_packet_error(self, message: str, *args) -> None:
        now = time.monotonic()
        if now - self._last_packet_error_log_at < 5:
            return
        self._last_packet_error_log_at = now
        LOGGER.warning(message, *args)


class KikiWebVoiceRecvClient(voice_recv.VoiceRecvClient):
    def listen(self, sink: voice_recv.AudioSink, *, after=None) -> None:
        if not self.is_connected():
            raise discord.ClientException("Not connected to voice.")
        if not isinstance(sink, voice_recv.AudioSink):
            raise TypeError(f"sink must be an AudioSink, not {sink.__class__.__name__}")
        if self.is_listening():
            raise discord.ClientException("Already receiving audio.")

        self._reader = KikiWebDAVEAudioReader(sink, self, after=after)
        self._reader.start()


class KikiWebWebAudioSource(discord.AudioSource):
    """Mixes short PCM buffers from browser, TTS, and collaboration audio."""

    def __init__(self) -> None:
        self.frame_queues: dict[str, queue.Queue[bytes]] = {}
        self.last_feed_at: dict[str, float] = {}
        self.lock = threading.Lock()

    def is_opus(self) -> bool:
        return False

    def read(self) -> bytes:
        with self.lock:
            frame_queues = list(self.frame_queues.items())
        frames = []
        for _, frame_queue in frame_queues:
            with contextlib.suppress(queue.Empty):
                frames.append(frame_queue.get_nowait())
        stale_before = time.monotonic() - 5
        with self.lock:
            for source, frame_queue in frame_queues:
                if (
                    source.startswith("collab:")
                    and frame_queue.empty()
                    and self.last_feed_at.get(source, 0) < stale_before
                    and self.frame_queues.get(source) is frame_queue
                ):
                    self.frame_queues.pop(source, None)
                    self.last_feed_at.pop(source, None)
        if not frames:
            return PCM_SILENCE
        if len(frames) == 1:
            return frames[0]

        mixed = [0] * (FRAME_BYTES // BYTES_PER_SAMPLE)
        for frame in frames:
            samples = array("h")
            samples.frombytes(frame)
            if sys.byteorder != "little":
                samples.byteswap()
            for index, sample in enumerate(samples):
                mixed[index] += sample

        output = array("h", (max(-32768, min(32767, sample)) for sample in mixed))
        if sys.byteorder != "little":
            output.byteswap()
        return output.tobytes()

    def feed(self, pcm: bytes, *, source: str = "browser") -> None:
        with self.lock:
            frame_queue = self.frame_queues.get(source)
            if frame_queue is None:
                frame_queue = queue.Queue(maxsize=50)
                self.frame_queues[source] = frame_queue
            self.last_feed_at[source] = time.monotonic()
        for offset in range(0, len(pcm), FRAME_BYTES):
            frame = pcm[offset : offset + FRAME_BYTES]
            if len(frame) != FRAME_BYTES:
                continue
            if frame_queue.full():
                with contextlib.suppress(queue.Empty):
                    frame_queue.get_nowait()
            frame_queue.put_nowait(frame)

    def clear(self, source: Optional[str] = None, *, prefix: Optional[str] = None) -> None:
        with self.lock:
            if source is not None:
                self.frame_queues.pop(source, None)
                self.last_feed_at.pop(source, None)
                return
            if prefix is not None:
                for key in [key for key in self.frame_queues if key.startswith(prefix)]:
                    self.frame_queues.pop(key, None)
                    self.last_feed_at.pop(key, None)
                return
            self.frame_queues.clear()
            self.last_feed_at.clear()


class KikiWebAudioSink(voice_recv.AudioSink):
    def __init__(self, relay: "KikiWebVoiceRelay") -> None:
        super().__init__()
        self.relay = relay
        self.pcm_remainders: dict[int, bytes] = {}

    def wants_opus(self) -> bool:
        return False

    def write(self, user: Optional[discord.abc.User], data: voice_recv.VoiceData) -> None:
        bot_user = getattr(getattr(self.relay.voice_client, "client", None), "user", None)
        packet = getattr(data, "packet", None)
        source_user_id = user.id if user is not None else None
        if source_user_id is None and packet is not None and self.relay.voice_client is not None:
            source_user_id = self.relay.voice_client._get_id_from_ssrc(packet.ssrc)
        if bot_user is not None and source_user_id == bot_user.id:
            return

        raw_source_id = source_user_id if source_user_id is not None else getattr(packet, "ssrc", 0)
        source_id = int(raw_source_id or 0)
        pcm = getattr(data, "pcm", None)
        if not pcm:
            return
        self.relay.note_voice_packet()

        buffered_pcm = self.pcm_remainders.get(source_id, b"") + bytes(pcm)
        complete_bytes = len(buffered_pcm) - (len(buffered_pcm) % FRAME_BYTES)
        if complete_bytes == 0:
            self.pcm_remainders[source_id] = buffered_pcm
            return

        complete_pcm = buffered_pcm[:complete_bytes]
        self.relay.enqueue_pcm(complete_pcm, source_id=source_id)
        self.relay.forward_collab_pcm(complete_pcm, source_id=source_id)
        remainder = buffered_pcm[complete_bytes:]
        if remainder:
            self.pcm_remainders[source_id] = remainder
        else:
            self.pcm_remainders.pop(source_id, None)

    def cleanup(self) -> None:
        self.pcm_remainders.clear()
        self.relay.clear_audio_queue()


class KikiWebVoiceRelay:
    def __init__(
        self,
        config: KikiWebConfig,
        collab_forwarder: Optional[Callable[[int, int, bytes], None]] = None,
    ) -> None:
        self.config = config
        self.collab_forwarder = collab_forwarder
        self.voice_client: Optional[KikiWebVoiceRecvClient] = None
        self.sink: Optional[KikiWebAudioSink] = None
        self.session: Optional[aiohttp.ClientSession] = None
        self.socket: Optional[aiohttp.ClientWebSocketResponse] = None
        self.queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=config.queue_size)
        self.chat_queue: asyncio.Queue[dict[str, object]] = asyncio.Queue(maxsize=100)
        self.chat_tts_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=20)
        self.chat_users: dict[str, str] = {}
        self.chat_timeout_requests: dict[
            str,
            asyncio.Future[dict[str, object]],
        ] = {}
        self.sender_task: Optional[asyncio.Task[None]] = None
        self.incoming_task: Optional[asyncio.Task[None]] = None
        self.chat_history_task: Optional[asyncio.Task[None]] = None
        self.chat_tts_task: Optional[asyncio.Task[None]] = None
        self.listen_restart_task: Optional[asyncio.Task[None]] = None
        self.listen_watchdog_task: Optional[asyncio.Task[None]] = None
        self.dave_reconnect_task: Optional[asyncio.Task[None]] = None
        self.listen_restart_lock = asyncio.Lock()
        self.voice_connect_lock = asyncio.Lock()
        self.dave_failures: dict[int, tuple[int, float, float]] = {}
        self.dave_reconnect_cooldown_until = 0.0
        self.ignore_next_after = False
        self.last_voice_packet_at = time.monotonic()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.closed = asyncio.Event()
        self.server_id = 0
        self.server_name = ""
        self.channel_id = 0
        self.channel_name = ""
        self.chat_channel_id = 0
        self.web_audio_source = KikiWebWebAudioSource()
        self.browser_audio_active = False
        self.chat_tts_playing = False
        self.collab_partner_guild_id: Optional[int] = None
        self.chat_tts_voice_cache: dict[str, str] = {
            "ja": config.chat_tts_voice,
            "en": config.chat_tts_english_voice,
        }
        self.chat_tts_voices: Optional[list[dict[str, object]]] = None

    async def connect(self, channel: discord.VoiceChannel | discord.StageChannel) -> None:
        async with self.voice_connect_lock:
            await self._connect_unlocked(channel)

    async def _connect_unlocked(
        self,
        channel: discord.VoiceChannel | discord.StageChannel,
    ) -> None:
        self.loop = asyncio.get_running_loop()
        self.closed.clear()
        metadata_changed = self.server_id != channel.guild.id or self.channel_id != channel.id
        self.server_id = channel.guild.id
        self.server_name = channel.guild.name
        self.channel_id = channel.id
        self.channel_name = channel.name
        if metadata_changed:
            self.chat_channel_id = channel.id
            self.clear_chat_queue()

        if not self.session or self.session.closed:
            self.session = aiohttp.ClientSession()

        if metadata_changed and self.socket and not self.socket.closed:
            await self.socket.close(code=1012, message=b"Voice stream changed")

        self._ensure_sender_task()

        voice_client = channel.guild.voice_client
        if voice_client and (
            not isinstance(voice_client, KikiWebVoiceRecvClient)
            or not voice_client.is_connected()
        ):
            await voice_client.disconnect(force=True)
            await asyncio.sleep(0.25)
            voice_client = None

        if voice_client:
            if getattr(voice_client.channel, "id", None) != channel.id:
                await voice_client.move_to(channel)
        else:
            voice_client = await channel.connect(cls=KikiWebVoiceRecvClient, self_deaf=False, self_mute=False)

        for _ in range(20):
            if voice_client.is_connected():
                break
            await asyncio.sleep(0.1)

        if not voice_client.is_connected():
            await voice_client.disconnect(force=True)
            await asyncio.sleep(0.25)
            voice_client = await channel.connect(
                cls=KikiWebVoiceRecvClient,
                self_deaf=False,
                self_mute=False,
            )

        if not voice_client.is_connected():
            raise RuntimeError("KikiWeb could not establish the Discord voice connection.")

        self.voice_client = voice_client
        await self._start_listening()
        if not self.listen_watchdog_task or self.listen_watchdog_task.done():
            self.listen_watchdog_task = asyncio.create_task(
                self._listen_watchdog(),
                name=f"kikiweb-listen-watchdog-{channel.guild.id}",
            )

    async def disconnect(self) -> None:
        self.closed.set()
        self.collab_partner_guild_id = None
        self.web_audio_source.clear()

        if self.dave_reconnect_task and self.dave_reconnect_task is not asyncio.current_task():
            self.dave_reconnect_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.dave_reconnect_task

        if self.voice_client and self.voice_client.is_listening():
            self.voice_client.stop_listening()

        if self.voice_client and self.voice_client.is_connected():
            await self.voice_client.disconnect(force=True)

        if self.sender_task:
            self.sender_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.sender_task

        if self.incoming_task:
            self.incoming_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.incoming_task

        if self.chat_history_task:
            self.chat_history_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.chat_history_task

        if self.chat_tts_task:
            self.chat_tts_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.chat_tts_task

        if self.listen_restart_task:
            self.listen_restart_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.listen_restart_task

        if self.listen_watchdog_task:
            self.listen_watchdog_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.listen_watchdog_task

        if self.socket and not self.socket.closed:
            await self.socket.close()

        if self.session:
            await self.session.close()

        self.voice_client = None
        self.sink = None
        self.socket = None
        self.session = None
        self.sender_task = None
        self.listen_restart_task = None
        self.listen_watchdog_task = None
        self.incoming_task = None
        self.chat_history_task = None
        self.chat_tts_task = None
        self.dave_reconnect_task = None
        self.dave_failures.clear()
        self.stop_web_audio()
        self.clear_audio_queue()
        self.clear_chat_queue()
        self.clear_chat_tts_queue()

    def note_voice_packet(self) -> None:
        self.last_voice_packet_at = time.monotonic()

    def note_dave_decrypt_failure(self, user_id: int) -> None:
        if not self.loop or self.closed.is_set():
            return
        self.loop.call_soon_threadsafe(self._record_dave_decrypt_failure, int(user_id))

    def _record_dave_decrypt_failure(self, user_id: int) -> None:
        if self.closed.is_set():
            return

        now = time.monotonic()
        count, first_at, last_at = self.dave_failures.get(user_id, (0, now, now))
        if now - last_at > 1.0:
            count, first_at = 0, now
        count += 1
        self.dave_failures[user_id] = (count, first_at, now)

        sustained = count >= 20 and now - first_at >= 2.0
        reconnect_running = self.dave_reconnect_task and not self.dave_reconnect_task.done()
        if not sustained or reconnect_running or now < self.dave_reconnect_cooldown_until:
            return

        self.dave_reconnect_cooldown_until = now + 60.0
        self.dave_failures.clear()
        self.dave_reconnect_task = asyncio.create_task(
            self._recover_dave_session(user_id),
            name=f"kikiweb-dave-reconnect-{self.server_id}",
        )

    async def _recover_dave_session(self, user_id: int) -> None:
        voice_client = self.voice_client
        channel = getattr(voice_client, "channel", None)
        if self.closed.is_set() or voice_client is None or channel is None:
            return

        LOGGER.warning(
            "KikiWeb detected sustained DAVE decrypt failures for user %s; reconnecting voice to resync keys.",
            user_id,
        )
        try:
            async with self.voice_connect_lock:
                if self.closed.is_set():
                    return
                if (
                    self.voice_client is not voice_client
                    or getattr(voice_client.channel, "id", None) != getattr(channel, "id", None)
                ):
                    return
                if self.listen_restart_task and not self.listen_restart_task.done():
                    self.listen_restart_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await self.listen_restart_task
                if voice_client.is_listening():
                    self.ignore_next_after = True
                    voice_client.stop_listening()
                if voice_client.is_connected():
                    await voice_client.disconnect(force=True)
                self.voice_client = None
                await asyncio.sleep(0.5)
                if self.closed.is_set():
                    return
                await self._connect_unlocked(channel)
            LOGGER.info("KikiWeb DAVE session resynchronized.")
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception("KikiWeb could not resynchronize the DAVE session")
        finally:
            self.dave_failures.clear()

    def _ensure_sender_task(self) -> None:
        if self.closed.is_set() or not self.loop:
            return
        if self.sender_task and not self.sender_task.done():
            return

        if self.sender_task and not self.sender_task.cancelled():
            with contextlib.suppress(asyncio.CancelledError):
                error = self.sender_task.exception()
                if error is not None:
                    LOGGER.error(
                        "KikiWeb relay sender stopped unexpectedly; restarting it.",
                        exc_info=(type(error), error, error.__traceback__),
                    )

        self.sender_task = asyncio.create_task(
            self._sender_loop(),
            name=f"kikiweb-audio-sender-{self.server_id}",
        )

    def enqueue_pcm(
        self,
        pcm: bytes,
        *,
        stream_type: int = STREAM_VOICE,
        source_id: int = 0,
    ) -> None:
        if not self.loop or self.closed.is_set():
            return

        self.loop.call_soon_threadsafe(self._enqueue_pcm_in_loop, pcm, stream_type, source_id)

    def forward_collab_pcm(self, pcm: bytes, *, source_id: int) -> None:
        if self.collab_partner_guild_id is None or self.collab_forwarder is None:
            return
        self.collab_forwarder(self.server_id, source_id, pcm)

    def play_collab_pcm(self, origin_guild_id: int, source_id: int, pcm: bytes) -> None:
        if (
            self.closed.is_set()
            or self.collab_partner_guild_id != origin_guild_id
            or not self.voice_client
            or not self.voice_client.is_connected()
        ):
            return
        self.web_audio_source.feed(
            pcm,
            source=f"collab:{origin_guild_id}:{source_id}",
        )
        if not self.voice_client.is_playing() and self.loop:
            self.loop.call_soon_threadsafe(self._ensure_web_audio_playing)

    def set_collab_partner(self, partner_guild_id: Optional[int]) -> None:
        self.collab_partner_guild_id = partner_guild_id
        self.web_audio_source.clear(prefix="collab:")
        if partner_guild_id is not None:
            self._ensure_web_audio_playing()
        elif not self.browser_audio_active and not self.chat_tts_playing:
            if self.voice_client and self.voice_client.is_playing():
                self.voice_client.stop()

    def clear_audio_queue(self) -> None:
        while True:
            try:
                self.queue.get_nowait()
                self.queue.task_done()
            except asyncio.QueueEmpty:
                break

    def clear_chat_queue(self) -> None:
        while True:
            try:
                self.chat_queue.get_nowait()
                self.chat_queue.task_done()
            except asyncio.QueueEmpty:
                break

    def clear_chat_tts_queue(self) -> None:
        while True:
            try:
                self.chat_tts_queue.get_nowait()
                self.chat_tts_queue.task_done()
            except asyncio.QueueEmpty:
                break

    def enqueue_chat_payload(self, payload: dict[str, object]) -> None:
        if self.closed.is_set():
            return
        if self.chat_queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.chat_queue.get_nowait()
                self.chat_queue.task_done()
        self.chat_queue.put_nowait(payload)

    def enqueue_chat_message(self, message: discord.Message) -> None:
        if self.closed.is_set() or message.guild is None or message.guild.id != self.server_id:
            return
        if message.channel.id != self.chat_channel_id:
            return

        attachment_urls: list[str] = []
        for attachment in message.attachments[:5]:
            url = str(getattr(attachment, "url", "")).strip()
            candidate = "\n".join((*attachment_urls, url))
            if url and len(candidate) <= 2_000:
                attachment_urls.append(url)

        attachment_block = "\n".join(attachment_urls)
        message_content = message.content.strip()
        message_limit = 2_000 - len(attachment_block) - (1 if message_content and attachment_block else 0)
        content = "\n".join(
            part for part in (message_content[:max(0, message_limit)], attachment_block) if part
        )
        if not content:
            return

        author = message.author
        payload: dict[str, object] = {
            "type": "chat-message",
            "id": str(message.id),
            "channelId": str(message.channel.id),
            "channelName": getattr(message.channel, "name", "Discord chat"),
            "authorId": str(author.id),
            "authorName": (
                getattr(author, "global_name", None)
                or getattr(author, "display_name", None)
                or author.name
            ),
            "bot": bool(author.bot),
            "webhook": message.webhook_id is not None,
            "content": content[:2_000],
            "timestamp": message.created_at.isoformat(),
        }
        self.enqueue_chat_payload(payload)

    async def post_chat_message(self, payload: dict[str, object]) -> None:
        request_id = str(payload.get("requestId", ""))[:100]
        result: dict[str, object] = {
            "type": "chat-post-result",
            "requestId": request_id,
            "ok": False,
        }
        try:
            channel_id = int(payload.get("channelId", 0))
            content = str(payload.get("content", "")).strip()
            author_id = str(payload.get("authorId", ""))
            author_name = " ".join(str(payload.get("authorName", "")).split())[:32]
            tts_content = str(payload.get("ttsContent", content)).strip()
            if len(request_id) < 8 or channel_id != self.chat_channel_id:
                raise ValueError("The Discord chat request did not match the connected VC.")
            if not content or len(content) > 1_000:
                raise ValueError("The Discord chat message must be between 1 and 1000 characters.")
            if contains_chat_url(content):
                raise ValueError("URLを含むメッセージは送信できません。")
            if not self.voice_client or not self.voice_client.is_connected():
                raise RuntimeError("The Discord Bot is not connected to the VC.")
            if re.fullmatch(r"\d{1,20}", author_id) and author_name:
                self.chat_users[author_id] = author_name
                while len(self.chat_users) > 100:
                    self.chat_users.pop(next(iter(self.chat_users)))

            client = self.voice_client.client
            channel = client.get_channel(channel_id)
            if channel is None:
                channel = await client.fetch_channel(channel_id)
            if not isinstance(channel, discord.abc.Messageable):
                raise RuntimeError("The connected VC does not support text messages.")

            discord_content = f"{author_name} >> {content}" if author_name else content
            message = await channel.send(
                discord_content,
                allowed_mentions=discord.AllowedMentions.none(),
            )
            self.enqueue_chat_message(message)
            self.enqueue_chat_tts(tts_content, author_name)
            result["ok"] = True
        except discord.Forbidden:
            result["error"] = (
                "Discord Bot cannot send messages in this VC. "
                "Give it View Channel and Send Messages permissions."
            )
        except discord.NotFound:
            result["error"] = "The connected Discord VC could not be found."
        except discord.HTTPException:
            LOGGER.exception("KikiWeb Bot could not send a VC chat message")
            result["error"] = "Discord rejected the Bot message. Please try again."
        except (TypeError, ValueError, RuntimeError) as error:
            result["error"] = str(error)
        except Exception:
            LOGGER.exception("KikiWeb Bot chat posting failed")
            result["error"] = "Discord Bot could not send the message."
        self.enqueue_chat_payload(result)

    def resolve_chat_user(self, value: str) -> Optional[tuple[str, str]]:
        normalized = " ".join(value.split())[:100]
        if re.fullmatch(r"\d{1,20}", normalized):
            return normalized, self.chat_users.get(normalized, normalized)

        matches = [
            (user_id, name)
            for user_id, name in self.chat_users.items()
            if name.casefold() == normalized.casefold()
        ]
        return matches[0] if len(matches) == 1 else None

    async def timeout_chat_user(self, user_id: str, duration_seconds: int = 60) -> None:
        if (
            not re.fullmatch(r"\d{1,20}", user_id)
            or duration_seconds not in CHAT_TIMEOUT_DURATIONS
        ):
            raise ValueError("The KikiWeb chat timeout request is invalid.")
        if not self.socket or self.socket.closed:
            raise RuntimeError("KikiWeb relay is not connected.")

        request_id = secrets.token_urlsafe(18)
        future = asyncio.get_running_loop().create_future()
        self.chat_timeout_requests[request_id] = future
        try:
            await self.socket.send_json(
                {
                    "type": "chat-timeout",
                    "requestId": request_id,
                    "userId": user_id,
                    "durationSeconds": duration_seconds,
                }
            )
            result = await asyncio.wait_for(future, timeout=10)
            if result.get("ok") is not True:
                raise RuntimeError(
                    str(result.get("error", "KikiWeb chat timeout failed."))
                )
        finally:
            self.chat_timeout_requests.pop(request_id, None)

    def resolve_chat_timeout_request(self, payload: dict[str, object]) -> None:
        request_id = str(payload.get("requestId", ""))
        future = self.chat_timeout_requests.get(request_id)
        if future is not None and not future.done():
            future.set_result(payload)

    def reject_chat_timeout_requests(self, reason: str) -> None:
        for future in self.chat_timeout_requests.values():
            if not future.done():
                future.set_exception(ConnectionError(reason))
        self.chat_timeout_requests.clear()

    def _schedule_chat_history(self) -> None:
        if self.chat_history_task and not self.chat_history_task.done():
            self.chat_history_task.cancel()
        self.chat_history_task = asyncio.create_task(
            self._load_chat_history(),
            name=f"kikiweb-chat-history-{self.server_id}",
        )

    async def _load_chat_history(self) -> None:
        if not self.voice_client or not self.chat_channel_id:
            return
        client = self.voice_client.client
        channel = client.get_channel(self.chat_channel_id)
        if channel is None:
            with contextlib.suppress(discord.HTTPException):
                channel = await client.fetch_channel(self.chat_channel_id)
        history = getattr(channel, "history", None)
        if not callable(history):
            return

        try:
            recent_messages = [message async for message in history(limit=25)]
            for message in reversed(recent_messages):
                self.enqueue_chat_message(message)
        except discord.Forbidden:
            LOGGER.warning(
                "KikiWeb cannot read Discord chat. Give the Bot View Channel and Read Message History permissions."
            )
        except discord.HTTPException as error:
            LOGGER.warning("KikiWeb could not load Discord chat history: %s", error)

    def play_web_audio(self, pcm: bytes) -> None:
        if (
            self.closed.is_set()
            or len(pcm) == 0
            or len(pcm) % FRAME_BYTES != 0
            or not self.voice_client
            or not self.voice_client.is_connected()
        ):
            return

        self.browser_audio_active = True
        self.web_audio_source.feed(pcm, source="browser")
        self._ensure_web_audio_playing()

    def _ensure_web_audio_playing(self) -> bool:
        if not self.voice_client or not self.voice_client.is_connected():
            return False
        if self.voice_client.is_playing():
            return True
        try:
            self.voice_client.play(self.web_audio_source)
            return True
        except discord.ClientException:
            LOGGER.warning("KikiWeb could not start audio playback in Discord.")
            return False

    def stop_web_audio(self) -> None:
        self.browser_audio_active = False
        self.web_audio_source.clear("browser")
        if (
            not self.chat_tts_playing
            and self.collab_partner_guild_id is None
            and self.voice_client
            and self.voice_client.is_playing()
        ):
            self.voice_client.stop()

    def enqueue_chat_tts(self, content: object, author_name: object = "") -> None:
        if not self.config.chat_tts_enabled or self.closed.is_set():
            return
        text = " ".join(str(content or "").split())
        normalized_author = " ".join(str(author_name or "").split())[:32]
        author_prefix = f"{normalized_author} >>" if normalized_author else ""
        if author_prefix and text.startswith(author_prefix):
            text = text[len(author_prefix) :].lstrip()
        text = truncate_chat_tts_text(text)
        if not text:
            return
        if self.chat_tts_queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.chat_tts_queue.get_nowait()
                self.chat_tts_queue.task_done()
        self.chat_tts_queue.put_nowait(text)
        if not self.chat_tts_task or self.chat_tts_task.done():
            self.chat_tts_task = asyncio.create_task(
                self._chat_tts_loop(),
                name=f"kikiweb-chat-tts-{self.server_id}",
            )

    async def _chat_tts_loop(self) -> None:
        while not self.closed.is_set():
            text = await self.chat_tts_queue.get()
            try:
                await self._play_chat_tts(text)
            except asyncio.CancelledError:
                raise
            except Exception:
                LOGGER.exception("KikiWeb could not read a Web chat message in Discord.")
            finally:
                self.chat_tts_queue.task_done()

    async def _play_chat_tts(self, text: str) -> None:
        if edge_tts is None:
            LOGGER.error("KikiWeb chat TTS requires edge-tts on the Discord Bot host.")
            return
        if not self.voice_client or not self.voice_client.is_connected():
            return

        language = chat_tts_language(text)
        voice = await self._chat_tts_voice(language)
        audio_data = bytearray()
        communicator = edge_tts.Communicate(
            text,
            voice,
            rate="+0%",
            volume="+15%",
        )
        async for chunk in communicator.stream():
            if chunk.get("type") != "audio":
                continue
            audio_data.extend(chunk.get("data", b""))
            if len(audio_data) > MAX_CHAT_TTS_BYTES:
                raise ValueError("Generated chat TTS audio is too large.")
        if not audio_data:
            return

        ffmpeg_executable = imageio_ffmpeg.get_ffmpeg_exe() if imageio_ffmpeg else "ffmpeg"
        process = await asyncio.create_subprocess_exec(
            ffmpeg_executable,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-t",
            str(MAX_CHAT_TTS_DURATION_SECONDS),
            "-filter:a",
            "loudnorm=I=-16:TP=-1.5:LRA=11",
            "-f",
            "s16le",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            str(CHANNELS),
            "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        pcm, stderr = await process.communicate(bytes(audio_data))
        if process.returncode != 0:
            detail = stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(detail or f"ffmpeg exited with status {process.returncode}")

        frames = [
            pcm[offset : offset + FRAME_BYTES]
            for offset in range(0, len(pcm), FRAME_BYTES)
            if len(pcm[offset : offset + FRAME_BYTES]) == FRAME_BYTES
        ]
        if not frames:
            return

        self.chat_tts_playing = True
        self.web_audio_source.clear("tts")
        try:
            if not self._ensure_web_audio_playing():
                return
            prebuffer_count = min(10, len(frames))
            for frame in frames[:prebuffer_count]:
                self.web_audio_source.feed(frame, source="tts")
            for frame in frames[prebuffer_count:]:
                await asyncio.sleep(FRAME_MS / 1000)
                self.web_audio_source.feed(frame, source="tts")
            await asyncio.sleep((prebuffer_count + 2) * FRAME_MS / 1000)
        finally:
            self.chat_tts_playing = False
            self.web_audio_source.clear("tts")
            if not self.browser_audio_active and self.collab_partner_guild_id is None:
                if self.voice_client and self.voice_client.is_playing():
                    self.voice_client.stop()

    async def _chat_tts_voice(self, language: str) -> str:
        cached_voice = self.chat_tts_voice_cache.get(language)
        if cached_voice:
            return cached_voice

        try:
            if self.chat_tts_voices is None:
                self.chat_tts_voices = await asyncio.wait_for(
                    edge_tts.list_voices(),
                    timeout=10,
                )
            preferred_locale = EDGE_TTS_LOCALE_PREFERENCES.get(language, language)
            preferred_voice = EDGE_TTS_NATURAL_VOICE_PREFERENCES.get(language, "")
            preferred_base = preferred_locale.split("-", 1)[0].lower()
            candidates = [
                voice
                for voice in self.chat_tts_voices
                if str(voice.get("Locale", "")).lower() == preferred_locale.lower()
                or str(voice.get("Locale", "")).split("-", 1)[0].lower()
                == preferred_base
            ]
            candidates.sort(
                key=lambda voice: (
                    str(voice.get("ShortName", "")) != preferred_voice,
                    str(voice.get("Locale", "")).lower()
                    != preferred_locale.lower(),
                    "conversation"
                    not in {
                        str(category).lower()
                        for category in voice.get("VoiceTag", {}).get(
                            "ContentCategories",
                            [],
                        )
                    },
                    "multilingualneural"
                    not in str(voice.get("ShortName", "")).lower(),
                    str(voice.get("Gender", "")).lower() != "female",
                    str(voice.get("ShortName", "")),
                )
            )
            if candidates:
                selected_voice = str(candidates[0].get("ShortName", ""))
                if selected_voice:
                    self.chat_tts_voice_cache[language] = selected_voice
                    return selected_voice
        except Exception:
            LOGGER.warning(
                "KikiWeb could not select a TTS voice for language %s; using English.",
                language,
                exc_info=True,
            )

        self.chat_tts_voice_cache[language] = self.config.chat_tts_english_voice
        return self.config.chat_tts_english_voice

    async def _incoming_loop(self, socket: aiohttp.ClientWebSocketResponse) -> None:
        async for message in socket:
            if message.type == aiohttp.WSMsgType.BINARY:
                self.play_web_audio(bytes(message.data))
            elif message.type == aiohttp.WSMsgType.TEXT:
                try:
                    payload = json.loads(message.data)
                except json.JSONDecodeError:
                    continue
                if not isinstance(payload, dict):
                    continue
                if payload.get("type") == "talk-stop":
                    self.stop_web_audio()
                elif payload.get("type") == "chat-post":
                    await self.post_chat_message(payload)
                elif payload.get("type") == "chat-tts":
                    self.enqueue_chat_tts(payload.get("content"), payload.get("authorName"))
                elif payload.get("type") == "chat-timeout-result":
                    self.resolve_chat_timeout_request(payload)
                elif payload.get("type") == "chat-channel":
                    try:
                        channel_id = int(payload.get("channelId", 0))
                    except (TypeError, ValueError):
                        continue
                    if channel_id <= 0:
                        continue
                    changed = self.chat_channel_id != channel_id
                    self.chat_channel_id = channel_id
                    if changed:
                        self.clear_chat_queue()
                    self._schedule_chat_history()

    def _enqueue_pcm_in_loop(
        self,
        pcm: bytes,
        stream_type: int = STREAM_VOICE,
        source_id: int = 0,
    ) -> None:
        header = bytes((stream_type,)) + source_id.to_bytes(8, "big", signed=False)

        for offset in range(0, len(pcm), FRAME_BYTES):
            frame = pcm[offset : offset + FRAME_BYTES]
            if len(frame) != FRAME_BYTES:
                continue

            if self.queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    self.queue.get_nowait()
                    self.queue.task_done()

            self.queue.put_nowait(header + frame)

    async def play_soundboard(self, sound_url: str, volume: float = 1.0) -> None:
        if self.closed.is_set() or not self.session or self.session.closed:
            return

        try:
            async with self.session.get(sound_url, max_redirects=3) as response:
                response.raise_for_status()
                if response.content_length and response.content_length > MAX_SOUNDBOARD_BYTES:
                    raise ValueError("Discord soundboard file is too large.")
                sound_data = await response.read()
                if len(sound_data) > MAX_SOUNDBOARD_BYTES:
                    raise ValueError("Discord soundboard file is too large.")

            normalized_volume = max(0.0, min(2.0, float(volume)))
            if normalized_volume == 0:
                normalized_volume = 1.0

            ffmpeg_executable = imageio_ffmpeg.get_ffmpeg_exe() if imageio_ffmpeg else "ffmpeg"
            process = await asyncio.create_subprocess_exec(
                ffmpeg_executable,
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-t",
                "10",
                "-filter:a",
                f"volume={normalized_volume:.3f}",
                "-f",
                "s16le",
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                str(CHANNELS),
                "pipe:1",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            pcm, stderr = await process.communicate(sound_data)
            if process.returncode != 0:
                detail = stderr.decode("utf-8", errors="replace").strip()
                raise RuntimeError(detail or f"ffmpeg exited with status {process.returncode}")

            source_id = secrets.randbits(64)
            for offset in range(0, len(pcm), FRAME_BYTES):
                frame = pcm[offset : offset + FRAME_BYTES]
                if len(frame) != FRAME_BYTES or self.closed.is_set():
                    break
                self._enqueue_pcm_in_loop(frame, STREAM_SOUNDBOARD, source_id)
                self.forward_collab_pcm(frame, source_id=source_id)
                await asyncio.sleep(FRAME_MS / 1000)
        except FileNotFoundError:
            LOGGER.error("KikiWeb soundboard requires ffmpeg on the Discord Bot host.")
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception("KikiWeb could not relay a Discord soundboard effect")

    def _after_listen(self, error: Optional[Exception]) -> None:
        if self.ignore_next_after:
            self.ignore_next_after = False
            return
        if error:
            message = str(error).lower()
            if "corrupted stream" in message:
                LOGGER.warning("KikiWeb ignored a corrupted Discord voice packet and restarted the receiver.")
            else:
                LOGGER.exception("KikiWeb voice receive stopped with an error", exc_info=error)
        if self.loop and not self.closed.is_set():
            self.loop.call_soon_threadsafe(self._schedule_listen_restart)

    async def _start_listening(self) -> None:
        async with self.listen_restart_lock:
            if not self.voice_client or self.closed.is_set():
                return
            if not self.voice_client.is_connected():
                raise RuntimeError("KikiWeb voice client disconnected before listening could start.")

            if self.voice_client.is_listening():
                self.ignore_next_after = True
                self.voice_client.stop_listening()
                await asyncio.sleep(0.25)

            self.sink = KikiWebAudioSink(self)
            self.voice_client.listen(self.sink, after=self._after_listen)
            self.last_voice_packet_at = time.monotonic()

    def _schedule_listen_restart(self) -> None:
        if self.listen_restart_task and not self.listen_restart_task.done():
            return

        self.listen_restart_task = asyncio.create_task(
            self._restart_listening(),
            name="kikiweb-listen-restarter",
        )

    def _voice_status(self) -> dict[str, object]:
        channel = getattr(self.voice_client, "channel", None)
        client = getattr(self.voice_client, "client", None)
        channel_members = list(getattr(channel, "members", []))
        bot_user = getattr(client, "user", None)
        audio_members = [
            member
            for member in channel_members
            if bot_user is None or member.id != bot_user.id
        ]
        members = [member for member in audio_members if not member.bot]
        muted_members = sum(
            1
            for member in members
            if member.voice is not None and (member.voice.self_mute or member.voice.mute)
        )
        return {
            "type": "voice-status",
            "guildCount": len(getattr(client, "guilds", [])),
            "memberCount": len(members),
            "mutedCount": muted_members,
            "users": [
                {
                    "id": str(member.id),
                    "name": getattr(member, "global_name", None) or member.name,
                    "bot": member.bot,
                    "muted": bool(
                        member.voice is not None
                        and (member.voice.self_mute or member.voice.mute)
                    ),
                }
                for member in audio_members[:100]
            ],
        }

    async def _restart_listening(self) -> None:
        await asyncio.sleep(self.config.listen_restart_delay)
        if self.closed.is_set() or not self.voice_client or not self.voice_client.is_connected():
            return

        LOGGER.info("Restarting KikiWeb voice receiver")
        await self._start_listening()

    def _receiver_is_healthy(self) -> bool:
        if not self.voice_client or not self.voice_client.is_listening():
            return False
        reader = getattr(self.voice_client, "_reader", None)
        packet_router = getattr(reader, "packet_router", None)
        return bool(packet_router and packet_router.is_alive())

    async def _listen_watchdog(self) -> None:
        while not self.closed.is_set():
            await asyncio.sleep(self.config.listen_watchdog_interval)
            self._ensure_sender_task()
            if self.closed.is_set() or not self.voice_client or not self.voice_client.is_connected():
                continue

            if not self._receiver_is_healthy():
                LOGGER.warning("KikiWeb voice receiver stopped; restarting it.")
                await self._start_listening()
                continue

            inactive_for = time.monotonic() - self.last_voice_packet_at
            if inactive_for >= self.config.listen_inactivity_timeout:
                LOGGER.warning(
                    "KikiWeb voice receiver produced no PCM for %.0f seconds; refreshing it.",
                    inactive_for,
                )
                await self._start_listening()

    async def _sender_loop(self) -> None:
        while not self.closed.is_set():
            try:
                if not self.session:
                    await asyncio.sleep(self.config.reconnect_delay)
                    continue

                if not self.server_id or not self.server_name or not self.channel_id or not self.channel_name:
                    raise RuntimeError("Discord server and voice channel metadata are not available.")

                LOGGER.info(
                    "Connecting to KikiWeb relay: server=%s (%s), channel=%s (%s)",
                    self.server_name,
                    self.server_id,
                    self.channel_name,
                    self.channel_id,
                )
                async with self.session.ws_connect(
                    self.config.websocket_url(
                        server_id=self.server_id,
                        server_name=self.server_name,
                        channel_id=self.channel_id,
                        channel_name=self.channel_name,
                    ),
                    heartbeat=25,
                    max_msg_size=0,
                ) as socket:
                    self.socket = socket
                    self.incoming_task = asyncio.create_task(
                        self._incoming_loop(socket),
                        name=f"kikiweb-browser-mic-{self.server_id}",
                    )
                    LOGGER.info("KikiWeb relay connected")
                    connected_at = time.monotonic()
                    next_status_at = 0.0
                    scheduled_refresh = False

                    while not self.closed.is_set() and not socket.closed:
                        if self.incoming_task.done():
                            incoming_error = None
                            if not self.incoming_task.cancelled():
                                incoming_error = self.incoming_task.exception()
                            if incoming_error is not None:
                                raise aiohttp.ClientConnectionError(
                                    f"KikiWeb relay receive loop stopped: {incoming_error}"
                                ) from incoming_error
                            LOGGER.warning("KikiWeb relay receive loop ended; reconnecting.")
                            break

                        now = time.monotonic()
                        if now - connected_at >= self.config.relay_connection_max_age:
                            scheduled_refresh = True
                            LOGGER.info(
                                "Refreshing the long-lived KikiWeb relay connection after %.1f hours.",
                                (now - connected_at) / 3600,
                            )
                            await socket.close(code=1000, message=b"Scheduled relay refresh")
                            break

                        if now >= next_status_at:
                            await socket.send_json(self._voice_status())
                            next_status_at = now + self.config.status_interval

                        while not self.chat_queue.empty():
                            payload = self.chat_queue.get_nowait()
                            try:
                                await socket.send_json(payload)
                            finally:
                                self.chat_queue.task_done()

                        try:
                            frame = await asyncio.wait_for(self.queue.get(), timeout=1)
                        except asyncio.TimeoutError:
                            continue
                        try:
                            await socket.send_bytes(frame)
                        finally:
                            self.queue.task_done()

                    if scheduled_refresh and not self.closed.is_set():
                        await asyncio.sleep(min(1.0, self.config.reconnect_delay))
                    elif not self.closed.is_set():
                        LOGGER.warning(
                            "KikiWeb relay disconnected: code=%s, reason=%s",
                            socket.close_code,
                            socket.exception() or "server closed the connection",
                        )
                        await asyncio.sleep(self.config.reconnect_delay)
            except asyncio.CancelledError:
                raise
            except aiohttp.ClientConnectionError as error:
                if not self.closed.is_set():
                    LOGGER.warning("KikiWeb relay transport closed; reconnecting: %s", error)
                    await asyncio.sleep(self.config.reconnect_delay)
            except Exception:
                LOGGER.exception("KikiWeb relay connection failed")
                await asyncio.sleep(self.config.reconnect_delay)
            finally:
                incoming_task = self.incoming_task
                self.incoming_task = None
                if incoming_task:
                    incoming_task.cancel()
                    results = await asyncio.gather(incoming_task, return_exceptions=True)
                    for result in results:
                        if isinstance(result, Exception) and not isinstance(
                            result,
                            aiohttp.ClientConnectionError,
                        ):
                            LOGGER.debug(
                                "KikiWeb relay receive task ended during cleanup: %s",
                                result,
                            )
                self.stop_web_audio()
                self.clear_audio_queue()
                self.reject_chat_timeout_requests("KikiWeb relay disconnected.")
                self.socket = None


class KikiWebRelayManager:
    def __init__(
        self,
        config: KikiWebConfig,
        *,
        auto_join_path: str | Path = "kikiweb_auto_join.json",
        role_path: Optional[str | Path] = None,
    ) -> None:
        self.config = config
        self.relays: dict[int, KikiWebVoiceRelay] = {}
        self.auto_join_path = Path(auto_join_path)
        self.auto_join_channels = self._load_auto_join_channels()
        self.role_path = (
            Path(role_path)
            if role_path is not None
            else self.auto_join_path.with_name("kikiweb_command_roles.json")
        )
        self.command_role_ids = self._load_command_role_ids()
        self.auto_join_lock = asyncio.Lock()
        self.collab_invites: dict[str, KikiWebCollabInvite] = {}
        self.collab_partners: dict[int, int] = {}

    def _load_auto_join_channels(self) -> dict[int, int]:
        try:
            payload = json.loads(self.auto_join_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, TypeError):
            LOGGER.exception("KikiWeb could not load auto-join settings from %s", self.auto_join_path)
            return {}

        if not isinstance(payload, dict):
            return {}

        channels: dict[int, int] = {}
        for raw_guild_id, raw_channel_id in payload.items():
            try:
                guild_id = int(raw_guild_id)
                channel_id = int(raw_channel_id)
            except (TypeError, ValueError):
                continue
            if guild_id > 0 and channel_id > 0:
                channels[guild_id] = channel_id
        return channels

    def _save_auto_join_channels(self) -> None:
        self.auto_join_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.auto_join_path.with_suffix(f"{self.auto_join_path.suffix}.tmp")
        payload = {str(guild_id): channel_id for guild_id, channel_id in self.auto_join_channels.items()}
        temporary_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary_path.replace(self.auto_join_path)

    def enable_auto_join(self, channel: discord.VoiceChannel | discord.StageChannel) -> None:
        self.auto_join_channels[channel.guild.id] = channel.id
        self._save_auto_join_channels()

    def disable_auto_join(self, guild_id: int) -> bool:
        removed = self.auto_join_channels.pop(guild_id, None) is not None
        if removed:
            self._save_auto_join_channels()
        return removed

    def _load_command_role_ids(self) -> dict[int, int]:
        try:
            payload = json.loads(self.role_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, TypeError):
            LOGGER.exception("KikiWeb could not load command roles from %s", self.role_path)
            return {}

        if not isinstance(payload, dict):
            return {}

        role_ids: dict[int, int] = {}
        for raw_guild_id, raw_role_id in payload.items():
            try:
                guild_id = int(raw_guild_id)
                role_id = int(raw_role_id)
            except (TypeError, ValueError):
                continue
            if guild_id > 0 and role_id > 0:
                role_ids[guild_id] = role_id
        return role_ids

    def _save_command_role_ids(self) -> None:
        self.role_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.role_path.with_suffix(f"{self.role_path.suffix}.tmp")
        payload = {
            str(guild_id): role_id
            for guild_id, role_id in self.command_role_ids.items()
        }
        temporary_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary_path.replace(self.role_path)

    def set_command_role(self, guild_id: int, role_id: int) -> None:
        self.command_role_ids[guild_id] = role_id
        self._save_command_role_ids()

    def can_use_restricted_command(self, member: discord.Member) -> bool:
        if member.id == member.guild.owner_id:
            return True
        role_id = self.command_role_ids.get(member.guild.id)
        return role_id is not None and any(role.id == role_id for role in member.roles)

    def _prune_collab_invites(self) -> None:
        now = time.monotonic()
        for code in [
            code
            for code, invite in self.collab_invites.items()
            if invite.expires_at <= now
        ]:
            self.collab_invites.pop(code, None)

    def create_collab_invite(
        self,
        channel: discord.VoiceChannel | discord.StageChannel,
    ) -> str:
        self._prune_collab_invites()
        if channel.guild.id in self.collab_partners:
            raise RuntimeError("このサーバーは既にコラボVCへ接続しています。")
        relay = self.relays.get(channel.guild.id)
        if (
            relay is None
            or relay.voice_client is None
            or not relay.voice_client.is_connected()
            or getattr(relay.voice_client.channel, "id", None) != channel.id
        ):
            raise RuntimeError("KikiWeb Botが対象VCへ接続していません。")

        for code, invite in list(self.collab_invites.items()):
            if invite.guild_id == channel.guild.id:
                self.collab_invites.pop(code, None)
        for _ in range(20):
            code = f"{secrets.randbelow(1_000_000):06d}"
            if code not in self.collab_invites:
                break
        else:
            raise RuntimeError("コラボVCの招待コードを作成できませんでした。")
        self.collab_invites[code] = KikiWebCollabInvite(
            code=code,
            guild_id=channel.guild.id,
            channel_id=channel.id,
            expires_at=time.monotonic() + COLLAB_INVITE_TTL_SECONDS,
        )
        return code

    async def join_collab(
        self,
        code: str,
        channel: discord.VoiceChannel | discord.StageChannel,
    ) -> KikiWebCollabInvite:
        self._prune_collab_invites()
        normalized_code = code.strip()
        invite = self.collab_invites.get(normalized_code)
        if invite is None:
            raise ValueError("招待コードが無効か、有効期限が切れています。")
        if invite.guild_id == channel.guild.id:
            raise ValueError("同じDiscordサーバー同士は接続できません。")
        if invite.guild_id in self.collab_partners or channel.guild.id in self.collab_partners:
            raise RuntimeError("どちらかのサーバーが既にコラボVCへ接続しています。")

        origin_relay = self.relays.get(invite.guild_id)
        if (
            origin_relay is None
            or origin_relay.voice_client is None
            or not origin_relay.voice_client.is_connected()
            or getattr(origin_relay.voice_client.channel, "id", None) != invite.channel_id
        ):
            self.collab_invites.pop(normalized_code, None)
            raise RuntimeError("招待元のKikiWeb BotがVCから切断されています。")

        target_relay = await self.connect(channel)
        self.collab_partners[invite.guild_id] = channel.guild.id
        self.collab_partners[channel.guild.id] = invite.guild_id
        origin_relay.set_collab_partner(channel.guild.id)
        target_relay.set_collab_partner(invite.guild_id)
        self.collab_invites.pop(normalized_code, None)
        return invite

    def end_collab(self, guild_id: int) -> Optional[int]:
        partner_guild_id = self.collab_partners.pop(guild_id, None)
        if partner_guild_id is None:
            return None
        self.collab_partners.pop(partner_guild_id, None)
        relay = self.relays.get(guild_id)
        partner_relay = self.relays.get(partner_guild_id)
        if relay is not None:
            relay.set_collab_partner(None)
        if partner_relay is not None:
            partner_relay.set_collab_partner(None)
        return partner_guild_id

    def forward_collab_pcm(self, guild_id: int, source_id: int, pcm: bytes) -> None:
        partner_guild_id = self.collab_partners.get(guild_id)
        if partner_guild_id is None:
            return
        partner_relay = self.relays.get(partner_guild_id)
        if partner_relay is not None:
            partner_relay.play_collab_pcm(guild_id, source_id, pcm)

    async def connect_auto_channels(
        self,
        bot,
        *,
        allowed_guild_ids: Optional[set[int] | frozenset[int]] = None,
    ) -> None:
        async with self.auto_join_lock:
            for guild_id, channel_id in list(self.auto_join_channels.items()):
                if allowed_guild_ids and guild_id not in allowed_guild_ids:
                    continue
                channel = bot.get_channel(channel_id)
                if not isinstance(channel, (discord.VoiceChannel, discord.StageChannel)):
                    LOGGER.warning(
                        "KikiWeb auto-join channel is unavailable: guild=%s, channel=%s",
                        guild_id,
                        channel_id,
                    )
                    continue
                relay = self.relays.get(guild_id)
                voice_client = relay.voice_client if relay is not None else None
                if (
                    voice_client is not None
                    and voice_client.is_connected()
                    and getattr(voice_client.channel, "id", None) == channel_id
                ):
                    continue
                try:
                    await self.connect(channel)
                    LOGGER.info(
                        "KikiWeb auto-joined voice channel: guild=%s, channel=%s",
                        guild_id,
                        channel_id,
                    )
                except Exception:
                    LOGGER.exception(
                        "KikiWeb could not auto-join voice channel: guild=%s, channel=%s",
                        guild_id,
                        channel_id,
                    )

    async def connect(
        self,
        channel: discord.VoiceChannel | discord.StageChannel,
    ) -> KikiWebVoiceRelay:
        relay = self.relays.get(channel.guild.id)
        if relay is None:
            relay = KikiWebVoiceRelay(
                self.config,
                collab_forwarder=self.forward_collab_pcm,
            )
            self.relays[channel.guild.id] = relay
        await relay.connect(channel)
        return relay

    async def disconnect(self, guild_id: int) -> None:
        self.end_collab(guild_id)
        relay = self.relays.pop(guild_id, None)
        if relay is not None:
            await relay.disconnect()

    async def disconnect_all(self) -> None:
        for guild_id in list(self.collab_partners):
            self.end_collab(guild_id)
        self.collab_invites.clear()
        relays = list(self.relays.values())
        self.relays.clear()
        await asyncio.gather(*(relay.disconnect() for relay in relays), return_exceptions=True)

    async def play_soundboard_effect(self, effect: discord.VoiceChannelEffect) -> None:
        if not effect.is_sound() or effect.sound is None:
            return

        relay = self.relays.get(effect.channel.guild.id)
        if relay is None or relay.voice_client is None:
            return
        if getattr(relay.voice_client.channel, "id", None) != effect.channel.id:
            return

        await relay.play_soundboard(effect.sound.url, effect.sound.volume)

    async def relay_chat_message(self, message: discord.Message) -> None:
        if message.guild is None:
            return
        relay = self.relays.get(message.guild.id)
        if relay is not None:
            relay.enqueue_chat_message(message)


def install_kikiweb_commands(
    bot,
    *,
    relay_url: str,
    ingest_token: str = "",
    voice_status: str = "試聴完全自由！",
    chat_tts_enabled: bool = True,
    chat_tts_voice: str = "ja-JP-NanamiNeural",
    chat_tts_english_voice: str = "en-US-AvaMultilingualNeural",
    command_prefix: str = "kikiweb",
    use_slash_commands: bool = True,
    auto_join_path: str | Path = "kikiweb_auto_join.json",
    role_path: Optional[str | Path] = None,
) -> KikiWebRelayManager:
    manager = KikiWebRelayManager(
        KikiWebConfig(
            relay_url=relay_url,
            ingest_token=ingest_token,
            voice_status=voice_status,
            chat_tts_enabled=chat_tts_enabled,
            chat_tts_voice=chat_tts_voice,
            chat_tts_english_voice=chat_tts_english_voice,
        ),
        auto_join_path=auto_join_path,
        role_path=role_path,
    )

    if use_slash_commands:
        tree = getattr(bot, "tree", None)
        if tree is None:
            raise RuntimeError("Slash commands require commands.Bot or a bot with a CommandTree.")

        @tree.command(name=f"{command_prefix}_join", description="参加中のVCをKikiWebへ中継します")
        async def kikiweb_join(interaction: discord.Interaction) -> None:
            member = interaction.user
            voice = getattr(member, "voice", None)
            if not interaction.guild or not voice or not voice.channel:
                await interaction.response.send_message("VC に入ってから実行してください。", ephemeral=True)
                return

            await interaction.response.defer(thinking=True)
            await manager.connect(voice.channel)
            await interaction.followup.send("KikiWeb への音声中継を開始しました。")

        @tree.command(name=f"{command_prefix}_leave", description="KikiWebのVC音声中継を停止します")
        async def kikiweb_leave(interaction: discord.Interaction) -> None:
            if not interaction.guild:
                await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
                return

            await manager.disconnect(interaction.guild.id)
            await interaction.response.send_message("KikiWeb への音声中継を停止しました。")

        @tree.command(name=f"{command_prefix}_auto", description="指定VCへの自動参加を設定します")
        @discord.app_commands.guild_only()
        @discord.app_commands.describe(
            enabled="trueで自動参加を有効、falseで無効にします",
            channel="自動参加するボイスチャンネル（trueの場合）",
        )
        async def kikiweb_auto(
            interaction: discord.Interaction,
            enabled: bool,
            channel: Optional[discord.VoiceChannel] = None,
        ) -> None:
            if not interaction.guild:
                await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
                return

            member = interaction.user
            if not isinstance(member, discord.Member) or not manager.can_use_restricted_command(
                member
            ):
                await interaction.response.send_message(
                    "サーバーオーナーまたは /kikiweb_role で許可されたロールだけが使用できます。",
                    ephemeral=True,
                )
                return

            if not enabled:
                removed = manager.disable_auto_join(interaction.guild.id)
                message = (
                    "KikiWebの自動参加を無効にしました。現在の接続は /kikiweb_leave で終了できます。"
                    if removed
                    else "このサーバーでは自動参加は設定されていません。"
                )
                await interaction.response.send_message(message, ephemeral=True)
                return

            target_channel = channel
            if target_channel is None:
                voice = getattr(member, "voice", None)
                if isinstance(getattr(voice, "channel", None), discord.VoiceChannel):
                    target_channel = voice.channel
            if target_channel is None:
                await interaction.response.send_message(
                    "自動参加するVCを選択するか、そのVCに参加してから実行してください。",
                    ephemeral=True,
                )
                return

            await interaction.response.defer(ephemeral=True, thinking=True)
            try:
                await manager.connect(target_channel)
                manager.enable_auto_join(target_channel)
            except Exception as error:
                LOGGER.exception("KikiWeb could not enable auto-join")
                await interaction.followup.send(
                    f"自動参加の設定に失敗しました: {error}",
                    ephemeral=True,
                )
                return
            await interaction.followup.send(
                f"{target_channel.name} への自動参加を有効にしました。",
                ephemeral=True,
            )

        @tree.command(
            name=f"{command_prefix}_timeout",
            description="サイトチャットのログインユーザーをタイムアウトします",
        )
        @discord.app_commands.guild_only()
        @discord.app_commands.describe(
            login_user="サイトチャットのログインユーザー",
            duration="タイムアウトする時間",
        )
        @discord.app_commands.choices(
            duration=[
                discord.app_commands.Choice(name=label, value=seconds)
                for seconds, label in CHAT_TIMEOUT_DURATIONS.items()
            ]
        )
        async def kikiweb_timeout(
            interaction: discord.Interaction,
            login_user: str,
            duration: discord.app_commands.Choice[int],
        ) -> None:
            if not interaction.guild:
                await interaction.response.send_message(
                    "サーバー内で実行してください。",
                    ephemeral=True,
                )
                return

            member = interaction.user
            if not isinstance(member, discord.Member) or not manager.can_use_restricted_command(
                member
            ):
                await interaction.response.send_message(
                    "サーバーオーナーまたは /kikiweb_role で許可されたロールだけが使用できます。",
                    ephemeral=True,
                )
                return

            relay = manager.relays.get(interaction.guild.id)
            if relay is None or relay.voice_client is None:
                await interaction.response.send_message(
                    "このサーバーではKikiWebがVCに接続していません。",
                    ephemeral=True,
                )
                return

            target = relay.resolve_chat_user(login_user)
            if target is None:
                await interaction.response.send_message(
                    "対象を確認できません。候補から選ぶかDiscordユーザーIDを入力してください。",
                    ephemeral=True,
                )
                return

            user_id, user_name = target
            await interaction.response.defer(ephemeral=True, thinking=True)
            try:
                await relay.timeout_chat_user(user_id, duration.value)
            except Exception as error:
                LOGGER.exception("KikiWeb could not timeout a site chat user")
                await interaction.followup.send(
                    f"チャットのタイムアウトに失敗しました: {error}",
                    ephemeral=True,
                )
                return
            await interaction.followup.send(
                f"{user_name} をこのサーバーのサイトチャットで{duration.name}タイムアウトしました。",
                ephemeral=True,
            )

        @kikiweb_timeout.autocomplete("login_user")
        async def kikiweb_timeout_user_autocomplete(
            interaction: discord.Interaction,
            current: str,
        ) -> list[discord.app_commands.Choice[str]]:
            if not interaction.guild:
                return []
            relay = manager.relays.get(interaction.guild.id)
            if relay is None:
                return []
            query = current.casefold().strip()
            choices = []
            for user_id, name in reversed(relay.chat_users.items()):
                label = f"{name} ({user_id})"
                if query and query not in label.casefold():
                    continue
                choices.append(
                    discord.app_commands.Choice(name=label[:100], value=user_id)
                )
                if len(choices) >= 25:
                    break
            return choices

        @tree.command(
            name=f"{command_prefix}_collab_create",
            description="参加中のVCからコラボVCの招待コードを作成します",
        )
        @discord.app_commands.guild_only()
        async def kikiweb_collab_create(interaction: discord.Interaction) -> None:
            if not interaction.guild or not isinstance(interaction.user, discord.Member):
                await interaction.response.send_message(
                    "サーバー内で実行してください。",
                    ephemeral=True,
                )
                return
            if not manager.can_use_restricted_command(interaction.user):
                await interaction.response.send_message(
                    "サーバーオーナーまたは /kikiweb_role で許可されたロールだけが使用できます。",
                    ephemeral=True,
                )
                return

            voice = interaction.user.voice
            if not voice or not isinstance(
                voice.channel,
                (discord.VoiceChannel, discord.StageChannel),
            ):
                await interaction.response.send_message(
                    "コラボに使用するVCへ入ってから実行してください。",
                    ephemeral=True,
                )
                return

            await interaction.response.defer(ephemeral=True, thinking=True)
            try:
                await manager.connect(voice.channel)
                code = manager.create_collab_invite(voice.channel)
            except Exception as error:
                LOGGER.exception("KikiWeb could not create a collaboration invite")
                await interaction.followup.send(
                    f"コラボVCの招待コードを作成できませんでした: {error}",
                    ephemeral=True,
                )
                return
            await interaction.followup.send(
                "コラボVCの招待コードは "
                f"`{code}` です。10分以内に相手サーバーで "
                f"`/{command_prefix}_collab_join code:{code}` を実行してください。",
                ephemeral=True,
            )

        @tree.command(
            name=f"{command_prefix}_collab_join",
            description="招待コードを使って二つのサーバーのVCを接続します",
        )
        @discord.app_commands.guild_only()
        @discord.app_commands.describe(code="相手サーバーで作成した6桁の招待コード")
        async def kikiweb_collab_join(
            interaction: discord.Interaction,
            code: str,
        ) -> None:
            if not interaction.guild or not isinstance(interaction.user, discord.Member):
                await interaction.response.send_message(
                    "サーバー内で実行してください。",
                    ephemeral=True,
                )
                return
            if not manager.can_use_restricted_command(interaction.user):
                await interaction.response.send_message(
                    "サーバーオーナーまたは /kikiweb_role で許可されたロールだけが使用できます。",
                    ephemeral=True,
                )
                return

            voice = interaction.user.voice
            if not voice or not isinstance(
                voice.channel,
                (discord.VoiceChannel, discord.StageChannel),
            ):
                await interaction.response.send_message(
                    "コラボに使用するVCへ入ってから実行してください。",
                    ephemeral=True,
                )
                return

            await interaction.response.defer(ephemeral=True, thinking=True)
            try:
                invite = await manager.join_collab(code, voice.channel)
            except (ValueError, RuntimeError) as error:
                await interaction.followup.send(str(error), ephemeral=True)
                return
            except Exception as error:
                LOGGER.exception("KikiWeb could not join a collaboration")
                await interaction.followup.send(
                    f"コラボVCへ接続できませんでした: {error}",
                    ephemeral=True,
                )
                return

            origin_guild = bot.get_guild(invite.guild_id)
            origin_name = origin_guild.name if origin_guild is not None else "相手サーバー"
            await interaction.followup.send(
                f"「{origin_name}」とのコラボVCを開始しました。両方のVCの音声が相互に流れます。",
                ephemeral=True,
            )

        @tree.command(
            name=f"{command_prefix}_collab_leave",
            description="接続中のコラボVCを終了します",
        )
        @discord.app_commands.guild_only()
        async def kikiweb_collab_leave(interaction: discord.Interaction) -> None:
            if not interaction.guild or not isinstance(interaction.user, discord.Member):
                await interaction.response.send_message(
                    "サーバー内で実行してください。",
                    ephemeral=True,
                )
                return
            if not manager.can_use_restricted_command(interaction.user):
                await interaction.response.send_message(
                    "サーバーオーナーまたは /kikiweb_role で許可されたロールだけが使用できます。",
                    ephemeral=True,
                )
                return

            partner_guild_id = manager.end_collab(interaction.guild.id)
            if partner_guild_id is None:
                await interaction.response.send_message(
                    "このサーバーはコラボVCへ接続していません。",
                    ephemeral=True,
                )
                return
            await interaction.response.send_message(
                "コラボVCを終了しました。通常のKikiWeb中継は継続します。",
                ephemeral=True,
            )

        @tree.command(
            name=f"{command_prefix}_role",
            description="管理用KikiWebコマンドを使用できるロールを設定します",
        )
        @discord.app_commands.guild_only()
        @discord.app_commands.default_permissions(manage_guild=True)
        @discord.app_commands.describe(role="管理用KikiWebコマンドを許可するロール")
        async def kikiweb_role(
            interaction: discord.Interaction,
            role: discord.Role,
        ) -> None:
            if not interaction.guild:
                await interaction.response.send_message(
                    "サーバー内で実行してください。",
                    ephemeral=True,
                )
                return
            if interaction.user.id != interaction.guild.owner_id:
                await interaction.response.send_message(
                    "このコマンドはサーバーオーナーだけが使用できます。",
                    ephemeral=True,
                )
                return
            if role.is_default() or role.managed:
                await interaction.response.send_message(
                    "@everyoneやBot・連携サービスが管理するロールは指定できません。",
                    ephemeral=True,
                )
                return

            try:
                manager.set_command_role(interaction.guild.id, role.id)
            except OSError as error:
                LOGGER.exception("KikiWeb could not save the command role")
                await interaction.response.send_message(
                    f"許可ロールを保存できませんでした: {error}",
                    ephemeral=True,
                )
                return
            await interaction.response.send_message(
                f"サーバーオーナーと「{role.name}」ロールに、自動参加・タイムアウト・コラボVC操作を許可しました。",
                ephemeral=True,
            )
    else:

        @bot.command(name=f"{command_prefix}_join")
        async def kikiweb_join(ctx):
            if not ctx.author.voice or not ctx.author.voice.channel:
                await ctx.reply("VC に入ってから実行してください。")
                return

            await manager.connect(ctx.author.voice.channel)
            await ctx.reply("KikiWeb への音声中継を開始しました。")

        @bot.command(name=f"{command_prefix}_leave")
        async def kikiweb_leave(ctx):
            await manager.disconnect(ctx.guild.id)
            await ctx.reply("KikiWeb への音声中継を停止しました。")

    @bot.listen("on_voice_channel_effect")
    async def kikiweb_soundboard(effect):
        await manager.play_soundboard_effect(effect)

    @bot.listen("on_message")
    async def kikiweb_chat_message(message):
        await manager.relay_chat_message(message)

    @bot.listen("on_ready")
    async def kikiweb_auto_join_ready():
        await manager.connect_auto_channels(bot)

    @bot.listen("on_voice_state_update")
    async def kikiweb_auto_rejoin(member, before, after):
        bot_user = getattr(bot, "user", None)
        if (
            bot_user is None
            or member.id != bot_user.id
            or before.channel is None
            or after.channel is not None
        ):
            return

        guild_id = member.guild.id
        await asyncio.sleep(2)
        voice_client = member.guild.voice_client
        if voice_client is not None and voice_client.is_connected():
            return
        await manager.disconnect(guild_id)
        if guild_id in manager.auto_join_channels:
            await manager.connect_auto_channels(bot)

    return manager
