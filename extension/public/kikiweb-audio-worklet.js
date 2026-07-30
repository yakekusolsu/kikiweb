class KikiWebPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = [];
    this.readIndex = 0;
    this.queuedSamples = 0;
    this.started = false;
    this.volume = 0.85;
    this.underruns = 0;
    this.framesUntilStats = 0;
    this.prebufferSamples = Math.round(sampleRate * 0.12);
    this.resumeBufferSamples = Math.round(sampleRate * 0.08);
    this.maxQueuedSamples = Math.round(sampleRate * 1.2);

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'pcm' && message.buffer) {
        const chunk = new Int16Array(message.buffer);
        if (chunk.length < 2) return;

        this.buffers.push(chunk);
        this.queuedSamples += Math.floor(chunk.length / 2);

        while (this.queuedSamples > this.maxQueuedSamples && this.buffers.length > 1) {
          const dropped = this.buffers.shift();
          this.queuedSamples -= Math.floor(dropped.length / 2);
          this.readIndex = 0;
        }
        return;
      }

      if (message.type === 'volume') {
        this.volume = Math.max(0, Math.min(1, Number(message.value) || 0));
        return;
      }

      if (message.type === 'reset') {
        this.buffers = [];
        this.readIndex = 0;
        this.queuedSamples = 0;
        this.started = false;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];

    if (!this.started) {
      if (this.queuedSamples < this.prebufferSamples) {
        left.fill(0);
        right.fill(0);
        this.postStats(left.length);
        return true;
      }
      this.started = true;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (this.buffers.length === 0) {
        left[index] = 0;
        right[index] = 0;
        if (this.started) {
          this.underruns += 1;
          this.started = false;
        }
        continue;
      }

      const buffer = this.buffers[0];
      left[index] = (buffer[this.readIndex] / 32768) * this.volume;
      right[index] = (buffer[this.readIndex + 1] / 32768) * this.volume;
      this.readIndex += 2;
      this.queuedSamples -= 1;

      if (this.readIndex >= buffer.length) {
        this.buffers.shift();
        this.readIndex = 0;
      }

      if (this.queuedSamples < this.resumeBufferSamples && this.buffers.length === 0) {
        this.started = false;
      }
    }

    this.postStats(left.length);
    return true;
  }

  postStats(frameCount) {
    this.framesUntilStats -= frameCount;
    if (this.framesUntilStats > 0) return;

    this.framesUntilStats = Math.round(sampleRate / 4);
    this.port.postMessage({
      type: 'stats',
      bufferMs: Math.round((this.queuedSamples / sampleRate) * 1000),
      underruns: this.underruns,
    });
  }
}

registerProcessor('kikiweb-pcm-player', KikiWebPcmPlayer);
