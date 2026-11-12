// Practice engine and UI wiring.
// Positions are measured in sixteenth-note "steps". A clock maps audio-context time <-> step position,
// so the metronome, a local file and Apple Music all drive the same playhead and judging code.
(function () {
  'use strict';
  const DC = window.DC, A = DC.audio;
  const $ = (id) => document.getElementById(id);
  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('dc:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('dc:' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ---- state ------------------------------------------------------------
  const S = Object.assign(
    { bpm: 76, mode: 'tempo', source: 'ext', metro: true, countIn: true, demo: false, sens: 55, cal: null, judge: 'std', scoreId: 'rock8', songOffset: 0, vol: 0.8, autoRestart: true, trackKind: 'demo' },
    store.get('settings', {})
  );
  S.running = false;
  // One-time switch for devices set up before "music from another app" became the default source.
  if (!S.extDefault) { S.source = 'ext'; S.extDefault = true; }
  const saveSettings = () => {
    const { running, ...keep } = S;
    store.set('settings', keep);
  };
  let custom = store.get('scores', []).map(DC.cloneScore);
  const saveCustom = () => store.set('scores', custom);
  // Copy newly shipped pieces into "my scores" once, so they can be edited in place and deleted for good.
  (function seedPieces() {
    const seen = store.get('seededPieces', []);
    const fresh = DC.PIECES.filter((p) => !seen.includes(p.id) && !custom.some((s) => s.id === p.id));
    if (!fresh.length) return;
    fresh.forEach((p) => custom.push(DC.cloneScore(p)));
    saveCustom();
    store.set('seededPieces', seen.concat(fresh.map((p) => p.id)));
  })();
  const allScores = () => DC.PRESETS.concat(custom);

  let score = null, view = null, total = 16, minGap = 4, markAbs = [];
  let clock = null;
  const sched = { next: null };
  const judge = { done: new Map(), cursor: null };
  const stats = { good: 0, early: 0, late: 0, miss: 0, extra: 0, combo: 0, devs: [] };
  const follow = { i: 0, lastT: null, gap: 0, est: [], laps: 0 };
  let calib = null;
  let wakeLock = null;
  // GOOD_MS: how close a hit must be to count as on time.
  // REACH_MS: the furthest a hit may be from a note and still count as that note played early or late.
  const GOOD_MS = { easy: 100, std: 65, hard: 40 };
  const REACH_MS = { easy: 350, std: 250, hard: 150 };
  // After this many seconds without a hit the tracker goes back to the first note and waits there.
  const PAUSE_SEC = 5;
  const pause = { wait: false, lastOnset: 0, missRun: 0 };

  // "Free-running" sources have no music of their own to follow: the metronome, and music playing in another app.
  const free = () => S.source === 'metro' || S.source === 'ext';
  const provider = () => (S.source === 'apple' ? DC.apple : S.source === 'file' ? DC.filePlayer : null);
  const calSec = () => (S.cal == null ? 0.06 : S.cal / 1000);

  // ---- clocks -----------------------------------------------------------
  function metroClock(t0) {
    return {
      active: true, t0,
      update() {},
      posAt(t) { return (t - this.t0) * S.bpm / 15; },
      timeAt(pos) { return this.t0 + pos * 15 / S.bpm; },
      stepMs() { return 15000 / S.bpm; },
      rebase(oldBpm) { // keep the current position when the tempo changes mid-run
        const now = A.ctx.currentTime;
        const pos = (now - this.t0) * oldBpm / 15;
        this.t0 = now - pos * 15 / S.bpm;
      },
    };
  }
  function mediaClock(p) {
    let off = null; // media time minus (context time * rate), smoothed
    return {
      active: false,
      update(now) {
        this.active = p.isPlaying();
        if (!this.active) { off = null; return; }
        const raw = p.getTime() - now * p.rate;
        if (off == null || Math.abs(raw - off) > 0.08) off = raw; else off += (raw - off) * 0.08;
      },
      posAt(t) { return (t * p.rate + off - S.songOffset) * S.bpm / 15; },
      timeAt(pos) { return (pos * 15 / S.bpm + S.songOffset - off) / p.rate; },
      stepMs() { return 15000 / S.bpm / p.rate; },
    };
  }
  // Is a note expected on this absolute step? (Nothing is expected during the count-in.)
  // Nothing is expected before the first bar: that time is the count-in.
  const expectedAt = (abs) => abs >= 0 && view.cols[mod(abs, total)].length > 0;

  // ---- score ------------------------------------------------------------
  function barsPerRow() {
    const w = $('score').clientWidth;
    return w >= 1500 ? 4 : w >= 620 ? 2 : 1;
  }
  let lastBpr = 0;
  function rebuild() {
    lastBpr = barsPerRow();
    view = DC.renderScore($('score'), score, lastBpr);
    total = view.total;
    markAbs = new Array(total).fill(null);
    minGap = total;
    view.notes.forEach((s, i) => {
      const nx = view.notes[(i + 1) % view.notes.length];
      minGap = Math.min(minGap, mod(nx - s, total) || total);
    });
    if (S.running && S.mode === 'follow' && view.notes.length) {
      follow.i = Math.min(follow.i, view.notes.length - 1);
      view.setCursor(view.notes[follow.i]);
    }
    if (S.running && pause.wait && view.notes.length) view.setCursor(view.notes[0]);
  }
  function fillScoreSelect() {
    const sel = $('scoreSel');
    sel.textContent = '';
    const g1 = document.createElement('optgroup'); g1.label = '入门课程';
    DC.PRESETS.forEach((s) => g1.appendChild(new Option(s.name, s.id)));
    sel.appendChild(g1);
    const bookOf = (s) => DC.PIECE_BOOKS[s.id.split('-')[0]] || '我的谱子';
    const groups = new Map();
    custom.forEach((s) => { const k = bookOf(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
    [...Object.values(DC.PIECE_BOOKS), '我的谱子'].forEach((label) => {
      if (!groups.has(label)) return;
      const g = document.createElement('optgroup'); g.label = label;
      groups.get(label).forEach((s) => g.appendChild(new Option(s.name, s.id)));
      sel.appendChild(g);
    });
    sel.value = score ? score.id : S.scoreId;
  }
  function loadScore(id, keepBpm) {
    if (S.running) stop();
    score = allScores().find((s) => s.id === id) || DC.PRESETS[3];
    S.scoreId = score.id;
    $('scoreSel').value = score.id;
    // With outside music the tempo always comes from the piece (the speed printed in the book).
    if ((S.source === 'ext' || (!keepBpm && free())) && score.bpm) setBpm(score.bpm, true);
    rebuild();
    showTip();
    if (S.source === 'file') loadTrackFor(score.id);
    edBar = Math.min(edBar, score.bars.length - 1);
    renderEditor();
    saveSettings();
  }
  function showTip() {
    const empty = !view.notes.length;
    const tip = empty ? '这份谱子还没有音符。打开下面的「编辑谱子」，照着书把音符点进去，会自动保存在这台设备上。' : score.tip || '';
    $('scoreTip').textContent = tip;
    $('scoreTip').hidden = !tip;
    if (empty) $('editor').open = true;
  }

  // ---- feedback ---------------------------------------------------------
  function say(text, cls) {
    const v = $('verdict');
    v.textContent = text;
    v.className = 'verdict' + (cls ? ' ' + cls : '');
  }
  let toastTimer = 0;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 7000);
  }
  function scoreNow() {
    const n = stats.good + stats.early + stats.late + stats.miss;
    return n ? Math.round((100 * (stats.good + 0.5 * (stats.early + stats.late))) / n) : null;
  }
  function showStats() {
    $('stGood').textContent = stats.good;
    $('stEarly').textContent = stats.early;
    $('stLate').textContent = stats.late;
    $('stMiss').textContent = stats.miss;
    $('stExtra').textContent = stats.extra;
    const sc = scoreNow();
    $('stScore').textContent = sc == null || S.mode === 'follow' ? '–' : sc;
  }
  function resetStats() {
    Object.assign(stats, { good: 0, early: 0, late: 0, miss: 0, extra: 0, combo: 0, devs: [] });
    $('gaugeDot').hidden = true;
    showStats();
  }
  // A hit belongs to the note it is nearest to: on each side a note "owns" half the gap to its
  // neighbour, up to REACH_MS. Only a note nobody played near is a miss.
  function sideLimit(abs, dir) { // in steps; dir = -1 for early hits, +1 for late hits
    let gap = total;
    for (let k = 1; k <= total; k++) if (expectedAt(abs + dir * k)) { gap = k; break; }
    return Math.min((REACH_MS[S.judge] || 250) / clock.stepMs(), gap / 2);
  }
  // Typical window for this score, used to scale the early/late gauge.
  function winMs() { return Math.min(REACH_MS[S.judge] || 250, minGap * clock.stepMs() * 0.5); }
  function goodMs() { return Math.min(GOOD_MS[S.judge] || 65, winMs() * 0.6); }
  function showGauge(dms) {
    const w = winMs(), g = goodMs();
    $('gaugeZone').style.left = 50 - (g / w) * 50 + '%';
    $('gaugeZone').style.width = (g / w) * 100 + '%';
    const d = $('gaugeDot');
    d.hidden = false;
    d.style.left = 50 + clamp(dms / w, -1, 1) * 50 + '%';
  }
  function record(abs, res, dms) {
    judge.done.set(abs, res);
    if (judge.done.size > 600) for (const k of judge.done.keys()) { if (k < abs - 4 * total) judge.done.delete(k); }
    stats[res]++;
    pause.missRun = res === 'miss' ? pause.missRun + 1 : 0;
    const step = mod(abs, total);
    view.setMark(step, res);
    markAbs[step] = abs;
    if (res === 'good') {
      stats.combo++;
      say(stats.combo >= 8 ? `连续 ${stats.combo} 下都准！` : '准！', 'good');
    } else {
      stats.combo = 0;
      if (res === 'early') say('早了一点', 'off');
      else if (res === 'late') say('晚了一点', 'off');
      else say('漏了一下', 'miss');
    }
    if (dms != null) { stats.devs.push(dms); showGauge(dms); }
    showStats();
  }

  // ---- microphone hits --------------------------------------------------
  let ledTimer = 0;
  function onOnset(t) {
    DC._onsets.push(t);
    if (DC._onsets.length > 400) DC._onsets.shift();
    const led = $('hitLed');
    led.classList.add('on');
    clearTimeout(ledTimer);
    ledTimer = setTimeout(() => led.classList.remove('on'), 110);
    if (calib) { calib.onsets.push(t); return; }
    if (!S.running) return;
    pause.lastOnset = t;
    if (S.mode === 'follow') return followHit(t);
    if (pause.wait) return restartOnHit(t);
    if (!clock || !clock.active) return;

    const hp = clock.posAt(t - calSec());
    const sm = clock.stepMs();
    const reach = Math.ceil((REACH_MS[S.judge] || 250) / sm) + 1;
    let best = null, bd = Infinity;
    for (let a = Math.floor(hp) - reach; a <= Math.ceil(hp) + reach; a++) {
      if (!expectedAt(a) || judge.done.has(a)) continue;
      const d = Math.abs(a - hp);
      if (d < bd) { bd = d; best = a; }
    }
    const limit = best == null ? 0 : sideLimit(best, hp >= best ? 1 : -1);
    if (best != null && bd <= limit + 1e-6) {
      const dms = (hp - best) * sm;
      const good = Math.min(GOOD_MS[S.judge] || 65, limit * sm * 0.6);
      record(best, Math.abs(dms) <= good ? 'good' : dms < 0 ? 'early' : 'late', dms);
      // With outside music the grid was placed by the player's first hit; let it settle onto their playing.
      if (S.source === 'ext' && clock.t0 != null) clock.t0 += (dms / 1000) * 0.15;
    } else if (hp > -0.5 || !free()) {
      stats.extra++;
      showStats();
    }
  }
  function followHit(t) {
    const notes = view.notes;
    if (!notes.length) return;
    const s = notes[follow.i];
    view.setMark(s, 'good');
    stats.good++;
    if (follow.lastT != null) {
      const dt = t - follow.lastT;
      if (dt < 3) {
        follow.est.push((follow.gap / 4 / dt) * 60);
        if (follow.est.length > 6) follow.est.shift();
      } else follow.est.length = 0;
    }
    follow.lastT = t;
    const ni = (follow.i + 1) % notes.length;
    follow.gap = mod(notes[ni] - s, total) || total;
    if (ni === 0) follow.laps++;
    follow.i = ni;
    // wipe old marks just ahead of the cursor so a new lap starts clean
    view.clearMark(notes[ni]);
    if (notes.length > 3) view.clearMark(notes[(ni + 1) % notes.length]);
    view.setCursor(notes[ni]);
    if (follow.est.length >= 3) {
      const m = median(follow.est);
      const spread = (Math.max(...follow.est) - Math.min(...follow.est)) / m;
      say(`你的速度 ≈ ${Math.round(m)} BPM · ${spread < 0.15 ? '很稳！' : '有点忽快忽慢'}`, spread < 0.15 ? 'good' : 'off');
    } else say(follow.laps ? `第 ${follow.laps + 1} 遍` : '对，就这样往下打', 'good');
    showStats();
  }

  // ---- restart after a pause --------------------------------------------
  // The mic cannot tell where in a piece the player is (many bars sound alike), so the rule is simple:
  // a long silence means "starting over", and tracking resumes from the first note.
  function followBackToStart() {
    Object.assign(follow, { i: 0, lastT: null, gap: 0, est: [] });
    view.clearMarks();
    view.setCursor(view.notes[0]);
    say('停了一会儿，从头再来：打第一个音');
  }
  function waitForHit(msg) {
    pause.wait = true;
    view.clearMarks();
    markAbs.fill(null);
    view.setPlayhead(null);
    view.setCursor(view.notes[0]);
    say(msg || (S.source === 'ext' ? '停了一会儿。把音乐倒回开头，再打第一下，我就跟上' : '停了一会儿，从头再来：你打第一下，我就跟上'));
  }
  // The "start over" button: the same reset, on demand.
  function restartNow() {
    if (!S.running) return;
    if (S.mode === 'follow') { followBackToStart(); say('从头再来：打第一个音'); return; }
    if (free()) { waitForHit(S.source === 'ext' ? '把音乐倒回开头，再打第一下，我就跟上' : '从头再来：你打第一下，我就跟上'); return; }
    const p = provider();
    try { if (p && p.ready) p.seek(0); } catch (e) { /* ignore */ }
    resetStats(); view.clearMarks(); markAbs.fill(null); judge.done.clear(); judge.cursor = null; sched.next = null;
    say('从头再来');
  }
  function restartOnHit(t) {
    pause.wait = false;
    resetStats();
    judge.done.clear();
    judge.cursor = null;
    sched.next = null;
    const first = view.notes[0];
    clock = metroClock(t - calSec() - (first * 15) / S.bpm); // the hit just heard is the first note, exactly on time
    view.setCursor(null);
    record(first, 'good', 0);
  }

  // ---- engine loop ------------------------------------------------------
  function scheduleStep(abs, t) {
    if (S.source === 'ext') return; // any sound from this page would fight the other app for the speaker
    if (S.metro && mod(abs, 4) === 0) A.click(t, mod(abs, 16) === 0);
    if (S.demo && expectedAt(abs)) view.cols[mod(abs, total)].forEach((id) => A.drum(id, t));
  }
  function tick() {
    if (!S.running) return;
    const now = A.ctx.currentTime;
    if (S.mode === 'follow') {
      if (S.autoRestart && follow.i !== 0 && follow.lastT != null && now - follow.lastT >= PAUSE_SEC) followBackToStart();
      return;
    }
    if (!clock || pause.wait) return;
    clock.update(now);
    if (!clock.active) return;
    const pos = clock.posAt(now);

    if (sched.next == null || sched.next < pos - 1 || sched.next > pos + 16) sched.next = Math.ceil(pos);
    while (clock.timeAt(sched.next) < now + 0.15) {
      const t = clock.timeAt(sched.next);
      if (t > now - 0.005) scheduleStep(sched.next, Math.max(t, now));
      sched.next++;
    }

    if (!A.micOn) return;
    // A note counts as missed once its window has passed, allowing for the mic's reporting delay.
    const lag = clock.posAt(now - calSec() - 0.06);
    if (judge.cursor == null || Math.abs(judge.cursor - lag) > 16) judge.cursor = Math.ceil(pos);
    while (judge.cursor < lag) {
      const c = judge.cursor;
      if (expectedAt(c)) {
        if (c + sideLimit(c, 1) >= lag) break; // a late hit could still arrive for this note
        if (!judge.done.has(c)) record(c, 'miss', null);
      }
      judge.cursor++;
    }
    // Only with the metronome: a song keeps playing, so its position cannot follow the player.
    if (S.autoRestart && free() && pause.missRun >= 2 && now - Math.max(pause.lastOnset, clock.timeAt(0)) >= PAUSE_SEC) waitForHit();
  }
  let meterPeak = 0, lastSeekUi = 0;
  function draw() {
    requestAnimationFrame(draw);
    meterPeak *= 0.9;
    $('meterFill').style.width = levelFrac(meterPeak) * 100 + '%';
    const p = provider();
    const nowMs = performance.now();
    if (p && p.ready && nowMs - lastSeekUi > 250 && !seeking) {
      lastSeekUi = nowMs;
      const d = p.getDuration(), t = p.getTime();
      if (d) { $('songSeek').max = d; $('songDur').textContent = fmt(d); }
      $('songSeek').value = t;
      $('songCur').textContent = fmt(t);
    }
    if (!S.running || S.mode !== 'tempo' || !clock || !view || pause.wait) return;
    if (!clock.active) { view.setPlayhead(null); return; }
    const pos = clock.posAt(A.ctx.currentTime);
    if (pos < 0) {
      view.setPlayhead(null);
      say(free() ? '预备… ' + clamp(Math.floor((pos + 16) / 4) + 1, 1, 4) : pos > -32 ? '预备… ' + (Math.floor((pos + 32) / 4) % 4 + 1) : '预备，听音乐');
      return;
    }
    if ($('verdict').textContent.startsWith('预备')) say(A.micOn ? '开始！' : '跟着蓝线打（没开麦克风，不计分）');
    view.setPlayhead(mod(pos, total));
    // erase last lap's marks just before the playhead reaches them again
    for (const s of view.notes) {
      if (markAbs[s] == null) continue;
      const up = s + total * Math.ceil((pos - 2 - s) / total);
      if (markAbs[s] < up && up - pos < 2.5) { view.clearMark(s); markAbs[s] = null; }
    }
  }

  async function ensureMic() {
    if (A.micOn) return true;
    try {
      await A.startMic();
    } catch (e) {
      const insecure = e.message === 'insecure' || !window.isSecureContext;
      toast(insecure ? '浏览器只允许 https 或 http://localhost 的页面用麦克风，请按 README 的方法打开本页面。'
        : e.name === 'NotAllowedError' ? '没有麦克风权限。请在浏览器地址栏旁边允许使用麦克风，然后再试一次。'
        : '打不开麦克风：' + (e.message || e.name));
      showMic();
      return false;
    }
    if (S.cal == null) { S.cal = Math.round(clamp(A.outputLatency() * 1000 + 25, 30, 250)); $('cal').value = S.cal; saveSettings(); }
    showMic();
    return true;
  }
  function showMic() {
    $('micBtn').textContent = A.micOn ? '关闭麦克风' : '打开麦克风';
    $('micState').textContent = A.micOn ? '正在听，敲一下试试，绿灯会亮' : '还没打开';
  }

  async function start() {
    if (S.running) return;
    if (!view.notes.length) { toast('这份谱子还是空的，先在下面「编辑谱子」里点几个音符。'); return; }
    await A.ensure();
    const p = provider();
    if (S.mode === 'tempo' && !free() && !(p && p.ready)) {
      toast(S.source === 'apple' ? '先在「伴奏音乐」里连接 Apple Music 并选一首歌。' : '先在「伴奏音乐」里选一个音频文件。');
      return;
    }
    const mic = await ensureMic();
    if (S.mode === 'follow' && !mic) return;
    resetStats();
    view.clearMarks();
    markAbs.fill(null);
    judge.done.clear();
    judge.cursor = null;
    sched.next = null;
    Object.assign(pause, { wait: false, lastOnset: 0, missRun: 0 });
    if (S.mode === 'follow') {
      Object.assign(follow, { i: 0, lastT: null, gap: 0, est: [], laps: 0 });
      view.setPlayhead(null);
      view.setCursor(view.notes[0]);
      say('打亮着的那一个音，打对了它就往前走');
    } else if (S.source === 'ext') {
      // Music plays in another app, so there is nothing to sync to: stay silent and start on the first hit.
      clock = null;
      waitForHit('先在另一个 App 里把音乐放起来，然后打第一下，我就开始跟');
    } else if (S.source === 'metro') {
      const lead = S.countIn ? 4 : 0;
      clock = metroClock(A.ctx.currentTime + 0.15 + (lead * 60) / S.bpm);
      sched.next = -lead * 4;
      judge.cursor = 0;
      say(lead ? '预备… 1' : '开始！');
    } else {
      clock = mediaClock(p);
      p.setVolume(S.vol);
      try { await p.play(); } catch (e) { toast('播放不了：' + (e.message || e.name || e)); return; }
      say(A.micOn ? '跟着音乐打' : '跟着蓝线打（没开麦克风，不计分）');
    }
    S.running = true;
    $('startBtn').textContent = '■ 停止';
    $('againBtn').hidden = false;
    $('startBtn').classList.add('on');
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
  }
  function stop(ended) {
    if (!S.running) return;
    S.running = false;
    const p = provider();
    if (S.mode === 'tempo' && p && p.ready && !ended) { try { p.pause(); } catch (e) { /* ignore */ } }
    if (view) { view.setPlayhead(null); view.setCursor(null); }
    $('startBtn').textContent = '▶ 开始';
    $('againBtn').hidden = true;
    $('startBtn').classList.remove('on');
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
    const n = stats.good + stats.early + stats.late + stats.miss;
    if (S.mode === 'follow') say(stats.good ? `打了 ${stats.good} 个音，真棒！` : '按「开始」，跟着谱子打');
    else if (n) {
      const avg = stats.devs.length ? stats.devs.reduce((a, b) => a + b, 0) / stats.devs.length : 0;
      const lean = Math.abs(avg) < 15 ? '快慢刚刚好' : avg < 0 ? `整体偏早 ${Math.round(-avg)} 毫秒，别着急`
        : avg >= 70 ? `整体偏晚 ${Math.round(avg)} 毫秒（每次都偏晚这么多的话，先做一次「自动校准」）` : `整体偏晚 ${Math.round(avg)} 毫秒，再跟紧一点`;
      say(`${n} 个音里准了 ${stats.good} 个，得分 ${scoreNow()} · ${lean}`, scoreNow() >= 80 ? 'good' : '');
    } else say('按「开始」，跟着谱子打');
  }

  // ---- tempo ------------------------------------------------------------
  function setBpm(v, silent) {
    v = clamp(Math.round(Number(v) * 10) / 10 || 76, 30, 240);
    const old = S.bpm;
    S.bpm = v;
    $('bpm').value = v;
    if (S.running && S.mode === 'tempo' && free() && clock && clock.rebase) { clock.rebase(old); sched.next = null; }
    if (!silent) {
      if (free() && score && !score.preset) { score.bpm = v; saveCustom(); }
      saveSongSync();
    }
    saveSettings();
  }
  const taps = [];
  function tap() {
    const wall = performance.now() / 1000;
    if (taps.length && wall - taps[taps.length - 1].wall > 2.5) taps.length = 0;
    const p = provider();
    const playing = !free() && p && p.ready && p.isPlaying();
    taps.push({ wall, media: playing ? p.getTime() : null });
    if (taps.length > 16) taps.shift();
    const n = taps.length;
    $('tapBtn').textContent = n < 3 ? `点拍子（${n}）` : `点拍子（${n}）`;
    clearTimeout(tap.timer);
    tap.timer = setTimeout(() => { $('tapBtn').textContent = '点拍子'; }, 2600);
    if (n < 3) return;
    const useMedia = taps.every((x) => x.media != null);
    const ts = taps.map((x) => (useMedia ? x.media : x.wall));
    // least-squares line through (tap index, time): slope = one beat
    const mi = (n - 1) / 2, mt = ts.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    ts.forEach((t, i) => { num += (i - mi) * (t - mt); den += (i - mi) * (i - mi); });
    const beat = num / den;
    if (!(beat > 0.2 && beat < 2.2)) return;
    setBpm(Math.round(60 / beat));
    if (useMedia && n >= 4) {
      const b = 60 / S.bpm;
      setSongOffset(ts.reduce((a, t, i) => a + (t - i * b), 0) / n);
    }
  }

  // ---- song sync --------------------------------------------------------
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  let seeking = false;
  function saveSongSync() {
    const p = provider();
    if (p && p.ready && p.key) store.set('song:' + p.key, { bpm: S.bpm, offset: S.songOffset });
  }
  function setSongOffset(v) {
    S.songOffset = Math.round((Number(v) || 0) * 1000) / 1000;
    $('songOffset').value = S.songOffset.toFixed(2);
    judge.cursor = null;
    saveSongSync();
    saveSettings();
  }
  // ---- backing track files, one per piece --------------------------------
  const COUNT_IN_BARS = 2; // the book's recordings all start with a two-bar count-in
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  function scoreForFile(name) {
    const n = norm(name);
    return custom.find((sc) => { const m = sc.name.match(/·\s*(.+?)\s*–/); const t = m ? norm(m[1]) : ''; return t.length >= 4 && n.includes(t); }) || null;
  }
  // Each piece can hold three recordings: the demo (with drums), the backing track with a click,
  // and the backing track without one.
  const KIND_NAME = { demo: '示范（带鼓）', click: '伴奏 + 滴答声', backing: '伴奏（无滴答声）' };
  const KINDS = Object.keys(KIND_NAME);
  const kindOfFile = (name) => {
    const n = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    if (/without click|no click|minus click/.test(n)) return 'backing';
    if (/with click/.test(n)) return 'click';
    if (/backing/.test(n)) return 'backing';
    return /demo|full|with drum/.test(n) ? 'demo' : null;
  };
  // Older versions saved files under the bare score id (demo) and put every backing file in one slot,
  // so look there too and go by the file's own name.
  const getTrack = async (id, kind) => {
    const own = await DC.tracks.get(id + '|' + kind);
    if (own && !(kind === 'backing' && kindOfFile(own.name) === 'click')) return own;
    if (kind === 'demo') return DC.tracks.get(id);
    const old = await DC.tracks.get(id + '|backing');
    return old && kindOfFile(old.name) === kind ? old : null;
  };
  async function loadTrackFor(id) {
    const kind = S.trackKind;
    const all = await Promise.all(KINDS.map((k) => getTrack(id, k)));
    const f = all[KINDS.indexOf(kind)];
    if (S.source !== 'file' || !score || score.id !== id || S.trackKind !== kind) return;
    document.querySelectorAll('#kindSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
    const missing = KINDS.filter((k, i) => !all[i]).map((k) => KIND_NAME[k]);
    const have = missing.length ? `还没添加：${missing.join('、')}。` : '三个版本都已添加。';
    if (f) {
      DC.filePlayer.load(f);
      onSongLoaded(DC.filePlayer, f);
      $('fileState').textContent = `正在用「${KIND_NAME[kind]}」：${f.name}。${have}`;
    } else {
      DC.filePlayer.unload();
      $('songBar').hidden = true;
      if (score.bpm) setBpm(score.bpm, true);
      $('fileState').textContent = `这首曲子还没有「${KIND_NAME[kind]}」的文件，在上面添加。${have}`;
    }
  }
  function setTrackKind(kind) {
    if (S.running) stop();
    S.trackKind = kind;
    saveSettings();
    if (score) loadTrackFor(score.id);
  }
  async function addFiles(files) {
    if (S.running) stop();
    const lines = [];
    let jump = null;
    for (const f of files) {
      const sc = scoreForFile(f.name) || (files.length === 1 ? score : null);
      if (!sc) { lines.push(`${f.name}：没找到名字对得上的曲目，先选好曲目再单独添加这个文件`); continue; }
      const kind = kindOfFile(f.name) || S.trackKind;
      await DC.tracks.put(sc.id + '|' + kind, f);
      lines.push(`${f.name} → ${sc.name} 的「${KIND_NAME[kind]}」`);
      if (!jump || sc.id === score.id) jump = sc.id;
      if (files.length === 1) S.trackKind = kind;
    }
    saveSettings();
    toast(lines.join('；'));
    if (jump && jump !== score.id) loadScore(jump); else loadTrackFor(score.id);
  }
  async function autoSync(p, file) {
    const bpm = (score && score.bpm) || S.bpm;
    try {
      // A backing track without the click has no count-in to listen for, so borrow the timing of the
      // demo of the same piece when there is one (the two recordings share a timeline).
      const demo = S.trackKind !== 'demo' ? await getTrack(score.id, 'demo') : null;
      if (demo) {
        const sv = store.get('song:file:' + demo.name, null);
        const off = sv ? sv.offset : (await DC.findFirstBeat(demo, bpm)) + (COUNT_IN_BARS * 4 * 60) / bpm;
        if (p.key !== 'file:' + file.name) return;
        setBpm(sv ? sv.bpm : bpm, true);
        setSongOffset(off);
        toast(`已按示范版对拍：第 1 小节从 ${S.songOffset.toFixed(2)} 秒开始。${S.trackKind === 'backing' ? '这个版本没有预备拍的滴答声，看屏幕上的「预备… 1 2 3 4」或打开「节拍器」来数拍。' : ''}不准就用 − / + 微调。`);
        return;
      }
      const first = await DC.findFirstBeat(file, bpm);
      if (p.key !== 'file:' + file.name) return;
      setBpm(bpm, true);
      setSongOffset(first + (COUNT_IN_BARS * 4 * 60) / bpm);
      toast(`已自动对拍：速度 ${bpm}，第 1 小节从 ${S.songOffset.toFixed(2)} 秒开始（按 ${COUNT_IN_BARS} 小节预备拍推算）。打开「节拍器」可以听是否对齐，不准就用「第 1 拍在」旁边的 − / + 微调。`);
    } catch (e) {
      toast('这个文件读不出声音，可能不是音频文件，或者格式不支持（请用 mp3、m4a 或 wav）。如果能正常播放，就按「开始」放起来，再跟着音乐按「点拍子」8 下对拍。');
    }
  }

  function onSongLoaded(p, file) {
    $('songBar').hidden = false;
    $('songTitle').textContent = p.title || '（没有名字）';
    $('songSub').textContent = p.sub || '';
    const sv = store.get('song:' + p.key, null);
    if (sv) { setBpm(sv.bpm, true); S.songOffset = sv.offset || 0; } else S.songOffset = 0;
    $('songOffset').value = S.songOffset.toFixed(2);
    p.setVolume(S.vol);
    const r = p.setRate(Number($('songRate').value)) || p.rate;
    if (Math.abs(r - Number($('songRate').value)) > 0.01) $('songRate').value = '1';
    if (!sv && file) autoSync(p, file);
    else if (!sv) toast('新歌：先按「开始」放起来，再跟着音乐按「点拍子」8 下对拍子。');
  }
  function setSource(src) {
    if (S.running) stop();
    S.source = src;
    document.querySelectorAll('#srcSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.src === src)));
    $('paneMetro').hidden = src !== 'metro';
    $('paneExt').hidden = src !== 'ext';
    $('paneApple').hidden = src !== 'apple';
    $('paneFile').hidden = src !== 'file';
    const p = provider();
    $('songBar').hidden = !(p && p.ready);
    if (src === 'file' && score) loadTrackFor(score.id);
    else if (p && p.ready) onSongLoaded(p);
    if (src === 'ext' && score && score.bpm) setBpm(score.bpm, true);
    $('bpmLbl').textContent = src === 'metro' ? '速度' : '歌曲速度';
    $('optCount').disabled = src !== 'metro';
    $('optMetro').disabled = $('optDemo').disabled = src === 'ext';
    saveSettings();
  }
  function setMode(m) {
    if (S.running) stop();
    S.mode = m;
    document.querySelectorAll('#modeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    $('gauge').style.visibility = m === 'follow' ? 'hidden' : '';
    say(m === 'follow' ? '不赶时间：打对一个，往前走一个' : '按「开始」，跟着谱子打');
    showStats();
    saveSettings();
  }

  // ---- mic settings -----------------------------------------------------
  const thrFromSens = (s) => Math.pow(10, (-6 - (s / 100) * 44) / 20);
  const levelFrac = (lin) => clamp((20 * Math.log10(Math.max(lin, 1e-6)) + 60) / 60, 0, 1);
  function setSens(v) {
    S.sens = clamp(Number(v), 0, 100);
    $('sens').value = S.sens;
    const thr = thrFromSens(S.sens);
    A.setThreshold(thr);
    $('meterThr').style.left = levelFrac(thr) * 100 + '%';
    saveSettings();
  }
  async function calibrate() {
    if (calib) return;
    if (S.running) stop();
    if (!(await ensureMic())) return;
    const n = 10, iv = 0.6, ctx = A.ctx, t0 = ctx.currentTime + 0.5;
    calib = { onsets: [] };
    $('calBtn').disabled = true;
    $('calMsg').textContent = '正在校准：安静听 10 下滴答声（戴耳机的话，跟着每一下拍手）…';
    for (let i = 0; i < n; i++) A.click(t0 + i * iv, false);
    await new Promise((r) => setTimeout(r, (0.5 + n * iv + 0.5) * 1000));
    const ons = calib.onsets;
    calib = null;
    $('calBtn').disabled = false;
    const ds = [];
    for (let i = 2; i < n; i++) {
      const c = t0 + i * iv;
      let best = null;
      for (const o of ons) { const d = o - c; if (d > -0.15 && d < 0.4 && (best == null || Math.abs(d) < Math.abs(best))) best = d; }
      if (best != null) ds.push(best);
    }
    if (ds.length < 5) {
      $('calMsg').textContent = '没听清滴答声。把音量开大、灵敏度调高，或戴着耳机跟着拍手，再试一次。';
      return;
    }
    S.cal = Math.round(clamp(median(ds) * 1000, 0, 500));
    $('cal').value = S.cal;
    saveSettings();
    $('calMsg').textContent = `校准好了：声音延迟约 ${S.cal} 毫秒（听到了 ${ds.length}/8 下）。换耳机或音箱后请重新校准。`;
  }

  // ---- Apple Music UI ---------------------------------------------------
  function showTokenInfo() {
    const tok = $('appleToken').value.trim();
    const info = tok ? DC.tokenInfo(tok) : null;
    $('appleTokenInfo').textContent = !tok ? '' : !info ? '这看起来不像一个令牌' : info.exp
      ? (info.exp < new Date() ? '令牌已过期：' : '令牌有效期到 ') + info.exp.toLocaleDateString('zh-CN') : '';
  }
  function showAppleStatus() {
    $('appleStatus').textContent = DC.apple.authorized ? '已登录 Apple Music，可以播整首歌' : '已连接，未登录：只能播 30 秒试听';
    $('appleAuth').hidden = DC.apple.authorized;
  }
  async function appleConnect() {
    const tok = $('appleToken').value.trim();
    if (!tok) { toast('先把开发者令牌粘贴进来。'); return; }
    const btn = $('appleConnect');
    btn.disabled = true; btn.textContent = '连接中…';
    try {
      await DC.apple.connect(tok);
      store.set('appleToken', tok);
      $('appleSetup').hidden = true;
      $('appleMain').hidden = false;
      showAppleStatus();
    } catch (e) {
      toast(e.message === 'load' ? '加载不了 Apple 的 MusicKit 脚本，请检查网络（必须通过 http://localhost 或 https 打开本页面）。'
        : '连接失败，请检查令牌是否正确、是否过期：' + (e.message || e));
    }
    btn.disabled = false; btn.textContent = '连接 Apple Music';
  }
  async function appleSearch(ev) {
    ev.preventDefault();
    const q = $('appleQuery').value.trim();
    if (!q) return;
    const ul = $('appleResults');
    ul.textContent = '';
    ul.appendChild(Object.assign(document.createElement('li'), { className: 'muted small', textContent: '搜索中…' }));
    let songs;
    try {
      songs = await DC.apple.search(q, $('appleScope').value);
    } catch (e) {
      ul.firstChild.textContent = $('appleScope').value === 'library' && !DC.apple.authorized
        ? '搜资料库要先登录 Apple Music。' : '搜索失败：' + (e.message || e) + '（令牌可能无效或已过期）';
      return;
    }
    ul.textContent = '';
    if (!songs.length) { ul.appendChild(Object.assign(document.createElement('li'), { className: 'muted small', textContent: '没搜到，换个关键词试试。' })); return; }
    songs.forEach((song) => {
      const a = song.attributes || {};
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button';
      if (a.artwork && a.artwork.url) {
        const img = document.createElement('img');
        img.alt = ''; img.loading = 'lazy';
        img.src = a.artwork.url.replace('{w}', '80').replace('{h}', '80');
        b.appendChild(img);
      }
      const t = document.createElement('span'); t.className = 't';
      t.appendChild(Object.assign(document.createElement('b'), { textContent: a.name || '' }));
      t.appendChild(Object.assign(document.createElement('span'), { textContent: [a.artistName, a.albumName].filter(Boolean).join(' · ') }));
      b.appendChild(t);
      b.addEventListener('click', async () => {
        if (S.running) stop();
        $('songTitle').textContent = '载入中…';
        $('songBar').hidden = false;
        try { await DC.apple.load(song); onSongLoaded(DC.apple); }
        catch (e) { $('songBar').hidden = true; toast('这首歌载入失败：' + (e.message || e)); }
      });
      li.appendChild(b); ul.appendChild(li);
    });
  }

  // ---- editor -----------------------------------------------------------
  let edBar = 0;
  function ensureCustom() {
    if (!score.preset) return;
    if (S.running) stop();
    const c = DC.cloneScore(score);
    c.id = 'my' + Date.now().toString(36);
    c.name = score.name.replace(/^.*?·\s*/, '') + '（我的）';
    c.tip = '';
    custom.push(c);
    score = c;
    S.scoreId = c.id;
    saveCustom();
    fillScoreSelect();
  }
  function afterEdit() {
    if (S.running) stop();
    saveCustom();
    saveSettings();
    rebuild();
    showTip();
    renderEditor();
  }
  function renderEditor() {
    if (!score) return;
    $('edName').value = score.name;
    $('edDelete').disabled = !!score.preset;
    const tabs = $('edBars');
    tabs.textContent = '';
    score.bars.forEach((_, i) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: String(i + 1) });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === edBar));
      b.setAttribute('aria-label', `第 ${i + 1} 小节`);
      b.addEventListener('click', () => { edBar = i; renderEditor(); });
      tabs.appendChild(b);
    });
    const grid = $('edGrid');
    grid.textContent = '';
    grid.appendChild(document.createElement('span'));
    for (let i = 0; i < 16; i++) {
      const h = document.createElement('span');
      h.className = 'hd' + (i % 4 === 0 ? ' beat b0' : '');
      h.textContent = i % 4 === 0 ? i / 4 + 1 : i % 4 === 2 ? '+' : i % 4 === 1 ? 'e' : 'a';
      grid.appendChild(h);
    }
    const bar = score.bars[edBar];
    DC.INSTR.forEach((I) => {
      grid.appendChild(Object.assign(document.createElement('span'), { className: 'rl', textContent: I.name }));
      for (let i = 0; i < 16; i++) {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = `cell i-${I.id}` + (i % 4 === 0 ? ' b0' : '');
        c.setAttribute('aria-pressed', String(bar[I.id][i] === 'x'));
        c.setAttribute('aria-label', `${I.name} 第 ${Math.floor(i / 4) + 1} 拍第 ${(i % 4) + 1} 格`);
        c.addEventListener('click', () => {
          ensureCustom();
          const b = score.bars[edBar];
          b[I.id] = b[I.id].slice(0, i) + (b[I.id][i] === 'x' ? '-' : 'x') + b[I.id].slice(i + 1);
          if (b[I.id][i] === 'x') A.ensure().then(() => A.drum(I.id, A.ctx.currentTime + 0.01));
          afterEdit();
        });
        grid.appendChild(c);
      }
    });
  }

  // ---- import / export --------------------------------------------------
  function importCode(text) {
    let code = String(text || '').trim();
    const m = code.match(/#import=([\w-]+)/);
    if (m) code = m[1];
    let list;
    try { list = DC.unpackScores(code); } catch (e) { toast('这段代码读不出来，请完整复制后再试一次。'); return false; }
    if (S.running) stop();
    list.forEach((s) => {
      const i = custom.findIndex((c) => c.id === s.id);
      if (i >= 0) custom[i] = s; else custom.push(s);
    });
    saveCustom();
    score = null;
    fillScoreSelect();
    loadScore(list[0].id);
    toast(`已导入 ${list.length} 份谱子：${list.map((s) => s.name).join('、')}`);
    return true;
  }
  function exportScores(list) {
    if (!list.length) { toast('还没有自己的谱子可以导出。'); return; }
    const link = location.origin + location.pathname + '#import=' + DC.packScores(list);
    const box = $('ioBox');
    box.value = link;
    box.select();
    const done = () => toast('导出链接已复制。把它存到备忘录里；以后在任何设备上打开这个链接，谱子就会导入进去。');
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, () => toast('导出链接在上面的框里，请手动复制保存。'));
    else toast('导出链接在上面的框里，请手动复制保存。');
  }

  // ---- wiring -----------------------------------------------------------
  function init() {
    DC._onsets = [];
    A.onOnset = onOnset;
    A.onLevel = (l) => { if (l > meterPeak) meterPeak = l; };
    DC.filePlayer.onEnded = DC.apple.onEnded = () => stop(true);

    fillScoreSelect();
    $('bpm').value = S.bpm;
    $('optMetro').checked = S.metro; $('optCount').checked = S.countIn; $('optDemo').checked = S.demo;
    $('optJudge').value = S.judge;
    $('cal').value = S.cal == null ? '' : S.cal;
    $('songVol').value = S.vol;
    setSens(S.sens);
    if (S.source === 'apple') S.source = 'ext'; // an Apple Music song has to be picked again after a reload
    setSource(S.source);
    setMode(S.mode);
    loadScore(S.scoreId, true);

    $('scoreSel').addEventListener('change', (e) => loadScore(e.target.value));
    $('modeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
    $('srcSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setSource(b.dataset.src); });
    $('startBtn').addEventListener('click', () => (S.running ? stop() : start()));
    $('againBtn').addEventListener('click', restartNow);
    $('bpm').addEventListener('change', (e) => setBpm(e.target.value));
    $('bpmDown').addEventListener('click', () => setBpm(S.bpm - (free() ? 4 : 1)));
    $('bpmUp').addEventListener('click', () => setBpm(S.bpm + (free() ? 4 : 1)));
    $('tapBtn').addEventListener('click', tap);
    $('optMetro').addEventListener('change', (e) => { S.metro = e.target.checked; saveSettings(); });
    $('optCount').addEventListener('change', (e) => { S.countIn = e.target.checked; saveSettings(); });
    $('optDemo').addEventListener('change', (e) => {
      S.demo = e.target.checked; saveSettings();
      if (S.demo && A.micOn) toast('示范鼓声如果从音箱放出来，会被麦克风当成你打的。听示范时先别计较得分，或者戴耳机。');
    });
    $('optRestart').checked = S.autoRestart;
    $('optRestart').addEventListener('change', (e) => { S.autoRestart = e.target.checked; saveSettings(); });
    $('optJudge').addEventListener('change', (e) => { S.judge = e.target.value; saveSettings(); });

    $('micBtn').addEventListener('click', async () => { if (A.micOn) { A.stopMic(); showMic(); } else await ensureMic(); });
    $('sens').addEventListener('input', (e) => setSens(e.target.value));
    $('cal').addEventListener('change', (e) => { S.cal = clamp(Math.round(Number(e.target.value) || 0), 0, 500); e.target.value = S.cal; saveSettings(); });
    $('calBtn').addEventListener('click', calibrate);

    $('fileInput').addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) addFiles(files);
    });
    $('kindSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTrackKind(b.dataset.kind); });
    $('songSeek').addEventListener('input', (e) => { seeking = true; $('songCur').textContent = fmt(Number(e.target.value)); });
    $('songSeek').addEventListener('change', async (e) => {
      const p = provider();
      try { if (p && p.ready) await p.seek(Number(e.target.value)); } catch (err) { /* ignore */ }
      seeking = false; judge.cursor = null; sched.next = null;
    });
    $('songRate').addEventListener('change', (e) => {
      const p = provider();
      if (!p) return;
      const want = Number(e.target.value), got = p.setRate(want) || p.rate;
      if (Math.abs(got - want) > 0.01) { e.target.value = '1'; toast('这首歌不支持变速播放。'); }
    });
    $('songVol').addEventListener('input', (e) => { S.vol = Number(e.target.value); const p = provider(); if (p) p.setVolume(S.vol); saveSettings(); });
    $('songOffset').addEventListener('change', (e) => setSongOffset(e.target.value));
    $('offDown').addEventListener('click', () => setSongOffset(S.songOffset - 0.02));
    $('offUp').addEventListener('click', () => setSongOffset(S.songOffset + 0.02));
    $('markOne').addEventListener('click', () => { const p = provider(); if (p && p.ready) setSongOffset(p.getTime()); });

    $('appleToken').value = store.get('appleToken', '');
    showTokenInfo();
    $('appleToken').addEventListener('input', showTokenInfo);
    $('appleConnect').addEventListener('click', appleConnect);
    $('appleAuth').addEventListener('click', async () => {
      try { await DC.apple.authorize(); } catch (e) { toast('登录没有完成：' + (e.message || e)); }
      showAppleStatus();
    });
    $('appleReset').addEventListener('click', () => { $('appleSetup').hidden = false; $('appleMain').hidden = true; });
    $('appleSearchForm').addEventListener('submit', appleSearch);

    $('edName').addEventListener('change', (e) => {
      const v = e.target.value.trim();
      if (!v || v === score.name) { e.target.value = score.name; return; }
      ensureCustom(); score.name = v; saveCustom(); fillScoreSelect();
    });
    $('edNew').addEventListener('click', () => {
      const c = { id: 'my' + Date.now().toString(36), name: '我的新谱子', bpm: 76, tip: '', bars: [DC.bar(), DC.bar()] };
      custom.push(c); saveCustom(); fillScoreSelect(); edBar = 0; loadScore(c.id, true);
    });
    $('edDelete').addEventListener('click', () => {
      if (score.preset) return;
      custom = custom.filter((s) => s.id !== score.id);
      saveCustom(); score = null; fillScoreSelect(); loadScore('rock8', true);
    });
    $('edAddBar').addEventListener('click', () => {
      if (score.bars.length >= 64) return;
      ensureCustom(); score.bars.push(DC.bar()); edBar = score.bars.length - 1; afterEdit();
    });
    $('edDupBar').addEventListener('click', () => {
      if (score.bars.length >= 64) return;
      ensureCustom(); score.bars.splice(edBar + 1, 0, DC.bar(score.bars[edBar])); edBar++; afterEdit();
    });
    $('edClearBar').addEventListener('click', () => { ensureCustom(); score.bars[edBar] = DC.bar(); afterEdit(); });
    $('edDelBar').addEventListener('click', () => {
      if (score.bars.length <= 1) return;
      ensureCustom(); score.bars.splice(edBar, 1); edBar = Math.min(edBar, score.bars.length - 1); afterEdit();
    });

    $('ioImport').addEventListener('click', () => { if (importCode($('ioBox').value)) $('ioBox').value = ''; });
    $('ioExport').addEventListener('click', () => exportScores([score]));
    $('ioExportAll').addEventListener('click', () => exportScores(custom.filter((s) => DC.notesAt(s).some((c) => c.length))));
    // A link ending in #import=... loads its scores once, then the address is cleaned up so a reload does not overwrite later edits.
    const importFromAddress = () => {
      if (!/^#import=/.test(location.hash)) return;
      importCode(location.hash);
      history.replaceState(null, '', location.pathname + location.search);
    };
    importFromAddress();
    // Pasting an import link into a tab that already shows this page changes only the part after "#",
    // which does not reload the page, so listen for that as well.
    window.addEventListener('hashchange', importFromAddress);

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || tag === 'summary') return;
      e.preventDefault();
      S.running ? stop() : start();
    });
    let rz = 0;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (barsPerRow() !== lastBpr) rebuild(); }, 150); });

    setInterval(tick, 25);
    requestAnimationFrame(draw);
    // hooks for testing from the console
    DC.debug = { S, stats, judge, follow, pause, onOnset, get clock() { return clock; }, get view() { return view; } };
  }
  init();
})();
