export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const FRAME_SIZE = 960;
export const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * Int16Array.BYTES_PER_ELEMENT;

export class AudioMixer {
  buffers = new Map();
  clients = new Set();
  lastAudioAt = 0;

  constructor(streamType = 0) {
    this.streamType = streamType;
    this.timer = setInterval(() => this.mixAndBroadcast(), 20);
    this.timer.unref();
  }

  addClient(client) {
    this.clients.add(client);
    if (!(client.kikiwebSourceGains instanceof Map)) {
      client.kikiwebSourceGains = new Map();
    }
    client.isAlive = true;
    client.on('pong', () => {
      client.isAlive = true;
    });
    client.on('close', () => {
      this.clients.delete(client);
    });
  }

  clientCount() {
    return this.clients.size;
  }

  setClientSourceGains(client, sourceGains) {
    if (!this.clients.has(client)) return;
    client.kikiwebSourceGains = new Map(sourceGains);
  }

  activeSpeakerCount() {
    return [...this.buffers.values()].filter((buffer) => buffer.length >= PCM_FRAME_BYTES).length;
  }

  getLastAudioAt() {
    return this.lastAudioAt;
  }

  feed(userId, chunk) {
    const current = this.buffers.get(userId);
    const next = current ? Buffer.concat([current, chunk]) : Buffer.from(chunk);
    const maxBufferedBytes = PCM_FRAME_BYTES * 12;
    this.buffers.set(userId, next.length > maxBufferedBytes ? next.subarray(next.length - maxBufferedBytes) : next);
  }

  removeInput(userId) {
    this.buffers.delete(userId);
  }

  clearInputs() {
    this.buffers.clear();
  }

  heartbeat() {
    for (const client of this.clients) {
      if (client.isAlive === false) {
        client.terminate();
        this.clients.delete(client);
        continue;
      }

      client.isAlive = false;
      client.ping();
    }
  }

  close() {
    clearInterval(this.timer);
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.buffers.clear();
  }

  mixAndBroadcast() {
    if (this.clients.size === 0) return;

    const frames = [];
    for (const [userId, buffer] of this.buffers) {
      if (buffer.length < PCM_FRAME_BYTES) continue;

      frames.push({ sourceId: userId, pcm: buffer.subarray(0, PCM_FRAME_BYTES) });
      const rest = buffer.subarray(PCM_FRAME_BYTES);
      if (rest.length === 0) {
        this.buffers.delete(userId);
      } else {
        this.buffers.set(userId, rest);
      }
    }

    if (frames.length === 0) return;

    this.lastAudioAt = Date.now();
    for (const client of this.clients) {
      if (client.readyState !== client.OPEN) continue;

      const audibleFrames = frames
        .map((frame) => ({
          ...frame,
          gain: client.kikiwebSourceGains.get(frame.sourceId) ?? 1,
        }))
        .filter((frame) => frame.gain > 0);
      const divisor =
        this.streamType === 1
          ? Math.max(1, audibleFrames.length)
          : Math.max(1, Math.sqrt(audibleFrames.length));
      const mixed = Buffer.alloc(PCM_FRAME_BYTES);

      for (let offset = 0; offset < PCM_FRAME_BYTES; offset += 2) {
        let sample = 0;
        for (const frame of audibleFrames) {
          sample += frame.pcm.readInt16LE(offset) * frame.gain;
        }

        sample = Math.max(-32768, Math.min(32767, Math.round(sample / divisor)));
        mixed.writeInt16LE(sample, offset);
      }

      const packet = Buffer.allocUnsafe(PCM_FRAME_BYTES + 1);
      packet[0] = this.streamType;
      mixed.copy(packet, 1);
      client.send(packet, { binary: true });
    }
  }
}
