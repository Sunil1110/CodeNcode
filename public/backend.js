// Where games live. Two interchangeable stores with the same methods:
//   - Firebase (Cloud Firestore): the real thing, shared live between phones.
//   - Local: demo mode in this browser only, used until Firebase is configured.
// The rules themselves run in the page (game.js); a store only loads a game,
// applies one action to it and saves the result atomically.

import { firebaseConfig } from './firebase-config.js';
import { GameError, applyAction, createGame, summary, view } from './game.js';

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/13.4.0';
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LIST_LIMIT = 100;

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

const visible = (game) => game && game.status !== 'closed';

// For local development against the Firestore emulator: open the page as
// http://localhost:PORT/?emulator=8080
function emulatorPort() {
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return null;
  const port = Number(new URLSearchParams(location.search).get('emulator'));
  return Number.isInteger(port) && port > 0 ? port : null;
}

export async function loadBackend() {
  const port = emulatorPort();
  if (firebaseConfig || port) return firebaseBackend(firebaseConfig || { projectId: 'demo-chipbank' }, port);
  return localBackend();
}

// ---------- Firebase ----------

function friendly(err) {
  if (err instanceof GameError) return err;
  if (err && err.code === 'permission-denied') {
    return new Error('The database refused that. Check the Firestore rules are published.');
  }
  return new Error('Could not reach the server. Check your connection.');
}

async function firebaseBackend(config, port) {
  const [{ initializeApp }, fs] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`),
  ]);
  const db = fs.getFirestore(initializeApp(config));
  if (port) fs.connectFirestoreEmulator(db, location.hostname, port);

  const games = fs.collection(db, 'games');
  // The game document holds the current state. Its history lives beside it in
  // games/{id}/entries, one small document per entry, so a live update never
  // has to carry the whole log.
  const fromDoc = (data) => ({ ...data, entries: [] });
  const save = (tx, ref, game) => {
    const { entries, ...current } = game;
    tx.set(ref, current);
    for (const e of entries) tx.set(fs.doc(ref, 'entries', String(e.n).padStart(6, '0')), e);
  };
  const fail = (onError) => (err) => onError && onError(friendly(err));

  return {
    kind: 'firebase',

    watchGames(cb, onError) {
      return fs.onSnapshot(
        fs.query(games, fs.orderBy('createdAt', 'desc'), fs.limit(LIST_LIMIT)),
        { includeMetadataChanges: true },
        (snap) =>
          cb(
            snap.docs.map((d) => d.data()).filter(visible).map((g) => summary(fromDoc(g))),
            { offline: snap.metadata.fromCache },
          ),
        fail(onError),
      );
    },

    watchGame(id, cb, onError) {
      return fs.onSnapshot(
        fs.doc(games, id),
        { includeMetadataChanges: true },
        (snap) => {
          const offline = snap.metadata.fromCache;
          // An empty answer from the cache only means "not loaded yet".
          if (!snap.exists() && offline) {
            cb(undefined, { offline });
            return;
          }
          const data = snap.data();
          cb(visible(data) ? view(fromDoc(data)) : null, { offline });
        },
        fail(onError),
      );
    },

    watchEntries(id, cb, onError) {
      return fs.onSnapshot(
        fs.query(fs.collection(games, id, 'entries'), fs.orderBy('n')),
        (snap) => cb(snap.docs.map((d) => d.data())),
        fail(onError),
      );
    },

    async createGame({ name, title, buyIn }) {
      try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const id = newId();
          const ref = fs.doc(games, id);
          const created = await fs.runTransaction(db, async (tx) => {
            if ((await tx.get(ref)).exists()) return false;
            const now = Date.now();
            const game = createGame({ id, title, buyIn, now });
            applyAction(game, { type: 'join', name }, now);
            save(tx, ref, game);
            return true;
          });
          if (created) return id;
        }
      } catch (err) {
        throw friendly(err);
      }
      throw new Error('Could not create the game. Please try again.');
    },

    // Read, apply and write happen in one transaction, so two phones acting at
    // the same moment can never overwrite each other's chips.
    async act(id, action) {
      const ref = fs.doc(games, id);
      try {
        await fs.runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists()) throw new GameError('That game does not exist.');
          const game = fromDoc(snap.data());
          const before = game.seq;
          applyAction(game, action);
          if (game.seq !== before) save(tx, ref, game);
        });
      } catch (err) {
        throw friendly(err);
      }
    },
  };
}

// ---------- local demo ----------

function localBackend() {
  const KEY = 'chipbank.demo.games';
  const listeners = new Set();
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      return {};
    }
  };
  const notify = () => listeners.forEach((fn) => fn());
  const write = (all) => {
    localStorage.setItem(KEY, JSON.stringify(all));
    notify();
  };
  const watch = (fn) => {
    listeners.add(fn);
    fn();
    return () => listeners.delete(fn);
  };
  // Other tabs of this browser share the same demo games.
  window.addEventListener('storage', (ev) => {
    if (ev.key === KEY) notify();
  });

  return {
    kind: 'local',

    watchGames(cb) {
      return watch(() =>
        cb(
          Object.values(read())
            .filter(visible)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, LIST_LIMIT)
            .map(summary),
          { offline: false },
        ),
      );
    },

    watchGame(id, cb) {
      return watch(() => {
        const game = read()[id];
        cb(visible(game) ? view(game) : null, { offline: false });
      });
    },

    watchEntries(id, cb) {
      return watch(() => {
        const game = read()[id];
        cb(game ? game.entries : []);
      });
    },

    async createGame({ name, title, buyIn }) {
      const all = read();
      let id = newId();
      while (all[id]) id = newId();
      const now = Date.now();
      const game = createGame({ id, title, buyIn, now });
      applyAction(game, { type: 'join', name }, now);
      all[id] = game;
      write(all);
      return id;
    },

    async act(id, action) {
      const all = read();
      const game = all[id];
      if (!game) throw new GameError('That game does not exist.');
      applyAction(game, action);
      write(all);
    },
  };
}
