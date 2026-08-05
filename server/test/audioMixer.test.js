import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AudioMixer, PCM_FRAME_BYTES } from '../src/audioMixer.js';

class FakeClient extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  packets = [];

  send(packet) {
    this.packets.push(Buffer.from(packet));
  }

  ping() {}

  close() {
    this.readyState = 3;
  }
}

const constantFrame = (sample) => {
  const frame = Buffer.alloc(PCM_FRAME_BYTES);
  for (let offset = 0; offset < frame.length; offset += 2) {
    frame.writeInt16LE(sample, offset);
  }
  return frame;
};

test('mixes Discord users with independent gains for each listener', () => {
  const mixer = new AudioMixer();
  const firstListener = new FakeClient();
  const secondListener = new FakeClient();
  const defaultListener = new FakeClient();

  try {
    mixer.addClient(firstListener);
    mixer.addClient(secondListener);
    mixer.addClient(defaultListener);
    mixer.setClientSourceGains(
      firstListener,
      new Map([
        ['voice-1', 1],
        ['voice-2', 0],
      ]),
    );
    mixer.setClientSourceGains(
      secondListener,
      new Map([
        ['voice-1', 0],
        ['voice-2', 1.5],
      ]),
    );

    mixer.feed('voice-1', constantFrame(1_000));
    mixer.feed('voice-2', constantFrame(2_000));
    mixer.mixAndBroadcast();

    assert.equal(firstListener.packets.length, 1);
    assert.equal(secondListener.packets.length, 1);
    assert.equal(defaultListener.packets.length, 1);
    assert.equal(firstListener.packets[0].readInt16LE(1), 1_000);
    assert.equal(secondListener.packets[0].readInt16LE(1), 3_000);
    assert.equal(defaultListener.packets[0].readInt16LE(1), 2_121);
  } finally {
    mixer.close();
  }
});

test('sends silence when a listener mutes every active user', () => {
  const mixer = new AudioMixer();
  const listener = new FakeClient();

  try {
    mixer.addClient(listener);
    mixer.setClientSourceGains(listener, new Map([['voice-1', 0]]));
    mixer.feed('voice-1', constantFrame(5_000));
    mixer.mixAndBroadcast();

    assert.equal(listener.packets.length, 1);
    assert.equal(listener.packets[0].readInt16LE(1), 0);
  } finally {
    mixer.close();
  }
});
