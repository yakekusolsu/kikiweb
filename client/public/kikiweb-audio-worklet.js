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

const KIKIWEB_VOICE_PRESETS = new Set([
  "normal",
  "feminine",
  "masculine",
  "robot",
  "minions",
  "chorus",
  "natural-low",
  "bright",
  "radio",
  "boy",
  "asmr",
]);

function normalizeVoicePreset(value) {
  return KIKIWEB_VOICE_PRESETS.has(value) ? value : "normal";
}

const KIKIWEB_VOICE_PRESET_PITCH = {
  feminine: 1.14,
  masculine: 0.86,
  minions: 1.36,
  "natural-low": 0.915,
  boy: 1.18,
};

class KikiWebPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const configuredNoiseGate = Number(options?.processorOptions?.noiseGateThreshold);
    this.noiseGateThreshold = Number.isFinite(configuredNoiseGate)
      ? Math.max(0, Math.min(0.1, configuredNoiseGate))
      : 0.0036;
    this.speechGain = Math.max(
      1,
      Math.min(8.5, Number(options?.processorOptions?.speechGain) || 2.5),
    );
    this.pitch = Math.max(0.7, Math.min(1.5, Number(options?.processorOptions?.pitch) || 1));
    this.voicePreset = normalizeVoicePreset(options?.processorOptions?.voicePreset);
    this.robotPhase = 0;
    this.radioPhase = 0;
    this.noiseState = 0x6d2b79f5;
    this.noiseLow = 0;
    this.asmrEnvelope = 0;
    this.asmrNoiseFastLeft = 0;
    this.asmrNoiseSlowLeft = 0;
    this.asmrNoiseFastRight = 0;
    this.asmrNoiseSlowRight = 0;
    this.previousLeft = 0;
    this.previousRight = 0;
    this.warmthLeft = 0;
    this.warmthRight = 0;
    this.effectLeft = 0;
    this.effectRight = 0;
    this.chorusPhase = 0;
    this.chorusPhaseSecondary = Math.PI / 2;
    this.chorusRingSize = 4_096;
    this.chorusRingMask = this.chorusRingSize - 1;
    this.chorusLeftRing = new Float32Array(this.chorusRingSize);
    this.chorusRightRing = new Float32Array(this.chorusRingSize);
    this.chorusWritePosition = 0;
    this.gateGain = 0;
    this.gateHoldFrames = 0;
    this.ringSize = 32_768;
    this.ringMask = this.ringSize - 1;
    this.leftRing = new Float32Array(this.ringSize);
    this.rightRing = new Float32Array(this.ringSize);
    this.writePosition = 0;
    this.outputPosition = 0;
    this.latencyFrames = 4_096;
    this.grainHop = 2_048;
    this.grainOverlapCount = 2;
    this.grainSize = this.grainHop * this.grainOverlapCount;
    this.port.onmessage = (event) => {
      if (event.data?.type === "speech-gain") {
        this.speechGain = Math.max(1, Math.min(8.5, Number(event.data.value) || 1));
      }
      if (event.data?.type === "noise-gate") {
        const threshold = Number(event.data.value);
        this.noiseGateThreshold = Number.isFinite(threshold)
          ? Math.max(0, Math.min(0.03, threshold))
          : 0.0036;
      }
      if (event.data?.type === "pitch") {
        this.pitch = Math.max(0.7, Math.min(1.5, Number(event.data.value) || 1));
      }
      if (event.data?.type === "voice-preset") {
        this.voicePreset = normalizeVoicePreset(event.data.value);
      }
    };
  }

  readRing(buffer, position) {
    if (position < 0 || position < this.writePosition - this.ringSize + 1 || position > this.writePosition - 2) {
      return 0;
    }
    const lower = Math.floor(position);
    const fraction = position - lower;
    const current = buffer[lower & this.ringMask];
    const next = buffer[(lower + 1) & this.ringMask];
    return current + (next - current) * fraction;
  }

  grainSample(buffer, outputPosition, grainStart, pitchScale = 1) {
    const grainOffset = outputPosition - grainStart;
    if (grainOffset < 0 || grainOffset >= this.grainSize) return 0;
    const window = Math.sin((Math.PI * grainOffset) / this.grainSize) ** 2;
    const presetPitch = KIKIWEB_VOICE_PRESET_PITCH[this.voicePreset] ?? 1;
    const effectivePitch = Math.min(1.75, Math.max(0.6, this.pitch * presetPitch * pitchScale));
    const sourcePosition = grainStart - this.latencyFrames + grainOffset * effectivePitch;
    return this.readRing(buffer, sourcePosition) * window;
  }

  pitchShiftedSample(buffer, pitchScale = 1) {
    const grainStart = Math.floor(this.outputPosition / this.grainHop) * this.grainHop;
    let mixedSample = 0;
    for (let index = 0; index < this.grainOverlapCount; index += 1) {
      mixedSample += this.grainSample(
        buffer,
        this.outputPosition,
        grainStart - this.grainHop * index,
        pitchScale,
      );
    }
    return mixedSample / (this.grainOverlapCount / 2);
  }

  readChorusRing(buffer, delaySamples) {
    const position = this.chorusWritePosition - delaySamples;
    const lower = Math.floor(position);
    const fraction = position - lower;
    const current = buffer[lower & this.chorusRingMask];
    const next = buffer[(lower + 1) & this.chorusRingMask];
    return current + (next - current) * fraction;
  }

  nextNoise() {
    this.noiseState = (Math.imul(this.noiseState, 1_664_525) + 1_013_904_223) >>> 0;
    return this.noiseState / 2_147_483_648 - 1;
  }

  applyPresetCharacter(leftSample, rightSample) {
    const leftHigh = leftSample - this.previousLeft;
    const rightHigh = rightSample - this.previousRight;
    this.previousLeft = leftSample;
    this.previousRight = rightSample;
    this.warmthLeft += (leftSample - this.warmthLeft) * 0.04;
    this.warmthRight += (rightSample - this.warmthRight) * 0.04;

    if (this.voicePreset === "natural-low") {
      this.effectLeft = Math.tanh((leftSample * 0.86 + this.warmthLeft * 0.22) * 1.2) * 0.9;
      this.effectRight = Math.tanh((rightSample * 0.86 + this.warmthRight * 0.22) * 1.2) * 0.9;
      return;
    }

    if (this.voicePreset === "bright") {
      this.effectLeft = Math.tanh((leftSample + leftHigh * 0.48) * 1.18) * 0.88;
      this.effectRight = Math.tanh((rightSample + rightHigh * 0.48) * 1.18) * 0.88;
      return;
    }

    if (this.voicePreset === "radio") {
      const noise = this.nextNoise();
      this.noiseLow += (noise - this.noiseLow) * 0.08;
      const hiss = noise - this.noiseLow;
      const hum = Math.sin(this.radioPhase);
      this.radioPhase += (Math.PI * 2 * 90) / sampleRate;
      if (this.radioPhase >= Math.PI * 2) this.radioPhase -= Math.PI * 2;
      this.effectLeft = Math.tanh(leftSample * 1.7) * 0.8 + hiss * 0.0022 + hum * 0.0008;
      this.effectRight = Math.tanh(rightSample * 1.7) * 0.8 + hiss * 0.002 + hum * 0.0008;
      return;
    }

    if (this.voicePreset === "boy") {
      this.effectLeft = Math.tanh((leftSample + leftHigh * 0.16) * 1.08) * 0.94;
      this.effectRight = Math.tanh((rightSample + rightHigh * 0.16) * 1.08) * 0.94;
      return;
    }

    if (this.voicePreset === "asmr") {
      const level = Math.max(Math.abs(leftSample), Math.abs(rightSample));
      const envelopeSpeed = level > this.asmrEnvelope ? 0.18 : 0.0015;
      this.asmrEnvelope += (level - this.asmrEnvelope) * envelopeSpeed;

      const leftNoise = this.nextNoise();
      const rightNoise = this.nextNoise();
      this.asmrNoiseFastLeft += (leftNoise - this.asmrNoiseFastLeft) * 0.55;
      this.asmrNoiseSlowLeft += (leftNoise - this.asmrNoiseSlowLeft) * 0.08;
      this.asmrNoiseFastRight += (rightNoise - this.asmrNoiseFastRight) * 0.55;
      this.asmrNoiseSlowRight += (rightNoise - this.asmrNoiseSlowRight) * 0.08;
      const leftBreath = this.asmrNoiseFastLeft - this.asmrNoiseSlowLeft;
      const rightBreath = this.asmrNoiseFastRight - this.asmrNoiseSlowRight;
      const breathLevel = Math.min(0.035, this.asmrEnvelope * 0.22);

      this.effectLeft =
        leftSample * 0.55 + this.warmthLeft * 0.16 + leftHigh * 0.34 + leftBreath * breathLevel;
      this.effectRight =
        rightSample * 0.55 + this.warmthRight * 0.16 + rightHigh * 0.34 + rightBreath * breathLevel;
      return;
    }

    this.effectLeft = leftSample;
    this.effectRight = rightSample;
  }

  applySpatialEffect(leftSample, rightSample) {
    this.chorusLeftRing[this.chorusWritePosition & this.chorusRingMask] = leftSample;
    this.chorusRightRing[this.chorusWritePosition & this.chorusRingMask] = rightSample;

    if (this.voicePreset === "asmr") {
      const leftNear = this.readChorusRing(this.chorusLeftRing, sampleRate * 0.0035);
      const rightNear = this.readChorusRing(this.chorusRightRing, sampleRate * 0.0055);
      this.effectLeft = leftSample * 0.78 + leftNear * 0.22;
      this.effectRight = rightSample * 0.78 + rightNear * 0.22;
      this.chorusWritePosition += 1;
      return;
    }

    if (this.voicePreset !== "chorus") {
      this.effectLeft = leftSample;
      this.effectRight = rightSample;
      this.chorusWritePosition += 1;
      return;
    }

    const firstBaseDelay = sampleRate * 0.014;
    const firstDepth = sampleRate * 0.005;
    const secondBaseDelay = sampleRate * 0.032;
    const secondDepth = sampleRate * 0.008;
    const leftFirstDelay = firstBaseDelay + Math.sin(this.chorusPhase) * firstDepth;
    const rightFirstDelay = firstBaseDelay + Math.sin(this.chorusPhase + Math.PI) * firstDepth;
    const leftSecondDelay = secondBaseDelay + Math.sin(this.chorusPhaseSecondary) * secondDepth;
    const rightSecondDelay = secondBaseDelay + Math.sin(this.chorusPhaseSecondary + Math.PI) * secondDepth;
    const leftFirstWet = this.readChorusRing(this.chorusLeftRing, leftFirstDelay);
    const rightFirstWet = this.readChorusRing(this.chorusRightRing, rightFirstDelay);
    const leftSecondWet = this.readChorusRing(this.chorusLeftRing, leftSecondDelay);
    const rightSecondWet = this.readChorusRing(this.chorusRightRing, rightSecondDelay);
    this.chorusPhase += (Math.PI * 2 * 0.83) / sampleRate;
    this.chorusPhaseSecondary += (Math.PI * 2 * 1.21) / sampleRate;
    if (this.chorusPhase >= Math.PI * 2) this.chorusPhase -= Math.PI * 2;
    if (this.chorusPhaseSecondary >= Math.PI * 2) this.chorusPhaseSecondary -= Math.PI * 2;
    this.chorusWritePosition += 1;
    this.effectLeft = leftSample * 0.48 + leftFirstWet * 0.3 + leftSecondWet * 0.24;
    this.effectRight = rightSample * 0.48 + rightFirstWet * 0.3 + rightSecondWet * 0.24;
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
        this.leftRing[this.writePosition & this.ringMask] = left[index];
        this.rightRing[this.writePosition & this.ringMask] = right[index];
        this.writePosition += 1;
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
        let leftShifted = this.pitchShiftedSample(this.leftRing);
        let rightShifted = this.pitchShiftedSample(this.rightRing);
        if (this.voicePreset === "chorus") {
          const leftLower = this.pitchShiftedSample(this.leftRing, 0.975);
          const leftUpper = this.pitchShiftedSample(this.leftRing, 1.025);
          const rightLower = this.pitchShiftedSample(this.rightRing, 0.975);
          const rightUpper = this.pitchShiftedSample(this.rightRing, 1.025);
          leftShifted = leftShifted * 0.5 + leftLower * 0.3 + leftUpper * 0.2;
          rightShifted = rightShifted * 0.5 + rightLower * 0.2 + rightUpper * 0.3;
        }
        if (this.voicePreset === "robot") {
          const carrier = Math.sin(this.robotPhase);
          leftShifted = Math.round((leftShifted * 0.68 + leftShifted * carrier * 0.32) * 128) / 128;
          rightShifted = Math.round((rightShifted * 0.68 + rightShifted * carrier * 0.32) * 128) / 128;
          this.robotPhase += (Math.PI * 2 * 72) / sampleRate;
          if (this.robotPhase >= Math.PI * 2) this.robotPhase -= Math.PI * 2;
        }
        this.applyPresetCharacter(leftShifted, rightShifted);
        this.applySpatialEffect(this.effectLeft, this.effectRight);
        leftShifted = this.effectLeft;
        rightShifted = this.effectRight;
        const leftSample = Math.tanh(leftShifted * this.gateGain * this.speechGain);
        const rightSample = Math.tanh(rightShifted * this.gateGain * this.speechGain);
        pcm[index * 2] = leftSample * 32767;
        pcm[index * 2 + 1] = rightSample * 32767;
        this.outputPosition += 1;
      }
      this.port.postMessage({ type: "pcm", buffer: pcm.buffer }, [pcm.buffer]);
    }

    // Keep this node connected without returning the microphone to local speakers.
    for (const channel of output || []) channel.fill(0);
    return true;
  }
}

registerProcessor("kikiweb-pcm-capture", KikiWebPcmCapture);
