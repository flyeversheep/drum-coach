// Instruments, built-in beginner lessons, and small score helpers.
// A bar is 4/4 split into 16 sixteenth-note steps; each instrument is a 16-char string of 'x' / '-'.
(function () {
  'use strict';
  const DC = (window.DC = window.DC || {});

  // y = vertical position relative to the top staff line (staff lines at 0,10,20,30,40)
  DC.INSTR = [
    { id: 'CR', name: '吊镲', y: -10, head: 'x' },
    { id: 'HH', name: '踩镲', y: -5, head: 'x' },
    { id: 'T1', name: '高音嗵鼓', y: 5, head: 'o' },
    { id: 'SN', name: '军鼓', y: 15, head: 'o' },
    { id: 'T2', name: '落地嗵鼓', y: 25, head: 'o' },
    { id: 'BD', name: '底鼓', y: 35, head: 'o' },
  ];
  const EMPTY = '----------------';

  DC.bar = function (parts) {
    const b = {};
    for (const I of DC.INSTR) {
      const s = ((parts && parts[I.id]) || EMPTY).replace(/[^x-]/g, '');
      b[I.id] = (s + EMPTY).slice(0, 16);
    }
    return b;
  };
  DC.cloneScore = function (s) {
    return { id: s.id, name: s.name, bpm: s.bpm, tip: s.tip || '', bars: s.bars.map((b) => DC.bar(b)) };
  };
  // notesAt[step] = list of instrument ids struck on that step
  DC.notesAt = function (score) {
    const out = [];
    score.bars.forEach((b) => {
      for (let i = 0; i < 16; i++) out.push(DC.INSTR.filter((I) => b[I.id][i] === 'x').map((I) => I.id));
    });
    return out;
  };

  // Compact text form of one or more scores, for moving them between devices without a server.
  // Each distinct bar is 24 hex digits (16 bits per instrument); "q" lists which bar plays when.
  const b64 = {
    enc(str) {
      let bin = '';
      new TextEncoder().encode(str).forEach((c) => (bin += String.fromCharCode(c)));
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    dec(code) {
      const s = code.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(s + '==='.slice((s.length + 3) % 4));
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    },
  };
  DC.packScores = function (list) {
    return b64.enc(JSON.stringify({
      v: 1,
      s: list.map((sc) => {
        const p = [], q = [];
        sc.bars.forEach((bar) => {
          const hex = DC.INSTR.map((I) => parseInt(bar[I.id].replace(/x/g, '1').replace(/-/g, '0'), 2).toString(16).padStart(4, '0')).join('');
          let i = p.indexOf(hex);
          if (i < 0) i = p.push(hex) - 1;
          q.push(i);
        });
        return { id: sc.id, n: sc.name, b: sc.bpm, t: sc.tip || '', p, q };
      }),
    }));
  };
  DC.unpackScores = function (code) {
    const d = JSON.parse(b64.dec(code));
    if (!d || d.v !== 1 || !Array.isArray(d.s) || !d.s.length || d.s.length > 50) throw new Error('format');
    return d.s.map((x) => {
      const ok = /^[\w-]{1,40}$/.test(x.id) && typeof x.n === 'string' && x.n.length <= 80 && Array.isArray(x.p) && Array.isArray(x.q)
        && x.q.length >= 1 && x.q.length <= 64 && x.p.every((h) => /^[0-9a-f]{24}$/.test(h)) && x.q.every((i) => Number.isInteger(i) && i >= 0 && i < x.p.length);
      if (!ok) throw new Error('format');
      const bars = x.p.map((h) => {
        const parts = {};
        DC.INSTR.forEach((I, k) => {
          parts[I.id] = parseInt(h.slice(k * 4, k * 4 + 4), 16).toString(2).padStart(16, '0').replace(/1/g, 'x').replace(/0/g, '-');
        });
        return parts;
      });
      return { id: x.id, name: x.n, bpm: Math.min(240, Math.max(30, Number(x.b) || 80)), tip: String(x.t || '').slice(0, 200), bars: x.q.map((i) => DC.bar(bars[i])) };
    });
  };

  const HH8 = 'x-x-x-x-x-x-x-x-';
  const HH4 = 'x---x---x---x---';
  const SN24 = '----x-------x---';
  const B = DC.bar;

  DC.PRESETS = [
    {
      id: 'count4', name: '第 1 课 · 数拍子：咚 哒 咚 哒', bpm: 70,
      tip: '大声数「1、2、3、4」。1 和 3 踩底鼓，2 和 4 打军鼓。',
      bars: [B({ SN: SN24, BD: 'x-------x-------' }), B({ SN: SN24, BD: 'x-------x-------' })],
    },
    {
      id: 'hat8', name: '第 2 课 · 踩镲八分音符', bpm: 70,
      tip: '数「1 + 2 + 3 + 4 +」，每数一下打一下踩镲，一样轻、一样匀。',
      bars: [B({ HH: HH8 }), B({ HH: HH8 })],
    },
    {
      id: 'slow4', name: '第 3 课 · 慢歌节奏（四分踩镲）', bpm: 72,
      tip: '踩镲每拍一下；1、3 拍加底鼓，2、4 拍加军鼓，两只手脚要同时落下。',
      bars: [B({ HH: HH4, SN: SN24, BD: 'x-------x-------' }), B({ HH: HH4, SN: SN24, BD: 'x-------x-------' })],
    },
    {
      id: 'rock8', name: '第 4 课 · 基础摇滚节奏（8 Beat）', bpm: 76,
      tip: '最常用的节奏：踩镲不停，底鼓在 1、3，军鼓在 2、4。先慢后快。',
      bars: [B({ HH: HH8, SN: SN24, BD: 'x-------x-------' }), B({ HH: HH8, SN: SN24, BD: 'x-------x-------' })],
    },
    {
      id: 'rock8b', name: '第 5 课 · 8 Beat 变化：多一脚底鼓', bpm: 76,
      tip: '第 3 拍后面的「+」多踩一下底鼓：咚 哒 咚咚 哒。',
      bars: [B({ HH: HH8, SN: SN24, BD: 'x-------x-x-----' }), B({ HH: HH8, SN: SN24, BD: 'x-------x-x-----' })],
    },
    {
      id: 'rock8c', name: '第 6 课 · 8 Beat 变化：抢拍底鼓', bpm: 76,
      tip: '底鼓在 1、「2 +」、3：咚 哒咚 咚 哒。',
      bars: [B({ HH: HH8, SN: SN24, BD: 'x-----x-x-------' }), B({ HH: HH8, SN: SN24, BD: 'x-----x-x-------' })],
    },
    {
      id: 'stomp', name: '第 7 课 · 咚咚哒（跺跺拍）', bpm: 80,
      tip: '两下底鼓、一下军鼓、停一拍。停的那一拍也要在心里数。',
      bars: [B({ SN: SN24, BD: 'x-x-----x-x-----' }), B({ SN: SN24, BD: 'x-x-----x-x-----' })],
    },
    {
      id: 'fill', name: '第 8 课 · 节奏 + 过门（加花）', bpm: 72,
      tip: '三小节节奏，第四小节后半段从军鼓敲到嗵鼓，然后回到第 1 拍打吊镲。',
      bars: [
        B({ CR: 'x---------------', HH: '--x-x-x-x-x-x-x-', SN: SN24, BD: 'x-------x-------' }),
        B({ HH: HH8, SN: SN24, BD: 'x-------x-------' }),
        B({ HH: HH8, SN: SN24, BD: 'x-------x-------' }),
        B({ HH: 'x-x-x-x---------', SN: '----x---xxxx----', T1: '------------xx--', T2: '--------------xx', BD: 'x---------------' }),
      ],
    },
    {
      id: 'hat16', name: '挑战 · 十六分音符军鼓', bpm: 60,
      tip: '数「1 e + a」，左右手轮流：右左右左。越匀越好，不求快。',
      bars: [B({ SN: 'xxxxxxxxxxxxxxxx' }), B({ SN: 'x-x-xxxxx-x-xxxx' })],
    },
  ];
  DC.PRESETS.forEach((p) => (p.preset = true));

  // Pieces from the player's own books. Only the titles are known here: each starts as four empty
  // bars and is copied into "my scores" on first run, where the notes are entered with the editor.
  const piece = (book, list, title, by) => ({
    id: `pc${book}-${list.toLowerCase()}`, name: `${list} · ${title} – ${by}`, bpm: 80, tip: '', bars: [B(), B(), B(), B()],
  });
  DC.PIECE_BOOKS = { pc1: 'Book 1', pc2: 'Book 2' };
  DC.PIECES = [
    piece(1, 'A1', 'Raptors', 'Daniel Bond'),
    piece(1, 'A2', 'Pop Up', 'Claire Brock'),
    piece(1, 'A3', 'Stressed Out', 'Twenty One Pilots'),
    piece(1, 'B1', 'Pink Suit', 'Tamir Barzilay'),
    piece(1, 'B2', 'You Know', 'Noam Lederman'),
    piece(1, 'B3', 'We Will Rock You', 'Queen'),
    piece(1, 'C1', 'Trailblazer', 'Jason Bowld'),
    piece(1, 'C2', 'You Bet', 'Catherine Ring'),
    piece(1, 'C3', 'Frosty Mornings', 'Lizzy Swinford'),
    piece(2, 'A1', 'Funk For Geoff', 'Dan Banks and Dan Earley'),
    piece(2, 'A2', 'Something Just Like This', 'The Chainsmokers and Coldplay'),
    piece(2, 'A3', 'Spacey Funk', "Vicky O'Neon"),
    piece(2, 'B1', 'Laguna', 'Daniel Bond'),
    piece(2, 'B2', "Hard To Say I'm Sorry", 'Chicago'),
    piece(2, 'B3', 'Ball And Biscuit', 'The White Stripes'),
    piece(2, 'C1', 'Cuban Roots', 'Emily Gunton'),
    piece(2, 'C2', 'Duck Walk', 'Noam Lederman'),
    piece(2, 'C3', 'Rock, Paper, Scissors!', 'Chris Woodham'),
  ];
})();
