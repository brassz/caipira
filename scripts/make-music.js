const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'public', 'assets', 'music');
fs.mkdirSync(dir, { recursive: true });

const SR = 22050;

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(v * 32767, 44 + i * 2);
  }
  return buf;
}

function env(t, a, h, d, len) {
  if (t < a) return t / a;
  if (t < a + h) return 1;
  if (t < len) return Math.max(0, 1 - (t - a - h) / d);
  return 0;
}

function makeTrack({ bpm, chords, bassOct, hat }) {
  const beat = 60 / bpm;
  const bars = chords.length;
  const lenSec = bars * 4 * beat;
  const n = Math.floor(lenSec * SR);
  const out = new Float64Array(n);
  const add = (i, v) => { if (i >= 0 && i < n) out[i] += v; };
  chords.forEach((chord, b) => {
    const t0 = b * 4 * beat;
    chord.forEach((hz, k) => {
      const dur = 3.6 * beat;
      const samples = Math.floor(dur * SR);
      for (let i = 0; i < samples; i++) {
        const t = i / SR;
        const e = env(t, 0.08, 1.4, 2.0, dur) * (k === 0 ? 0.11 : 0.07);
        const s = Math.sin(2 * Math.PI * hz * t) * 0.7 + Math.sin(2 * Math.PI * hz * 2 * t) * 0.18;
        add(Math.floor((t0) * SR) + i, s * e);
      }
    });
    const root = chord[0] / Math.pow(2, bassOct ? 0 : 1);
    for (let step = 0; step < 4; step++) {
      const t0b = t0 + step * beat;
      const dur = 0.55 * beat;
      const samples = Math.floor(dur * SR);
      for (let i = 0; i < samples; i++) {
        const t = i / SR;
        const e = env(t, 0.01, 0.12, 0.35, dur) * 0.16;
        add(Math.floor(t0b * SR) + i, Math.sin(2 * Math.PI * (root / 2) * t) * e);
      }
    }
    if (hat) {
      for (let step = 0; step < 8; step++) {
        const t0h = t0 + step * (beat / 2);
        const samples = Math.floor(0.04 * SR);
        for (let i = 0; i < samples; i++) {
          const t = i / SR;
          const e = env(t, 0.001, 0.005, 0.03, 0.04) * (step % 2 ? 0.025 : 0.04);
          add(Math.floor(t0h * SR) + i, (Math.random() * 2 - 1) * e);
        }
      }
    }
  });
  let peak = 0.0001;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = (out[i] / peak) * 0.72;
  return samples;
}

const A3 = 220, C4 = 261.63, D4 = 293.66, E4 = 329.63, F4 = 349.23, G4 = 392, A4 = 440, B4 = 493.88, C5 = 523.25;

fs.writeFileSync(path.join(dir, '01.wav'), wav(makeTrack({
  bpm: 78,
  hat: true,
  chords: [
    [A3, C4, E4], [F4 / 2, A3, C4], [C4, E4, G4], [G4 / 2, B4 / 2, D4]
  ]
})));
fs.writeFileSync(path.join(dir, '02.wav'), wav(makeTrack({
  bpm: 86,
  hat: true,
  chords: [
    [D4 / 2, F4, A4], [G4 / 2, B4 / 2, D4], [C4, E4, G4], [A3, C4, E4]
  ]
})));
fs.writeFileSync(path.join(dir, '03.wav'), wav(makeTrack({
  bpm: 70,
  hat: false,
  chords: [
    [E4 / 2, G4, B4], [C4, E4, G4], [A3, C4, E4], [B4 / 2, D4, F4]
  ]
})));
console.log('music ok', fs.readdirSync(dir));
