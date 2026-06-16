const socket = io();

// ── Local state ───────────────────────────────────────────────────────────────
let mySeat = null;
let selectedChip = 25;
let myAnte = 0;
let myPairPlus = 0;
let myPlay = 0;
let isReady = false;
const RED_SUITS = new Set(['♥','♦']);

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function show(id)  { $(id).classList.remove('hidden'); }
function hide(id)  { $(id).classList.add('hidden'); }
function setMsg(main, sub='') { $('message').textContent = main; $('sub-message').textContent = sub; }
function setLog(t) { $('log').textContent = t; }
function hideBanner() { $('result-banner').className = ''; }
function showBanner(text, type) { const b=$('result-banner'); b.textContent=text; b.className=type; }

function cardHTML(card) {
  if (!card) return `<div class="card back animate"></div>`;
  const red = RED_SUITS.has(card.suit) ? ' red' : '';
  return `<div class="card${red} animate">
    <div class="card-rank">${card.rank}</div>
    <div class="card-suit">${card.suit}</div>
  </div>`;
}

function updateBetZone(id, amount, label) {
  const el = $(id);
  if (amount > 0) {
    el.classList.add('has-bet');
    el.innerHTML = `<span class="bet-amount">${amount}</span>`;
  } else {
    el.classList.remove('has-bet');
    el.innerHTML = `<span>${label}</span>`;
  }
}

// ── Join screen ───────────────────────────────────────────────────────────────
document.querySelectorAll('.seat-pick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const seatNo = parseInt(btn.dataset.seat);
    const name = $('join-name').value.trim() || `Player${seatNo}`;
    socket.emit('join', { seatNo, name });
  });
});

// ── Chip selector ─────────────────────────────────────────────────────────────
document.querySelectorAll('.chip-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedChip = parseInt(btn.dataset.value);
  });
});
document.querySelector('.chip-btn[data-value="25"]').classList.add('selected');

// ── Bet zone clicks ───────────────────────────────────────────────────────────
$('zone-ante').addEventListener('click', () => { if (!isReady) placeBet('ante'); });
$('zone-pair-plus').addEventListener('click', () => { if (!isReady) placeBet('pairplus'); });

// ── Action buttons ────────────────────────────────────────────────────────────
$('btn-ante').addEventListener('click', () => placeBet('ante'));
$('btn-pair-plus').addEventListener('click', () => placeBet('pairplus'));
$('btn-clear').addEventListener('click', () => {
  socket.emit('clear_bet');
  myAnte = 0; myPairPlus = 0; isReady = false;
  updateBetZone('zone-ante', 0, 'ANTE');
  updateBetZone('zone-pair-plus', 0, 'PAIR<br>PLUS');
});
$('btn-ready').addEventListener('click', () => {
  if (myAnte === 0) return;
  socket.emit('ready');
  isReady = true;
  hide('btn-ante'); hide('btn-pair-plus'); hide('btn-clear'); hide('btn-ready');
  setMsg('他のプレイヤーを待っています…');
});
$('btn-play').addEventListener('click', () => {
  socket.emit('decision', { action: 'play' });
  hide('btn-play'); hide('btn-fold');
  setMsg('他のプレイヤーを待っています…');
});
$('btn-fold').addEventListener('click', () => {
  socket.emit('decision', { action: 'fold' });
  hide('btn-play'); hide('btn-fold');
  setMsg('他のプレイヤーを待っています…');
});
$('btn-new-round').addEventListener('click', () => {
  socket.emit('new_round');
  hideBanner();
  $('dealer-hand-label').textContent = '';
});

function placeBet(type) {
  socket.emit('bet', { type, amount: selectedChip });
  if (type === 'ante')     myAnte     += selectedChip;
  if (type === 'pairplus') myPairPlus += selectedChip;
  updateBetZone('zone-ante',      myAnte,     'ANTE');
  updateBetZone('zone-pair-plus', myPairPlus, 'PAIR<br>PLUS');
}

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('init', ({ takenSeats }) => {
  takenSeats.forEach(s => {
    const b = document.querySelector(`.seat-pick-btn[data-seat="${s}"]`);
    if (b) b.disabled = true;
  });
});

socket.on('player_joined', ({ seatNo, name }) => {
  const b = document.querySelector(`.seat-pick-btn[data-seat="${seatNo}"]`);
  if (b) b.disabled = true;
  setLog(`${name} が席 ${seatNo} に参加しました`);
});

socket.on('player_left', ({ seatNo }) => {
  const b = document.querySelector(`.seat-pick-btn[data-seat="${seatNo}"]`);
  if (b) b.disabled = false;
  renderSeatPanel(seatNo, null);
  setLog(`席 ${seatNo} のプレイヤーが退席しました`);
});

socket.on('error', msg => alert(msg));

socket.on('state', data => {
  if (!mySeat && data.mySeat) {
    mySeat = data.mySeat;
    $('join-screen').style.display = 'none';
    $('game-screen').style.display = 'block';
  }

  // Chips
  if (data.myChips != null) $('my-chips-label').textContent = `チップ: ${data.myChips}`;

  // Dealer cards
  $('dealer-cards').innerHTML = data.dealerCards.map(c => cardHTML(c)).join('');

  // Seat panels
  for (let s = 1; s <= 4; s++) {
    const seatData = data.seats.find(x => x.seatNo === s);
    renderSeatPanel(s, seatData, data.mySeat, data.phase, data.myCards, data.myHand);
  }

  updateButtons(data);
  updateMessage(data);
});

socket.on('results', ({ results, dealerHand, dealerCards }) => {
  $('dealer-cards').innerHTML = dealerCards.map(c => cardHTML(c)).join('');
  $('dealer-hand-label').textContent = dealerHand;

  if (mySeat && results[mySeat]) {
    const r = results[mySeat];
    const type = r.net > 0 ? 'win' : r.net < 0 ? 'lose' : 'push';
    const label = r.net > 0 ? `勝ち！ +${r.net}チップ` : r.net < 0 ? `負け ${r.net}チップ` : '引き分け（Push）';
    showBanner(label, type);
    setMsg(r.msg, `あなた: ${r.handName} | ディーラー: ${dealerHand}`);
  }
  hide('btn-play'); hide('btn-fold');
  show('btn-new-round');
  myAnte = 0; myPairPlus = 0; myPlay = 0; isReady = false;
  updateBetZone('zone-ante', 0, 'ANTE');
  updateBetZone('zone-pair-plus', 0, 'PAIR<br>PLUS');
  updateBetZone('zone-play', 0, 'PLAY');
});

// ── Render seat panel ─────────────────────────────────────────────────────────
function renderSeatPanel(seatNo, seatData, mySeatNo, phase, myCards, myHand) {
  const panel = $(`seat-panel-${seatNo}`);
  if (!seatData) {
    panel.className = 'seat-panel empty';
    panel.innerHTML = `<span class="seat-name" style="opacity:0.4">席 ${seatNo}（空き）</span>`;
    return;
  }

  const isMe = seatNo === mySeatNo;
  panel.className = 'seat-panel' + (isMe ? ' mine' : '');

  const cards = isMe && myCards ? myCards : [];
  const handName = isMe && myHand ? myHand : null;

  let decisionHTML = '';
  if (phase === 'dealt' || phase === 'result') {
    if (seatData.decision === 'play')   decisionHTML = `<span class="seat-decision play">プレイ</span>`;
    else if (seatData.decision === 'fold') decisionHTML = `<span class="seat-decision fold">フォールド</span>`;
    else decisionHTML = `<span class="seat-decision waiting">考え中…</span>`;
  } else if (phase === 'betting' && seatData.ready) {
    decisionHTML = `<span class="seat-decision ready">準備完了 ✓</span>`;
  }

  const ante = isMe ? myAnte : seatData.ante;
  const pp   = isMe ? myPairPlus : seatData.pairPlus;
  const play = isMe ? myPlay : seatData.play;
  let betsHTML = '';
  if (ante > 0)  betsHTML += `<span class="bet-pill">ANTE ${ante}</span>`;
  if (pp > 0)    betsHTML += `<span class="bet-pill">PP ${pp}</span>`;
  if (play > 0)  betsHTML += `<span class="bet-pill">PLAY ${play}</span>`;

  let cardsHTML = '';
  if (cards.length > 0) {
    cardsHTML = `<div class="cards-row">${cards.map(c=>cardHTML(c)).join('')}</div>`;
    if (handName) cardsHTML += `<div class="hand-badge">${handName}</div>`;
  } else if ((phase === 'dealt' || phase === 'result') && !isMe) {
    cardsHTML = `<div class="cards-row">${[0,1,2].map(()=>`<div class="card back" style="width:40px;height:58px"></div>`).join('')}</div>`;
  }

  panel.innerHTML = `
    <div class="seat-name">${seatData.name}${isMe ? ' 👤' : ''}</div>
    <div class="seat-chips">💰 ${seatData.chips}</div>
    ${betsHTML ? `<div class="seat-bets">${betsHTML}</div>` : ''}
    ${cardsHTML}
    ${decisionHTML}
  `;
}

function updateButtons(data) {
  const phase = data.phase;
  ['btn-ante','btn-pair-plus','btn-clear','btn-ready','btn-play','btn-fold','btn-new-round']
    .forEach(id => hide(id));

  if (phase === 'betting' && !isReady) {
    show('btn-ante');
    show('btn-pair-plus');
    if (myAnte > 0 || myPairPlus > 0) show('btn-clear');
    if (myAnte > 0) show('btn-ready');
  } else if (phase === 'dealt') {
    const me = data.seats.find(s => s.seatNo === mySeat);
    if (me && me.decision === null) {
      myPlay = myAnte;
      updateBetZone('zone-play', myPlay, 'PLAY');
      show('btn-play');
      show('btn-fold');
    }
  }
  // result buttons are handled in 'results' event
}

function updateMessage(data) {
  const phase = data.phase;
  if (phase === 'betting') {
    if (isReady) {
      const waiting = data.seats.filter(s => !s.ready).length;
      setMsg('他のプレイヤーを待っています…', waiting > 0 ? `残り ${waiting} 人が未準備` : '');
    } else if (myAnte === 0) {
      setMsg('チップを選んでアンティに賭けてください');
    } else {
      setMsg('準備完了を押してください');
    }
  } else if (phase === 'dealt') {
    const me = data.seats.find(s => s.seatNo === mySeat);
    if (me && me.decision === null) {
      setMsg('プレイ or フォールド？');
    } else {
      const pending = data.seats.filter(s => s.decision === null).length;
      setMsg('他のプレイヤーを待っています…', `${pending} 人が決断中`);
    }
  }
}

$('payout-toggle').addEventListener('click', () => {
  const t = $('payout-table');
  t.style.display = t.style.display === 'block' ? 'none' : 'block';
});
