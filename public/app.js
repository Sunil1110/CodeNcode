/* ChipBank page: no build step. The store (backend.js) pushes the current game
   every time anyone changes it, and this file re-renders from that. */

import { loadBackend } from './backend.js';

const NAME_KEY = 'chipbank.name';
const $app = document.getElementById('app');

const state = {
  name: readName(),
  route: parseRoute(),
  games: null, // list for the home page
  game: null, // current game
  gone: false, // current game does not exist
  online: true,
  failed: null, // message when the store could not be loaded or read
  tab: 'table',
  sheet: null,
  toast: null,
  busy: false,
  hist: { id: null, list: [], stop: null },
};

let backend = null;
let stopWatching = null;
let sheetSeq = 0;
let focusedSheet = 0;
let toastTimer = null;

// ---------- small helpers ----------

function readName() {
  try {
    return cleanName(localStorage.getItem(NAME_KEY) || '');
  } catch {
    return '';
  }
}

function cleanName(raw) {
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 20).trim();
}

const myKey = () => state.name.toLowerCase();

function parseRoute() {
  const m = location.hash.match(/^#\/g\/([A-Za-z0-9]+)/);
  return m ? { page: 'game', id: m[1].toUpperCase() } : { page: 'home' };
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmt = (n) => Number(n).toLocaleString();
const chipsText = (n) => `${fmt(n)} ${n === 1 ? 'chip' : 'chips'}`;
const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '0');
const netClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted');

function avatar(name) {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) % 360;
  const letter = esc([...name][0].toUpperCase());
  return `<span class="avatar" style="background:hsl(${h} 62% 68%)" aria-hidden="true">${letter}</span>`;
}

function timeOf(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dateOf(t) {
  return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

// Tap-to-add chip sizes that suit the buy-in: 1000 -> 10, 50, 100, 500.
function chipSizes(buyIn) {
  const base = Math.max(1, 10 ** (Math.floor(Math.log10(Math.max(buyIn, 1))) - 2));
  return [1, 5, 10, 50].map((m) => m * base);
}

function toast(message, kind = 'info') {
  state.toast = { message, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, 3200);
  render();
}

// ---------- shared state ----------

function connect() {
  if (stopWatching) stopWatching();
  stopWatching = null;
  if (state.hist.stop) state.hist.stop();
  state.hist = { id: null, list: [], stop: null };
  if (!backend) return;

  const onError = (err) => {
    state.failed = err.message;
    render();
  };
  if (state.route.page === 'game') {
    const { id } = state.route;
    stopWatching = backend.watchGame(
      id,
      (game, meta) => {
        if (state.route.page !== 'game' || state.route.id !== id) return;
        state.failed = null;
        state.online = !meta.offline;
        if (game) applyGame(game);
        else if (game === undefined) render(); // still waiting for the first answer
        else {
          state.gone = true;
          state.game = null;
          state.sheet = null;
          render();
        }
      },
      onError,
    );
  } else {
    stopWatching = backend.watchGames((games, meta) => {
      state.failed = null;
      state.online = !meta.offline;
      state.games = games;
      render();
    }, onError);
  }
}

function applyGame(game) {
  if (state.game && game.seq < state.game.seq) return; // stale update
  const justEnded = state.game && state.game.status !== 'ended' && game.status === 'ended';
  state.game = game;
  state.gone = false;
  if (justEnded) state.sheet = null;
  watchHistory();
  render();
}

// The history is only loaded once someone looks at it, then kept up to date.
function watchHistory() {
  const g = state.game;
  const h = state.hist;
  if (!g || h.id === g.id) return;
  if (state.tab !== 'history' && g.status !== 'ended') return;
  h.id = g.id;
  h.stop = backend.watchEntries(g.id, (entries) => {
    if (state.hist !== h) return;
    h.list = entries;
    render();
  });
}

async function act(type, extra = {}) {
  if (state.busy || !state.game) return false;
  state.busy = true;
  try {
    await backend.act(state.game.id, { name: state.name, type, ...extra });
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  } finally {
    state.busy = false;
  }
}

// ---------- views ----------

function viewLogin() {
  const joining = state.route.page === 'game';
  return `
  <main class="page login" data-key="login">
    <div class="logo"><img src="./icon.svg" alt=""><strong>ChipBank</strong></div>
    <div class="stack">
      <h1>${joining ? 'Enter your name to join the game.' : 'Cards on the table, chips on your phone.'}</h1>
      <p class="muted">No password. Use the same name each time and your chips follow you.</p>
    </div>
    <form class="stack" data-submit="login">
      <label class="field">Your name
        <input class="input" name="name" maxlength="20" autocomplete="nickname" autocapitalize="words" placeholder="e.g. Sunil" required>
      </label>
      <button class="btn primary block" type="submit">${joining ? 'Continue to game' : 'Continue'}</button>
    </form>
  </main>`;
}

function viewHome() {
  const games = state.games;
  const live = games ? games.filter((g) => g.status !== 'ended') : [];
  const past = games ? games.filter((g) => g.status === 'ended') : [];

  const liveItem = (g) => {
    const active = g.players.filter((p) => p.active);
    const mine = active.some((p) => p.key === myKey());
    const badge =
      g.status === 'live' ? '<span class="badge live">Live</span>' : '<span class="badge lobby">Waiting</span>';
    const people = `${active.length} ${active.length === 1 ? 'player' : 'players'}`;
    const names = active.map((p) => p.name).join(', ');
    return `
    <li data-key="${g.id}">
      <div class="game-item">
        <div class="grow">
          <h3>${esc(g.title)} ${badge}</h3>
          <p>${people}${names ? ` · ${esc(names)}` : ''}</p>
        </div>
        ${
          mine
            ? `<a class="btn small" href="#/g/${g.id}">Open</a>`
            : `<button class="btn small primary" data-action="join-open" data-id="${g.id}">Join</button>`
        }
      </div>
    </li>`;
  };

  const pastItem = (g) => {
    const top = [...g.players].sort((a, b) => b.net - a.net)[0];
    const result = top && top.net > 0 ? `${esc(top.name)} won ${fmt(top.net)}` : 'All square';
    return `
    <li data-key="${g.id}">
      <a class="game-item" href="#/g/${g.id}">
        <div class="grow">
          <h3>${esc(g.title)}</h3>
          <p>${dateOf(g.endedAt)} · ${g.players.length} players · ${result}</p>
        </div>
        <span class="chev" aria-hidden="true">›</span>
      </a>
    </li>`;
  };

  return `
  <main class="page" data-key="home">
    <header class="home-head">
      <div class="logo"><img src="./icon.svg" alt=""><strong>ChipBank</strong></div>
      <div class="who">Playing as <b>${esc(state.name)}</b>
        <button class="link" data-action="open-sheet" data-sheet="name">Change name</button>
      </div>
    </header>

    ${
      backend.kind === 'local'
        ? '<div class="notice" data-key="demo"><span class="grow"><b>Demo mode.</b> No database is connected yet, so games stay on this device and are not shared with other phones.</span></div>'
        : ''
    }
    ${state.failed ? `<div class="notice offline" data-key="failed">${esc(state.failed)}</div>` : ''}
    ${state.online || state.failed ? '' : '<div class="notice offline" data-key="offline">No connection. Trying to reconnect…</div>'}

    <h2 class="section-title" data-key="t-live">Games on now</h2>
    ${
      !games
        ? `<p class="empty" data-key="live-empty">${state.failed ? 'Games could not be loaded.' : 'Loading…'}</p>`
        : live.length
          ? `<ul class="game-list" data-key="live-list">${live.map(liveItem).join('')}</ul>`
          : '<p class="empty" data-key="live-empty">No game is running. Start one below.</p>'
    }

    <section class="card" data-key="new">
      <h2>New game</h2>
      <form class="stack" data-submit="create">
        <label class="field">Game name
          <input class="input" name="title" maxlength="40" placeholder="Poker night" autocomplete="off">
        </label>
        <label class="field">Chips per buy-in
          <input class="input" name="buyIn" type="number" inputmode="numeric" min="1" max="1000000" value="1000" required>
        </label>
        <button class="btn primary block" type="submit">Create game</button>
      </form>
    </section>

    ${
      past.length
        ? `<h2 class="section-title" data-key="t-past">Past games</h2>
           <ul class="game-list" data-key="past-list">${past.map(pastItem).join('')}</ul>`
        : ''
    }
  </main>`;
}

function viewGame() {
  if (state.gone) {
    return `
    <main class="page" data-key="gone">
      <header class="top"><a class="back" href="#/" aria-label="Back to games">←</a>
        <div class="titles"><h1>Game not found</h1></div></header>
      <p class="empty">This game does not exist, or it was closed before it started.</p>
      <a class="btn block" href="#/">See all games</a>
    </main>`;
  }
  const g = state.game;
  if (!g) {
    return `<main class="page" data-key="loading">
      <p class="empty">${state.failed ? esc(state.failed) : state.online ? 'Loading game…' : 'No connection. Trying to reconnect…'}</p>
      ${state.failed ? '<a class="btn block" href="#/">See all games</a>' : ''}
    </main>`;
  }

  const me = g.players.find((p) => p.key === myKey());
  const ctx = {
    g,
    me,
    active: Boolean(me && me.active),
    isBank: Boolean(me && me.active && g.bankKey === me.key),
  };
  const status =
    g.status === 'live'
      ? `<span class="badge live">Live</span>`
      : g.status === 'lobby'
        ? `<span class="badge lobby">Waiting</span>`
        : `<span class="badge">Ended</span>`;

  let body;
  if (g.status === 'lobby') body = viewLobby(ctx);
  else if (g.status === 'ended') body = viewEnded(ctx);
  else body = viewLive(ctx);

  return `
  <main class="page" data-key="game-${g.id}-${g.status}">
    <header class="top" data-key="top">
      <a class="back" href="#/" aria-label="Back to games">←</a>
      <div class="titles">
        <h1>${esc(g.title)}</h1>
        <div class="sub">${status}<span class="code">${g.id}</span></div>
      </div>
      ${g.status === 'ended' ? '' : '<button class="btn small" data-action="share">Invite</button>'}
    </header>
    ${state.online ? '' : '<div class="notice offline" data-key="offline">Reconnecting… chips may be out of date.</div>'}
    ${body}
  </main>`;
}

function joinNotice({ g, me, active }) {
  if (active || g.status === 'ended') return '';
  const text = me
    ? `You left with ${chipsText(me.chips)}. They are waiting for you.`
    : 'You are watching this game.';
  return `
  <div class="notice" data-key="join">
    <span class="grow">${text}</span>
    <button class="btn small primary" data-action="join">${me ? 'Rejoin' : `Join as ${esc(state.name)}`}</button>
  </div>`;
}

function playerRows({ g, isBank }, { showGive = false } = {}) {
  return g.players
    .map((p) => {
      const badges = [
        p.key === g.bankKey ? '<span class="badge bank">Bank</span>' : '',
        p.key === myKey() ? '<span class="badge you">You</span>' : '',
        p.active ? '' : '<span class="badge">Left</span>',
      ].join('');
      const fromBank = p.bought - p.returned;
      const sub =
        g.status === 'lobby'
          ? 'Ready'
          : `Took ${fmt(fromBank)}${p.inPot ? ` · In pot ${fmt(p.inPot)}` : ''}`;
      const right =
        g.status === 'lobby'
          ? ''
          : `<div class="stackv num"><strong>${fmt(p.chips)}</strong><span class="${netClass(p.net)}">${signed(p.net)}</span></div>`;
      const give =
        showGive && isBank && p.active
          ? `<button class="btn small gold" data-action="open-sheet" data-sheet="give" data-to="${esc(p.key)}" aria-label="Give chips to ${esc(p.name)}">Give</button>`
          : '';
      return `
      <li class="player${p.active ? '' : ' left'}" data-key="${esc(p.key)}">
        ${avatar(p.name)}
        <div class="grow">
          <div class="name"><span class="n">${esc(p.name)}</span>${badges}</div>
          <div class="sub num">${sub}</div>
        </div>
        ${right}${give}
      </li>`;
    })
    .join('');
}

function viewLobby(ctx) {
  const { g, active } = ctx;
  const count = g.players.length;
  return `
    ${joinNotice(ctx)}
    <section class="card" data-key="players">
      <h2>Players at the table (${count})</h2>
      <ul class="players">${playerRows(ctx)}</ul>
    </section>
    <section class="card stack" data-key="start">
      <p>When everyone is in, start the game. One player is picked at random to be the <b>bank</b> and hands out ${fmt(g.buyIn)} chips to each player.</p>
      <button class="btn primary block" data-action="start" ${active && count >= 2 ? '' : 'disabled'}>Start game</button>
      ${count < 2 ? '<p class="small muted center">Waiting for at least 2 players. Tap Invite to share the link.</p>' : ''}
    </section>
    ${
      active
        ? `<div class="more" data-key="foot">
             <button class="link" data-action="open-sheet" data-sheet="leave">Leave game</button>
             <button class="link" data-action="open-sheet" data-sheet="cancel">Close this game</button>
           </div>`
        : ''
    }`;
}

function viewLive(ctx) {
  const { g } = ctx;
  const tabs = [
    ['table', 'Table'],
    ['settle', 'Settle up'],
    ['history', 'History'],
  ]
    .map(
      ([id, label]) =>
        `<button class="tab" role="tab" aria-selected="${state.tab === id}" data-action="tab" data-tab="${id}">${label}</button>`,
    )
    .join('');

  let body;
  if (state.tab === 'settle') {
    body = `
      <section class="card" data-key="pay">
        <h2>If the game ended now</h2>
        ${payments(g)}
        ${g.pot.total ? '<p class="small muted" style="margin-top:12px">Chips in the pot still count as belonging to whoever put them in.</p>' : ''}
      </section>
      <section class="card" data-key="sheet"><h2>Chip sheet</h2>${chipSheet(g)}</section>`;
  } else if (state.tab === 'history') {
    body = `<section class="card" data-key="history"><h2>Every entry (${fmt(g.entryCount)})</h2>${historyList()}</section>`;
  } else {
    body = viewTable(ctx);
  }

  return `
    <nav class="tabs" role="tablist" data-key="tabs">${tabs}</nav>
    ${joinNotice(ctx)}
    ${body}`;
}

function viewTable(ctx) {
  const { g, me, active, isBank } = ctx;
  const ins = g.players.filter((p) => p.inPot > 0);

  const pot = `
    <section class="pot" data-key="pot">
      <div class="label">Pot · Hand ${fmt(g.hand)}</div>
      <div class="total num">${fmt(g.pot.total)}</div>
      <div class="unit">${g.pot.total === 1 ? 'chip' : 'chips'}</div>
      ${ins.length ? `<ul class="ins num">${ins.map((p) => `<li>${esc(p.name)} ${fmt(p.inPot)}</li>`).join('')}</ul>` : ''}
      ${
        active
          ? `<button class="btn gold" data-action="open-sheet" data-sheet="award" ${g.pot.total ? '' : 'disabled'}>Who won the pot?</button>`
          : ''
      }
    </section>`;

  const bankbar = isBank
    ? `<section class="bankbar" data-key="bank">
         <div class="grow"><b>You are the bank</b><span>Hand out chips to the players.</span></div>
         <button class="btn gold small" data-action="open-sheet" data-sheet="giveAll">Give everyone</button>
       </section>`
    : '';

  let mine = '';
  if (active) {
    const highest = Math.max(0, ...g.players.filter((p) => p.active).map((p) => p.inPot));
    const toCall = Math.min(me.chips, highest - me.inPot);
    const sizes = chipSizes(g.buyIn);
    const broke = me.chips === 0;
    mine = `
    <section class="card me" data-key="me">
      <div class="head"><h2>Your chips</h2><div class="mine num">${fmt(me.chips)}<small>${me.chips === 1 ? 'chip' : 'chips'}</small></div></div>
      <form class="stack" data-submit="bet">
        <input id="betAmount" class="input amount" name="amount" type="number" inputmode="numeric" pattern="[0-9]*" min="1" placeholder="Chips to bet" autocomplete="off" aria-label="Chips to bet">
        <div class="chip-row">
          ${sizes.map((v) => `<button type="button" class="chip" data-action="chip" data-v="${v}" aria-label="Add ${v}">+${fmt(v)}</button>`).join('')}
        </div>
        <div class="actions">
          <button type="submit" class="btn primary" data-key="bet" ${broke ? 'disabled' : ''}>Bet</button>
          ${toCall > 0 ? `<button type="button" class="btn" data-key="call" data-action="call" data-v="${toCall}">Call ${fmt(toCall)}</button>` : ''}
          <button type="button" class="btn" data-key="allin" data-action="allin" ${broke ? 'disabled' : ''}>All in</button>
        </div>
      </form>
      ${
        broke && !me.inPot
          ? `<p class="small muted center" data-key="hint" style="margin-top:12px">You have no chips. ${isBank ? 'Give yourself some from the bank.' : `Ask ${esc(g.bankName || 'the bank')} for chips.`}</p>`
          : ''
      }
      <div class="more" data-key="more" style="margin-top:10px">
        ${me.inPot ? `<button class="link" data-key="undo" data-action="undo-bet" data-v="${me.inPot}">Take back my ${fmt(me.inPot)}</button>` : ''}
        <button class="link" data-key="send" data-action="open-sheet" data-sheet="send">Send chips</button>
        <button class="link" data-key="ret" data-action="open-sheet" data-sheet="return">Return to bank</button>
      </div>
    </section>`;
  }

  const count = g.players.filter((p) => p.active).length;
  const foot = active
    ? `<div class="more" data-key="foot">
         <button class="link" data-key="leave" data-action="open-sheet" data-sheet="leave">Leave game</button>
         ${isBank ? '<button class="link" data-key="hand" data-action="open-sheet" data-sheet="bank">Hand over the bank</button>' : ''}
         ${isBank || !g.bankKey ? '<button class="link" data-key="end" data-action="open-sheet" data-sheet="end">End game</button>' : ''}
       </div>`
    : '';

  return `
    ${pot}
    ${bankbar}
    ${mine}
    <section class="card" data-key="players">
      <h2>Players (${count})</h2>
      <ul class="players">${playerRows(ctx, { showGive: true })}</ul>
    </section>
    ${foot}`;
}

function payments(g) {
  if (!g.settlement.length) {
    return `<p class="empty">Nobody owes anything${g.status === 'ended' ? '.' : ' yet.'}</p>`;
  }
  return `<ul class="pay-list">${g.settlement
    .map(
      (p) => `
      <li class="pay">
        <span class="from">${esc(p.from)}</span>
        <span class="mid num"><b>${fmt(p.amount)}</b><span>pays →</span></span>
        <span class="to">${esc(p.to)}</span>
      </li>`,
    )
    .join('')}</ul>`;
}

function chipSheet(g) {
  const rows = [...g.players].sort((a, b) => b.net - a.net);
  return `
  <table class="sheet-table num">
    <thead><tr><th>Player</th><th>From bank</th><th>${g.status === 'ended' ? 'Final' : 'Now'}</th><th>Result</th></tr></thead>
    <tbody>
      ${rows
        .map(
          (p) => `<tr>
            <td>${esc(p.name)}</td>
            <td>${fmt(p.bought - p.returned)}</td>
            <td>${fmt(p.chips + p.inPot)}</td>
            <td class="net ${netClass(p.net)}">${signed(p.net)}</td>
          </tr>`,
        )
        .join('')}
    </tbody>
  </table>`;
}

function historyList() {
  const h = state.hist;
  const complete = h.list.length >= state.game.entryCount;
  if (!h.list.length) return `<p class="empty">${complete ? 'Nothing yet.' : 'Loading…'}</p>`;
  const items = [...h.list]
    .reverse()
    .map(
      (e) =>
        `<li class="${esc(e.type)}" data-key="e${e.n}"><time>${timeOf(e.t)}</time><span class="txt">${esc(e.text)}</span></li>`,
    )
    .join('');
  return `<ul class="log">${items}</ul>`;
}

function viewEnded({ g }) {
  const top = [...g.players].sort((a, b) => b.net - a.net)[0];
  const headline = top && top.net > 0 ? `${esc(top.name)} won ${chipsText(top.net)}` : 'Everyone finished level';
  return `
    <section class="winner" data-key="winner">
      <div class="label">Game over · ${dateOf(g.endedAt)}</div>
      <h2>${headline}</h2>
    </section>
    <section class="card" data-key="pay"><h2>Who pays whom</h2>${payments(g)}</section>
    <section class="card" data-key="sheet"><h2>Final chips</h2>${chipSheet(g)}</section>
    <section class="card" data-key="history"><h2>Every entry (${fmt(g.entryCount)})</h2>${historyList()}</section>
    <a class="btn block" href="#/" data-key="home">Back to all games</a>`;
}

// ---------- sheets (bottom dialogs) ----------

function amountField(label, value) {
  return `
  <label class="field">${label}
    <input class="input amount" name="amount" type="number" inputmode="numeric" pattern="[0-9]*" min="1" value="${value || ''}" autocomplete="off" required>
  </label>`;
}

function pickList(players, selected, action) {
  return `<div class="picks">${players
    .map(
      (p) => `
      <button type="button" class="pick" data-key="${esc(p.key)}" data-action="${action}" data-to="${esc(p.key)}" aria-pressed="${selected.includes(p.key)}">
        ${avatar(p.name)}<span class="n">${esc(p.name)}</span>
      </button>`,
    )
    .join('')}</div>`;
}

function sheetButtons(label, kind = 'primary', disabled = false) {
  return `
  <div class="row">
    <button type="button" class="btn grow" data-action="close-sheet">Cancel</button>
    <button type="submit" class="btn ${kind} grow" ${disabled ? 'disabled' : ''}>${label}</button>
  </div>`;
}

function viewSheet() {
  const s = state.sheet;
  if (!s) return '';
  const g = state.game;
  let inner = '';

  if (s.type === 'name') {
    inner = `
      <h2>Change your name</h2>
      <p class="muted small">Games remember you by name, so a new name is a new player.</p>
      <label class="field">Your name
        <input class="input" name="name" maxlength="20" value="${esc(state.name)}" autocomplete="nickname" autocapitalize="words" required>
      </label>
      ${sheetButtons('Save')}`;
  } else if (!g) {
    return '';
  } else {
    const others = g.players.filter((p) => p.active && p.key !== myKey());
    const actives = g.players.filter((p) => p.active);
    const target = g.players.find((p) => p.key === s.to);

    if (s.type === 'give') {
      inner = `
        <h2>Give chips to ${esc(target ? target.name : '')}</h2>
        ${amountField('How many chips?', g.buyIn)}
        ${sheetButtons('Give chips', 'gold')}`;
    } else if (s.type === 'giveAll') {
      inner = `
        <h2>Give chips to everyone</h2>
        <p class="muted small">Each of the ${actives.length} players at the table gets this many chips: ${esc(actives.map((p) => p.name).join(', '))}.</p>
        ${amountField('Chips per player', g.buyIn)}
        ${sheetButtons('Give to everyone', 'gold')}`;
    } else if (s.type === 'award') {
      const n = s.winners.length;
      inner = `
        <h2>Who won the pot of ${fmt(g.pot.total)}?</h2>
        <p class="muted small">Pick more than one player to split it evenly.</p>
        ${pickList(actives, s.winners, 'pick-winner')}
        ${sheetButtons(n > 1 ? `Split between ${n}` : 'Give the pot', 'gold', n === 0)}`;
    } else if (s.type === 'send') {
      inner = `
        <h2>Send chips to a player</h2>
        ${others.length ? pickList(others, s.to ? [s.to] : [], 'pick-to') : '<p class="empty">No other players at the table.</p>'}
        ${amountField('How many chips?', '')}
        ${sheetButtons('Send', 'primary', !s.to)}`;
    } else if (s.type === 'return') {
      inner = `
        <h2>Return chips to the bank</h2>
        <p class="muted small">Use this to fix a wrong hand-out. Returned chips come off what you took from the bank.</p>
        ${amountField('How many chips?', '')}
        ${sheetButtons('Return chips')}`;
    } else if (s.type === 'bank') {
      inner = `
        <h2>Hand over the bank</h2>
        ${others.length ? pickList(others, s.to ? [s.to] : [], 'pick-to') : '<p class="empty">No other players at the table.</p>'}
        ${sheetButtons('Make them the bank', 'gold', !s.to)}`;
    } else if (s.type === 'leave') {
      const me = g.players.find((p) => p.key === myKey());
      inner = `
        <h2>Leave the game?</h2>
        <p class="muted">${
          g.status === 'live' && me
            ? `Your ${chipsText(me.chips)} stay on the sheet and count in the final report. You can rejoin with the same name.`
            : 'You can join again any time.'
        }</p>
        ${sheetButtons('Leave game', 'danger')}`;
    } else if (s.type === 'end') {
      inner = `
        <h2>End the game for everyone?</h2>
        <p class="muted">The table closes and everyone sees who pays whom. ${g.pot.total ? `The ${chipsText(g.pot.total)} in the pot go back to the players who bet them.` : ''} This cannot be undone.</p>
        ${sheetButtons('End game', 'danger')}`;
    } else if (s.type === 'cancel') {
      inner = `
        <h2>Close this game?</h2>
        <p class="muted">It has not started, so it will simply be removed for everyone.</p>
        ${sheetButtons('Close game', 'danger')}`;
    }
  }

  return `
  <div class="scrim" data-key="sheet-${s.id}">
    <form class="sheet" role="dialog" aria-modal="true" data-submit="sheet">${inner}</form>
  </div>`;
}

function viewToast() {
  if (!state.toast) return '';
  return `<div class="toast ${state.toast.kind}" role="status" data-key="toast">${esc(state.toast.message)}</div>`;
}

// ---------- rendering ----------

// Update the live DOM to match freshly rendered markup without replacing
// nodes that have not changed, so a bet from someone else never steals focus
// or wipes what you were typing.
function morph(from, to) {
  for (const { name, value } of [...to.attributes]) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  for (const { name } of [...from.attributes]) {
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }

  const wanted = [...to.childNodes];
  const keys = new Set(wanted.filter((n) => n.nodeType === 1 && n.dataset.key).map((n) => n.dataset.key));
  for (const child of [...from.children]) {
    if (child.dataset.key && !keys.has(child.dataset.key)) child.remove();
  }

  wanted.forEach((next, i) => {
    const current = from.childNodes[i] || null;
    if (next.nodeType === 1 && next.dataset.key) {
      const match = [...from.children].find((c) => c.dataset.key === next.dataset.key);
      if (match && match.nodeName === next.nodeName) {
        if (match !== current) from.insertBefore(match, current);
        morph(match, next);
      } else {
        if (match) match.remove();
        from.insertBefore(next, from.childNodes[i] || null);
      }
      return;
    }
    if (!current) {
      from.appendChild(next);
    } else if (current.nodeType === 1 && current.dataset.key) {
      from.insertBefore(next, current);
    } else if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      from.replaceChild(next, current);
    } else if (next.nodeType === 1) {
      morph(current, next);
    } else if (current.nodeValue !== next.nodeValue) {
      current.nodeValue = next.nodeValue;
    }
  });
  while (from.childNodes.length > wanted.length) from.lastChild.remove();
}

function viewStartup() {
  if (!state.failed) return '<main class="page" data-key="boot"><p class="empty">Loading…</p></main>';
  return `
  <main class="page login" data-key="boot">
    <div class="logo"><img src="./icon.svg" alt=""><strong>ChipBank</strong></div>
    <p>${esc(state.failed)}</p>
    <button class="btn primary block" data-action="reload">Try again</button>
  </main>`;
}

function render() {
  let page;
  if (!backend) page = viewStartup();
  else if (!state.name) page = viewLogin();
  else if (state.route.page === 'game') page = viewGame();
  else page = viewHome();

  const next = document.createElement('div');
  next.id = 'app';
  next.innerHTML = page + viewSheet() + viewToast();
  morph($app, next);

  document.title = state.game && state.route.page === 'game' ? `${state.game.title} · ChipBank` : 'ChipBank';

  // Put the cursor in a newly opened sheet's first field.
  const sheetId = state.sheet ? state.sheet.id : 0;
  if (sheetId && sheetId !== focusedSheet) {
    const input = $app.querySelector('.sheet input');
    if (input) {
      input.focus();
      input.select();
    }
  }
  focusedSheet = sheetId;
}

// ---------- events ----------

function openSheet(type, extra = {}) {
  sheetSeq += 1;
  state.sheet = { id: sheetSeq, type, to: null, winners: [], ...extra };
  render();
}

function closeSheet() {
  state.sheet = null;
  render();
}

function readAmount(form) {
  const input = form.querySelector('[name=amount]');
  const n = Number(input ? input.value : '');
  if (!Number.isInteger(n) || n <= 0) {
    toast('Enter a whole number of chips.', 'error');
    if (input) input.focus();
    return null;
  }
  return n;
}

async function placeBet(amount) {
  if (await act('bet', { amount })) {
    const input = document.getElementById('betAmount');
    if (input) input.value = '';
  }
}

async function submitSheet(form) {
  const s = state.sheet;
  if (!s) return;

  if (s.type === 'name') {
    const name = cleanName(form.querySelector('[name=name]').value);
    if (!name) return;
    state.name = name;
    localStorage.setItem(NAME_KEY, name);
    closeSheet();
    return;
  }

  let ok = false;
  if (s.type === 'give') {
    const amount = readAmount(form);
    if (amount) ok = await act('give', { to: s.to, amount });
  } else if (s.type === 'giveAll') {
    const amount = readAmount(form);
    if (amount) ok = await act('giveAll', { amount });
  } else if (s.type === 'award') {
    ok = await act('award', { winners: s.winners });
  } else if (s.type === 'send') {
    const amount = readAmount(form);
    if (amount) ok = await act('send', { to: s.to, amount });
  } else if (s.type === 'return') {
    const amount = readAmount(form);
    if (amount) ok = await act('return', { amount });
  } else if (s.type === 'bank') {
    ok = await act('makeBank', { to: s.to });
  } else if (s.type === 'leave') {
    ok = await act('leave');
    if (ok) {
      state.sheet = null;
      location.hash = '#/';
      return;
    }
  } else if (s.type === 'end') {
    ok = await act('end');
  } else if (s.type === 'cancel') {
    ok = await act('end');
    if (ok) {
      state.sheet = null;
      location.hash = '#/';
      return;
    }
  }
  if (ok && state.sheet === s) closeSheet();
}

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('[data-submit]');
  if (!form) return;
  ev.preventDefault();
  const kind = form.dataset.submit;

  if (kind === 'login') {
    const name = cleanName(form.querySelector('[name=name]').value);
    if (!name) return;
    state.name = name;
    localStorage.setItem(NAME_KEY, name);
    render();
  } else if (kind === 'create') {
    if (state.busy) return;
    state.busy = true;
    try {
      const id = await backend.createGame({
        name: state.name,
        title: form.querySelector('[name=title]').value,
        buyIn: form.querySelector('[name=buyIn]').value,
      });
      location.hash = `#/g/${id}`;
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      state.busy = false;
    }
  } else if (kind === 'bet') {
    const amount = readAmount(form);
    if (amount) placeBet(amount);
  } else if (kind === 'sheet') {
    submitSheet(form);
  }
});

document.addEventListener('click', async (ev) => {
  if (ev.target.classList && ev.target.classList.contains('scrim')) {
    closeSheet();
    return;
  }
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const { action } = el.dataset;
  const g = state.game;

  switch (action) {
    case 'open-sheet':
      openSheet(el.dataset.sheet, { to: el.dataset.to || null });
      break;
    case 'close-sheet':
      closeSheet();
      break;
    case 'tab':
      state.tab = el.dataset.tab;
      watchHistory();
      render();
      break;
    case 'join':
      act('join');
      break;
    case 'join-open':
      try {
        await backend.act(el.dataset.id, { name: state.name, type: 'join' });
        location.hash = `#/g/${el.dataset.id}`;
      } catch (err) {
        toast(err.message, 'error');
      }
      break;
    case 'start':
      act('start');
      break;
    case 'chip': {
      const input = document.getElementById('betAmount');
      input.value = (Number(input.value) || 0) + Number(el.dataset.v);
      break;
    }
    case 'call':
      placeBet(Number(el.dataset.v));
      break;
    case 'allin': {
      const me = g && g.players.find((p) => p.key === myKey());
      if (me && me.chips > 0) placeBet(me.chips);
      break;
    }
    case 'undo-bet':
      act('takeBack', { amount: Number(el.dataset.v) });
      break;
    case 'pick-winner': {
      const s = state.sheet;
      if (!s) break;
      const key = el.dataset.to;
      s.winners = s.winners.includes(key) ? s.winners.filter((k) => k !== key) : [...s.winners, key];
      render();
      break;
    }
    case 'pick-to':
      if (state.sheet) {
        state.sheet.to = el.dataset.to;
        render();
      }
      break;
    case 'share': {
      const url = `${location.origin}${location.pathname}${location.search}#/g/${g.id}`;
      const text = `Join "${g.title}" on ChipBank`;
      try {
        if (navigator.share) await navigator.share({ title: 'ChipBank', text, url });
        else {
          await navigator.clipboard.writeText(url);
          toast('Invite link copied.');
        }
      } catch (err) {
        if (err && err.name !== 'AbortError') toast(`Share this link: ${url}`);
      }
      break;
    }
    case 'reload':
      location.reload();
      break;
    default:
      break;
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.sheet) closeSheet();
});

window.addEventListener('hashchange', () => {
  state.route = parseRoute();
  state.game = null;
  state.gone = false;
  state.sheet = null;
  state.tab = 'table';
  connect();
  render();
});

render();
loadBackend()
  .then((loaded) => {
    backend = loaded;
    connect();
  })
  .catch(() => {
    state.failed = 'ChipBank could not start. Check your connection and try again.';
  })
  .finally(render);
