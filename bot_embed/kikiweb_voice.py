from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from dataclasses import dataclass
from typing import Optional
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
OPUS_SILENCE = b"\xf8\xff\xfe"
STREAM_VOICE = 0
STREAM_SOUNDBOARD = 1
MAX_SOUNDBOARD_BYTES = 10 * 1024 * 1024


@dataclass(slots=True)
class KikiWebConfig:
    relay_url: str
    ingest_token: str = ""
    reconnect_delay: float = 3.0
    listen_restart_delay: float = 1.0
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


class KikiWebAudioSink(voice_recv.AudioSink):
    def __init__(self, relay: "KikiWebVoiceRelay") -> None:
        super().__init__()
        self.relay = relay
        self.pcm_remainders: dict[int, bytes] = {}

    def wants_opus(self) -> bool:
        return False

    def write(self, user: Optional[discord.abc.User], data: voice_recv.VoiceData) -> None:
        packet = getattr(data, "packet", None)
        raw_source_id = user.id if user is not None else getattr(packet, "ssrc", 0)
        source_id = int(raw_source_id or 0)
        pcm = getattr(data, "pcm", None)
        if not pcm:
            return

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
        self.sender_task: Optional[asyncio.Task[None]] = None
        self.listen_restart_task: Optional[asyncio.Task[None]] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.closed = asyncio.Event()
        self.server_id = 0
        self.server_name = ""
        self.channel_id = 0
        self.channel_name = ""

    async def connect(self, channel: discord.VoiceChannel | discord.StageChannel) -> None:
        self.loop = asyncio.get_running_loop()
        self.closed.clear()
        metadata_changed = self.server_id != channel.guild.id or self.channel_id != channel.id
        self.server_id = channel.guild.id
        self.server_name = channel.guild.name
        self.channel_id = channel.id
        self.channel_name = channel.name

        if not self.session or self.session.closed:
            self.session = aiohttp.ClientSession()

        if metadata_changed and self.socket and not self.socket.closed:
            await self.socket.close(code=1012, message=b"Voice stream changed")

        if not self.sender_task or self.sender_task.done():
            self.sender_task = asyncio.create_task(
                self._sender_loop(),
                name=f"kikiweb-audio-sender-{channel.guild.id}",
            )

        if channel.guild.voice_client:
            voice_client = channel.guild.voice_client
            if not isinstance(voice_client, KikiWebVoiceRecvClient):
                await voice_client.disconnect(force=True)
                voice_client = await channel.connect(cls=KikiWebVoiceRecvClient, self_deaf=False, self_mute=True)
            elif getattr(voice_client.channel, "id", None) != channel.id:
                await voice_client.move_to(channel)
        else:
            voice_client = await channel.connect(cls=KikiWebVoiceRecvClient, self_deaf=False, self_mute=True)

        self.voice_client = voice_client
        self._start_listening()

    async def disconnect(self) -> None:
        self.closed.set()

        if self.voice_client and self.voice_client.is_listening():
            self.voice_client.stop_listening()

        if self.voice_client and self.voice_client.is_connected():
            await self.voice_client.disconnect(force=True)

        if self.sender_task:
            self.sender_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.sender_task

        if self.listen_restart_task:
            self.listen_restart_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.listen_restart_task

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
        self.clear_audio_queue()

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
        if error:
            message = str(error).lower()
            if "corrupted stream" in message:
                LOGGER.warning("KikiWeb ignored a corrupted Discord voice packet and restarted the receiver.")
            else:
                LOGGER.exception("KikiWeb voice receive stopped with an error", exc_info=error)
        if self.loop and not self.closed.is_set():
            self.loop.call_soon_threadsafe(self._schedule_listen_restart)

    def _start_listening(self) -> None:
        if not self.voice_client or self.closed.is_set():
            return

        if self.voice_client.is_listening():
            self.voice_client.stop_listening()

        self.sink = KikiWebAudioSink(self)
        self.voice_client.listen(self.sink, after=self._after_listen)

    def _schedule_listen_restart(self) -> None:
        if self.listen_restart_task and not self.listen_restart_task.done():
            return

        self.listen_restart_task = asyncio.create_task(
            self._restart_listening(),
            name="kikiweb-listen-restarter",
        )

    def _voice_status(self) -> dict[str, int | str]:
        channel = getattr(self.voice_client, "channel", None)
        members = [member for member in getattr(channel, "members", []) if not member.bot]
        muted_members = sum(
            1
            for member in members
            if member.voice is not None and (member.voice.self_mute or member.voice.mute)
        )
        return {
            "type": "voice-status",
            "memberCount": len(members),
            "mutedCount": muted_members,
        }

    async def _restart_listening(self) -> None:
        await asyncio.sleep(self.config.listen_restart_delay)
        if self.closed.is_set() or not self.voice_client or not self.voice_client.is_connected():
            return

        LOGGER.info("Restarting KikiWeb voice receiver")
        self._start_listening()

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
                    LOGGER.info("KikiWeb relay connected")
                    next_status_at = 0.0

                    while not self.closed.is_set() and not socket.closed:
                        now = time.monotonic()
                        if now >= next_status_at:
                            await socket.send_json(self._voice_status())
                            next_status_at = now + self.config.status_interval

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
                self.socket = None


class KikiWebRelayManager:
    def __init__(self, config: KikiWebConfig) -> None:
        self.config = config
        self.relays: dict[int, KikiWebVoiceRelay] = {}

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


def install_kikiweb_commands(
    bot,
    *,
    relay_url: str,
    ingest_token: str = "",
    command_prefix: str = "kikiweb",
) -> KikiWebRelayManager:
    manager = KikiWebRelayManager(KikiWebConfig(relay_url=relay_url, ingest_token=ingest_token))

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

    return manager
