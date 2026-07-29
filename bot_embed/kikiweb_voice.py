from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from typing import Optional

import aiohttp
import discord
from discord import opus
from discord.ext import voice_recv

LOGGER = logging.getLogger(__name__)

SAMPLE_RATE = 48_000
CHANNELS = 2
FRAME_MS = 20
BYTES_PER_SAMPLE = 2
FRAME_BYTES = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * FRAME_MS // 1000


@dataclass(slots=True)
class KikiWebConfig:
    relay_url: str
    ingest_token: str = ""
    reconnect_delay: float = 3.0
    listen_restart_delay: float = 1.0
    queue_size: int = 160

    def websocket_url(self) -> str:
        if not self.ingest_token:
            return self.relay_url

        separator = "&" if "?" in self.relay_url else "?"
        return f"{self.relay_url}{separator}token={self.ingest_token}"


class KikiWebAudioSink(voice_recv.AudioSink):
    def __init__(self, relay: "KikiWebVoiceRelay") -> None:
        super().__init__()
        self.relay = relay
        self.decoders: dict[int, opus.Decoder] = {}

    def wants_opus(self) -> bool:
        return True

    def write(self, user: Optional[discord.abc.User], data: voice_recv.VoiceData) -> None:
        if user is not None and getattr(user, "bot", False):
            return

        pcm = None
        opus_packet = getattr(data, "opus", None)
        if opus_packet:
            decoder_key = user.id if user is not None else 0
            decoder = self.decoders.setdefault(decoder_key, opus.Decoder())
            try:
                pcm = decoder.decode(opus_packet, fec=False)
            except opus.OpusError:
                LOGGER.warning("KikiWeb skipped a corrupted Discord voice packet.")
                return

        if pcm is None:
            pcm = getattr(data, "pcm", None)

        if not pcm:
            return

        self.relay.enqueue_pcm(bytes(pcm))

    def cleanup(self) -> None:
        self.decoders.clear()
        self.relay.clear_audio_queue()


class KikiWebVoiceRelay:
    def __init__(self, config: KikiWebConfig) -> None:
        self.config = config
        self.voice_client: Optional[voice_recv.VoiceRecvClient] = None
        self.sink: Optional[KikiWebAudioSink] = None
        self.session: Optional[aiohttp.ClientSession] = None
        self.socket: Optional[aiohttp.ClientWebSocketResponse] = None
        self.queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=config.queue_size)
        self.sender_task: Optional[asyncio.Task[None]] = None
        self.listen_restart_task: Optional[asyncio.Task[None]] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.closed = asyncio.Event()

    async def connect(self, channel: discord.VoiceChannel | discord.StageChannel) -> None:
        self.loop = asyncio.get_running_loop()
        self.closed.clear()

        if not self.session or self.session.closed:
            self.session = aiohttp.ClientSession()

        if not self.sender_task or self.sender_task.done():
            self.sender_task = asyncio.create_task(self._sender_loop(), name="kikiweb-audio-sender")

        if channel.guild.voice_client:
            voice_client = channel.guild.voice_client
            if not isinstance(voice_client, voice_recv.VoiceRecvClient):
                await voice_client.disconnect(force=True)
                voice_client = await channel.connect(cls=voice_recv.VoiceRecvClient, self_deaf=False, self_mute=True)
            elif getattr(voice_client.channel, "id", None) != channel.id:
                await voice_client.move_to(channel)
        else:
            voice_client = await channel.connect(cls=voice_recv.VoiceRecvClient, self_deaf=False, self_mute=True)

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

    def enqueue_pcm(self, pcm: bytes) -> None:
        if not self.loop or self.closed.is_set():
            return

        self.loop.call_soon_threadsafe(self._enqueue_pcm_in_loop, pcm)

    def clear_audio_queue(self) -> None:
        while True:
            try:
                self.queue.get_nowait()
                self.queue.task_done()
            except asyncio.QueueEmpty:
                break

    def _enqueue_pcm_in_loop(self, pcm: bytes) -> None:
        for offset in range(0, len(pcm), FRAME_BYTES):
            frame = pcm[offset : offset + FRAME_BYTES]
            if len(frame) != FRAME_BYTES:
                continue

            if self.queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    self.queue.get_nowait()
                    self.queue.task_done()

            self.queue.put_nowait(frame)

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

                LOGGER.info("Connecting to KikiWeb relay: %s", self.config.relay_url)
                async with self.session.ws_connect(
                    self.config.websocket_url(),
                    heartbeat=25,
                    max_msg_size=0,
                ) as socket:
                    self.socket = socket
                    LOGGER.info("KikiWeb relay connected")

                    while not self.closed.is_set() and not socket.closed:
                        frame = await self.queue.get()
                        try:
                            await socket.send_bytes(frame)
                        finally:
                            self.queue.task_done()
            except asyncio.CancelledError:
                raise
            except Exception:
                LOGGER.exception("KikiWeb relay connection failed")
                await asyncio.sleep(self.config.reconnect_delay)
            finally:
                self.socket = None


def install_kikiweb_commands(
    bot,
    *,
    relay_url: str,
    ingest_token: str = "",
    command_prefix: str = "kikiweb",
) -> KikiWebVoiceRelay:
    relay = KikiWebVoiceRelay(KikiWebConfig(relay_url=relay_url, ingest_token=ingest_token))

    @bot.command(name=f"{command_prefix}_join")
    async def kikiweb_join(ctx):
        if not ctx.author.voice or not ctx.author.voice.channel:
            await ctx.reply("VC に入ってから実行してください。")
            return

        await relay.connect(ctx.author.voice.channel)
        await ctx.reply("KikiWeb への音声中継を開始しました。")

    @bot.command(name=f"{command_prefix}_leave")
    async def kikiweb_leave(ctx):
        await relay.disconnect()
        await ctx.reply("KikiWeb への音声中継を停止しました。")

    return relay
