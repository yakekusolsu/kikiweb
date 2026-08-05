import os

import discord
from discord.ext import commands

from kikiweb_voice import install_kikiweb_commands

intents = discord.Intents.default()
intents.voice_states = True

bot = commands.Bot(command_prefix=commands.when_mentioned, intents=intents)

install_kikiweb_commands(
    bot,
    relay_url=os.environ["KIKIWEB_RELAY_URL"],
    ingest_token=os.environ.get("KIKIWEB_INGEST_TOKEN", ""),
    voice_status=os.environ.get("KIKIWEB_VOICE_STATUS", "試聴完全自由！"),
    use_slash_commands=True,
    auto_join_path=os.environ.get("KIKIWEB_AUTO_JOIN_FILE", "kikiweb_auto_join.json"),
)


@bot.event
async def setup_hook() -> None:
    await bot.tree.sync()


bot.run(os.environ["DISCORD_TOKEN"])
