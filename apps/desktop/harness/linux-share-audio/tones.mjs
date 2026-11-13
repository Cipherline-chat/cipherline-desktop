// Writes the test tones as 16-bit 48 kHz WAV files: t440 / t1000 / t2000 (stereo) and t1000mono, amplitude 0.25, 8 s.
import fs from 'node:fs';
const dir = process.argv[2] || '/tmp/tones';
fs.mkdirSync(dir, { recursive: true });
function wav(file, hz, channels, seconds = 8, rate = 48000, amp = 0.25) {
    const frames = rate * seconds;
    const data = Buffer.alloc(frames * channels * 2);
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
wav('t440', 440, 2);
wav('t1000', 1000, 2);
wav('t2000', 2000, 2);   // the "self" tone of app-test.mjs (a process of Cipherline's own tree)
wav('t1000mono', 1000, 1);
console.log('tones written to', dir);
