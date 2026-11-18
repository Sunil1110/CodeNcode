import test from 'node:test';
import assert from 'node:assert/strict';

import { GameError, applyAction, createGame, settle, standings, view } from '../public/game.js';

const firstPlayer = () => 0; // rng that always picks the first candidate

function liveGame(names = ['Asha', 'Ravi', 'Meena']) {
  const game = createGame({ id: 'TEST1', title: 'Test', buyIn: 1000, now: 1 });
  for (const name of names) applyAction(game, { type: 'join', name }, 1);
  applyAction(game, { type: 'start', name: names[0] }, 2, firstPlayer);
  return game;
}

const player = (game, name) => game.players.find((p) => p.name === name);
const act = (game, type, name, extra = {}) => applyAction(game, { type, name, ...extra }, 5, firstPlayer);

test('joining is by name and the same name is the same player', () => {
  const game = createGame({ id: 'A', title: '', buyIn: 500, now: 1 });
  act(game, 'join', '  Asha  ');
  act(game, 'join', 'asha');
  assert.equal(game.players.length, 1);
  assert.equal(game.players[0].name, 'Asha');
  assert.throws(() => act(game, 'join', '   '), GameError);
});

test('starting needs two players and picks a bank', () => {
  const game = createGame({ id: 'A', title: '', buyIn: 500, now: 1 });
  act(game, 'join', 'Asha');
  assert.throws(() => act(game, 'start', 'Asha'), /at least 2/);
  act(game, 'join', 'Ravi');
  applyAction(game, { type: 'start', name: 'Ravi' }, 2, () => 0.99);
  assert.equal(game.status, 'live');
  assert.equal(game.bankKey, 'ravi');
});

test('only the bank hands out chips', () => {
  const game = liveGame();
  assert.throws(() => act(game, 'give', 'Ravi', { to: 'ravi', amount: 100 }), /Only the bank/);
  act(game, 'giveAll', 'Asha', { amount: 1000 });
  act(game, 'give', 'Asha', { to: 'meena', amount: 500 });
  assert.equal(player(game, 'Ravi').chips, 1000);
  assert.equal(player(game, 'Meena').chips, 1500);
  assert.equal(player(game, 'Meena').bought, 1500);
});

test('amounts must be positive whole numbers within the stack', () => {
  const game = liveGame();
  act(game, 'giveAll', 'Asha', { amount: 100 });
  for (const amount of [0, -5, 1.5, 'abc', null]) {
    assert.throws(() => act(game, 'bet', 'Ravi', { amount }), GameError);
  }
  assert.throws(() => act(game, 'bet', 'Ravi', { amount: 101 }), /only have 100/);
});

test('bets build the pot and the winner takes it', () => {
  const game = liveGame();
  act(game, 'giveAll', 'Asha', { amount: 1000 });
  act(game, 'bet', 'Asha', { amount: 100 });
  act(game, 'bet', 'Ravi', { amount: 100 });
  act(game, 'bet', 'Meena', { amount: 150 });
  act(game, 'takeBack', 'Meena', { amount: 50 });
  assert.equal(game.pot.total, 300);
  act(game, 'award', 'Asha', { winners: ['ravi'] });
  assert.equal(player(game, 'Ravi').chips, 1200);
  assert.equal(game.pot.total, 0);
  assert.equal(game.hand, 2);
  assert.throws(() => act(game, 'award', 'Asha', { winners: ['ravi'] }), /empty/);
});

test('a split pot shares odd chips without losing any', () => {
  const game = liveGame();
  act(game, 'giveAll', 'Asha', { amount: 1000 });
  act(game, 'bet', 'Asha', { amount: 51 });
  act(game, 'bet', 'Ravi', { amount: 50 });
  act(game, 'award', 'Meena', { winners: ['asha', 'ravi', 'asha'] });
  assert.equal(player(game, 'Asha').chips, 949 + 51);
  assert.equal(player(game, 'Ravi').chips, 950 + 50);
});

test('the bank role moves on when the bank leaves', () => {
  const game = liveGame();
  act(game, 'giveAll', 'Asha', { amount: 1000 });
  act(game, 'leave', 'Asha');
  assert.equal(game.bankKey, 'ravi');
  assert.equal(player(game, 'Asha').active, false);
  assert.equal(player(game, 'Asha').chips, 1000);
  act(game, 'join', 'Asha');
  assert.equal(player(game, 'Asha').active, true);
  assert.equal(game.bankKey, 'ravi');
  assert.throws(() => act(game, 'send', 'Ravi', { to: 'nobody', amount: 1 }), /not in this game/);
});

test('ending the game refunds the pot and settles to zero', () => {
  const game = liveGame();
  act(game, 'giveAll', 'Asha', { amount: 1000 });
  act(game, 'give', 'Asha', { to: 'ravi', amount: 1000 });
  act(game, 'bet', 'Asha', { amount: 400 });
  act(game, 'bet', 'Ravi', { amount: 900 });
  act(game, 'award', 'Ravi', { winners: ['meena'] });
  act(game, 'send', 'Meena', { to: 'asha', amount: 100 });
  act(game, 'return', 'Meena', { amount: 200 });
  act(game, 'bet', 'Asha', { amount: 50 });
  assert.throws(() => act(game, 'end', 'Ravi'), /Only the bank/);
  act(game, 'end', 'Asha');

  assert.equal(game.status, 'ended');
  const rows = standings(game);
  assert.equal(rows.reduce((sum, r) => sum + r.net, 0), 0);
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.name, r.net])),
    { Asha: -300, Ravi: -900, Meena: 1200 },
  );
  assert.deepEqual(view(game).settlement, [
    { from: 'Ravi', to: 'Meena', amount: 900 },
    { from: 'Asha', to: 'Meena', amount: 300 },
  ]);
  assert.throws(() => act(game, 'join', 'Late'), /ended/);
});

test('settle uses at most one payment fewer than the number of players', () => {
  const rows = [
    { name: 'A', net: -700 },
    { name: 'B', net: -300 },
    { name: 'C', net: 450 },
    { name: 'D', net: 550 },
    { name: 'E', net: 0 },
  ];
  const payments = settle(rows);
  assert.ok(payments.length <= 3);
  const balance = Object.fromEntries(rows.map((r) => [r.name, r.net]));
  for (const p of payments) {
    balance[p.from] += p.amount;
    balance[p.to] -= p.amount;
  }
  assert.ok(Object.values(balance).every((v) => v === 0));
});

test('every change is written to the history in order', () => {
  const game = liveGame();
  act(game, 'giveAll', 'Asha', { amount: 1000 });
  act(game, 'bet', 'Ravi', { amount: 25 });
  assert.deepEqual(game.entries.map((e) => e.n), game.entries.map((_, i) => i + 1));
  assert.equal(game.entries.at(-1).text, 'Ravi put 25 chips in the pot');
  assert.equal(view(game).entryCount, game.entries.length);
});

test('a game that never starts is closed, not settled', () => {
  const game = createGame({ id: 'A', title: '', buyIn: 500, now: 1 });
  act(game, 'join', 'Asha');
  act(game, 'join', 'Ravi');
  act(game, 'leave', 'Ravi');
  assert.equal(game.status, 'lobby');
  act(game, 'leave', 'Asha');
  assert.equal(game.status, 'closed');
  assert.throws(() => act(game, 'join', 'Asha'), /closed/);

  const other = createGame({ id: 'B', title: '', buyIn: 500, now: 1 });
  act(other, 'join', 'Asha');
  act(other, 'end', 'Asha');
  assert.equal(other.status, 'closed');
});
