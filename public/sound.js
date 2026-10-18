// Paper sounds synthesised with the Web Audio API, so the app ships no audio files.
const ShelfSound = (() => {
  let ctx = null;
  let master = null;
  let noise = null;
  let rain = null;
  const prefs = { effects: read('shelfspace-sound', 'on') === 'on', rain: false };

  function read(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  }

  function audio() {
    if (!ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return null;
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // A filtered burst of noise shaped by a gain envelope: the basic building block of paper sounds.
  function burst({ at = 0, length, from, to, q = 0.9, type = 'bandpass', peak, attack = 0.02 }) {
    const start = ctx.currentTime + at;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = 0.85 + Math.random() * 0.3;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(to, start + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    source.connect(filter).connect(gain).connect(master);
    source.start(start, Math.random() * 1.2, length + 0.05);
  }

  function thump(at, frequency, peak) {
    const start = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, start);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.55, start + 0.18);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + 0.25);
  }

  function pageTurn() {
    if (!prefs.effects || !audio()) return;
    const jitter = Math.random() * 400;
    burst({ length: 0.34, from: 3200 + jitter, to: 900, q: 0.7, peak: 0.22, attack: 0.05 });
    burst({ at: 0.04, length: 0.22, from: 6500, to: 2600, q: 1.4, type: 'highpass', peak: 0.05 });
    burst({ at: 0.3, length: 0.07, from: 1400, to: 500, q: 0.8, peak: 0.16, attack: 0.005 });
  }

  function bookOpen() {
    if (!prefs.effects || !audio()) return;
    burst({ length: 0.55, from: 1800, to: 420, q: 0.6, peak: 0.2, attack: 0.08 });
    burst({ at: 0.1, length: 0.3, from: 4200, to: 1500, q: 1.1, peak: 0.06 });
    thump(0.5, 110, 0.18);
  }

  function bookClose() {
    if (!prefs.effects || !audio()) return;
    burst({ length: 0.16, from: 1600, to: 500, q: 0.7, peak: 0.14, attack: 0.03 });
    thump(0.12, 95, 0.22);
  }

  // Soft rain: looping noise through a gentle band, with slow swells so it never sounds static.
  function startRain() {
    if (rain || !audio()) return;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 1500;
    const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 260;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 1.5);
    const swell = ctx.createOscillator(); swell.frequency.value = 0.09;
    const swellDepth = ctx.createGain(); swellDepth.gain.value = 0.02;
    swell.connect(swellDepth).connect(gain.gain);
    source.connect(low).connect(high).connect(gain).connect(master);
    source.start(); swell.start();
    const drops = setInterval(() => {
      if (Math.random() < 0.6) burst({ length: 0.05, from: 2500 + Math.random() * 2500, to: 1200, q: 4, peak: 0.012 + Math.random() * 0.02, attack: 0.003 });
    }, 140);
    rain = { source, swell, gain, drops };
  }

  function stopRain() {
    if (!rain) return;
    const { source, swell, gain, drops } = rain;
    rain = null;
    clearInterval(drops);
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
    source.stop(ctx.currentTime + 0.9); swell.stop(ctx.currentTime + 0.9);
  }

  return {
    pageTurn, bookOpen, bookClose,
    get effects() { return prefs.effects; },
    get rain() { return prefs.rain; },
    toggleEffects() {
      prefs.effects = !prefs.effects;
      try { localStorage.setItem('shelfspace-sound', prefs.effects ? 'on' : 'off'); } catch {}
      if (prefs.effects) pageTurn();
      return prefs.effects;
    },
    toggleRain() {
      prefs.rain = !prefs.rain;
      prefs.rain ? startRain() : stopRain();
      return prefs.rain;
    },
    stopAmbience() { prefs.rain = false; stopRain(); }
  };
})();
