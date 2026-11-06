# Generates public/sfx/ambient-highlife.mp3: a soft, original 16 s highlife-feel
# loop (guitar arpeggios, round bass, shaker, bell). Seamless: the tail wraps
# onto the start. Deterministic (fixed seed). Run: python3 tools/make_ambient.py
import numpy as np, subprocess, sys, wave
SR = 22050; BPM = 120; BEAT = 60 / BPM; BARS = 8; L = int(SR * BEAT * 4 * BARS)
rng = np.random.default_rng(7)
out = np.zeros(L + SR * 2)
def add(sig, t):
    i = int(t * SR); out[i:i + len(sig)] += sig[: len(out) - i]
def pluck(f, dur, amp):
    n = int(SR * dur); p = max(2, int(SR / f)); buf = rng.uniform(-1, 1, p); y = np.zeros(n)
    for k in range(n):
        y[k] = buf[k % p]; buf[k % p] = 0.5 * (buf[k % p] + buf[(k + 1) % p]) * 0.996
    return y * amp
def bass(f, dur, amp):
    t = np.arange(int(SR * dur)) / SR
    env = np.minimum(1, t / 0.01) * np.exp(-t * 3.2)
    return (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)) * env * amp
def shaker(amp):
    n = int(SR * 0.06); t = np.arange(n) / SR; x = rng.normal(0, 1, n)
    x = np.diff(np.concatenate([[0], x]))  # crude highpass
    return x * np.exp(-t * 60) * amp
def bell(f, amp):
    t = np.arange(int(SR * 0.5)) / SR
    return (np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * f * 2.76 * t)) * np.exp(-t * 9) * amp
G, C, D, Em = 196.0, 261.63, 293.66, 329.63
prog = [('G', [196.0, 246.94, 293.66]), ('C', [261.63, 329.63, 392.0]), ('D', [293.66, 369.99, 440.0]), ('G', [196.0, 246.94, 293.66]),
        ('Em', [164.81, 196.0, 246.94]), ('C', [261.63, 329.63, 392.0]), ('D', [293.66, 369.99, 440.0]), ('G', [196.0, 246.94, 293.66])]
roots = {'G': 98.0, 'C': 65.41 * 2, 'D': 73.42 * 2, 'Em': 82.41}
arp = [0, 1, 2, 1, 2, 1, 0, 2]  # 8ths, highlife guitar sway
for b, (name, ch) in enumerate(prog):
    t0 = b * 4 * BEAT
    for k, idx in enumerate(arp):
        f = ch[idx] * (2 if k in (3, 5) else 1)
        add(pluck(f, 0.7, 0.22 if k % 2 == 0 else 0.15), t0 + k * BEAT / 2 + (0.012 if k % 2 else 0))
    r = roots[name]
    for (bt, mul, a) in [(0, 1, 0.5), (1.5, 1, 0.35), (2, 1.5, 0.4), (3, 1, 0.3), (3.5, 1.5, 0.25)]:
        add(bass(r * mul, 0.45, a), t0 + bt * BEAT)
    for s in range(8):
        add(shaker(0.05 if s % 2 else 0.08), t0 + s * BEAT / 2 + (0.02 if s % 2 else 0))
    for bt in (0, 1.5, 3):  # bell on the highlife timeline
        add(bell(1320.0, 0.05), t0 + bt * BEAT)
out[:SR * 2] += out[L:L + SR * 2]  # wrap the tail for a seamless loop
y = out[:L]
y = np.convolve(y, np.ones(3) / 3, mode='same')  # soften
y = y / np.max(np.abs(y)) * 0.7
pcm = (y * 32767).astype('<i2')
wav = '/tmp/ambient.wav'
with wave.open(wav, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
dst = sys.argv[1] if len(sys.argv) > 1 else 'public/sfx/ambient-highlife.mp3'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-ac', '1', '-ar', '22050', '-b:a', '40k', dst], check=True)
print('wrote', dst, L / SR, 's')
