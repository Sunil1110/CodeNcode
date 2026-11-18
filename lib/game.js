'use strict';

// Pure game rules for the chip tracker. Nothing in here touches the network or
// the disk: every function takes a game object and either mutates it or reads it.

const MAX_AMOUNT = 1_000_000_000;
const MAX_PLAYERS = 30;
const NAME_LENGTH = 20;
const TITLE_LENGTH = 40;

class GameError extends Error {}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH).trim();
  if (!name) throw new GameError('Please enter a name.');
  return name;
}

const keyOf = (name) => name.toLowerCase();

function cleanTitle(raw) {
  const title = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_LENGTH).trim();
  return title || 'Poker night';
}

function cleanAmount(raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (!Number.isInteger(n) || n <= 0) {
    throw new GameError('Enter a whole number of chips greater than 0.');
  }
  if (n > MAX_AMOUNT) throw new GameError('That is too many chips.');
  return n;
}

const chips = (n) => `${n.toLocaleString('en-US')} ${n === 1 ? 'chip' : 'chips'}`;

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function createGame({ id, title, buyIn, now }) {
  return {
    id,
    title: cleanTitle(title),
    buyIn: buyIn === undefined || buyIn === '' ? 1000 : cleanAmount(buyIn),
    status: 'lobby', // lobby -> live -> ended
    createdAt: now,
    startedAt: null,
    endedAt: null,
    bankKey: null,
    hand: 1,
    pot: { total: 0, by: {} },
    players: [],
    entries: [],
    seq: 0,
  };
}

function addEntry(game, now, type, actor, text, data = {}) {
  game.seq += 1;
  game.entries.push({ n: game.seq, t: now, type, actor: actor || null, text, ...data });
}

const findPlayer = (game, key) => game.players.find((p) => p.key === key);
const activePlayers = (game) => game.players.filter((p) => p.active);

function requireLive(game) {
  if (game.status === 'lobby') throw new GameError('The game has not started yet.');
  if (game.status === 'ended') throw new GameError('This game has ended.');
}

function requireActive(game, name) {
  const player = findPlayer(game, keyOf(cleanName(name)));
  if (!player || !player.active) throw new GameError('Join the game first.');
  return player;
}

function requireBank(game, player) {
  if (game.bankKey !== player.key) throw new GameError('Only the bank can do that.');
}

function requireTarget(game, rawKey) {
  const target = findPlayer(game, keyOf(cleanName(rawKey)));
  if (!target) throw new GameError('That player is not in this game.');
  if (!target.active) throw new GameError(`${target.name} has left the game.`);
  return target;
}

function pickBank(game, now, rng) {
  const candidates = activePlayers(game);
  if (!candidates.length) {
    game.bankKey = null;
    return;
  }
  const bank = candidates[Math.floor(rng() * candidates.length)];
  game.bankKey = bank.key;
  addEntry(game, now, 'bank', bank.name, `${bank.name} is now the bank`);
}

const actions = {
  join(game, a, now) {
    if (game.status === 'ended') throw new GameError('This game has ended.');
    const name = cleanName(a.name);
    const existing = findPlayer(game, keyOf(name));
    if (existing) {
      if (existing.active) return;
      existing.active = true;
      addEntry(game, now, 'join', existing.name, `${existing.name} rejoined with ${chips(existing.chips)}`);
    } else {
      if (game.players.length >= MAX_PLAYERS) throw new GameError('This game is full.');
      game.players.push({
        key: keyOf(name),
        name,
        chips: 0,
        bought: 0,
        returned: 0,
        active: true,
        joinedAt: now,
      });
      addEntry(game, now, 'join', name, `${name} joined`);
    }
    // Everyone had left a running game, so the first person back runs the bank.
    if (game.status === 'live' && !game.bankKey) {
      const player = findPlayer(game, keyOf(name));
      game.bankKey = player.key;
      addEntry(game, now, 'bank', player.name, `${player.name} is now the bank`);
    }
  },

  leave(game, a, now, rng) {
    if (game.status === 'ended') throw new GameError('This game has ended.');
    const player = requireActive(game, a.name);
    if (game.status === 'lobby') {
      game.players = game.players.filter((p) => p !== player);
      addEntry(game, now, 'leave', player.name, `${player.name} left`);
      return;
    }
    player.active = false;
    addEntry(game, now, 'leave', player.name, `${player.name} left with ${chips(player.chips)}`);
    if (game.bankKey === player.key) pickBank(game, now, rng);
  },

  start(game, a, now, rng) {
    if (game.status !== 'lobby') throw new GameError('The game has already started.');
    const player = requireActive(game, a.name);
    if (activePlayers(game).length < 2) throw new GameError('You need at least 2 players to start.');
    game.status = 'live';
    game.startedAt = now;
    addEntry(game, now, 'start', player.name, `${player.name} started the game`);
    pickBank(game, now, rng);
  },

  give(game, a, now) {
    requireLive(game);
    const bank = requireActive(game, a.name);
    requireBank(game, bank);
    const target = requireTarget(game, a.to);
    const amount = cleanAmount(a.amount);
    target.chips += amount;
    target.bought += amount;
    addEntry(game, now, 'give', bank.name, `Bank gave ${chips(amount)} to ${target.name}`, {
      to: target.name,
      amount,
    });
  },

  giveAll(game, a, now) {
    requireLive(game);
    const bank = requireActive(game, a.name);
    requireBank(game, bank);
    const amount = cleanAmount(a.amount);
    const targets = activePlayers(game);
    for (const p of targets) {
      p.chips += amount;
      p.bought += amount;
    }
    addEntry(
      game,
      now,
      'give',
      bank.name,
      `Bank gave ${chips(amount)} each to ${listNames(targets.map((p) => p.name))}`,
      { amount },
    );
  },

  // A player hands chips back to the bank, e.g. to fix a wrong hand-out.
  return(game, a, now) {
    requireLive(game);
    const player = requireActive(game, a.name);
    const amount = cleanAmount(a.amount);
    if (amount > player.chips) throw new GameError(`You only have ${chips(player.chips)}.`);
    player.chips -= amount;
    player.returned += amount;
    addEntry(game, now, 'return', player.name, `${player.name} returned ${chips(amount)} to the bank`, {
      amount,
    });
  },

  bet(game, a, now) {
    requireLive(game);
    const player = requireActive(game, a.name);
    const amount = cleanAmount(a.amount);
    if (amount > player.chips) throw new GameError(`You only have ${chips(player.chips)}.`);
    player.chips -= amount;
    game.pot.total += amount;
    game.pot.by[player.key] = (game.pot.by[player.key] || 0) + amount;
    const allIn = player.chips === 0 ? ' (all in)' : '';
    addEntry(game, now, 'bet', player.name, `${player.name} put ${chips(amount)} in the pot${allIn}`, {
      amount,
    });
  },

  takeBack(game, a, now) {
    requireLive(game);
    const player = requireActive(game, a.name);
    const amount = cleanAmount(a.amount);
    const mine = game.pot.by[player.key] || 0;
    if (amount > mine) throw new GameError(`You only have ${chips(mine)} in the pot.`);
    player.chips += amount;
    game.pot.total -= amount;
    game.pot.by[player.key] = mine - amount;
    if (!game.pot.by[player.key]) delete game.pot.by[player.key];
    addEntry(game, now, 'takeBack', player.name, `${player.name} took ${chips(amount)} back from the pot`, {
      amount,
    });
  },

  award(game, a, now) {
    requireLive(game);
    const player = requireActive(game, a.name);
    if (!game.pot.total) throw new GameError('The pot is empty.');
    if (!Array.isArray(a.winners) || !a.winners.length) throw new GameError('Pick who won the pot.');
    const winners = [];
    for (const raw of a.winners) {
      const w = requireTarget(game, raw);
      if (!winners.includes(w)) winners.push(w);
    }
    const total = game.pot.total;
    const share = Math.floor(total / winners.length);
    const odd = total - share * winners.length;
    winners.forEach((w, i) => {
      w.chips += share + (i < odd ? 1 : 0);
    });
    const names = listNames(winners.map((w) => w.name));
    const text =
      winners.length === 1
        ? `${names} won the pot of ${chips(total)}`
        : `${names} split the pot of ${chips(total)}`;
    addEntry(game, now, 'award', player.name, text, {
      amount: total,
      hand: game.hand,
      winners: winners.map((w) => w.name),
    });
    game.pot = { total: 0, by: {} };
    game.hand += 1;
  },

  send(game, a, now) {
    requireLive(game);
    const player = requireActive(game, a.name);
    const target = requireTarget(game, a.to);
    if (target === player) throw new GameError('Pick another player.');
    const amount = cleanAmount(a.amount);
    if (amount > player.chips) throw new GameError(`You only have ${chips(player.chips)}.`);
    player.chips -= amount;
    target.chips += amount;
    addEntry(game, now, 'send', player.name, `${player.name} sent ${chips(amount)} to ${target.name}`, {
      to: target.name,
      amount,
    });
  },

  makeBank(game, a, now) {
    requireLive(game);
    const bank = requireActive(game, a.name);
    requireBank(game, bank);
    const target = requireTarget(game, a.to);
    if (target === bank) throw new GameError('You are already the bank.');
    game.bankKey = target.key;
    addEntry(game, now, 'bank', bank.name, `${bank.name} handed the bank to ${target.name}`, {
      to: target.name,
    });
  },

  end(game, a, now) {
    requireLive(game);
    const player = requireActive(game, a.name);
    if (game.bankKey) requireBank(game, player);
    if (game.pot.total) {
      for (const p of game.players) {
        const back = game.pot.by[p.key] || 0;
        p.chips += back;
      }
      addEntry(game, now, 'refund', null, `Unclaimed pot of ${chips(game.pot.total)} went back to the players`, {
        amount: game.pot.total,
      });
      game.pot = { total: 0, by: {} };
    }
    game.status = 'ended';
    game.endedAt = now;
    addEntry(game, now, 'end', player.name, `${player.name} ended the game`);
  },
};

function applyAction(game, action, now = Date.now(), rng = Math.random) {
  const handler = Object.hasOwn(actions, action?.type) ? actions[action.type] : null;
  if (!handler) throw new GameError('Unknown action.');
  handler(game, action, now, rng);
}

// What each player is up or down. Chips sitting in the pot still belong to
// whoever put them there until the pot is awarded.
function standings(game) {
  return game.players.map((p) => {
    const inPot = game.pot.by[p.key] || 0;
    return { ...p, inPot, net: p.chips + inPot + p.returned - p.bought };
  });
}

// Fewest simple payments that clear everyone's balance: the biggest loser pays
// the biggest winner, and so on down the list.
function settle(rows) {
  const byAmount = (a, b) => b.amount - a.amount || a.name.localeCompare(b.name);
  const debtors = rows
    .filter((r) => r.net < 0)
    .map((r) => ({ name: r.name, amount: -r.net }))
    .sort(byAmount);
  const creditors = rows
    .filter((r) => r.net > 0)
    .map((r) => ({ name: r.name, amount: r.net }))
    .sort(byAmount);
  const payments = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d].amount, creditors[c].amount);
    payments.push({ from: debtors[d].name, to: creditors[c].name, amount });
    debtors[d].amount -= amount;
    creditors[c].amount -= amount;
    if (!debtors[d].amount) d += 1;
    if (!creditors[c].amount) c += 1;
  }
  return payments;
}

function view(game, { entryLimit } = {}) {
  const players = standings(game);
  const bank = players.find((p) => p.key === game.bankKey);
  return {
    ...game,
    players,
    bankName: bank ? bank.name : null,
    settlement: settle(players),
    entries: entryLimit ? game.entries.slice(-entryLimit) : game.entries,
    entryCount: game.seq,
  };
}

function summary(game) {
  const players = standings(game);
  const bank = players.find((p) => p.key === game.bankKey);
  return {
    id: game.id,
    title: game.title,
    status: game.status,
    buyIn: game.buyIn,
    createdAt: game.createdAt,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    bankName: bank ? bank.name : null,
    entryCount: game.seq,
    players: players.map((p) => ({ key: p.key, name: p.name, active: p.active, net: p.net })),
  };
}

module.exports = {
  GameError,
  applyAction,
  cleanName,
  createGame,
  keyOf,
  settle,
  standings,
  summary,
  view,
};
