import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import { Client, GatewayIntentBits } from 'discord.js';
import prism from 'prism-media';
import { PassThrough } from 'node:stream';
import { config, hasDiscordConfig } from './config.js';

export class DiscordVoiceBridge {
  constructor(mixer) {
    this.mixer = mixer;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
    this.connection = null;
    this.state = hasDiscordConfig ? 'starting' : 'missing-config';
    this.errorMessage = '';
    this.started = false;
    this.activeUsers = new Set();
  }

  getStatus() {
    return {
      state: this.state,
      error: this.errorMessage,
      activeSpeakers: this.activeUsers.size,
      connectedGuildId: config.discordGuildId || null,
      connectedVoiceChannelId: config.discordVoiceChannelId || null,
      botUser: this.client.user
        ? {
            id: this.client.user.id,
            username: this.client.user.username,
          }
        : null,
    };
  }

  async start() {
    if (this.started || !hasDiscordConfig) return;
    this.started = true;
    this.state = 'starting';

    this.client.once('ready', async () => {
      try {
        await this.joinConfiguredChannel();
      } catch (error) {
        this.setError(error);
      }
    });

    this.client.on('error', (error) => this.setError(error));
    await this.client.login(config.discordToken);
  }

  async reconnect() {
    this.connection?.destroy();
    this.connection = null;
    this.activeUsers.clear();
    await this.joinConfiguredChannel();
  }

  async close() {
    this.connection?.destroy();
    await this.client.destroy();
  }

  async joinConfiguredChannel() {
    const guild = await this.client.guilds.fetch(config.discordGuildId);
    const channel = await this.client.channels.fetch(config.discordVoiceChannelId);

    if (!channel?.isVoiceBased() || channel.isDMBased()) {
      throw new Error('DISCORD_VOICE_CHANNEL_ID must point to a guild voice channel or stage channel.');
    }

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.state = 'disconnected';
    });

    this.connection.on('error', (error) => this.setError(error));

    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    this.state = 'ready';
    this.errorMessage = '';
    this.listenToSpeakers();
  }

  listenToSpeakers() {
    if (!this.connection) return;

    this.connection.receiver.speaking.on('start', (userId) => {
      if (this.activeUsers.has(userId)) return;

      this.activeUsers.add(userId);
      const opusStream = this.connection?.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 200,
        },
      });

      if (!opusStream) {
        this.activeUsers.delete(userId);
        return;
      }

      const decoder = new prism.opus.Decoder({
        rate: 48_000,
        channels: 2,
        frameSize: 960,
      });

      const pcmStream = opusStream.pipe(decoder).pipe(new PassThrough());

      pcmStream.on('data', (chunk) => {
        this.mixer.feed(userId, chunk);
      });

      const cleanup = () => {
        this.activeUsers.delete(userId);
        this.mixer.removeInput(userId);
        opusStream.destroy();
        decoder.destroy();
      };

      pcmStream.once('end', cleanup);
      pcmStream.once('close', cleanup);
      pcmStream.once('error', cleanup);
    });
  }

  setError(error) {
    this.state = 'error';
    this.errorMessage = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
}
