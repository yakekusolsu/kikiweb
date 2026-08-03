class KikiWebPcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffers = [];
    this.readFrameIndex = 0;
    this.sourcePhase = 0;
    this.queuedSamples = 0;
    this.started = false;
    this.volume = 0.85;
    this.underruns = 0;
    this.framesUntilStats = 0;
    this.sourceSampleRate = Math.max(
      8_000,
      Number(options?.processorOptions?.sourceSampleRate) || 48_000,
    );
    this.sourceStep = this.sourceSampleRate / sampleRate;
    this.needsResampling = Math.abs(this.sourceStep - 1) > 0.000001;
    this.prebufferSamples = Math.round(this.sourceSampleRate * 0.12);
    this.resumeBufferSamples = Math.round(this.sourceSampleRate * 0.08);
    this.maxQueuedSamples = Math.round(this.sourceSampleRate * 1.2);

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "pcm" && message.buffer) {
        const chunk = new Int16Array(message.buffer);
        if (chunk.length < 2) return;

        this.buffers.push(chunk);
        this.queuedSamples += Math.floor(chunk.length / 2);

        while (this.queuedSamples > this.maxQueuedSamples && this.buffers.length > 1) {
          const dropped = this.buffers.shift();
          this.queuedSamples -= Math.floor(dropped.length / 2) - this.readFrameIndex;
          this.readFrameIndex = 0;
          this.sourcePhase = 0;
        }
        return;
      }

      if (message.type === "volume") {
        this.volume = Math.max(0, Math.min(1, Number(message.value) || 0));
        return;
      }

      if (message.type === "reset") {
        this.buffers = [];
        this.readFrameIndex = 0;
        this.sourcePhase = 0;
        this.queuedSamples = 0;
        this.started = false;
      }
    };
  }

  sampleAt(frameOffset, channel) {
    let index = this.readFrameIndex + frameOffset;
    for (const buffer of this.buffers) {
      const frameCount = Math.floor(buffer.length / 2);
      if (index < frameCount) return buffer[index * 2 + channel];
      index -= frameCount;
    }
    return null;
  }

  consumeSourceFrames(frameCount) {
    let remaining = frameCount;
    while (remaining > 0 && this.buffers.length > 0) {
      const bufferFrames = Math.floor(this.buffers[0].length / 2);
      const available = bufferFrames - this.readFrameIndex;
      const consumed = Math.min(remaining, available);
      this.readFrameIndex += consumed;
      this.queuedSamples -= consumed;
      remaining -= consumed;

      if (this.readFrameIndex >= bufferFrames) {
        this.buffers.shift();
        this.readFrameIndex = 0;
      }
    }
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

    for (let i = 0; i < left.length; i += 1) {
      if (this.buffers.length === 0) {
        left[i] = 0;
        right[i] = 0;
        if (this.started) {
          this.underruns += 1;
          this.started = false;
        }
        continue;
      }

      if (!this.needsResampling) {
        const buffer = this.buffers[0];
        const readIndex = this.readFrameIndex * 2;
        left[i] = (buffer[readIndex] / 32768) * this.volume;
        right[i] = (buffer[readIndex + 1] / 32768) * this.volume;
        this.readFrameIndex += 1;
        this.queuedSamples -= 1;

        if (this.readFrameIndex * 2 >= buffer.length) {
          this.buffers.shift();
          this.readFrameIndex = 0;
        }

        if (this.queuedSamples < this.resumeBufferSamples && this.buffers.length === 0) {
          this.started = false;
        }
        continue;
      }

      const leftCurrent = this.sampleAt(0, 0);
      const rightCurrent = this.sampleAt(0, 1);
      if (leftCurrent === null || rightCurrent === null) continue;

      const leftNext = this.sampleAt(1, 0) ?? leftCurrent;
      const rightNext = this.sampleAt(1, 1) ?? rightCurrent;
      const leftSample = leftCurrent + (leftNext - leftCurrent) * this.sourcePhase;
      const rightSample = rightCurrent + (rightNext - rightCurrent) * this.sourcePhase;
      left[i] = (leftSample / 32768) * this.volume;
      right[i] = (rightSample / 32768) * this.volume;

      this.sourcePhase += this.sourceStep;
      const consumedFrames = Math.floor(this.sourcePhase);
      this.sourcePhase -= consumedFrames;
      this.consumeSourceFrames(consumedFrames);

      if (this.queuedSamples < this.resumeBufferSamples && this.buffers.length === 0) {
        this.started = false;
        this.sourcePhase = 0;
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
      type: "stats",
      bufferMs: Math.round((this.queuedSamples / this.sourceSampleRate) * 1000),
      underruns: this.underruns,
    });
  }
}

registerProcessor("kikiweb-pcm-player", KikiWebPcmPlayer);

class KikiWebPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.noiseGateThreshold = Math.max(
      0,
      Math.min(0.1, Number(options?.processorOptions?.noiseGateThreshold) || 0.012),
    );
    this.speechGain = Math.max(
      1,
      Math.min(4, Number(options?.processorOptions?.speechGain) || 2.5),
    );
    this.gateGain = 0;
    this.gateHoldFrames = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const left = input?.[0];
    const right = input?.[1] || left;

    if (left && right) {
      let sum = 0;
      for (let index = 0; index < left.length; index += 1) {
        sum += (left[index] * left[index] + right[index] * right[index]) / 2;
      }
      const rms = Math.sqrt(sum / left.length);
      if (rms >= this.noiseGateThreshold) {
        this.gateHoldFrames = Math.round(sampleRate * 0.18);
      } else {
        this.gateHoldFrames = Math.max(0, this.gateHoldFrames - left.length);
      }
      const targetGain = this.gateHoldFrames > 0 ? 1 : 0;
      const smoothing = targetGain > this.gateGain ? 0.45 : 0.08;
      this.gateGain += (targetGain - this.gateGain) * smoothing;

      const pcm = new Int16Array(left.length * 2);
      for (let index = 0; index < left.length; index += 1) {
        const leftSample = Math.tanh(left[index] * this.gateGain * this.speechGain);
        const rightSample = Math.tanh(right[index] * this.gateGain * this.speechGain);
        pcm[index * 2] = leftSample * 32767;
        pcm[index * 2 + 1] = rightSample * 32767;
      }
      this.port.postMessage({ type: "pcm", buffer: pcm.buffer }, [pcm.buffer]);
    }

    // Keep this node connected without returning the microphone to local speakers.
    for (const channel of output || []) channel.fill(0);
    return true;
  }
}

registerProcessor("kikiweb-pcm-capture", KikiWebPcmCapture);
