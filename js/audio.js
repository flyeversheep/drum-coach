// Audio context, metronome click, demo drum sounds, and the microphone hit detector.
(function () {
  'use strict';
  const DC = window.DC;

  // Hit detector. Self-contained on purpose: its source text is also loaded into an AudioWorklet.
  // A hit is a sudden rise, not a loudness level: the sound is split into low / middle / high bands,
  // and in each band a quick-reacting level is compared with a slow-reacting one. While an earlier
  // note is still ringing the two agree, so nothing fires; a new stroke makes the quick one leap ahead,
  // even when the overall volume never dropped below the threshold in between. A kick under a ringing
  // cymbal, or a hi-hat after a loud snare, shows up in its own band.
  function makeDetector(sr) {
    var thr = 0.03, last = -1, px = 0, py = 0, peak = 0, since = 0, pk = 0;
    var REFRACTORY = 0.075, reportEvery = Math.round(sr * 0.04);
    var k = function (fc) { return 1 - Math.exp(-2 * Math.PI * fc / sr); };
    var tc = function (sec) { return 1 - Math.exp(-1 / (sr * sec)); };
    var aLo = k(150), aMid = k(2500), aHi = k(4000), lpLo = 0, lpMid = 0, lpHi = 0;
    var pkDecay = Math.exp(-1 / (sr * 0.004));
    // per band: quick level, slow level, and their time constants
    var fast = [0, 0, 0], slow = [0, 0, 0];
    var aF = [tc(0.015), tc(0.006), tc(0.004)], aS = [tc(0.06), tc(0.045), tc(0.045)];
    var RISE = [2.0, 1.7, 1.7]; // how far the quick level must jump ahead of the slow one, per band
    return {
      setThr: function (v) { thr = v; },
      // x: Float32Array of samples, t: context time of x[0]. Returns null or {onsets:[time...], level}
      process: function (x, t) {
        var out = null;
        for (var i = 0; i < x.length; i++) {
          var y = x[i] - px + 0.995 * py; // remove DC / rumble
          px = x[i]; py = y;
          var a = y < 0 ? -y : y;
          pk = a > pk ? a : pk * pkDecay; // short-lived peak, compared with the sensitivity threshold
          lpLo += aLo * (y - lpLo); lpMid += aMid * (y - lpMid); lpHi += aHi * (y - lpHi);
          var b0 = lpLo, b1 = lpMid - lpLo, b2 = y - lpHi, hit = false;
          for (var n = 0; n < 3; n++) {
            var v = n === 0 ? b0 : n === 1 ? b1 : b2;
            if (v < 0) v = -v;
            fast[n] += aF[n] * (v - fast[n]);
            if (fast[n] > RISE[n] * slow[n] && fast[n] > 0.12 * thr) hit = true;
            slow[n] += aS[n] * (fast[n] - slow[n]);
          }
          if (hit && pk > thr) {
            var ts = t + i / sr;
            if (ts - last > REFRACTORY) {
              last = ts;
              if (!out) out = { onsets: [] };
              out.onsets.push(ts);
            }
          }
          if (a > peak) peak = a;
          if (++since >= reportEvery) {
            if (!out) out = { onsets: [] };
            out.level = peak;
            peak = 0; since = 0;
          }
        }
        return out;
      },
    };
  }
  DC.makeDetector = makeDetector;

  const A = (DC.audio = {
    ctx: null, micOn: false, usingWorklet: false,
    onOnset: null, onLevel: null,
    _thr: 0.03, _stream: null, _node: null, _src: null, _noise: null, _out: null,

    async ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this._out = this.ctx.createGain();
        this._out.gain.value = 0.9;
        this._out.connect(this.ctx.destination);
        const len = this.ctx.sampleRate;
        this._noise = this.ctx.createBuffer(1, len, len);
        const d = this._noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { /* needs a tap */ } }
      return this.ctx;
    },
    outputLatency() {
      const c = this.ctx;
      return c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0;
    },

    click(t, accent) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.frequency.value = accent ? 1760 : 1175;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(accent ? 0.7 : 0.45, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      o.connect(g).connect(this._out);
      o.start(t); o.stop(t + 0.06);
    },
    _tone(t, f0, f1, dur, vol, type) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this._out);
      o.start(t); o.stop(t + dur + 0.02);
    },
    _hiss(t, hp, dur, vol) {
      const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = this._noise;
      f.type = 'highpass'; f.frequency.value = hp;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f).connect(g).connect(this._out);
      s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
    },
    drum(id, t) {
      if (id === 'BD') this._tone(t, 150, 45, 0.28, 0.9);
      else if (id === 'SN') { this._hiss(t, 1200, 0.16, 0.5); this._tone(t, 220, 160, 0.1, 0.35, 'triangle'); }
      else if (id === 'HH') this._hiss(t, 7500, 0.05, 0.3);
      else if (id === 'CR') this._hiss(t, 5000, 0.7, 0.35);
      else if (id === 'T1') this._tone(t, 230, 140, 0.26, 0.6);
      else if (id === 'T2') this._tone(t, 140, 80, 0.32, 0.7);
    },

    setThreshold(v) {
      this._thr = v;
      if (this._node && this._node.port) this._node.port.postMessage({ thr: v });
      if (this._det) this._det.setThr(v);
    },
    _deliver(r) {
      if (!r) return;
      if (r.level != null && this.onLevel) this.onLevel(r.level);
      if (this.onOnset) for (const t of r.onsets) this.onOnset(t);
    },

    async startMic() {
      if (this.micOn) return true;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('insecure');
      }
      await this.ensure();
      // Processing meant for speech smears drum attacks, so turn it all off.
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      await this.ensure();
      const ctx = this.ctx;
      this._src = ctx.createMediaStreamSource(this._stream);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      mute.connect(ctx.destination);
      this._det = null;
      try {
        const code = makeDetector.toString() + `
          class DCOnset extends AudioWorkletProcessor {
            constructor() { super(); this.d = makeDetector(sampleRate); this.port.onmessage = (e) => { if (e.data && e.data.thr != null) this.d.setThr(e.data.thr); }; }
            process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) { const r = this.d.process(ch, currentTime); if (r) this.port.postMessage(r); } return true; }
          }
          registerProcessor('dc-onset', DCOnset);`;
        const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        this._node = new AudioWorkletNode(ctx, 'dc-onset', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        this._node.port.onmessage = (e) => this._deliver(e.data);
        this.usingWorklet = true;
      } catch (err) {
        // Older browsers: same detector on the main thread.
        const sp = ctx.createScriptProcessor(1024, 1, 1);
        const det = (this._det = makeDetector(ctx.sampleRate));
        sp.onaudioprocess = (e) => {
          const x = e.inputBuffer.getChannelData(0);
          this._deliver(det.process(x, ctx.currentTime - x.length / ctx.sampleRate));
        };
        this._node = sp;
        this.usingWorklet = false;
      }
      this._src.connect(this._node);
      this._node.connect(mute);
      this.setThreshold(this._thr);
      this.micOn = true;
      return true;
    },
    stopMic() {
      if (!this.micOn) return;
      try { this._src.disconnect(); this._node.disconnect(); } catch (e) { /* already gone */ }
      this._stream.getTracks().forEach((tr) => tr.stop());
      this._stream = this._src = this._node = this._det = null;
      this.micOn = false;
    },
  });
})();
