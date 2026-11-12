// Draws a score as drum-staff notation in SVG and exposes handles for the playhead and per-note marks.
(function () {
  'use strict';
  const DC = window.DC;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs, parent, text) => {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  };

  // Notes are spaced evenly straight through the bar lines (a bar line sits halfway between the last
  // note of one bar and the first of the next), so the playhead moves at one constant speed.
  const G = { stepW: 26, left: 36, right: 8, y0: 62, h: 152, beam: -38 };
  G.padL = G.stepW / 2;
  G.barW = 16 * G.stepW;
  const Y = (rel) => G.y0 + rel;
  const BY = { CR: -10, HH: -5, T1: 5, SN: 15, T2: 25, BD: 35 };

  function head(g, id, cx) {
    const y = Y(BY[id]);
    if (id === 'CR' || id === 'HH') {
      if (id === 'CR') {
        el('line', { class: 'ledger', x1: cx - 10, x2: cx + 10, y1: y, y2: y }, g);
        el('circle', { class: 'n-CR', cx, cy: y, r: 7.4, 'stroke-width': 1.5 }, g);
      }
      el('path', { class: 'n-' + id, d: `M${cx - 4.3},${y - 4.3}L${cx + 4.3},${y + 4.3}M${cx - 4.3},${y + 4.3}L${cx + 4.3},${y - 4.3}` }, g);
    } else {
      el('ellipse', { class: 'n-' + id, cx, cy: y, rx: 5.8, ry: 4.3, transform: `rotate(-20 ${cx} ${y})` }, g);
    }
  }
  function rest(g, kind, cx) {
    const cy = Y(20);
    if (kind === 'q') {
      el('path', { class: 'rest', d: `M${cx - 3},${cy - 11}l6,8l-5,6l5,6q-8,-3 -4,6` }, g);
      return;
    }
    el('circle', { class: 'restdot', cx: cx - 2.5, cy: cy - 5, r: 2.7 }, g);
    el('path', { class: 'rest', d: `M${cx - 2.5},${cy - 4.200}q4.5,2 7,-2.300l-4.2,17` }, g);
    if (kind === 's') {
      el('circle', { class: 'restdot', cx: cx - 4, cy: cy + 2, r: 2.7 }, g);
      el('path', { class: 'rest', d: `M${cx - 4},${cy + 2.800}q4.5,2 6.800,-1.800` }, g);
    }
    if (kind === 'e.') el('circle', { class: 'restdot', cx: cx + 9, cy: cy - 5, r: 1.8 }, g);
  }

  DC.renderScore = function (container, score, barsPerRow) {
    container.textContent = '';
    const nb = score.bars.length;
    const total = nb * 16;
    const cols = DC.notesAt(score);
    const uses16 = cols.some((c, i) => c.length && i % 2 === 1);
    const info = new Array(total);
    const rows = [];
    const W = G.left + barsPerRow * G.barW + G.right;

    for (let r = 0; r * barsPerRow < nb; r++) {
      const n = Math.min(barsPerRow, nb - r * barsPerRow);
      const svg = el('svg', { viewBox: `0 0 ${W} ${G.h}`, class: 'sys', role: 'img', 'aria-label': `第 ${r * barsPerRow + 1} 到 ${r * barsPerRow + n} 小节` });
      const gMark = el('g', {}, svg);
      const gStaff = el('g', {}, svg);
      const gNote = el('g', {}, svg);
      const xEnd = G.left + n * G.barW;
      for (let i = 0; i < 5; i++) el('line', { class: 'staff', x1: 4, x2: xEnd, y1: Y(i * 10), y2: Y(i * 10) }, gStaff);
      el('line', { class: 'barline', x1: 4, x2: 4, y1: Y(0), y2: Y(40) }, gStaff);
      el('line', { class: 'clef', x1: 15, x2: 15, y1: Y(10), y2: Y(30) }, gStaff);
      el('line', { class: 'clef', x1: 23, x2: 23, y1: Y(10), y2: Y(30) }, gStaff);

      for (let j = 0; j < n; j++) {
        const bi = r * barsPerRow + j;
        const bx = G.left + j * G.barW;
        const X = (i) => bx + G.padL + i * G.stepW;
        const last = bi === nb - 1;
        el('line', { class: 'barline' + (last ? ' end' : ''), x1: bx + G.barW - (last ? 2 : 0), x2: bx + G.barW - (last ? 2 : 0), y1: Y(0), y2: Y(40) }, gStaff);
        el('text', { class: 'barno', x: bx + 3, y: Y(-48) }, gStaff, String(bi + 1));

        for (let i = 0; i < 16; i++) {
          const step = bi * 16 + i;
          const cx = X(i);
          const here = cols[step];
          const rec = { row: r, x: cx, mark: null, tag: null };
          info[step] = rec;
          const label = i % 4 === 0 ? String(i / 4 + 1) : i % 4 === 2 ? '+' : uses16 ? (i % 4 === 1 ? 'e' : 'a') : '';
          if (label) el('text', { class: 'cnt' + (i % 4 === 0 ? ' beat' : ''), x: cx, y: Y(66) }, gStaff, label);
          if (!here.length) continue;
          rec.mark = el('rect', { class: 'mark', x: cx - 12, y: Y(-46), width: 24, height: 96, rx: 9 }, gMark);
          rec.tag = el('text', { class: 'tag', x: cx, y: Y(84) }, gMark);
          here.forEach((id) => head(gNote, id, cx));
        }

        // stems, beams, flags and rests, one beat at a time
        for (let k = 0; k < 4; k++) {
          const on = [];
          for (let s = 0; s < 4; s++) if (cols[bi * 16 + k * 4 + s].length) on.push(s);
          const x0 = X(k * 4);
          if (!on.length) { rest(gNote, 'q', x0 + 2); continue; }
          if (on[0] === 1) rest(gNote, 's', x0);
          else if (on[0] === 2) rest(gNote, 'e', x0);
          else if (on[0] === 3) rest(gNote, 'e.', x0);
          const beamY = Y(G.beam);
          const dur = on.map((s, i) => (i + 1 < on.length ? on[i + 1] : 4) - s);
          const nbm = dur.map((d) => (d === 1 ? 2 : d === 4 ? 0 : 1));
          const sx = on.map((s) => X(k * 4 + s) + 5.4);
          on.forEach((s, i) => {
            const ids = cols[bi * 16 + k * 4 + s];
            const low = Math.max.apply(null, ids.map((id) => BY[id]));
            el('line', { class: 'stem', x1: sx[i], x2: sx[i], y1: Y(low) - 1, y2: beamY }, gNote);
            if (dur[i] === 3) ids.forEach((id) => el('circle', { class: 'dot', cx: sx[i] + 6.500, cy: Y(BY[id]) - 1, r: 1.8 }, gNote));
          });
          if (on.length >= 2) {
            el('rect', { class: 'beam', x: sx[0] - 0.75, y: beamY, width: sx[sx.length - 1] - sx[0] + 1.5, height: 5 }, gNote);
            const joined = on.map(() => false);
            for (let i = 0; i + 1 < on.length; i++) {
              if (nbm[i] === 2 && nbm[i + 1] === 2) {
                el('rect', { class: 'beam', x: sx[i] - 0.75, y: beamY + 8, width: sx[i + 1] - sx[i] + 1.5, height: 5 }, gNote);
                joined[i] = joined[i + 1] = true;
              }
            }
            on.forEach((s, i) => {
              if (nbm[i] !== 2 || joined[i]) return;
              const leftStub = i === on.length - 1;
              el('rect', { class: 'beam', x: leftStub ? sx[i] - 10 : sx[i] - 0.75, y: beamY + 8, width: 10.75, height: 5 }, gNote);
            });
          } else {
            for (let f = 0; f < nbm[0]; f++) {
              el('path', { class: 'flag', d: `M${sx[0]},${beamY + f * 8}q9,6 6,17` }, gNote);
            }
          }
        }
      }
      const ph = el('rect', { class: 'ph', x: 0, y: Y(-50), width: 3, height: 104, rx: 1.5, visibility: 'hidden' }, svg);
      container.appendChild(svg);
      rows.push({ svg, ph });
    }

    const notes = [];
    cols.forEach((c, i) => { if (c.length) notes.push(i); });
    let shownRow = -1;
    let phRow = -1;
    let curStep = null;
    const TAG = { good: '', early: '早', late: '晚', miss: '漏' };

    function showRow(r) {
      if (r === shownRow) return;
      shownRow = r;
      if (r < 0) return;
      // Keep the line being played at the top of the box, so the lines that follow are visible below it.
      // (Measured with getBoundingClientRect: SVG elements have no offsetTop.)
      const top = rows[r].svg.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top: Math.max(0, top - 6), behavior: 'smooth' });
    }
    return {
      total, cols, notes,
      setMark(step, cls) {
        const m = info[step];
        if (!m || !m.mark) return;
        m.mark.setAttribute('class', 'mark ' + cls + (step === curStep ? ' cur' : ''));
        m.tag.textContent = TAG[cls] || '';
      },
      clearMark(step) {
        const m = info[step];
        if (!m || !m.mark) return;
        m.mark.setAttribute('class', 'mark' + (step === curStep ? ' cur' : ''));
        m.tag.textContent = '';
      },
      clearMarks() { notes.forEach((s) => this.clearMark(s)); },
      // highlighted "play this next" column, used by the wait-for-me mode
      setCursor(step) {
        if (curStep != null && info[curStep].mark) info[curStep].mark.classList.remove('cur');
        curStep = step;
        if (step != null && info[step].mark) { info[step].mark.classList.add('cur'); showRow(info[step].row); }
      },
      // pos: fractional step position within the score, or null to hide
      setPlayhead(pos) {
        if (pos == null) {
          if (phRow >= 0) rows[phRow].ph.setAttribute('visibility', 'hidden');
          phRow = -1; shownRow = -1;
          return;
        }
        const s = Math.min(total - 1, Math.max(0, Math.floor(pos)));
        const m = info[s];
        if (m.row !== phRow) { // only touch visibility when the line changes row
          if (phRow >= 0) rows[phRow].ph.setAttribute('visibility', 'hidden');
          rows[m.row].ph.setAttribute('visibility', 'visible');
          phRow = m.row;
        }
        // Glide across the gap at a bar line instead of hopping over it.
        const nx = info[s + 1] && info[s + 1].row === m.row ? info[s + 1].x : m.x + G.stepW;
        rows[m.row].ph.setAttribute('x', (m.x + (pos - s) * (nx - m.x) - 1.5).toFixed(1));
        showRow(m.row);
      },
    };
  };
})();
