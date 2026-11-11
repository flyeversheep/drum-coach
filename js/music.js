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
