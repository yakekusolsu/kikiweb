from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import queue
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import aiohttp
import davey
import discord
from discord.ext import voice_recv
from discord.ext.voice_recv.reader import AudioReader
from discord.http import Route

try:
    import imageio_ffmpeg
except ImportError:
    imageio_ffmpeg = None

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


@dataclass(slots=True)
class KikiWebConfig:
    relay_url: str
    ingest_token: str = ""
    voice_status: str = "試聴完全自由！"
    reconnect_delay: float = 3.0
    listen_restart_delay: float = 1.0
    listen_watchdog_interval: float = 5.0
    listen_inactivity_timeout: float = 90.0
    status_interval: float = 1.0
    queue_size: int = 160

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


class KikiWebDAVEAudioReader(AudioReader):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._transport_decrypt_rtp = self.decryptor.decrypt_rtp
        self._last_dave_error_log_at = 0.0
        self.decryptor.decrypt_rtp = self._decrypt_rtp

    def _decrypt_rtp(self, packet) -> bytes:
        payload = self._transport_decrypt_rtp(packet)

        if packet.padding:
            if not payload:
                return OPUS_SILENCE
            padding_size = payload[-1]
            if padding_size == 0 or padding_size > len(payload):
                self._log_dave_error("KikiWeb dropped an RTP packet with invalid padding.")
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
            self._log_dave_error("KikiWeb dropped a DAVE packet that could not be decrypted: %s", error)
            return OPUS_SILENCE

    def _log_dave_error(self, message: str, *args) -> None:
        now = time.monotonic()
        if now - self._last_dave_error_log_at < 5:
            return
        self._last_dave_error_log_at = now
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
    """A short PCM buffer used to play browser microphone audio into Discord."""

    def __init__(self) -> None:
        self.frames: queue.Queue[bytes] = queue.Queue(maxsize=50)

    def is_opus(self) -> bool:
        return False

    def read(self) -> bytes:
        try:
            return self.frames.get(timeout=FRAME_MS / 1000)
        except queue.Empty:
            return PCM_SILENCE

    def feed(self, pcm: bytes) -> None:
        for offset in range(0, len(pcm), FRAME_BYTES):
            frame = pcm[offset : offset + FRAME_BYTES]
            if len(frame) != FRAME_BYTES:
                continue
            if self.frames.full():
                with contextlib.suppress(queue.Empty):
                    self.frames.get_nowait()
            self.frames.put_nowait(frame)

    def clear(self) -> None:
        while True:
            try:
                self.frames.get_nowait()
            except queue.Empty:
                return


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

        self.relay.enqueue_pcm(buffered_pcm[:complete_bytes], source_id=source_id)
        remainder = buffered_pcm[complete_bytes:]
        if remainder:
            self.pcm_remainders[source_id] = remainder
        else:
            self.pcm_remainders.pop(source_id, None)

    def cleanup(self) -> None:
        self.pcm_remainders.clear()
        self.relay.clear_audio_queue()


class KikiWebVoiceRelay:
    def __init__(self, config: KikiWebConfig) -> None:
        self.config = config
        self.voice_client: Optional[KikiWebVoiceRecvClient] = None
        self.sink: Optional[KikiWebAudioSink] = None
        self.session: Optional[aiohttp.ClientSession] = None
        self.socket: Optional[aiohttp.ClientWebSocketResponse] = None
        self.queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=config.queue_size)
        self.chat_queue: asyncio.Queue[dict[str, object]] = asyncio.Queue(maxsize=100)
        self.sender_task: Optional[asyncio.Task[None]] = None
        self.incoming_task: Optional[asyncio.Task[None]] = None
        self.chat_history_task: Optional[asyncio.Task[None]] = None
        self.listen_restart_task: Optional[asyncio.Task[None]] = None
        self.listen_watchdog_task: Optional[asyncio.Task[None]] = None
        self.listen_restart_lock = asyncio.Lock()
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

    async def _set_voice_status(
        self,
        channel: discord.VoiceChannel | discord.StageChannel,
        status: Optional[str],
    ) -> None:
        try:
            await channel._state.http.request(
                Route("PUT", "/channels/{channel_id}/voice-status", channel_id=channel.id),
                json={"status": status or None},
            )
        except discord.Forbidden:
            LOGGER.warning(
                "KikiWeb could not set the VC status. Give the Bot the Set Voice Channel Status permission."
            )
        except discord.HTTPException as error:
            LOGGER.warning("KikiWeb could not update the VC status: %s", error)

    async def connect(self, channel: discord.VoiceChannel | discord.StageChannel) -> None:
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

        if not self.sender_task or self.sender_task.done():
            self.sender_task = asyncio.create_task(
                self._sender_loop(),
                name=f"kikiweb-audio-sender-{channel.guild.id}",
            )

        voice_client = channel.guild.voice_client
        if voice_client and (
            not isinstance(voice_client, KikiWebVoiceRecvClient)
            or not voice_client.is_connected()
        ):
            await voice_client.disconnect(force=True)
            await asyncio.sleep(0.25)
            voice_client = None

        if voice_client:
            previous_channel = getattr(voice_client, "channel", None)
            if previous_channel and getattr(previous_channel, "id", None) != channel.id:
                await self._set_voice_status(previous_channel, None)
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
        await self._set_voice_status(channel, self.config.voice_status)
        if not self.listen_watchdog_task or self.listen_watchdog_task.done():
            self.listen_watchdog_task = asyncio.create_task(
                self._listen_watchdog(),
                name=f"kikiweb-listen-watchdog-{channel.guild.id}",
            )

    async def disconnect(self) -> None:
        self.closed.set()

        if self.voice_client and self.voice_client.is_listening():
            self.voice_client.stop_listening()

        if self.voice_client and self.voice_client.is_connected():
            channel = getattr(self.voice_client, "channel", None)
            if channel is not None:
                await self._set_voice_status(channel, None)
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
        self.stop_web_audio()
        self.clear_audio_queue()
        self.clear_chat_queue()

    def note_voice_packet(self) -> None:
        self.last_voice_packet_at = time.monotonic()

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

    def enqueue_chat_message(self, message: discord.Message) -> None:
        if self.closed.is_set() or message.guild is None or message.guild.id != self.server_id:
            return
        if message.channel.id != self.chat_channel_id:
            return

        content = message.content.strip()
        if not content and message.attachments:
            attachment_names = ", ".join(attachment.filename for attachment in message.attachments[:5])
            content = f"[添付ファイル] {attachment_names}"
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
        if self.chat_queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.chat_queue.get_nowait()
                self.chat_queue.task_done()
        self.chat_queue.put_nowait(payload)

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

        self.web_audio_source.feed(pcm)
        if not self.voice_client.is_playing():
            try:
                self.voice_client.play(self.web_audio_source)
            except discord.ClientException:
                LOGGER.warning("KikiWeb could not start browser microphone playback in Discord.")

    def stop_web_audio(self) -> None:
        self.web_audio_source.clear()
        if self.voice_client and self.voice_client.is_playing():
            self.voice_client.stop()

    async def _incoming_loop(self, socket: aiohttp.ClientWebSocketResponse) -> None:
        async for message in socket:
            if message.type == aiohttp.WSMsgType.BINARY:
                self.play_web_audio(bytes(message.data))
            elif message.type == aiohttp.WSMsgType.TEXT:
                try:
                    payload = json.loads(message.data)
                except json.JSONDecodeError:
                    continue
                if payload.get("type") == "talk-stop":
                    self.stop_web_audio()
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
        channel_members = list(getattr(channel, "members", []))
        bot_user = getattr(getattr(self.voice_client, "client", None), "user", None)
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
                    next_status_at = 0.0

                    while not self.closed.is_set() and not socket.closed:
                        now = time.monotonic()
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

                    if not self.closed.is_set():
                        LOGGER.warning(
                            "KikiWeb relay disconnected: code=%s, reason=%s",
                            socket.close_code,
                            socket.exception() or "server closed the connection",
                        )
                        await asyncio.sleep(self.config.reconnect_delay)
            except asyncio.CancelledError:
                raise
            except Exception:
                LOGGER.exception("KikiWeb relay connection failed")
                await asyncio.sleep(self.config.reconnect_delay)
            finally:
                if self.incoming_task:
                    self.incoming_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await self.incoming_task
                self.incoming_task = None
                self.stop_web_audio()
                self.socket = None


class KikiWebRelayManager:
    def __init__(
        self,
        config: KikiWebConfig,
        *,
        auto_join_path: str | Path = "kikiweb_auto_join.json",
    ) -> None:
        self.config = config
        self.relays: dict[int, KikiWebVoiceRelay] = {}
        self.auto_join_path = Path(auto_join_path)
        self.auto_join_channels = self._load_auto_join_channels()
        self.auto_join_lock = asyncio.Lock()

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
            relay = KikiWebVoiceRelay(self.config)
            self.relays[channel.guild.id] = relay
        await relay.connect(channel)
        return relay

    async def disconnect(self, guild_id: int) -> None:
        relay = self.relays.pop(guild_id, None)
        if relay is not None:
            await relay.disconnect()

    async def disconnect_all(self) -> None:
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
    command_prefix: str = "kikiweb",
    use_slash_commands: bool = True,
    auto_join_path: str | Path = "kikiweb_auto_join.json",
) -> KikiWebRelayManager:
    manager = KikiWebRelayManager(
        KikiWebConfig(
            relay_url=relay_url,
            ingest_token=ingest_token,
            voice_status=voice_status,
        ),
        auto_join_path=auto_join_path,
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
        @discord.app_commands.default_permissions(manage_guild=True)
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
            if not isinstance(member, discord.Member) or not member.guild_permissions.manage_guild:
                await interaction.response.send_message("サーバー管理権限が必要です。", ephemeral=True)
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
