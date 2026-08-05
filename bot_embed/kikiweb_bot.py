"""Standalone KikiWeb Discord Bot.

Place this file and kikiweb_voice.py in /home/container, then run:
    python main.py
"""

from __future__ import annotations

import os
from pathlib import Path

import discord
from discord.ext import commands

from kikiweb_voice import install_kikiweb_commands


def load_env_file(path: Path) -> None:
    """Load a simple .env file without requiring python-dotenv."""

    if not path.is_file():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


load_env_file(Path("/home/container/.env"))
load_env_file(Path(".env"))

discord_token = os.getenv("DISCORD_TOKEN", "")
relay_url = os.getenv("KIKIWEB_RELAY_URL", "wss://kikiweb.onrender.com/ingest")
ingest_token = os.getenv("KIKIWEB_INGEST_TOKEN", "")
voice_status = os.getenv("KIKIWEB_VOICE_STATUS", "試聴完全自由！")
auto_join_file = os.getenv("KIKIWEB_AUTO_JOIN_FILE", "/home/container/kikiweb_auto_join.json")

if not discord_token:
    raise RuntimeError("DISCORD_TOKEN is required. Set it in /home/container/.env.")

intents = discord.Intents.default()
intents.voice_states = True
intents.message_content = True

bot = commands.Bot(command_prefix=commands.when_mentioned, intents=intents)

install_kikiweb_commands(
    bot,
    relay_url=relay_url,
    ingest_token=ingest_token,
    voice_status=voice_status,
    use_slash_commands=True,
    auto_join_path=auto_join_file,
)

commands_synced = False


@bot.event
async def on_ready() -> None:
    global commands_synced
    if not commands_synced:
        guild_id = os.getenv("DISCORD_GUILD_ID", "").strip()
        if guild_id:
            guild = discord.Object(id=int(guild_id))
            bot.tree.copy_global_to(guild=guild)
            await bot.tree.sync(guild=guild)
        else:
            await bot.tree.sync()
        commands_synced = True
    print(f"KikiWeb Bot is ready: {bot.user} ({bot.user.id})")


bot.run(discord_token)
