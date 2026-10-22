'use strict';
// Plays many full games with simple bots to check the engine never breaks its own invariants.
const assert = require('assert');
const { Game, GameError, isWild, cardValue, DECKS, WILD_RANK } = require('../game');

const TOTAL_CARDS = DECKS * 54;

function countCards(g) {
  let n = g.stock.length + g.discard.length;
  for (const p of g.players) n += p.hand.length + p.foot.length;
  for (const t of g.teams) { n += t.red3s.length; for (const m of t.melds) n += m.cards.length; }
  return n;
}

function tryAct(fn) {
  try { fn(); return true; } catch (e) { if (!(e instanceof GameError)) throw e; return false; }
}

function botTurn(g, stats) {
  const seat = g.turn;
  const t = seat % 2;
  const team = g.teams[t];
  const hand = () => g.players[seat].hand;

  // Draw phase: try picking up the pile if possible
  const top = g.discard[g.discard.length - 1];
  let picked = false;
  if (top && !isWild(top) && top.r !== '3') {
    const pair = hand().filter((c) => c.r === top.r).slice(0, 2).map((c) => c.id);
    if (pair.length === 2) {
      // when not opened, stage every natural triple as well
      const plan = { newMelds: [] };
      if (!team.opened) {
        const groups = {};
        for (const c of hand()) if (!isWild(c) && c.r !== '3' && !pair.includes(c.id)) (groups[c.r] = groups[c.r] || []).push(c.id);
        for (const ids of Object.values(groups)) if (ids.length >= 3) plan.newMelds.push(ids.slice(0, 7));
      }
      picked = tryAct(() => g.pickup(seat, pair, plan));
      if (picked) stats.pickups++;
    }
  }
  if (!picked) g.draw(seat);
  if (g.phase !== 'playing') return;

  // Play phase: new melds from natural groups (+ wilds if not opened and short)
  for (let guard = 0; guard < 6 && g.phase === 'playing'; guard++) {
    const groups = {};
    for (const c of hand()) if (!isWild(c) && c.r !== '3') (groups[c.r] = groups[c.r] || []).push(c);
    const wilds = hand().filter(isWild);
    const plan = { newMelds: [], adds: [] };
    const used = new Set();
    for (const [rank, cards] of Object.entries(groups)) {
      const existing = team.melds.find((m) => m.rank === rank && m.cards.length < 7);
      if (existing && team.opened) {
        const room = 7 - existing.cards.length;
        const ids = cards.slice(0, room).map((c) => c.id);
        ids.forEach((i) => used.add(i));
        if (ids.length) plan.adds.push({ meldId: existing.id, ids });
      } else if (cards.length >= 3) {
        const ids = cards.slice(0, 7).map((c) => c.id);
        ids.forEach((i) => used.add(i));
        plan.newMelds.push(ids);
      } else if (cards.length === 2 && wilds.length && Math.random() < 0.5) {
        const w = wilds.find((x) => !used.has(x.id));
        if (w) { used.add(w.id); plan.newMelds.push([...cards.map((c) => c.id), w.id]); }
      }
    }
    // top up open dirty melds with wilds
    if (team.opened) {
      for (const m of team.melds) {
        const mw = m.cards.filter(isWild).length;
        if (m.cards.length < 7 && m.cards.length >= 4 && mw < 3 && !m.cards.every((c) => !isWild(c)) ) {
          const w = wilds.find((x) => !used.has(x.id));
          if (w) { used.add(w.id); const a = plan.adds.find((x) => x.meldId === m.id); if (a) { if (m.cards.length + a.ids.length < 7) a.ids.push(w.id); } else plan.adds.push({ meldId: m.id, ids: [w.id] }); }
        }
      }
    }
    // wild meld: start one with 3+ spare wilds, or feed the existing one
    if (team.opened) {
      const spare = wilds.filter((x) => !used.has(x.id));
      const wm = team.melds.find((m) => m.rank === WILD_RANK && m.cards.length < 7);
      if (wm && spare.length) plan.adds.push({ meldId: wm.id, ids: spare.slice(0, 7 - wm.cards.length).map((c) => c.id) });
      else if (!wm && spare.length >= 3 && !team.melds.some((m) => m.rank === WILD_RANK)) plan.newMelds.push(spare.slice(0, 7).map((c) => c.id));
    }
    if (!plan.newMelds.length && !plan.adds.length) break;
    if (tryAct(() => g.meld(seat, plan))) stats.melds++;
    else {
      // retry adds only, then each new meld singly
      let any = false;
      if (team.opened && plan.adds.length) any = tryAct(() => g.meld(seat, { adds: plan.adds })) || any;
      for (const nm of plan.newMelds) if (g.phase === 'playing') any = tryAct(() => g.meld(seat, { newMelds: [nm] })) || any;
      if (!any) break;
    }
  }
  if (g.phase !== 'playing') return;

  // Ask partner when going out looks close; partner bot always says yes
  if (g.players[seat].inFoot && g.canGoOut(t) && hand().length <= 4 && !g.goOutAsk) {
    g.askGoOut(seat);
    g.answerGoOut((seat + 2) % 4, Math.random() < 0.9);
    stats.asks = (stats.asks || 0) + 1;
  }
  // Going out over a finished book: if 2 cards left and one matches a finished book, play it then discard
  if (g.players[seat].inFoot && g.canGoOut(t) && hand().length === 2) {
    for (const c of hand()) {
      const bookM = team.melds.find((m) => m.cards.length >= 7 && (m.rank === WILD_RANK ? isWild(c) : c.r === m.rank));
      if (bookM && tryAct(() => g.meld(seat, { adds: [{ meldId: bookM.id, ids: [c.id] }] }))) { stats.overflow = (stats.overflow || 0) + 1; break; }
    }
    if (g.phase !== 'playing') return;
  }
  // Discard: lowest value non-wild, otherwise anything allowed
  const sorted = hand().slice().sort((a, b) => (isWild(a) - isWild(b)) || cardValue(a) - cardValue(b));
  for (const c of sorted) if (tryAct(() => g.discardCard(seat, c.id))) return;
  throw new Error('bot could not discard: ' + JSON.stringify(hand()) + ' seat=' + seat + ' phase=' + g.phase + '/' + g.turnPhase + ' hc=' + g.players.map((p) => p.hand.length + (p.inFoot ? 'F' : 'H')).join(',') + ' stock=' + g.stock.length + ' inFoot=' + g.players[seat].inFoot + '\n' + g.log.slice(-6).map((l) => l.text).join('\n'));
}

const GAMES = Number(process.argv[2] || 300);
const stats = { games: 0, rounds: 0, wentOut: 0, stockOut: 0, pickups: 0, melds: 0, turns: 0 };
for (let i = 0; i < GAMES; i++) {
  const g = new Game(['N', 'E', 'S', 'W']);
  let turns = 0;
  while (g.phase !== 'gameOver') {
    if (g.phase === 'roundEnd') {
      const lr = g.lastRound;
      stats.rounds++;
      if (lr.reason === 'went out') stats.wentOut++; else stats.stockOut++;
      g.nextRound();
      continue;
    }
    botTurn(g, stats);
    turns++;
    assert.strictEqual(countCards(g), TOTAL_CARDS, 'card count changed');
    for (const team of g.teams) for (const m of team.melds) {
      assert(m.cards.length >= 3, 'bad meld size');
      if (m.cards.length > 7) assert(m.cards.slice(7).every((c) => (m.rank === WILD_RANK ? isWild(c) : c.r === m.rank)), 'bad extra card on book');
      if (m.rank === WILD_RANK) { assert(m.cards.every(isWild), 'natural in wild meld'); continue; }
      assert(m.cards.filter(isWild).length <= 3, 'too many wilds');
      assert(m.cards.filter((c) => !isWild(c)).every((c) => c.r === m.rank), 'mixed meld');
    }
    for (const p of g.players) assert(!p.hand.some((c) => c.r === '3' && (c.s === 'H' || c.s === 'D')), 'red 3 in hand');
    if (turns > 5000) throw new Error('game did not finish');
  }
  stats.rounds++;
  if (g.lastRound.reason === 'went out') stats.wentOut++; else stats.stockOut++;
  stats.turns += turns;
  stats.games++;
  stats.wildBooks = (stats.wildBooks || 0) + g.history.reduce((t, h) => t + h.teams[0].wild + h.teams[1].wild, 0);
  // view sanity
  const v = g.view(0);
  assert.strictEqual(v.history.length, 4);
}
console.log('OK', stats);
