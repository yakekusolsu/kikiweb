import dotenv from 'dotenv';

dotenv.config();

const numberFromEnv = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

export const config = {
  port: numberFromEnv('PORT', 8787),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  discordToken: process.env.DISCORD_TOKEN ?? '',
  discordGuildId: process.env.DISCORD_GUILD_ID ?? '',
  discordVoiceChannelId: process.env.DISCORD_VOICE_CHANNEL_ID ?? '',
  listenToken: process.env.LISTEN_TOKEN ?? '',
};

export const hasDiscordConfig = Boolean(
  config.discordToken && config.discordGuildId && config.discordVoiceChannelId,
);
