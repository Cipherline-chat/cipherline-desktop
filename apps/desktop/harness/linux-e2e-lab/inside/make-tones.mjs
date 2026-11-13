// Test tones as 16-bit 48 kHz stereo WAVs (amplitude 0.25, 8 s): t440.wav, t1000.wav. Same recipe as linux-share-audio/tones.mjs.
import fs from 'node:fs';
const dir = process.argv[2] || '/tmp/tones';
fs.mkdirSync(dir, { recursive: true });
function wav(file, hz, channels = 2, seconds = 8, rate = 48000, amp = 0.25) {
  const frames = rate * seconds, data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * 32767);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(`${dir}/${file}.wav`, Buffer.concat([h, data]));
}
wav('t440', 440); wav('t1000', 1000);
