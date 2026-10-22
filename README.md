# Hand & Foot — online, 4 players, with chat

A browser game for four friends playing in two partnerships. Works on iPhone, Android and desktop — no app to install. One person creates a game, shares the 4-letter code (or invite link), everyone joins from their phone's browser.

## Run it on your own computer first

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. To try it as four players on one machine, open four browser windows (use private/incognito windows for some of them so each gets its own seat). Phones on the same Wi-Fi can join at `http://<your-computer's-IP>:3000`.

Tests: `npm test` runs these checks: 100 bot games through the rules engine, the database code, a 4-player multiplayer test, a kill-and-restart test, and a notification test.

## Put it online for free (Render + Neon)

Games can run over days, so they're saved in a small free database. That way they survive the server going to sleep.

**1. Make the free database (Neon, ~3 minutes)**
1. Sign up at [neon.com](https://neon.com). No credit card is needed, and the Free plan doesn't expire.
2. Create a project, any name, and pick a region near you. Sydney is closest for Adelaide.
3. On the project dashboard, click **Connect** and copy the connection string. It looks like `postgresql://user:password@ep-something.ap-southeast-2.aws.neon.tech/neondb?sslmode=require`.

**2. Put the code on GitHub**
Make a free account at [github.com](https://github.com) and create a new repository called `hand-and-foot`. Upload all of these files to it, but skip `node_modules` and `data` if they're there.

**3. Host it on Render**
1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Click **New → Blueprint**, pick your `hand-and-foot` repository, and click **Apply**.
3. When it asks for `DATABASE_URL`, paste the Neon connection string from step 1.
4. After a few minutes you get a link like `https://hand-and-foot-xxxx.onrender.com`. Send that to your friends.

The server saves notification keys in the database on first start, so you don't have to set those up.

What to expect on the free plan:
- The server sleeps after 15 minutes with nobody looking at the game. The next person to open the link waits about a minute while it wakes up. **Nothing is lost**: the game, chat and everyone's cards come back exactly as they were.
- Notifications are sent the moment someone finishes their turn, while the server is awake anyway, so sleeping doesn't delay them.

To update the game later, change the files on GitHub and Render redeploys automatically.

## Playing over days

- Nobody is ever timed out. Whoever's turn it is can take as long as they like, and the screen shows how long it's been their turn.
- **Turn notifications:** tap 🔕 in the top bar (or the button in the lobby) and allow notifications. It turns to 🔔. After that you get a notification when it's your turn, when a round ends, and for chat while you're away (at most one chat alert every 10 minutes).
  - **iPhone:** notifications only work from the home-screen app. Open the link in Safari, tap Share → **Add to Home Screen**, open Hand & Foot from the home screen, rejoin with your name, then tap 🔕. This needs iOS 16.4 or newer.
  - **Android:** works straight from Chrome. Adding it to the home screen (Chrome menu → **Add to Home screen**) is still nicer.
- **Coming back:** open the link (or the home-screen app). On a new device, or the first time in the home-screen app, enter **the same name** you joined with and the game code. You get your seat and cards back.
- **What happened while I was gone?** Tap the line under the player names (or open 💬 → **What happened**). It shows every move with how long ago it happened.
- The green dot next to a name means that person has the game open right now.

## Run it on your own computer (or home server) instead

Without `DATABASE_URL`, games are saved as files in a `data/` folder, which is fine for a computer that stays on. Notifications need the site to be served over HTTPS (Render does this for you).

## How to play in the app

- **Create** a game, then tap **Invite friends** to share the link. Partners sit opposite each other (North + South vs East + West); tap a seat to swap. The host taps **Deal the cards**.
- On your turn, tap **Draw 2** (or tap the stock).
- **To pick up the pile:** select the two matching cards from your hand, then tap **Pick up** (the button and the pile both show how many cards you'll take). If your team hasn't opened yet, first stage any extra melds you need with **+ Meld** so the total reaches the minimum.
- **To meld:** select cards → **+ New meld** (this stages it), or select cards and tap one of your team's melds to add to it. For a wild meld, select 3 or more 2s/jokers → **+ New meld**. Staged cards wait in the gold tray; tap a staged group to put it back. Tap **Lay down** to play everything staged.
- **Hints:** cards in your hand that can go on one of your team's unfinished melds glow green, with a tag showing which meld (e.g. →A). 2s and jokers only glow if your team has an unfinished wild meld. When you select cards, any of your melds they can legally go on lights up.
- **To go out:** once you're in your foot, tap **🙋 Ask to go out**. When your partner says yes, play your last cards (or discard your last card) to go out. If your partner asks you, a green Yes / No box appears above your hand.
- **To discard:** select one card → **Discard**. That ends your turn.
- With nothing selected, tap any meld (yours or theirs) to see its cards.
- 💬 opens chat. New messages pop up at the top; tap one to open chat.

## Rules used

Every number here is a setting at the top of `game.js`.

| | |
|---|---|
| Players | 4, in two partnerships (partners share melds and score) |
| Cards | 6 standard decks with jokers (324 cards) |
| Deal | 11-card hand + 11-card foot each; play your hand first |
| Wild cards | 2s and jokers |
| Turn | Draw 2 from the stock, **or** pick up from the discard pile; meld; discard 1 |
| Picking up | Top card must be natural (not wild, not a 3), and you must meld it with two natural matching cards from your hand. How many cards you take (including the top card) depends on the top card: **4s take 4, 5s take 5 … 9s take 9; 10s, J, Q, K and A take 10**. If the pile is shorter you take it all. The screen shows how many you'll get |
| Melds | 3–7 cards of one rank; at least 2 naturals; at most 3 wilds; 3s can't be melded |
| Wild meld | A meld made only of 2s and jokers (3–7 cards). Only wild cards can be added to it |
| Books | A meld of 7 is a closed book: **wild** (all wild cards) 2500, **clean** (no wilds) 500, **dirty** 300 |
| Opening | A team's first meld(s) in a round must total 50 / 90 / 120 / 150 points in rounds 1–4. Pile cards don't count toward the opening (only the top card and your pair) |
| Red 3s | Laid down automatically and replaced; +100 each. Shown as a pile at the start of each team's melds |
| Black 3s | Can't be melded; discarding one blocks the next player from picking up the pile |
| Foot | When your hand runs out (by melding or discarding), pick up your foot. If you discarded your last card, your turn ends |
| Going out | Only from your foot, once your team has **1 wild, 1 clean and 2 dirty books**. Meld or discard your last card for a +100 bonus. You can't play down to your last card unless you can go out |
| Asking to go out | Before going out you must ask your partner: tap **🙋 Ask to go out** (on your turn, once you're in your foot, once per turn). Your partner gets a Yes / No prompt (and a notification if they're away). Yes = you may go out this turn (not forced to). No = you can't go out this turn. Everyone sees the question and answer in the history. Turn it off with `ASK_PARTNER = false` in `game.js` |
| Going out over a book | When you're going out, you may put extra natural cards on top of a finished book (e.g. a K on your kings book, then discard your last card). Only allowed if it leaves you with at most 1 card to discard. No wild cards on a finished natural book; only 2s and jokers on the wild book. The book keeps its type, and the extra cards score their normal value |
| Round ends | Someone goes out, or the stock runs out (including when only red 3s are left) |
| Card values | Joker 50 · 2 and A 20 · 8–K 10 · 4–7 and black 3 5 |
| Scoring | Books + value of melded cards + red 3s + going-out bonus − value of cards left in each partner's hand and unplayed foot |
| Game | 4 rounds; highest total wins |

## Files

- `game.js` — rules engine (the server decides everything; phones can't cheat by seeing others' cards)
- `server.js` — web server, rooms, seats, reconnects, chat, notifications
- `storage.js` — saves games to Postgres (`DATABASE_URL`) or to files in `data/`
- `public/sw.js` — receives notifications on the phone
- `public/` — the phone/browser interface
- `test/` — bot simulation and multiplayer tests
