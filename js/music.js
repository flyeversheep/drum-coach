// Music sources that the score can follow: a local audio file, or Apple Music through MusicKit JS.
// Both expose the same small interface: ready, key, title, sub, rate, play(), pause(), isPlaying(),
// getTime(), getDuration(), seek(sec), setRate(r), setVolume(v).
(function () {
  'use strict';
  const DC = window.DC;

  // ---- local file -------------------------------------------------------
  const el = new Audio();
  el.preload = 'auto';
  if ('preservesPitch' in el) el.preservesPitch = true;
  DC.filePlayer = {
    ready: false, key: null, title: '', sub: '', rate: 1, onEnded: null,
    load(file) {
      if (el.src) URL.revokeObjectURL(el.src);
      el.src = URL.createObjectURL(file);
      el.playbackRate = this.rate;
      this.ready = true;
      this.key = 'file:' + file.name;
      this.title = file.name.replace(/\.[^.]+$/, '');
      this.sub = '本地文件';
    },
    unload() {
      el.pause();
      if (el.src) { URL.revokeObjectURL(el.src); el.removeAttribute('src'); el.load(); }
      this.ready = false;
      this.key = null;
    },
    play() { return el.play(); },
    pause() { el.pause(); },
    isPlaying() { return !el.paused && !el.ended && el.readyState > 2; },
    getTime() { return el.currentTime; },
    getDuration() { return isFinite(el.duration) ? el.duration : 0; },
    seek(t) { el.currentTime = t; },
    setRate(r) { this.rate = r; el.playbackRate = r; },
    setVolume(v) { el.volume = v; },
  };
  el.addEventListener('ended', () => DC.filePlayer.onEnded && DC.filePlayer.onEnded());

  // ---- backing tracks remembered per piece -------------------------------
  // The audio files stay on this device, in the browser's own database, keyed by score id.
  const memory = new Map();
  const db = () => new Promise((resolve, reject) => {
    const rq = indexedDB.open('drum-coach', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('tracks');
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const rq = fn(d.transaction('tracks', mode).objectStore('tracks'));
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  };
  DC.tracks = {
    async put(id, file) { memory.set(id, file); try { await tx('readwrite', (s) => s.put(file, id)); } catch (e) { /* kept for this visit only */ } },
    async get(id) { if (memory.has(id)) return memory.get(id); try { return (await tx('readonly', (s) => s.get(id))) || null; } catch (e) { return null; } },
    async del(id) { memory.delete(id); try { await tx('readwrite', (s) => s.delete(id)); } catch (e) { /* ignore */ } },
  };

  // Find where the beat sits in a recording whose tempo is already known.
  // Returns the time of the first sound, nudged onto the beat grid that best fits the whole track.
  DC.findFirstBeat = async function (file, bpm) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const data = await file.arrayBuffer();
    const audio = await new Promise((resolve, reject) => {
      const p = new OAC(1, 1, 44100).decodeAudioData(data, resolve, reject);
      if (p && p.catch) p.catch(reject);
    });
    const sr = audio.sampleRate, hop = Math.round(sr / 86), n = Math.floor(audio.length / hop);
    const chans = [];
    for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
    const env = new Float32Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = i * hop; j < (i + 1) * hop; j++) { let v = 0; for (const ch of chans) v += ch[j]; v /= chans.length; sum += v * v; }
      env[i] = Math.sqrt(sum / hop);
      if (env[i] > max) max = env[i];
    }
    if (!(max > 0)) throw new Error('silent');
    const flux = new Float32Array(n);
    for (let i = 1; i < n; i++) flux[i] = Math.max(0, Math.log1p(200 * env[i] / max) - Math.log1p(200 * env[i - 1] / max));
    let first = 0;
    while (first < n && env[first] < 0.05 * max) first++;
    const t0 = (first * hop) / sr, per = 60 / bpm, dur = (n * hop) / sr;
    let best = t0, bestScore = -1;
    for (let ph = t0 - 0.08; ph <= t0 + 0.08; ph += 0.002) {
      let score = 0;
      for (let t = ph; t < dur; t += per) { const i = Math.round((t * sr) / hop); if (i >= 0 && i < n) score += flux[i]; }
      if (score > bestScore) { bestScore = score; best = ph; }
    }
    return Math.max(0, best);
  };

  // ---- Apple Music ------------------------------------------------------
  const MK_SRC = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
  let mkLoading = null;
  function loadMusicKit() {
    if (window.MusicKit) return Promise.resolve();
    if (mkLoading) return mkLoading;
    mkLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MK_SRC;
      s.async = true;
      const done = () => (window.MusicKit ? resolve() : reject(new Error('load')));
      document.addEventListener('musickitloaded', done, { once: true });
      s.onload = () => setTimeout(done, 1500); // in case the event fired before we listened
      s.onerror = () => reject(new Error('load'));
      document.head.appendChild(s);
    }).catch((e) => { mkLoading = null; throw e; });
    return mkLoading;
  }

  // Read the expiry date out of a developer token without verifying it (display only).
  DC.tokenInfo = function (jwt) {
    try {
      const part = jwt.trim().split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const p = JSON.parse(atob(part + '==='.slice((part.length + 3) % 4)));
      return { exp: p.exp ? new Date(p.exp * 1000) : null, iss: p.iss || '' };
    } catch (e) { return null; }
  };

  DC.apple = {
    music: null, ready: false, key: null, title: '', sub: '', rate: 1, onEnded: null,
    async connect(token) {
      await loadMusicKit();
      await window.MusicKit.configure({ developerToken: token.trim(), app: { name: 'Drum Coach', build: '1.0.0' } });
      this.music = window.MusicKit.getInstance();
      this.music.addEventListener('playbackStateDidChange', () => {
        const PS = window.MusicKit.PlaybackStates;
        if (PS && (this.music.playbackState === PS.ended || this.music.playbackState === PS.completed)) {
          if (this.onEnded) this.onEnded();
        }
      });
      return this.music;
    },
    get authorized() { return !!(this.music && this.music.isAuthorized); },
    async authorize() { await this.music.authorize(); return this.authorized; },
    async search(term, scope) {
      const m = this.music;
      if (scope === 'library') {
        const r = await m.api.music('/v1/me/library/search', { term, types: 'library-songs', limit: 20 });
        const d = r.data.results['library-songs'];
        return d ? d.data : [];
      }
      const sf = m.storefrontCountryCode || m.storefrontId || 'us';
      const r = await m.api.music(`/v1/catalog/${sf}/search`, { term, types: 'songs', limit: 20 });
      const d = r.data.results.songs;
      return d ? d.data : [];
    },
    async load(song) {
      const a = song.attributes || {};
      const pp = a.playParams || {};
      const id = pp.catalogId || pp.id || song.id;
      this.ready = false;
      await this.music.setQueue({ song: id, startPlaying: false });
      this.ready = true;
      this.key = 'apple:' + id;
      this.title = a.name || '';
      this.sub = (a.artistName || '') + (this.authorized ? '' : ' · 未登录，只能播 30 秒试听');
      this.setRate(this.rate);
    },
    play() { return this.music.play(); },
    pause() { return this.music.pause(); },
    isPlaying() {
      const PS = window.MusicKit && window.MusicKit.PlaybackStates;
      return !!(this.music && PS && this.music.playbackState === PS.playing);
    },
    // MusicKit's own clock can update in coarse steps; its <audio> element is smoother when it agrees.
    getTime() {
      const t = this.music.currentPlaybackTime || 0;
      const a = document.getElementById('apple-music-player') || document.querySelector('audio');
      if (a && !a.paused && isFinite(a.currentTime) && Math.abs(a.currentTime - t) < 1.5) return a.currentTime;
      return t;
    },
    getDuration() { return this.music.currentPlaybackDuration || 0; },
    seek(t) { return this.music.seekToTime(t); },
    setRate(r) {
      this.rate = r;
      try { if (this.music) this.music.playbackRate = r; } catch (e) { /* not supported for this item */ }
      // If MusicKit refused, report the speed it is really using so the score stays in step.
      if (this.music && typeof this.music.playbackRate === 'number' && this.music.playbackRate > 0) this.rate = this.music.playbackRate;
      return this.rate;
    },
    setVolume(v) { if (this.music) this.music.volume = v; },
  };
})();
