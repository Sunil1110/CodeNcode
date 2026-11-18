'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Keeps every game in memory and mirrors each one to its own JSON file, so a
// restart picks up live games and the full history where they left off.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.games = new Map();
    this.dirty = new Set();
    this.timer = null;
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const game = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (game && game.id) this.games.set(game.id, game);
      } catch (err) {
        console.error(`Skipping unreadable game file ${file}: ${err.message}`);
      }
    }
  }

  get(id) {
    return this.games.get(id);
  }

  all() {
    return [...this.games.values()];
  }

  put(game) {
    this.games.set(game.id, game);
    this.dirty.add(game.id);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 50);
  }

  remove(id) {
    this.games.delete(id);
    this.dirty.delete(id);
    fs.rmSync(this.fileFor(id), { force: true });
  }

  fileFor(id) {
    return path.join(this.dir, `${id}.json`);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const id of this.dirty) {
      const game = this.games.get(id);
      if (!game) continue;
      // Write to a temp file first so a crash mid-write never corrupts a game.
      const tmp = `${this.fileFor(id)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(game));
      fs.renameSync(tmp, this.fileFor(id));
    }
    this.dirty.clear();
  }
}

module.exports = { Store };
