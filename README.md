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

## How it is hosted

The site is plain static files in `public/`, served by GitHub Pages. Games are
stored in Cloud Firestore (Firebase), which also pushes every change to all
open phones. There is no server of our own to run.

### One-time setup

**Firebase (the database)**

1. Go to https://console.firebase.google.com and create a project. Analytics is not needed.
2. Open **Build > Firestore Database**, click **Create database**, pick a location near you and start in **production mode**.
3. Open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules) and click **Publish**.
4. Open **Project settings** (gear icon) **> Your apps**, add a **Web** app, and copy the `firebaseConfig` object it shows.
5. Paste that object into [`public/firebase-config.js`](public/firebase-config.js) in place of `null`.

**GitHub Pages (the website)**

1. In this repository open **Settings > Pages** and set **Source** to **GitHub Actions**.
2. Every push to `master` then tests and publishes the site (see `.github/workflows/pages.yml`).

Until `firebase-config.js` is filled in, the site runs in demo mode: it works,
but games stay on one device.

## Develop

```
npm test     # rules and settle-up maths
npm start    # serve public/ locally
```

- `public/game.js`: the game rules and the settle-up maths
- `public/backend.js`: saving and live sync (Firestore, or local demo mode)
- `public/app.js`, `style.css`, `index.html`: the page players use
- `firestore.rules`: what the database allows
- `test/`: tests for the game rules

## Good to know

Names are not protected by a password, and the rules run in each player's
browser, so anyone with the link can join as any name. The database rules
limit the damage (nothing can be deleted, finished games and history entries
cannot be changed), but this is built for a table of friends, not for real
stakes with strangers.
