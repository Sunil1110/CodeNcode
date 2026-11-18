CodeNcode
=========

code of ncode

# ChipBank

A small web app for poker nights played with real cards and virtual chips.
Everyone opens the site on their phone, the app keeps each player's chips in
sync live, and at the end it shows who pays whom.

## How a game works

1. **Enter your name.** That is the whole login. Use the same name again and you are the same player.
2. **Create a game** (name and chips per buy-in) or **join** one from the list or an invite link.
3. **Start the game.** One player is picked at random as the **bank**.
4. **The bank hands out chips** to everyone at once, or to one player (rebuys, late joiners).
5. **Play.** Each player bets chips into the pot from their own phone. After the hand, anyone picks the winner and the pot moves to them. Pick several winners to split it.
6. **Join or leave any time.** A player who leaves keeps their chips on the sheet and can rejoin with the same name. If the bank leaves, another player becomes the bank.
7. **The bank ends the game.** Everyone sees the report: the fewest payments that settle all debts, each player's result, and the full history.

Every change (joins, hand-outs, bets, pots, transfers) is saved as an entry.
Past games stay on the home page with their report and history.

## Run it

Needs Node.js 18 or newer. There are no dependencies to install.

```
npm start
```

Then open http://localhost:3000. Players on the same Wi-Fi can open
`http://<your-computer-ip>:3000`.

| Setting    | Default  | Meaning                         |
| ---------- | -------- | ------------------------------- |
| `PORT`     | `3000`   | Port the site listens on        |
| `DATA_DIR` | `./data` | Folder where games are saved    |

Games are saved as one JSON file each in `data/games/`. If you host this
online, point `DATA_DIR` at storage that survives restarts, or the history is
lost on each deploy.

## Tests

```
npm test
```

## Layout

- `server.js`: web server, JSON API and live updates (server-sent events)
- `lib/game.js`: the game rules and the settle-up maths
- `lib/store.js`: saving games to disk
- `public/`: the page players use
- `test/`: tests for the game rules

Names are not protected by a password, so anyone with the link can join as
any name. That is fine for a table of friends; do not use it for real stakes
with strangers.
