const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Deck ─────────────────────────────────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i) => [r, i+2]));

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, val: RANK_VAL[r] });
  return d;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ── Hand eval ─────────────────────────────────────────────────────────────────
function evaluateHand(cards) {
  const vals = cards.map(c => c.val).sort((a,b) => a-b);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const isAceLow = vals[0] === 2 && vals[1] === 3 && vals[2] === 14;
  const isStraight = (vals[2] - vals[0] === 2 && new Set(vals).size === 3) || isAceLow;
  const straightHigh = isAceLow ? 3 : vals[2];
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const freq = Object.values(counts).sort((a,b) => b-a);
  const tb = (a,b,c) => a*10000 + b*100 + c;

  if (isFlush && isStraight) return { rank:5, name:'ストレートフラッシュ', tiebreak: tb(straightHigh,0,0) };
  if (freq[0]===3)           return { rank:4, name:'スリーカード',         tiebreak: tb(vals[0],0,0) };
  if (isStraight)            return { rank:3, name:'ストレート',           tiebreak: tb(straightHigh,0,0) };
  if (isFlush)               return { rank:2, name:'フラッシュ',           tiebreak: tb(vals[2],vals[1],vals[0]) };
  if (freq[0]===2) {
    const pv = parseInt(Object.entries(counts).find(([,c])=>c===2)[0]);
    const kv = parseInt(Object.entries(counts).find(([,c])=>c===1)[0]);
    return { rank:1, name:'ワンペア', tiebreak: tb(pv,kv,0) };
  }
  return { rank:0, name:'ハイカード', tiebreak: tb(vals[2],vals[1],vals[0]) };
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank > b.rank ? 1 : -1;
  if (a.tiebreak !== b.tiebreak) return a.tiebreak > b.tiebreak ? 1 : -1;
  return 0;
}

function dealerQualifies(hand) {
  if (hand.rank > 0) return true;
  return hand.tiebreak >= 12 * 10000;
}

function anteBonusPayout(r) { return r===5?5 : r===4?4 : r===3?1 : 0; }
function pairPlusPayout(r)  { return r===5?40: r===4?30: r===3?6 : r===2?3 : r===1?1 : -1; }

// ── Game state ────────────────────────────────────────────────────────────────
const MAX_SEATS = 4;

// seats: { [seatNo]: { socketId, name, chips, ante, pairPlus, play, cards, hand, decision, pairPlusResult } }
let seats = {};
let dealerCards = [];
let phase = 'waiting'; // waiting | betting | dealt | result
let deck = [];

function seatList() {
  return Object.entries(seats).map(([seatNo, p]) => ({
    seatNo: +seatNo,
    name: p.name,
    chips: p.chips,
    ante: p.ante,
    pairPlus: p.pairPlus,
    play: p.play,
    decision: p.decision,
    // Only include hand info if result phase or own seat (sent separately)
  }));
}

function broadcast() {
  // Send each player their private cards, others only see back
  const base = {
    phase,
    dealerCards: phase === 'result' ? dealerCards : [null, null, null],
    seats: seatList(),
  };
  for (const [seatNo, p] of Object.entries(seats)) {
    const playerView = {
      ...base,
      mySeat: +seatNo,
      myCards: p.cards,
      myHand: p.hand ? p.hand.name : null,
      myPairPlusResult: p.pairPlusResult ?? null,
      myChips: p.chips,
    };
    io.to(p.socketId).emit('state', playerView);
  }
  // Also send to spectators (connected but not seated)
  const spectatorView = { ...base, mySeat: null, myCards: null, myHand: null, myChips: null };
  io.emit('state_spectator', spectatorView);
}

function startBetting() {
  phase = 'betting';
  for (const p of Object.values(seats)) {
    p.ante = 0;
    p.pairPlus = 0;
    p.play = 0;
    p.cards = [];
    p.hand = null;
    p.decision = null;
    p.pairPlusResult = null;
    p.ready = false;
  }
  dealerCards = [];
  broadcast();
}

function dealCards() {
  deck = shuffle(makeDeck());
  dealerCards = [deck.pop(), deck.pop(), deck.pop()];
  for (const p of Object.values(seats)) {
    p.cards = [deck.pop(), deck.pop(), deck.pop()];
    p.hand = evaluateHand(p.cards);
    // Resolve pair plus immediately
    if (p.pairPlus > 0) {
      const mult = pairPlusPayout(p.hand.rank);
      if (mult > 0) {
        const win = p.pairPlus * mult;
        p.chips += p.pairPlus + win;
        p.pairPlusResult = { win, mult };
      } else {
        p.pairPlusResult = { win: -p.pairPlus, mult: 0 };
      }
      p.pairPlus = 0;
    }
  }
  phase = 'dealt';
  broadcast();
}

function resolveAll() {
  const dh = evaluateHand(dealerCards);
  const qual = dealerQualifies(dh);
  const results = {};

  for (const [seatNo, p] of Object.entries(seats)) {
    const ph = p.hand;
    let net = 0;
    let msg = '';

    if (p.decision === 'fold') {
      net = -(p.ante);
      msg = 'フォールド';
    } else {
      // play
      if (!qual) {
        // not qualify: ante pays 1:1, play push
        net = p.ante;
        p.chips += p.ante + p.play + net;
        const bonus = anteBonusPayout(ph.rank) * p.ante;
        if (bonus > 0) { p.chips += bonus; net += bonus; }
        msg = `ノットクオリファイ +${net}`;
      } else {
        const cmp = compareHands(ph, dh);
        if (cmp > 0) {
          net = p.ante + p.play;
          p.chips += p.ante + p.play + net;
          const bonus = anteBonusPayout(ph.rank) * p.ante;
          if (bonus > 0) { p.chips += bonus; net += bonus; }
          msg = `勝ち +${net}`;
        } else if (cmp < 0) {
          net = -(p.ante + p.play);
          msg = `負け ${net}`;
        } else {
          p.chips += p.ante + p.play;
          net = 0;
          msg = 'Push（引き分け）';
        }
      }
    }
    p.ante = 0;
    p.play = 0;
    results[seatNo] = { net, msg, handName: ph.name, chips: p.chips };
    if (p.chips <= 0) p.chips = 1000; // refill
  }

  phase = 'result';
  const dHandName = dh.name + (qual ? '' : '（ノットクオリファイ）');
  io.emit('results', { results, dealerHand: dHandName, dealerCards });
  broadcast();
}

function checkAllDecided() {
  const active = Object.values(seats).filter(p => p.ante > 0 || p.play > 0 || p.decision);
  if (active.length === 0) return;
  if (active.every(p => p.decision !== null)) resolveAll();
}

function checkAllReady() {
  const players = Object.values(seats);
  if (players.length === 0) return;
  if (players.every(p => p.ready)) dealCards();
}

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  // Send current state to newcomer
  socket.emit('init', {
    seats: seatList(),
    phase,
    takenSeats: Object.keys(seats).map(Number),
  });

  socket.on('join', ({ seatNo, name }) => {
    if (seats[seatNo]) return socket.emit('error', 'その席は埋まっています');
    if (Object.values(seats).find(p => p.socketId === socket.id)) return;
    seats[seatNo] = {
      socketId: socket.id, name: name || `Player${seatNo}`,
      chips: 1000, ante: 0, pairPlus: 0, play: 0,
      cards: [], hand: null, decision: null, pairPlusResult: null, ready: false,
    };
    io.emit('player_joined', { seatNo, name: seats[seatNo].name });
    if (phase === 'waiting' && Object.keys(seats).length >= 1) startBetting();
    else broadcast();
  });

  socket.on('bet', ({ type, amount }) => {
    const p = Object.values(seats).find(p => p.socketId === socket.id);
    if (!p || phase !== 'betting') return;
    if (p.chips < amount) return;
    if (type === 'ante')     { p.ante += amount;     p.chips -= amount; }
    if (type === 'pairplus') { p.pairPlus += amount; p.chips -= amount; }
    broadcast();
  });

  socket.on('clear_bet', () => {
    const p = Object.values(seats).find(p => p.socketId === socket.id);
    if (!p || phase !== 'betting') return;
    p.chips += p.ante + p.pairPlus;
    p.ante = 0; p.pairPlus = 0; p.ready = false;
    broadcast();
  });

  socket.on('ready', () => {
    const seatEntry = Object.entries(seats).find(([,p]) => p.socketId === socket.id);
    if (!seatEntry || phase !== 'betting') return;
    const p = seatEntry[1];
    if (p.ante === 0) return; // must have ante to be ready
    p.ready = true;
    broadcast();
    checkAllReady();
  });

  socket.on('decision', ({ action }) => {
    const seatEntry = Object.entries(seats).find(([,p]) => p.socketId === socket.id);
    if (!seatEntry || phase !== 'dealt') return;
    const [, p] = seatEntry;
    if (p.decision !== null) return;

    if (action === 'play') {
      if (p.chips < p.ante) { action = 'fold'; }
      else { p.play = p.ante; p.chips -= p.play; }
    }
    p.decision = action;
    broadcast();
    checkAllDecided();
  });

  socket.on('new_round', () => {
    if (phase !== 'result') return;
    startBetting();
  });

  socket.on('leave', () => {
    const seatNo = Object.keys(seats).find(k => seats[k].socketId === socket.id);
    if (seatNo) {
      delete seats[seatNo];
      io.emit('player_left', { seatNo: +seatNo });
      if (Object.keys(seats).length === 0) phase = 'waiting';
      else broadcast();
    }
  });

  socket.on('disconnect', () => {
    const seatNo = Object.keys(seats).find(k => seats[k].socketId === socket.id);
    if (seatNo) {
      // If in dealt phase and player hadn't decided, auto-fold
      if (phase === 'dealt' && seats[seatNo].decision === null) {
        seats[seatNo].decision = 'fold';
        checkAllDecided();
      }
      delete seats[seatNo];
      io.emit('player_left', { seatNo: +seatNo });
      if (Object.keys(seats).length === 0) phase = 'waiting';
      else broadcast();
    }
  });
});

const PORT = process.env.PORT || 3200;
server.listen(PORT, () => console.log(`Three Card Poker running on http://localhost:${PORT}`));
