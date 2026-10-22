/* Hand & Foot — browser client */
(() => {
  'use strict';
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const socket = io();

  const VERSION = '1.6 (pickup by rank)';
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', 'JK'];
  const isWild = (c) => c.r === '2' || c.r === 'JK';
  const value = (c) => (c.r === 'JK' ? 50 : c.r === '2' || c.r === 'A' ? 20 : ['8', '9', '10', 'J', 'Q', 'K'].includes(c.r) ? 10 : 5);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const rankName = (r) => (r === 'JK' ? 'Joker' : r === 'W' ? 'Wild' : r);
  const ago = (ts) => {
    if (!ts) return '';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  };
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  let S = null; // latest room state from server
  let session = store.get('hf:session'); // { code, token, name }
  const urlCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  const ui = {
    selected: new Set(),
    newMelds: [],      // [[cardId...]]
    adds: {},          // meldId -> [cardId...]
    busy: false,
    hideSummary: false,
    chatOpen: false,
    drawerTab: 'chat',
    pushOn: false,
    seenTs: store.get('hf:seenTs') || 0,
    turnKey: null,
    connected: false,
  };

  // ---------- persistent chat drawer ----------
  const $chat = document.createElement('div');
  $chat.className = 'chat';
  $chat.hidden = true;
  $chat.innerHTML = `
    <div class="chat-head">
      <div class="tabs"><button class="tab on" data-tab="chat">Chat</button><button class="tab" data-tab="log">What happened</button></div>
      <button class="icon" data-close aria-label="Close">✕</button>
    </div>
    <div class="msgs" aria-live="polite"></div>
    <div class="log" hidden></div>
    <form class="chat-form"><input name="m" maxlength="300" autocomplete="off" placeholder="Say something…" enterkeyhint="send"><button class="btn primary">Send</button></form>`;
  document.body.appendChild($chat);
  const $msgs = $chat.querySelector('.msgs');
  const $log = $chat.querySelector('.log');
  const $form = $chat.querySelector('form');
  $chat.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
  function setTab(tab) {
    ui.drawerTab = tab;
    $chat.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $msgs.hidden = tab !== 'chat';
    $form.hidden = tab !== 'chat';
    $log.hidden = tab !== 'log';
    renderChat();
    const el = tab === 'chat' ? $msgs : $log;
    setTimeout(() => { el.scrollTop = el.scrollHeight; }, 0);
  }
  $chat.querySelector('[data-close]').onclick = () => toggleChat(false);
  $chat.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    const input = e.target.m;
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    input.value = '';
  };

  function toggleChat(open, tab) {
    ui.chatOpen = open;
    if (open && tab) setTab(tab);
    $chat.hidden = !open;
    document.body.classList.toggle('chat-open', open);
    if (open) { markChatSeen(); renderChat(); setTimeout(() => $msgs.scrollTop = $msgs.scrollHeight, 0); }
    render();
  }
  function markChatSeen() {
    if (!S || !S.chat.length) return;
    ui.seenTs = S.chat[S.chat.length - 1].ts;
    store.set('hf:seenTs', ui.seenTs);
  }
  function unreadCount() {
    if (!S) return 0;
    return S.chat.filter((m) => !m.sys && m.ts > ui.seenTs && m.name !== S.you.name).length;
  }
  function renderChat() {
    if (!S) return;
    const atBottom = $msgs.scrollHeight - $msgs.scrollTop - $msgs.clientHeight < 40;
    $msgs.innerHTML = S.chat.map((m) => m.sys
      ? `<div class="msg sys">${esc(m.text)}</div>`
      : `<div class="msg ${m.name === S.you.name ? 'mine' : ''} t${m.seat % 2}"><b>${esc(m.name)}</b><span>${esc(m.text)}</span></div>`).join('')
      || '<div class="msg sys">No messages yet.</div>';
    if (atBottom || ui.chatOpen) $msgs.scrollTop = $msgs.scrollHeight;
    const g = S.game;
    const logAtBottom = $log.scrollHeight - $log.scrollTop - $log.clientHeight < 40;
    $log.innerHTML = g && g.log.length
      ? g.log.map((l) => `<div class="logline"><time>${ago(l.ts)}</time><span>${esc(l.text)}</span></div>`).join('')
      : '<div class="msg sys">Nothing has happened yet.</div>';
    if (logAtBottom) $log.scrollTop = $log.scrollHeight;
  }

  // ---------- connection ----------
  function join(code, name, token, silent) {
    socket.emit('join', { code, name, token }, (res) => {
      if (res.error) {
        if (silent) { session = null; store.set('hf:session', null); }
        toast(res.error);
        render();
        return;
      }
      session = { code: res.code, token: res.token, name: res.name || name };
      store.set('hf:session', session);
      store.set('hf:name', session.name);
      history.replaceState(null, '', '?room=' + res.code);
      syncPush();
      socket.emit('visible', { visible: document.visibilityState === 'visible' });
    });
  }

  socket.on('connect', () => {
    ui.connected = true;
    if (session && session.token && (!urlCode || urlCode === session.code)) join(session.code, session.name, session.token, true);
    else render();
  });
  socket.on('disconnect', () => { ui.connected = false; render(); });
  socket.on('kicked', (msg) => toast(msg));
  socket.on('state', (st) => {
    const prevChat = S ? S.chat.length && S.chat[S.chat.length - 1].ts : 0;
    S = st;
    prune();
    if (ui.chatOpen) markChatSeen();
    else {
      const last = S.chat[S.chat.length - 1];
      if (last && !last.sys && last.ts !== prevChat && last.ts > ui.seenTs && last.name !== S.you.name && prevChat !== 0) {
        toast(`${last.name}: ${last.text}`, 'note');
      }
    }
    notifyTurn();
    renderChat();
    render();
  });

  // Keep staging/selection in sync with the actual hand
  function prune() {
    const g = S && S.game;
    if (!g) { clearStaging(); return; }
    const ids = new Set(g.hand.map((c) => c.id));
    ui.selected = new Set([...ui.selected].filter((id) => ids.has(id)));
    const myTurn = g.turn === S.you.seat && g.phase === 'playing';
    if (!myTurn) { ui.newMelds = []; ui.adds = {}; return; }
    ui.newMelds = ui.newMelds.map((grp) => grp.filter((id) => ids.has(id))).filter((grp) => grp.length);
    const meldIds = new Set(g.teams[S.you.seat % 2].melds.map((m) => m.id));
    for (const k of Object.keys(ui.adds)) {
      ui.adds[k] = ui.adds[k].filter((id) => ids.has(id));
      if (!ui.adds[k].length || !meldIds.has(k)) delete ui.adds[k];
    }
    if (g.phase === 'playing') ui.hideSummary = false;
  }
  function clearStaging() { ui.newMelds = []; ui.adds = {}; ui.selected.clear(); }
  function stagedIds() { return new Set([...ui.newMelds.flat(), ...Object.values(ui.adds).flat()]); }
  function hasStaging() { return ui.newMelds.length > 0 || Object.keys(ui.adds).length > 0; }
  function plan() { return { newMelds: ui.newMelds, adds: Object.entries(ui.adds).map(([meldId, ids]) => ({ meldId, ids })) }; }

  function notifyTurn() {
    const g = S && S.game;
    const mine = g && g.phase === 'playing' && g.turn === S.you.seat;
    document.title = mine ? '● Your turn — Hand & Foot' : 'Hand & Foot';
    const key = g ? `${g.round}-${g.turn}-${g.log.length}` : null;
    if (mine && g.turnPhase === 'draw' && key !== ui.turnKey) {
      ui.turnKey = key;
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    }
  }

  function send(type, extra) {
    if (ui.busy) return;
    ui.busy = true;
    socket.emit('action', { type, ...extra }, (res) => {
      ui.busy = false;
      if (res && res.error) { toast(res.error); render(); return; }
      if (['meld', 'pickup', 'discard'].includes(type)) clearStaging();
    });
  }

  // ---------- notifications ----------
  let swReg = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; syncPush(); }).catch(() => {});
  }
  const b64ToBytes = (b64) => {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  };
  async function syncPush() {
    // re-attach this device's existing subscription to whoever is signed in here
    if (!swReg || !pushSupported || !session) return;
    try {
      const sub = await swReg.pushManager.getSubscription();
      ui.pushOn = !!sub && Notification.permission === 'granted';
      if (sub && ui.pushOn) socket.emit('push-subscribe', { sub: sub.toJSON() });
      render();
    } catch { /* ignore */ }
  }
  async function enablePush() {
    if (!pushSupported) {
      if (isIOS && !standalone) {
        toast('On iPhone, notifications only work from the home-screen app: tap Share → Add to Home Screen, open Hand & Foot from there, then tap 🔔.');
      } else toast("This browser can't show notifications. Try Chrome on Android, or the home-screen app on iPhone.");
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Notifications are blocked. Allow them for this site in your phone settings, then try again.'); return; }
      const reg = swReg || await navigator.serviceWorker.ready;
      const key = await fetch('/vapid-public-key').then((r) => r.text());
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      socket.emit('push-subscribe', { sub: sub.toJSON() }, (r) => {
        if (r && r.error) return toast(r.error);
        ui.pushOn = true;
        render();
        socket.emit('push-test');
        toast("Done — you'll get a notification when it's your turn (and for chat while you're away).", 'note');
      });
    } catch (e) {
      toast('Could not turn on notifications: ' + (e.message || e));
    }
  }
  async function disablePush() {
    if (!confirm('Turn off notifications on this device?')) return;
    try {
      const sub = swReg && await swReg.pushManager.getSubscription();
      if (sub) { socket.emit('push-unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    } catch { /* ignore */ }
    ui.pushOn = false;
    render();
  }
  document.addEventListener('visibilitychange', () => {
    socket.emit('visible', { visible: document.visibilityState === 'visible' });
    if (document.visibilityState === 'visible') render();
  });
  setInterval(() => { if (S && S.game && document.visibilityState === 'visible') render(); }, 60000);

  let toastTimer;
  function toast(text, kind) {
    $toast.textContent = text;
    $toast.className = 'toast' + (kind ? ' ' + kind : '');
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, kind === 'note' ? 3500 : 4200);
  }
  $toast.onclick = () => { $toast.hidden = true; if ($toast.classList.contains('note')) toggleChat(true); };

  // ---------- rendering ----------
  function cardHTML(c, extra = '', tag = 'span', attrs = '') {
    const red = c.s === 'H' || c.s === 'D';
    const cls = `card ${red ? 'red' : 'black'} ${isWild(c) ? 'wild' : ''} ${c.r === 'JK' ? 'joker' : ''} ${extra}`;
    const face = c.r === 'JK' ? '<b>JK</b><i>★</i>' : `<b>${c.r}</b><i>${SUIT[c.s]}</i>`;
    return `<${tag} class="${cls}" ${attrs}>${face}</${tag}>`;
  }
  const sortCards = (cards) => cards.slice().sort((a, b) => ORDER.indexOf(a.r) - ORDER.indexOf(b.r) || String(a.s).localeCompare(String(b.s)));

  function render() {
    if (!S) return renderJoin();
    document.body.classList.toggle('offline', !ui.connected);
    if (!S.game) return renderLobby();
    return renderGame();
  }

  function renderJoin() {
    const name = (session && session.name) || store.get('hf:name') || '';
    $app.innerHTML = `
      <main class="join">
        <div class="fan" aria-hidden="true">
          ${cardHTML({ r: 'A', s: 'S' }, 'f1')}${cardHTML({ r: 'JK', s: null }, 'f2')}${cardHTML({ r: 'K', s: 'H' }, 'f3')}
        </div>
        <h1 class="logo">Hand <em>&amp;</em> Foot</h1>
        <p class="tag">Four players · two teams · may end in dessert</p>
        <form id="joinForm" class="panel">
          <label>Your name<input name="name" maxlength="20" value="${esc(name)}" autocomplete="nickname" required></label>
          <label>Game code<input name="code" maxlength="4" value="${esc(urlCode)}" placeholder="Leave blank to start a new game" autocapitalize="characters" autocomplete="off"></label>
          <button class="btn primary big" type="submit">${urlCode ? 'Join game' : 'Create a new game'}</button>
          <p class="muted">Coming back to a game? Enter the same name and game code you used before.</p>
        </form>
        <p class="muted center version">Version ${VERSION}</p>
        ${ui.connected ? '' : '<p class="muted">Connecting to the server… (a free server can take ~30 s to wake up)</p>'}
      </main>`;
    const f = document.getElementById('joinForm');
    f.code.oninput = () => {
      f.code.value = f.code.value.toUpperCase().replace(/[^A-Z]/g, '');
      f.querySelector('button').textContent = f.code.value ? 'Join game' : 'Create a new game';
    };
    f.onsubmit = (e) => {
      e.preventDefault();
      const n = f.name.value.trim();
      if (!n) return toast('Enter your name.');
      join(f.code.value.trim(), n, null, false);
    };
  }

  function chatButton() {
    const n = unreadCount();
    return `<span class="hbtns"><button class="icon bell ${ui.pushOn ? 'on' : ''}" data-act="bell" aria-label="${ui.pushOn ? 'Notifications on' : 'Turn on notifications'}">${ui.pushOn ? '🔔' : '🔕'}</button><button class="icon chatbtn" data-act="chat" aria-label="Open chat">💬${n ? `<b class="badge">${n}</b>` : ''}</button></span>`;
  }

  function renderLobby() {
    const seat = (s) => {
      const st = S.seats[s];
      const mine = S.you.seat === s;
      return `<div class="seat ${mine ? 'mine' : ''} ${st.name ? '' : 'empty'}">
        <small>${st.label}</small>
        <strong>${st.name ? esc(st.name) : 'Empty seat'}${st.isHost ? ' <span class="host">host</span>' : ''}</strong>
        ${st.name && !st.connected ? `<em class="off">away${st.lastSeen ? ' · ' + ago(st.lastSeen) : ''}</em>` : ''}
        ${mine ? '<em>You</em>' : `<button class="btn small" data-act="sit" data-seat="${s}">${st.name ? 'Swap' : 'Sit here'}</button>`}
      </div>`;
    };
    const full = S.seats.every((s) => s.name);
    $app.innerHTML = `
      <main class="lobby">
        <header class="bar"><span class="logo sm">Hand <em>&amp;</em> Foot</span>${chatButton()}</header>
        <section class="panel code-panel">
          <small>Game code</small>
          <div class="code">${esc(S.code)}</div>
          <button class="btn primary" data-act="share">Invite friends</button>
        </section>
        <section class="teams">
          <div class="team t0"><h3>Team 1</h3>${seat(0)}${seat(2)}</div>
          <div class="team t1"><h3>Team 2</h3>${seat(1)}${seat(3)}</div>
        </section>
        <p class="muted center">Partners sit opposite each other. Tap a seat to move.</p>
        ${ui.pushOn ? '' : `<button class="btn" data-act="bell">🔔 Notify me when it's my turn</button>`}
        ${S.you.isHost
          ? `<button class="btn primary big" data-act="start" ${full ? '' : 'disabled'}>${full ? 'Deal the cards' : `Waiting for ${4 - S.lobby.length} more…`}</button>`
          : `<p class="center waiting">${full ? 'Waiting for the host to deal…' : `Waiting for ${4 - S.lobby.length} more player${4 - S.lobby.length === 1 ? '' : 's'}…`}</p>`}
        <button class="btn ghost" data-act="leave">Leave</button>
        <p class="muted center version">Version ${VERSION}</p>
      </main>`;
  }

  function seatPill(g, s, label) {
    const st = S.seats[s];
    const p = g.players[s];
    const turn = g.turn === s && g.phase === 'playing';
    return `<div class="pill t${s % 2} ${turn ? 'turn' : ''}">
      <span class="who"><i class="dot ${st.connected ? 'on' : ''}"></i>${esc(st.name)}${st.notify ? '' : ''}</span>
      <span class="meta">${label} · ${p.handCount} card${p.handCount === 1 ? '' : 's'}</span>
      <span class="foot ${p.inFoot ? 'in' : ''}">${p.inFoot ? 'in foot' : 'on hand'}${st.connected ? '' : ` · <span class="away">seen ${ago(st.lastSeen)}</span>`}</span>
    </div>`;
  }

  /** Can these cards be added to meld m right now (counting anything already staged onto it)? */
  /** Is my team ready to go out, with me in my foot? (Then cards may go on top of finished books.) */
  function readyToGoOut() {
    const g = S.game;
    return g.players[S.you.seat].inFoot && g.teams[S.you.seat % 2].canGoOut && hasPermission();
  }
  /** Has my partner said yes to me going out this turn? */
  function hasPermission() {
    const g = S.game;
    if (!g.askPartner) return true;
    const a = g.goOutAsk;
    return !!a && a.seat === S.you.seat && a.status === 'yes';
  }
  function canAdd(m, cards) {
    if (!cards.length) return false;
    const g = S.game;
    const already = (ui.adds[m.id] || []).map((id) => g.hand.find((c) => c.id === id)).filter(Boolean);
    const all = already.concat(cards);
    if (m.wild) {
      if (!all.every(isWild)) return false;
    } else if (!all.every((c) => isWild(c) || c.r === m.rank)) return false;
    // wilds fill the book first; anything past 7 must be a natural (or a wild on the wild book)
    const room = Math.max(0, g.rules.bookSize - m.cards.length);
    const ordered = all.slice().sort((a, b) => isWild(b) - isWild(a));
    const fill = ordered.slice(0, room), extra = ordered.slice(room);
    if (!m.wild && m.wilds + fill.filter(isWild).length > g.rules.maxWilds) return false;
    if (extra.length) {
      if (!readyToGoOut()) return false;
      if (!m.wild && extra.some(isWild)) return false;
    }
    return true;
  }
  /** The meld a single hand card fits on. Naturals: their rank's meld. Wilds: only an unfinished wild meld (else every wild would glow). */
  function fitFor(c, team) {
    return team.melds.find((m) => (isWild(c) ? m.wild : !m.wild && m.rank === c.r) && canAdd(m, [c])) || null;
  }

  function red3Pile(team) {
    const cards = team.red3Cards || [];
    if (!cards.length) return '';
    const shown = cards.slice(0, 6);
    return `<div class="r3pile" title="Red 3s: +${cards.length * 100}">
      <div class="r3stack" style="--n:${shown.length}">${shown.map((c, i) => cardHTML(c, 'r3', 'span', `style="--i:${i}"`)).join('')}</div>
      <span class="r3lbl">Red 3 ×${cards.length}</span><b class="r3pts">+${cards.length * 100}</b>
    </div>`;
  }

  function meldChip(m, mine, opened, selCards) {
    const staged = mine ? (ui.adds[m.id] || []).length : 0;
    const bv = S.game.rules.bookValues;
    const book = m.complete ? (m.wild ? 'book wildbook' : m.clean ? 'book clean' : 'book dirty') : (m.wild ? 'wildmeld' : '');
    const sub = m.complete
      ? (m.wild ? `Wild ${bv.wild}` : m.clean ? `Clean ${bv.clean}` : `Dirty ${bv.dirty}`)
      : (m.wild ? 'all wild' : m.wilds ? `${m.wilds} wild` : 'clean');
    const tappable = mine && opened && (!m.complete || readyToGoOut());
    const target = mine && selCards && selCards.length && canAdd(m, selCards);
    return `<button class="chip ${book} ${staged ? 'staged' : ''} ${tappable ? 'tap' : ''} ${target ? 'target' : ''}" data-act="meld" data-id="${m.id}" data-mine="${mine ? 1 : 0}">
      <span class="cr">${rankName(m.rank)}</span>
      <span class="cn">${m.cards.length > 7 ? `7<small>+${m.cards.length - 7}</small>` : `${m.cards.length}<small>/7</small>`}</span>
      <span class="cw">${sub}</span>
      ${staged ? `<span class="plus">+${staged}</span>` : ''}
    </button>`;
  }

  function goalLine(team, g) {
    const b = team.books;
    const need = g.rules.booksToGoOut;
    const tick = (n, k) => `<span class="${n >= k ? 'ok' : ''}">${Math.min(n, k)}/${k}</span>`;
    return `<span class="goal">Wild ${tick(b.wild, need.wild)}</span><span class="goal">Clean ${tick(b.clean, need.clean)}</span><span class="goal">Dirty ${tick(b.dirty, need.dirty)}</span>${team.opened ? '' : `<span class="goal warn">Not open · ${g.minMeld}</span>`}`;
  }

  function renderGame() {
    const g = S.game;
    const me = S.you.seat;
    const myT = me % 2;
    const myTeam = g.teams[myT];
    const theirTeam = g.teams[1 - myT];
    const myTurn = g.turn === me && g.phase === 'playing';
    const drawPhase = myTurn && g.turnPhase === 'draw';
    const playPhase = myTurn && g.turnPhase === 'play';
    const meP = g.players[me];
    const staged = stagedIds();
    const hand = sortCards(g.hand.filter((c) => !staged.has(c.id)));
    const allStaged = g.hand.filter((c) => staged.has(c.id));
    const stagedPts = allStaged.reduce((t, c) => t + value(c), 0);
    const top = g.discardTop;
    const sel = ui.selected.size;
    const selCards = g.hand.filter((c) => ui.selected.has(c.id));
    const fits = new Map();   // cardId -> meld it can go on
    if (g.phase === 'playing') for (const c of hand) { const m = fitFor(c, myTeam); if (m) fits.set(c.id, m); }

    // status line
    const partnerSeat = (me + 2) % 4;
    const partnerName = S.seats[partnerSeat].name;
    const ask = g.phase === 'playing' ? g.goOutAsk : null;
    const askMine = ask && ask.seat === me ? ask : null;
    const askFromPartner = ask && ask.seat === partnerSeat && ask.status === 'pending' ? ask : null;
    let status;
    if (g.phase !== 'playing') status = 'Round over.';
    else if (askMine && askMine.status === 'pending') status = `Asked <b>${esc(partnerName)}</b> if you can go out — waiting for an answer${S.seats[partnerSeat].connected ? '' : ` (${esc(partnerName)} is away — they've been notified if notifications are on)`}. You can keep melding meanwhile.`;
    else if (!myTurn) {
      const st = S.seats[g.turn];
      status = `Waiting for <b>${esc(st.name)}</b> to ${g.turnPhase === 'draw' ? 'draw' : 'play'} · their turn for ${ago(g.turnStartedAt).replace('just now', 'a moment')}${st.connected ? '' : ' (away)'}`;
    }
    else if (drawPhase) status = top && !isWild(top) && top.r !== '3'
      ? `Your turn — <b>draw 2</b>, or select two ${rankName(top.r)}s and <b>pick up</b> ${g.pickupTakes} card${g.pickupTakes === 1 ? '' : 's'} from the pile.`
      : 'Your turn — <b>draw 2</b> from the stock.';
    else if (sel === 0 && !hasStaging() && meP.inFoot && g.hand.length === 1 && myTeam.canGoOut && hasPermission()) status = '<b>Discard your last card to go out!</b>';
    else if (sel === 0 && !hasStaging() && askMine && askMine.status === 'yes') status = `<b>${esc(partnerName)} said yes</b> — you can go out this turn.`;
    else if (sel === 0 && !hasStaging() && askMine && askMine.status === 'no') status = `${esc(partnerName)} said <b>no</b> — you can't go out this turn.`;
    else if (sel === 0 && !hasStaging() && meP.inFoot && myTeam.canGoOut && !askMine && g.askPartner) status = `Your team has its books. To go out, tap <b>Ask to go out</b> first.`;
    else if (sel === 0 && !hasStaging() && fits.size) status = `<b>Glowing cards</b> fit on your melds — select them, then tap the meld (it lights up).`;
    else if (sel === 0 && !hasStaging()) status = myTeam.opened ? 'Select cards to meld, or one card to discard.' : `Your team needs <b>${g.minMeld}</b> points to open. Select cards to meld, or discard.`;
    else if (hasStaging()) status = myTeam.opened ? `Staged ${stagedPts} pts — tap <b>Lay down</b> to play them.` : `Opening: <b>${stagedPts}</b> / ${g.minMeld} points.`;
    else status = sel === 1 ? 'Tap <b>Discard</b> to end your turn, or select more to meld.' : 'Tap <b>New meld</b>, or tap one of your melds to add to it.';

    const stagingHTML = hasStaging() ? `
      <div class="staging">
        ${ui.newMelds.map((grp, i) => `<button class="sgroup" data-act="unstage" data-i="${i}" title="Tap to return to hand">${sortCards(grp.map((id) => g.hand.find((c) => c.id === id))).map((c) => cardHTML(c, 'mini')).join('')}</button>`).join('')}
        ${Object.entries(ui.adds).map(([mid, ids]) => {
          const m = myTeam.melds.find((x) => x.id === mid);
          return `<button class="sgroup add" data-act="unstageadd" data-id="${mid}"><span class="onto">→ ${rankName(m.rank)}s</span>${ids.map((id) => cardHTML(g.hand.find((c) => c.id === id), 'mini')).join('')}</button>`;
        }).join('')}
        <span class="spts ${!myTeam.opened && stagedPts >= g.minMeld ? 'ok' : ''}">${myTeam.opened ? `${stagedPts} pts` : `${stagedPts}/${g.minMeld}`}</span>
      </div>` : '';

    let actions = '';
    const askBtn = myTurn && g.askPartner && meP.inFoot && !askMine
      ? `<button class="btn ask" data-act="askgoout">🙋 Ask to go out</button>` : '';
    if (drawPhase) {
      actions = `
        <button class="btn primary" data-act="draw">Draw 2</button>
        <button class="btn" data-act="pickup" ${sel === 2 ? '' : 'disabled'}>Pick up ${g.pickupTakes || ''}</button>
        ${myTeam.opened ? '' : `<button class="btn" data-act="newmeld" ${sel >= 3 ? '' : 'disabled'}>+ Meld</button>`}
        ${hasStaging() || sel ? '<button class="btn ghost" data-act="clear">Clear</button>' : ''}${askBtn}`;
    } else if (playPhase) {
      actions = `
        <button class="btn" data-act="newmeld" ${sel >= 3 ? '' : 'disabled'}>+ New meld</button>
        <button class="btn primary" data-act="laydown" ${hasStaging() ? '' : 'disabled'}>Lay down</button>
        <button class="btn warn" data-act="discard" ${sel === 1 && !hasStaging() ? '' : 'disabled'}>Discard</button>
        ${hasStaging() || sel ? '<button class="btn ghost" data-act="clear">Clear</button>' : ''}${askBtn}`;
    }
    const askBanner = askFromPartner ? `
      <div class="askbanner">
        <div><b>${esc(partnerName)}</b> asks: <em>"May I go out?"</em></div>
        <div class="row">
          <button class="btn primary" data-act="answergoout" data-yes="1">Yes, go out</button>
          <button class="btn" data-act="answergoout" data-yes="0">No, not yet</button>
        </div>
      </div>` : '';

    const summary = (g.phase === 'roundEnd' || g.phase === 'gameOver') && !ui.hideSummary ? summaryHTML(g, myT) : '';
    const lastLog = (g.log[g.log.length - 1] || {}).text || '';

    $app.innerHTML = `
      <main class="game ${myTurn ? 'my-turn' : ''}">
        <header class="bar">
          <div class="round">Round ${g.round}<small>/${g.rounds}</small><span class="open">open ${g.minMeld}</span></div>
          <div class="score"><span class="t${myT}">Us <b>${g.totals[myT]}</b></span><span class="t${1 - myT}">Them <b>${g.totals[1 - myT]}</b></span></div>
          ${chatButton()}
        </header>
        <div class="players">
          ${seatPill(g, (me + 1) % 4, 'next')}
          ${seatPill(g, (me + 2) % 4, 'partner')}
          ${seatPill(g, (me + 3) % 4, 'before you')}
        </div>
        <button class="ticker" data-act="log">${esc(lastLog)} <span>· history</span></button>
        <div class="scroll">
          <section class="tablerow">
            <button class="pile stock" data-act="draw" ${drawPhase ? '' : 'disabled'} aria-label="Draw two from stock">
              <span class="back"></span><span class="lbl">Stock<small>${g.stockCount}</small></span>
            </button>
            <button class="pile discard" data-act="pickup" ${drawPhase && sel === 2 ? '' : 'disabled'} aria-label="Pick up discard pile">
              ${top ? cardHTML(top, top.r === '3' || isWild(top) ? 'frozen' : '') : '<span class="card empty">—</span>'}
              <span class="lbl">Discard<small>${g.discardCount}${top && !isWild(top) && top.r !== '3' ? ` · takes ${g.pickupTakes}` : ''}</small></span>
            </button>
          </section>
          <section class="melds mine t${myT}">
            <h4><span>Our melds</span>${goalLine(myTeam, g)}</h4>
            <div class="chips">${red3Pile(myTeam)}${myTeam.melds.map((m) => meldChip(m, true, myTeam.opened, playPhase ? selCards : null)).join('') || (myTeam.red3s ? '' : '<p class="muted">No melds yet.</p>')}</div>
          </section>
          <section class="melds theirs t${1 - myT}">
            <h4><span>Their melds</span>${goalLine(theirTeam, g)}</h4>
            <div class="chips">${red3Pile(theirTeam)}${theirTeam.melds.map((m) => meldChip(m, false, false)).join('') || (theirTeam.red3s ? '' : '<p class="muted">No melds yet.</p>')}</div>
          </section>
        </div>
        <div class="dock">
          ${askBanner}
          <div class="status">${status}</div>
          ${stagingHTML}
          ${actions ? `<div class="actions">${actions}</div>` : ''}
          <div class="handhead"><span>Your ${meP.inFoot ? 'foot' : 'hand'} · ${g.hand.length}</span><span class="muted">${meP.inFoot ? 'Playing your foot' : `Foot waiting (${meP.footCount})`}</span></div>
          <div class="hand">${hand.map((c) => {
            const m = fits.get(c.id);
            return cardHTML(c, `${ui.selected.has(c.id) ? 'sel' : ''} ${m ? 'fits' : ''}`, 'button', `data-act="card" data-id="${c.id}"${m ? ` data-fit="${rankName(m.rank) === 'Wild' ? 'W' : rankName(m.rank)}" aria-label="${rankName(c.r)} – fits your ${rankName(m.rank)} meld"` : ''}`);
          }).join('') || (g.hand.length ? '<p class="muted">All your cards are staged.</p>' : '<p class="muted">No cards left.</p>')}</div>
        </div>
        ${summary}
        ${(g.phase === 'roundEnd' || g.phase === 'gameOver') && ui.hideSummary ? '<button class="btn primary floating" data-act="showsummary">Scores</button>' : ''}
      </main>`;
  }

  function summaryHTML(g, myT) {
    const r = g.lastRound;
    const A = r.teams[myT], B = r.teams[1 - myT];
    const row = (label, a, b, cls = '') => `<tr class="${cls}"><th>${label}</th><td>${a}</td><td>${b}</td></tr>`;
    const goer = r.goer == null ? 'The stock ran out' : `${esc(S.seats[r.goer].name)} went out`;
    const over = g.phase === 'gameOver';
    const winner = g.totals[myT] === g.totals[1 - myT] ? "It's a tie!" : g.totals[myT] > g.totals[1 - myT] ? 'Your team wins! 🎉' : 'Their team wins.';
    return `<div class="overlay"><div class="sheet">
      <h2>${over ? winner : `Round ${r.round} done`}</h2>
      <p class="muted center">${goer}.</p>
      <table class="scores">
        <thead><tr><th></th><th class="t${myT}">Us</th><th class="t${1 - myT}">Them</th></tr></thead>
        <tbody>
          ${row('Wild books', `${A.wild} × ${g.rules.bookValues.wild}`, `${B.wild} × ${g.rules.bookValues.wild}`)}
          ${row('Clean books', `${A.clean} × ${g.rules.bookValues.clean}`, `${B.clean} × ${g.rules.bookValues.clean}`)}
          ${row('Dirty books', `${A.dirty} × ${g.rules.bookValues.dirty}`, `${B.dirty} × ${g.rules.bookValues.dirty}`)}
          ${row('Cards melded', A.meldPts, B.meldPts)}
          ${row('Red 3s', A.red3, B.red3)}
          ${row('Going out', A.goOut, B.goOut)}
          ${row('Left in hand/foot', -A.penalty, -B.penalty, 'neg')}
          ${row('Round total', A.total, B.total, 'total')}
          ${row('Game total', r.totals[myT], r.totals[1 - myT], 'grand')}
        </tbody>
      </table>
      ${g.history.length > 1 ? `<p class="muted center">Rounds: ${g.history.map((h) => `${h.teams[myT].total} / ${h.teams[1 - myT].total}`).join(' · ')}</p>` : ''}
      <div class="row">
        <button class="btn ghost" data-act="hidesummary">See the table</button>
        ${over ? '<button class="btn primary" data-act="newgame">New game</button>' : `<button class="btn primary" data-act="nextround">Deal round ${r.round + 1}</button>`}
      </div>
    </div></div>`;
  }

  // ---------- interaction ----------
  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    const g = S && S.game;
    switch (act) {
      case 'chat': toggleChat(true, 'chat'); return;
      case 'log': toggleChat(true, 'log'); return;
      case 'bell': if (ui.pushOn) disablePush(); else enablePush(); return;
      case 'share': share(); return;
      case 'sit': socket.emit('sit', { seat: Number(el.dataset.seat) }, (r) => r && r.error && toast(r.error)); return;
      case 'start': socket.emit('start', {}, (r) => r && r.error && toast(r.error)); return;
      case 'leave':
        socket.emit('leave');
        session = null; store.set('hf:session', null); S = null;
        history.replaceState(null, '', '/');
        render();
        return;
      case 'card': {
        const id = el.dataset.id;
        if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id);
        break;
      }
      case 'clear': clearStaging(); break;
      case 'newmeld': {
        if (ui.selected.size < 3) { toast('A new meld needs at least 3 cards.'); return; }
        const cards = g.hand.filter((c) => ui.selected.has(c.id));
        const nat = cards.filter((c) => !isWild(c));
        const ranks = new Set(nat.map((c) => c.r));
        if (ranks.size === 0) {
          // a wild meld: 2s and jokers only
          if (cards.length > g.rules.bookSize) { toast('A book is complete at 7 cards.'); return; }
          ui.newMelds.push([...ui.selected]);
          ui.selected.clear();
          break;
        }
        if (ranks.size !== 1) { toast('All natural cards in a meld must be the same rank.'); return; }
        if (ranks.has('3')) { toast("3s can't be melded."); return; }
        if (nat.length < g.rules.minNaturals) { toast('A meld needs at least 2 natural cards.'); return; }
        if (cards.length - nat.length > g.rules.maxWilds) { toast('A meld can have at most 3 wild cards.'); return; }
        if (cards.length > g.rules.bookSize) { toast('A book is complete at 7 cards.'); return; }
        ui.newMelds.push([...ui.selected]);
        ui.selected.clear();
        break;
      }
      case 'meld': {
        const mine = el.dataset.mine === '1';
        const team = g.teams[mine ? S.you.seat % 2 : 1 - (S.you.seat % 2)];
        const m = team.melds.find((x) => x.id === el.dataset.id);
        const myTurn = g.turn === S.you.seat && g.phase === 'playing' && g.turnPhase === 'play';
        if (mine && myTurn && ui.selected.size && team.opened) {
          const cur = ui.adds[m.id] || [];
          const selCards = g.hand.filter((c) => ui.selected.has(c.id));
          if (!canAdd(m, selCards)) {
            const past7 = m.cards.length + cur.length + selCards.length > g.rules.bookSize;
            if (past7 && !readyToGoOut()) toast(`That ${rankName(m.rank)}s book is finished. You can only add to a finished book when it lets you go out — from your foot, once your team has all its books.`);
            else if (past7 && !m.wild && selCards.some(isWild)) toast('Only natural cards can go on top of a finished book — no 2s or jokers.');
            else if (m.wild) toast('Only 2s and jokers can go on the wild meld.');
            else toast(`Those cards don't fit on the ${rankName(m.rank)}s (a meld can have at most ${g.rules.maxWilds} wild cards).`);
            return;
          }
          ui.adds[m.id] = cur.concat([...ui.selected]);
          ui.selected.clear();
          break;
        }
        // otherwise, show what's in it
        toast(`${rankName(m.rank)}s: ${sortCards(m.cards).map((c) => (c.r === 'JK' ? 'JK' : c.r + SUIT[c.s])).join(' ')}`);
        return;
      }
      case 'unstage': ui.newMelds.splice(Number(el.dataset.i), 1); break;
      case 'unstageadd': delete ui.adds[el.dataset.id]; break;
      case 'laydown': send('meld', { plan: plan() }); return;
      case 'draw':
        if (ui.selected.size || hasStaging()) clearStaging();
        send('draw');
        return;
      case 'pickup':
        if (ui.selected.size !== 2) { toast('Select the two matching cards from your hand first.'); return; }
        send('pickup', { pair: [...ui.selected], plan: plan() });
        return;
      case 'discard': {
        const [id] = [...ui.selected];
        send('discard', { cardId: id });
        return;
      }
      case 'askgoout': send('askGoOut'); return;
      case 'answergoout': send('answerGoOut', { yes: el.dataset.yes === '1' }); return;
      case 'nextround': send('nextRound'); return;
      case 'newgame': send('newGame'); return;
      case 'hidesummary': ui.hideSummary = true; break;
      case 'showsummary': ui.hideSummary = false; break;
      default: return;
    }
    render();
  });

  async function share() {
    const url = `${location.origin}/?room=${S.code}`;
    const text = `Join my Hand & Foot game — code ${S.code}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Hand & Foot', text, url }); return; } catch { /* cancelled */ }
    }
    try { await navigator.clipboard.writeText(url); toast('Invite link copied — paste it to your friends.'); }
    catch { toast(url); }
  }

  render();
})();
