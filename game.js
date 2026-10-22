'use strict';
/*
 * Hand and Foot — game engine (server-authoritative).
 * Rules are configured by the constants below; see README.md for the full rule list.
 */
const crypto = require('crypto');

const RANK_ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', 'JK'];
const SUITS = ['S', 'H', 'D', 'C'];
const MIN_MELD = [50, 90, 120, 150];   // opening minimum per round
const ROUNDS = MIN_MELD.length;
const DECKS = 6;                         // 6 decks incl. jokers = 324 cards
const HAND_SIZE = 11;                    // cards in each hand and each foot
// How many cards you take when you pick up the pile (including the top card), by the top card's rank:
// 4s take 4, 5s take 5 … 9s take 9; 10s, picture cards and aces take 10.
const PICKUP_BY_RANK = { 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 10, Q: 10, K: 10, A: 10 };
const pickupCount = (rank) => PICKUP_BY_RANK[rank] || 0;
const BOOK_SIZE = 7;
const MIN_NATURALS = 2;
const MAX_WILDS = 3;
const CLEAN_BOOK = 500;
const DIRTY_BOOK = 300;
const WILD_BOOK = 2500;                  // a book made only of 2s and jokers
const RED3_BONUS = 100;
const GO_OUT_BONUS = 100;
const BOOKS_TO_GO_OUT = { wild: 1, clean: 1, dirty: 2 };
const ASK_PARTNER = true;                // you must ask your partner (and get a yes) before going out
const WILD_RANK = 'W';                   // rank used for an all-wild meld
const GO_OUT_TEXT = `${BOOKS_TO_GO_OUT.wild} wild, ${BOOKS_TO_GO_OUT.clean} clean and ${BOOKS_TO_GO_OUT.dirty} dirty book${BOOKS_TO_GO_OUT.dirty === 1 ? '' : 's'}`;

class GameError extends Error {}

const teamOf = (seat) => seat % 2;
const partnerOf = (seat) => (seat + 2) % 4;
const isWild = (c) => c.r === '2' || c.r === 'JK';
const isRed3 = (c) => c.r === '3' && (c.s === 'H' || c.s === 'D');

function cardValue(c) {
  if (c.r === 'JK') return 50;
  if (c.r === '2' || c.r === 'A') return 20;
  if (['8', '9', '10', 'J', 'Q', 'K'].includes(c.r)) return 10;
  return 5; // 3s (black), 4-7
}
const sumValues = (cards) => cards.reduce((t, c) => t + cardValue(c), 0);
const rankLabel = (r) => (r === 'JK' ? 'Joker' : r === WILD_RANK ? 'Wild' : r);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDeck() {
  const cards = [];
  let id = 0;
  for (let d = 0; d < DECKS; d++) {
    for (const s of SUITS) {
      for (const r of RANK_ORDER) {
        if (r !== 'JK') cards.push({ id: 'c' + id++, r, s });
      }
    }
    cards.push({ id: 'c' + id++, r: 'JK', s: null });
    cards.push({ id: 'c' + id++, r: 'JK', s: null });
  }
  return cards;
}

/** Validate a set of cards as one meld. Returns its natural rank or throws. */
function checkMeld(cards) {
  const naturals = cards.filter((c) => !isWild(c));
  const wilds = cards.length - naturals.length;
  const ranks = new Set(naturals.map((c) => c.r));
  if (ranks.size === 0) {
    // all-wild meld (2s and jokers only)
    if (cards.length > BOOK_SIZE) throw new GameError(`A book is complete at ${BOOK_SIZE} cards — that's too many.`);
    return WILD_RANK;
  }
  if (ranks.size > 1) throw new GameError('All natural cards in a meld must be the same rank.');
  const rank = naturals[0].r;
  if (rank === '3') throw new GameError("3s can't be melded.");
  if (naturals.length < MIN_NATURALS) throw new GameError(`A meld needs at least ${MIN_NATURALS} natural ${rank}s.`);
  if (wilds > MAX_WILDS) throw new GameError(`A meld can't have more than ${MAX_WILDS} wild cards.`);
  if (cards.length > BOOK_SIZE) throw new GameError(`A book is complete at ${BOOK_SIZE} cards — that's too many.`);
  return rank;
}

class Game {
  constructor(names) {
    this.names = names;           // index = seat (0 N, 1 E, 2 S, 3 W)
    this.round = 0;
    this.totals = [0, 0];
    this.history = [];
    this.log = [];
    this.meldSeq = 1;
    this.lastRound = null;
    this.startRound();
  }

  get minMeld() { return MIN_MELD[Math.min(this.round, ROUNDS - 1)]; }

  addLog(text) {
    this.log.push({ ts: Date.now(), text });
    if (this.log.length > 150) this.log.shift();
  }

  /** Recreate a Game from saved JSON. */
  static restore(data) {
    return Object.assign(Object.create(Game.prototype), data);
  }

  startRound() {
    this.stock = shuffle(buildDeck());
    this.discard = [];
    this.players = [0, 1, 2, 3].map(() => ({ hand: [], foot: [], inFoot: false }));
    this.teams = [0, 1].map(() => ({ melds: [], red3s: [], opened: false }));
    for (let i = 0; i < HAND_SIZE; i++) {
      for (const p of this.players) {
        p.hand.push(this.stock.pop());
        p.foot.push(this.stock.pop());
      }
    }
    this.turn = this.round % 4;
    this.turnPhase = 'draw';
    this.phase = 'playing';
    this.turnStartedAt = Date.now();
    this.goOutAsk = null;
    this.addLog(`Round ${this.round + 1} — opening meld needs ${this.minMeld} points. ${this.names[this.turn]} starts.`);
    this.players.forEach((_, s) => this.layRed3s(s));
  }

  /** Move red 3s from a player's hand to their team and replace them from the stock. */
  layRed3s(seat) {
    const p = this.players[seat];
    const team = this.teams[teamOf(seat)];
    for (;;) {
      const reds = p.hand.filter(isRed3);
      if (!reds.length) return;
      p.hand = p.hand.filter((c) => !isRed3(c));
      team.red3s.push(...reds);
      this.addLog(`${this.names[seat]} laid ${reds.length === 1 ? 'a red 3' : reds.length + ' red 3s'} (+${RED3_BONUS * reds.length}).`);
      for (let i = 0; i < reds.length && this.stock.length; i++) p.hand.push(this.stock.pop());
      if (!this.stock.length) {
        // nothing left to replace with; leave any further red 3s to be caught next loop
        const more = p.hand.filter(isRed3);
        if (more.length) { p.hand = p.hand.filter((c) => !isRed3(c)); team.red3s.push(...more); }
        return;
      }
    }
  }

  /** Run fn as a transaction: on any error, roll the state back. */
  tx(fn) {
    const keys = ['stock', 'discard', 'players', 'teams', 'turn', 'turnPhase', 'phase', 'round', 'totals', 'history', 'log', 'meldSeq', 'lastRound', 'turnStartedAt', 'goOutAsk'];
    const snap = JSON.stringify(keys.map((k) => this[k]));
    try {
      return fn();
    } catch (e) {
      const vals = JSON.parse(snap);
      keys.forEach((k, i) => { this[k] = vals[i]; });
      throw e;
    }
  }

  checkTurn(seat, phase) {
    if (this.phase !== 'playing') throw new GameError('The round is over.');
    if (seat !== this.turn) throw new GameError("It's not your turn.");
    if (phase && this.turnPhase !== phase) {
      throw new GameError(phase === 'draw' ? 'You have already drawn this turn.' : 'Draw or pick up the pile first.');
    }
  }

  bookCounts(t) {
    let clean = 0, dirty = 0, wild = 0;
    for (const m of this.teams[t].melds) {
      if (m.cards.length < BOOK_SIZE) continue;
      if (m.rank === WILD_RANK) wild++;
      else if (m.cards.some(isWild)) dirty++;
      else clean++;
    }
    return { clean, dirty, wild };
  }

  canGoOut(t) {
    const b = this.bookCounts(t);
    return b.wild >= BOOKS_TO_GO_OUT.wild && b.clean >= BOOKS_TO_GO_OUT.clean && b.dirty >= BOOKS_TO_GO_OUT.dirty;
  }

  /** Has this player's partner said yes to them going out this turn? */
  mayGoOut(seat) {
    if (!ASK_PARTNER) return true;
    const a = this.goOutAsk;
    return !!a && a.seat === seat && a.status === 'yes';
  }

  /** Why this player can't go out right now, or null if they can. */
  goOutBlocker(seat) {
    if (!this.canGoOut(teamOf(seat))) return `your team needs ${GO_OUT_TEXT}`;
    if (!this.mayGoOut(seat)) {
      const a = this.goOutAsk;
      const partner = this.names[partnerOf(seat)];
      if (a && a.seat === seat && a.status === 'no') return `${partner} said no to going out this turn`;
      if (a && a.seat === seat && a.status === 'pending') return `${partner} hasn't answered your request to go out yet`;
      return `you need to ask ${partner} first (tap "Ask to go out")`;
    }
    return null;
  }

  takeFromHand(p, ids) {
    if (!Array.isArray(ids)) throw new GameError('Bad card list.');
    const out = [];
    for (const id of ids) {
      const i = p.hand.findIndex((c) => c.id === id);
      if (i < 0) throw new GameError('That card is not in your hand.');
      out.push(p.hand.splice(i, 1)[0]);
    }
    return out;
  }

  /**
   * Apply a meld plan: { newMelds: [[cardId...]...], adds: [{meldId, ids:[cardId...]}] }.
   * Mutates state (call inside tx). Returns the point value of the cards played.
   */
  applyPlan(seat, plan) {
    plan = plan || {};
    const p = this.players[seat];
    const team = this.teams[teamOf(seat)];
    let points = 0;
    let overflow = false;   // cards put on top of a finished book
    for (const ids of plan.newMelds || []) {
      const cards = this.takeFromHand(p, ids);
      if (cards.length < 3) throw new GameError('A new meld needs at least 3 cards.');
      const rank = checkMeld(cards);
      team.melds.push({ id: 'm' + this.meldSeq++, rank, cards });
      points += sumValues(cards);
    }
    for (const add of plan.adds || []) {
      const meld = team.melds.find((m) => m.id === (add && add.meldId));
      if (!meld) throw new GameError('That meld no longer exists.');
      const cards = this.takeFromHand(p, add.ids);
      if (!cards.length) continue;
      if (meld.rank === WILD_RANK && cards.some((c) => !isWild(c))) throw new GameError('Only 2s and jokers can go on the wild meld.');
      // Split into cards that finish the book (up to 7) and extras on top of the finished book.
      // Wilds go into the "finishing" part first; extras must match the book (naturals, or wilds on the wild book).
      const room = Math.max(0, BOOK_SIZE - meld.cards.length);
      const ordered = cards.slice().sort((a, b) => isWild(b) - isWild(a));
      const fill = ordered.slice(0, room);
      const extra = ordered.slice(room);
      if (fill.length) {
        const rank = checkMeld(meld.cards.concat(fill));
        if (rank !== meld.rank) throw new GameError(`Those cards don't go on the ${rankLabel(meld.rank)}s.`);
      }
      if (extra.length) {
        const ok = meld.rank === WILD_RANK ? extra.every(isWild) : extra.every((c) => c.r === meld.rank);
        if (!ok) {
          throw new GameError(meld.rank === WILD_RANK
            ? 'Only 2s and jokers can go on the wild book.'
            : `Only natural ${rankLabel(meld.rank)}s can go on top of a finished ${rankLabel(meld.rank)}s book — no wild cards.`);
        }
        overflow = true;
      }
      meld.cards.push(...fill, ...extra);
      points += sumValues(cards);
    }
    if (overflow) {
      const t = teamOf(seat);
      if (!p.inFoot || !this.canGoOut(t) || p.hand.length > 1) {
        throw new GameError(`You can only put cards on a finished book when it lets you go out this turn (from your foot, with ${GO_OUT_TEXT}, leaving at most 1 card to discard).`);
      }
      const why = this.goOutBlocker(seat);
      if (why) throw new GameError(`You can't go out yet — ${why}.`);
    }
    return points;
  }

  playedSomething(plan) {
    return !!plan && (((plan.newMelds || []).some((m) => m && m.length)) || ((plan.adds || []).some((a) => a && a.ids && a.ids.length)));
  }

  /** After cards leave the hand by melding: handle empty hand / going out. */
  afterMelding(seat) {
    const p = this.players[seat];
    const t = teamOf(seat);
    if (p.hand.length === 0) {
      if (p.inFoot) {
        const why = this.goOutBlocker(seat);
        if (why) throw new GameError(`That would play your last card, but you can't go out yet — ${why}.`);
        this.addLog(`${this.names[seat]} went out!`);
        this.endRound(seat, 'went out');
      } else {
        this.pickUpFoot(seat);
      }
    } else if (p.inFoot && p.hand.length === 1) {
      const why = this.goOutBlocker(seat);
      if (why) throw new GameError(`Keep at least 2 cards — your last card has to be discarded to go out, and you can't go out yet: ${why}.`);
    }
  }

  pickUpFoot(seat) {
    const p = this.players[seat];
    p.hand = p.foot;
    p.foot = [];
    p.inFoot = true;
    this.layRed3s(seat);
    this.addLog(`${this.names[seat]} picked up their foot.`);
  }

  // ---------- player actions ----------

  draw(seat) {
    return this.tx(() => {
      this.checkTurn(seat, 'draw');
      if (!this.stock.length) {
        this.addLog('The stock ran out.');
        this.endRound(null, 'stock ran out');
        return;
      }
      const p = this.players[seat];
      const team = this.teams[teamOf(seat)];
      let got = 0, reds = 0;
      while (got < 2 && this.stock.length) {
        const c = this.stock.pop();
        if (isRed3(c)) { team.red3s.push(c); reds++; } else { p.hand.push(c); got++; }
      }
      this.turnPhase = 'play';
      this.addLog(`${this.names[seat]} drew ${got}${reds ? ` and laid ${reds === 1 ? 'a red 3' : reds + ' red 3s'} (+${RED3_BONUS * reds})` : ''}.`);
      if (got === 0) {
        // only red 3s were left: nothing to draw, so the stock has run out
        this.addLog('The stock ran out.');
        this.endRound(null, 'stock ran out');
      }
    });
  }

  /** Pick up the top 7 of the discard pile. pair = two natural cards from hand matching the top card. */
  pickup(seat, pair, plan) {
    return this.tx(() => {
      this.checkTurn(seat, 'draw');
      if (!this.discard.length) throw new GameError('The discard pile is empty.');
      const top = this.discard[this.discard.length - 1];
      if (isWild(top) || top.r === '3') throw new GameError(`You can't pick up the pile when the top card is ${top.r === '3' ? 'a 3' : 'wild'}.`);
      if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1]) {
        throw new GameError(`Select two natural ${rankLabel(top.r)}s from your hand to pick up the pile.`);
      }
      const p = this.players[seat];
      const t = teamOf(seat);
      const team = this.teams[t];
      const pairCards = this.takeFromHand(p, pair);
      if (pairCards.some((c) => c.r !== top.r)) {
        throw new GameError(`To pick up you need two natural ${rankLabel(top.r)}s.`);
      }
      this.discard.pop();
      const meldCards = [top, ...pairCards];
      checkMeld(meldCards);
      team.melds.push({ id: 'm' + this.meldSeq++, rank: top.r, cards: meldCards });
      let points = sumValues(meldCards);
      points += this.applyPlan(seat, plan);
      if (!team.opened) {
        if (points < this.minMeld) {
          throw new GameError(`Your opening meld needs ${this.minMeld} points (you have ${points}). Stage more melds before picking up.`);
        }
        team.opened = true;
      }
      const rest = this.discard.splice(Math.max(0, this.discard.length - (pickupCount(top.r) - 1)));
      p.hand.push(...rest);
      this.turnPhase = 'play';
      this.addLog(`${this.names[seat]} picked up the pile (${rest.length + 1} cards).`);
      this.afterMelding(seat);
    });
  }

  meld(seat, plan) {
    return this.tx(() => {
      this.checkTurn(seat, 'play');
      if (!this.playedSomething(plan)) throw new GameError('Nothing to lay down.');
      const team = this.teams[teamOf(seat)];
      const points = this.applyPlan(seat, plan);
      if (!team.opened) {
        if (points < this.minMeld) throw new GameError(`Your opening meld needs ${this.minMeld} points (you have ${points}).`);
        team.opened = true;
        this.addLog(`${this.names[seat]} opened for their team with ${points} points.`);
      } else {
        this.addLog(`${this.names[seat]} laid down ${points} points.`);
      }
      this.afterMelding(seat);
    });
  }

  discardCard(seat, cardId) {
    return this.tx(() => {
      this.checkTurn(seat, 'play');
      const p = this.players[seat];
      const t = teamOf(seat);
      const i = p.hand.findIndex((c) => c.id === cardId);
      if (i < 0) throw new GameError('That card is not in your hand.');
      if (p.hand.length === 1 && p.inFoot) {
        const why = this.goOutBlocker(seat);
        if (why) throw new GameError(`That's your last card, and you can't go out yet — ${why}.`);
        this.discard.push(p.hand.splice(i, 1)[0]);
        this.addLog(`${this.names[seat]} discarded and went out!`);
        this.endRound(seat, 'went out');
        return;
      }
      const card = p.hand.splice(i, 1)[0];
      this.discard.push(card);
      this.addLog(`${this.names[seat]} discarded ${rankLabel(card.r)}.`);
      if (p.hand.length === 0) this.pickUpFoot(seat);
      this.turn = (this.turn + 1) % 4;
      this.turnPhase = 'draw';
      this.turnStartedAt = Date.now();
      this.goOutAsk = null;
    });
  }

  /** Ask your partner for permission to go out this turn. */
  askGoOut(seat) {
    return this.tx(() => {
      this.checkTurn(seat);
      if (!ASK_PARTNER) throw new GameError("You don't need to ask in this game.");
      if (!this.players[seat].inFoot) throw new GameError('You can only go out from your foot.');
      const a = this.goOutAsk;
      if (a && a.seat === seat) {
        throw new GameError(a.status === 'pending' ? 'Already asked — waiting for an answer.' : 'You have already asked this turn.');
      }
      this.goOutAsk = { seat, status: 'pending', ts: Date.now() };
      this.addLog(`${this.names[seat]} asked ${this.names[partnerOf(seat)]}: "May I go out?"`);
    });
  }

  /** Partner answers a pending request to go out. */
  answerGoOut(seat, yes) {
    return this.tx(() => {
      const a = this.goOutAsk;
      if (this.phase !== 'playing' || !a || a.status !== 'pending') throw new GameError('There is no question to answer.');
      if (partnerOf(a.seat) !== seat) throw new GameError('Only their partner can answer.');
      a.status = yes ? 'yes' : 'no';
      a.answeredAt = Date.now();
      this.addLog(`${this.names[seat]} said ${yes ? 'yes' : 'no'} to ${this.names[a.seat]} going out.`);
    });
  }

  endRound(goer, reason) {
    const summary = { round: this.round + 1, goer, reason, teams: [] };
    for (let t = 0; t < 2; t++) {
      const team = this.teams[t];
      const { clean, dirty, wild } = this.bookCounts(t);
      const meldPts = team.melds.reduce((s, m) => s + sumValues(m.cards), 0);
      const red3 = team.red3s.length * RED3_BONUS;
      const goOut = goer !== null && teamOf(goer) === t ? GO_OUT_BONUS : 0;
      let penalty = 0;
      for (let s = 0; s < 4; s++) {
        if (teamOf(s) === t) penalty += sumValues(this.players[s].hand) + sumValues(this.players[s].foot);
      }
      const books = wild * WILD_BOOK + clean * CLEAN_BOOK + dirty * DIRTY_BOOK;
      const total = books + meldPts + red3 + goOut - penalty;
      summary.teams.push({ wild, clean, dirty, books, meldPts, red3, goOut, penalty, total });
      this.totals[t] += total;
    }
    summary.totals = this.totals.slice();
    this.history.push(summary);
    this.lastRound = summary;
    this.round++;
    this.phase = this.round >= ROUNDS ? 'gameOver' : 'roundEnd';
    this.addLog(`Round ${summary.round} over — ${reason}.`);
  }

  nextRound() {
    if (this.phase !== 'roundEnd') throw new GameError('The round is still being played.');
    this.startRound();
  }

  /** What one seat is allowed to see. */
  view(seat) {
    const meldView = (m) => ({
      id: m.id,
      rank: m.rank,
      cards: m.cards,
      wilds: m.cards.filter(isWild).length,
      complete: m.cards.length >= BOOK_SIZE,
      clean: !m.cards.some(isWild),
      wild: m.rank === WILD_RANK,
    });
    return {
      phase: this.phase,
      round: this.phase === 'playing' ? this.round + 1 : this.round,
      rounds: ROUNDS,
      minMeld: MIN_MELD[(this.phase === 'playing' ? this.round : this.round - 1)],
      turn: this.turn,
      turnPhase: this.turnPhase,
      goOutAsk: this.goOutAsk || null,
      askPartner: ASK_PARTNER,
      turnStartedAt: this.turnStartedAt,
      stockCount: this.stock.length,
      discardTop: this.discard[this.discard.length - 1] || null,
      pickupTakes: this.discard.length ? Math.min(pickupCount(this.discard[this.discard.length - 1].r), this.discard.length) : 0,
      discardCount: this.discard.length,
      totals: this.totals,
      lastRound: this.lastRound,
      history: this.history,
      log: this.log.slice(-100),
      players: this.players.map((p) => ({ handCount: p.hand.length, footCount: p.foot.length, inFoot: p.inFoot })),
      teams: this.teams.map((team, t) => ({
        opened: team.opened,
        red3s: team.red3s.length,
        red3Cards: team.red3s,
        melds: team.melds.map(meldView),
        books: this.bookCounts(t),
        canGoOut: this.canGoOut(t),
      })),
      hand: seat == null ? [] : this.players[seat].hand,
      rules: { decks: DECKS, bookValues: { wild: WILD_BOOK, clean: CLEAN_BOOK, dirty: DIRTY_BOOK }, bookSize: BOOK_SIZE, maxWilds: MAX_WILDS, minNaturals: MIN_NATURALS, booksToGoOut: BOOKS_TO_GO_OUT, pickupByRank: PICKUP_BY_RANK },
    };
  }
}

module.exports = { pickupCount, ASK_PARTNER, partnerOf, Game, GameError, cardValue, isWild, isRed3, checkMeld, teamOf, RANK_ORDER, MIN_MELD, BOOK_SIZE, DECKS, WILD_RANK };
