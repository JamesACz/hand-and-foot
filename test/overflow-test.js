'use strict';
// Rules for putting extra cards on a finished book to go out.
const assert = require('assert');
const { Game, GameError } = require('../game');

let n = 0;
const card = (r, s = 'S') => ({ id: 't' + n++, r, s });
const book = (rank, wilds = 0) => {
  const cards = [];
  for (let i = 0; i < 7 - wilds; i++) cards.push(card(rank, 'SHDC'[i % 4]));
  for (let i = 0; i < wilds; i++) cards.push(card('2', 'C'));
  return { id: 'm' + n++, rank, cards };
};
const wildBook = () => ({ id: 'm' + n++, rank: 'W', cards: Array.from({ length: 7 }, () => card('JK', null)) });

// Seat 0 in their foot, team ready to go out (1 wild, 1 clean, 2 dirty), turn in play phase.
function setup(hand, { ready = true, inFoot = true, allowed = true } = {}) {
  const g = new Game(['James', 'Kate', 'Sam', 'Mia']);
  g.turn = 0; g.turnPhase = 'play'; g.phase = 'playing';
  const t = g.teams[0];
  t.opened = true;
  const kings = book('K');
  t.melds = ready ? [wildBook(), kings, book('9', 2), book('Q', 1)] : [kings, book('9', 2)];
  g.players[0].hand = hand;
  g.players[0].inFoot = inFoot;
  if (allowed) g.goOutAsk = { seat: 0, status: 'yes' };   // Sam already said yes
  return { g, kings };
}
const throwsGame = (fn, re) => assert.throws(fn, (e) => e instanceof GameError && re.test(e.message));

// 1. James's example: K + A in hand → put K on the kings book, discard A, go out
{
  const k = card('K', 'H'), a = card('A', 'S');
  const { g, kings } = setup([k, a]);
  g.meld(0, { adds: [{ meldId: kings.id, ids: [k.id] }] });
  assert.strictEqual(kings.cards.length, 8);
  assert.strictEqual(g.phase, 'playing');
  g.discardCard(0, a.id);
  assert.strictEqual(g.phase, 'roundEnd');
  assert.strictEqual(g.lastRound.goer, 0);
  assert.strictEqual(g.lastRound.teams[0].clean, 1, 'kings book still counts as clean');
}
// 2. Melding the last card onto a book goes out directly
{
  const k = card('K');
  const { g, kings } = setup([k]);
  g.meld(0, { adds: [{ meldId: kings.id, ids: [k.id] }] });
  assert.strictEqual(g.phase, 'roundEnd');
}
// 3. Not allowed if it doesn't lead to going out (2+ cards left)
{
  const k = card('K'), a = card('A'), b = card('5');
  const { g, kings } = setup([k, a, b]);
  throwsGame(() => g.meld(0, { adds: [{ meldId: kings.id, ids: [k.id] }] }), /go out this turn/);
  assert.strictEqual(g.teams[0].melds.find((m) => m.id === kings.id).cards.length, 7, 'rolled back');
  assert.strictEqual(g.players[0].hand.length, 3);
}
// 4. Not allowed if the team doesn't have its books yet
{
  const k = card('K'), a = card('A');
  const { g, kings } = setup([k, a], { ready: false });
  throwsGame(() => g.meld(0, { adds: [{ meldId: kings.id, ids: [k.id] }] }), /go out this turn/);
}
// 5. Not allowed from the hand (must be in foot)
{
  const k = card('K'), a = card('A');
  const { g, kings } = setup([k, a], { inFoot: false });
  throwsGame(() => g.meld(0, { adds: [{ meldId: kings.id, ids: [k.id] }] }), /go out this turn/);
}
// 6. No wild cards on top of a finished natural book
{
  const w = card('2', 'H'), a = card('A');
  const { g, kings } = setup([w, a]);
  throwsGame(() => g.meld(0, { adds: [{ meldId: kings.id, ids: [w.id] }] }), /no wild cards/);
}
// 7. Wild cards can go on top of the wild book; naturals can't
{
  const w = card('JK', null), a = card('A');
  const { g } = setup([w, a]);
  const wb = g.teams[0].melds[0];
  throwsGame(() => g.meld(0, { adds: [{ meldId: wb.id, ids: [a.id] }] }), /2s and jokers/);
  g.meld(0, { adds: [{ meldId: wb.id, ids: [w.id] }] });
  assert.strictEqual(g.teams[0].melds.find((m) => m.id === wb.id).cards.length, 8);
}
// 8. Finishing a 6-card meld and going past 7 in one go (6 + 3 kings) when going out
{
  const ks = [card('K'), card('K'), card('K')];
  const { g } = setup(ks);
  const six = { id: 'six', rank: 'K', cards: book('K').cards.slice(0, 6) };
  g.teams[0].melds.push(six);
  g.meld(0, { adds: [{ meldId: 'six', ids: ks.map((c) => c.id) }] });
  assert.strictEqual(six.cards.length, 9);
  assert.strictEqual(g.phase, 'roundEnd');
}
// 9. Normal play untouched: filling a meld to exactly 7 is fine mid-game
{
  const ks = [card('K'), card('K')], rest = [card('5'), card('6'), card('8')];
  const { g } = setup(ks.concat(rest), { inFoot: false, ready: false });
  const five = { id: 'five', rank: 'K', cards: book('K').cards.slice(0, 5) };
  g.teams[0].melds.push(five);
  g.meld(0, { adds: [{ meldId: 'five', ids: ks.map((c) => c.id) }] });
  assert.strictEqual(five.cards.length, 7);
}
// 10. Red 3s are visible in the view
{
  const g = new Game(['A', 'B', 'C', 'D']);
  g.teams[0].red3s = [card('3', 'H'), card('3', 'D')];
  const v = g.view(0);
  assert.strictEqual(v.teams[0].red3s, 2);
  assert.deepStrictEqual(v.teams[0].red3Cards.map((c) => c.s), ['H', 'D']);
}
// ---------- asking your partner ----------
// 11. Without asking, you can't go out (discard, meld last card, or play onto a finished book)
{
  const k = card('K'), a = card('A');
  const { g, kings } = setup([k, a], { allowed: false });
  throwsGame(() => g.meld(0, { adds: [{ meldId: kings.id, ids: [k.id] }] }), /ask Sam first/);
  const { g: g2 } = setup([card('A')], { allowed: false });
  throwsGame(() => g2.discardCard(0, g2.players[0].hand[0].id), /ask Sam first/);
  const fives = [card('5'), card('5'), card('5')];
  const { g: g3 } = setup(fives.concat([card('9')]), { allowed: false });
  throwsGame(() => g3.meld(0, { newMelds: [fives.map((c) => c.id)] }), /Keep at least 2 cards.*ask Sam first/);
}
// 12. Ask → pending blocks; only the partner can answer; yes allows going out
{
  const a = card('A');
  const { g } = setup([a], { allowed: false });
  throwsGame(() => g.askGoOut(1), /not your turn/);
  g.askGoOut(0);
  throwsGame(() => g.askGoOut(0), /waiting for an answer/);
  throwsGame(() => g.discardCard(0, a.id), /hasn't answered/);
  throwsGame(() => g.answerGoOut(1, true), /Only their partner/);
  throwsGame(() => g.answerGoOut(3, true), /Only their partner/);
  g.answerGoOut(2, true);
  assert.strictEqual(g.view(1).goOutAsk.status, 'yes', 'everyone can see the answer');
  g.discardCard(0, a.id);
  assert.strictEqual(g.phase, 'roundEnd');
  assert(g.log.some((l) => /asked Sam: "May I go out\?"/.test(l.text)));
  assert(g.log.some((l) => /Sam said yes to James going out/.test(l.text)));
}
// 13. No means no for the rest of the turn; can't ask twice; resets next turn
{
  const a = card('A'), b = card('6');
  const { g } = setup([a, b], { allowed: false });
  g.askGoOut(0);
  g.answerGoOut(2, false);
  throwsGame(() => g.askGoOut(0), /already asked this turn/);
  throwsGame(() => g.answerGoOut(2, true), /no question/);
  g.discardCard(0, a.id);                     // normal discard is fine, turn passes
  assert.strictEqual(g.turn, 1);
  assert.strictEqual(g.goOutAsk, null, 'cleared for the next turn');
}
// 14. Can't ask from your hand (only from your foot); can ask before drawing
{
  const { g } = setup([card('A'), card('6')], { allowed: false, inFoot: false });
  throwsGame(() => g.askGoOut(0), /from your foot/);
  const { g: g2 } = setup([card('A'), card('6')], { allowed: false });
  g2.turnPhase = 'draw';
  g2.askGoOut(0);
  assert.strictEqual(g2.goOutAsk.status, 'pending');
}
console.log('go-out tests OK — 14 cases');

// ---------- picking up the pile: number of cards depends on the top card ----------
{
  const { pickupCount } = require('../game');
  assert.deepStrictEqual(['4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].map(pickupCount), [4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 10]);
  const cases = [['4', 4], ['8', 8], ['K', 10], ['A', 10], ['10', 10]];
  for (const [rank, expect] of cases) {
    const g = new Game(['James', 'Kate', 'Sam', 'Mia']);
    g.turn = 0; g.turnPhase = 'draw';
    g.teams[0].opened = true;
    // 15 filler cards under the top card
    g.discard = Array.from({ length: 15 }, (_, i) => card(i % 2 ? '6' : '9', 'C')).concat([card(rank, 'H')]);
    const pair = [card(rank, 'S'), card(rank, 'D')];
    g.players[0].hand = pair.concat([card('5'), card('6')]);
    assert.strictEqual(g.view(0).pickupTakes, expect);
    g.pickup(0, pair.map((c) => c.id), {});
    // took `expect` cards in total: top card went into the meld, the rest into the hand
    assert.strictEqual(g.discard.length, 16 - expect, `${rank}: pile left`);
    assert.strictEqual(g.players[0].hand.length, 2 + (expect - 1), `${rank}: hand size`);
  }
  // short pile: take what's there
  const g = new Game(['James', 'Kate', 'Sam', 'Mia']);
  g.turn = 0; g.turnPhase = 'draw'; g.teams[0].opened = true;
  g.discard = [card('9', 'C'), card('9', 'C'), card('K', 'H')];
  const pair = [card('K', 'S'), card('K', 'D')];
  g.players[0].hand = pair.concat([card('5')]);
  assert.strictEqual(g.view(0).pickupTakes, 3);
  g.pickup(0, pair.map((c) => c.id), {});
  assert.strictEqual(g.discard.length, 0);
  console.log('pickup-by-rank tests OK');
}
