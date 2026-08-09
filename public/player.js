import {
  $, el, connect, action, toast, sound, vibrate, flash,
  installAudioUnlock, unlockAudio, keepScreenAwake, onConnectionChange, isOnline, setFrageText } from '/common.js';

let state = null;
let selectedTeam = localStorage.getItem('quizduell.teamId') || null;
let pointerDown = false;

installAudioUnlock();
keepScreenAwake(); // auch nach einem Reload, nicht nur beim Beitreten
$('#my-name').value = localStorage.getItem('quizduell.name') || '';

connect({
  role: 'player',
  onState: (next) => {
    const prev = state;
    state = next;
    render(prev);
  },
  onEvent: (name, data) => {
    if (name === 'buzz' && data.teamId === state?.you?.teamId) vibrate([40, 40, 80]);
  },
});

onConnectionChange(() => {
  if (state) renderBuzzer(null);
});

/* ---------------------------------------------------------------- Anmeldung */

$('#join-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  unlockAudio(); // echte Nutzergeste – ab jetzt darf iOS Töne abspielen
  keepScreenAwake();
  const name = $('#my-name').value.trim();
  if (!name) return;
  if (!selectedTeam) return toast('Bitte ein Team auswählen.', 'error');
  document.activeElement?.blur?.(); // Tastatur wegräumen
  const res = await action('joinTeam', { teamId: selectedTeam, name });
  if (res.ok) {
    localStorage.setItem('quizduell.name', name);
    localStorage.setItem('quizduell.teamId', selectedTeam);
  }
});

$('#btn-leave').addEventListener('click', () => action('leaveTeam'));

/* ------------------------------------------------------------------ Buzzer */

const buzzer = $('#buzzer');
let buzzLock = false;

async function pressBuzzer() {
  if (buzzLock) return;

  if (!state?.you?.canBuzz) {
    // Bewusst kein disabled-Attribut: deaktivierte Buttons feuern gar keine
    // Events, dann bliebe ein zu früher Druck völlig unkommentiert.
    if (state?.current?.step === 'primary') {
      buzzer.classList.remove('tooearly');
      void buzzer.offsetWidth;
      buzzer.classList.add('tooearly');
      toast('Noch zu früh – erst muss das Zugteam antworten.');
    }
    return;
  }
  if (!isOnline()) return toast('Keine Verbindung – dein Buzz käme nicht an.', 'error');

  buzzLock = true;
  setTimeout(() => (buzzLock = false), 400);
  vibrate(60);
  sound('buzz');

  const res = await action('buzz', { quiet: true });
  if (!res.ok) {
    // „Zu spät" ist normal und braucht keinen roten Kasten – der Screen zeigt
    // ohnehin gleich, wer schneller war.
    if (res.offline) toast('Nicht angekommen – nochmal drücken!', 'error');
    else if (!/spät/i.test(res.error || '')) toast(res.error, 'error');
  }
}

// Auf der Zone statt nur auf dem Knopf: ein Fehlgriff daneben soll trotzdem zählen.
$('#buzz-zone').addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  pointerDown = true;
  pressBuzzer();
});
for (const evt of ['pointerup', 'pointercancel', 'pointerleave']) {
  $('#buzz-zone').addEventListener(evt, () => (pointerDown = false));
}
document.addEventListener('keydown', (ev) => {
  if (ev.key !== ' ' || ev.repeat) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  ev.preventDefault();
  pressBuzzer();
});

/* ------------------------------------------------------------------ Render */

function render(prev) {
  if (!state) return;
  const joined = !!state.you?.teamId;
  $('#view-join').classList.toggle('active', !joined);
  $('#view-play').classList.toggle('active', joined);

  if (!joined) {
    if (prev?.you?.teamId) {
      toast('Dein Team gibt es nicht mehr – bitte neu wählen.', 'error');
      selectedTeam = null;
    }
    return renderJoin();
  }

  const me = state.teams.find((t) => t.id === state.you.teamId);
  $('#p-team').textContent = me?.name || '—';
  $('#p-name').textContent = (me?.members || []).map((m) => m.name).join(', ');
  $('#p-score').textContent = me?.score ?? 0;
  // Teamwechsel lehnt der Server während einer Frage ab – Knopf dann ausblenden.
  $('#btn-leave').hidden = state.phase === 'question';

  renderQuestion();
  renderPicker();
  renderBuzzer(prev);
  renderScores();
}

function renderJoin() {
  const box = $('#team-choices');
  // Nur neu bauen, wenn sich wirklich etwas geändert hat – sonst geht ein
  // Antippen verloren, weil zwischendurch ein State-Update eintrudelt.
  const key = state.teams.map((t) => `${t.id}:${t.name}:${t.members.map((m) => m.name).join(',')}`).join('|')
    + `#${selectedTeam}`;
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    if (!state.teams.length) {
      box.append(el('p', { class: 'muted small' }, 'Der Host hat noch keine Teams angelegt. Gleich geht’s los …'));
    }
    if (selectedTeam && !state.teams.some((t) => t.id === selectedTeam)) selectedTeam = null;
    for (const team of state.teams) {
      box.append(
        el('button', {
          type: 'button',
          class: `team-choice ${selectedTeam === team.id ? 'selected' : ''}`,
          onclick: () => { selectedTeam = team.id; renderJoin(); },
        },
          el('span', { class: 'dot', style: { background: team.color } }),
          el('span', {},
            el('div', {}, team.name),
            el('div', { class: 'sub' },
              team.members.length ? team.members.map((m) => m.name).join(', ') : 'noch frei'),
          ),
        ),
      );
    }
  }
  $('#join-hint').textContent =
    state.phase === 'lobby'
      ? 'Für Zweierteams wählt ihr beide dasselbe Team.'
      : 'Das Spiel läuft schon – du kannst trotzdem einsteigen.';
}

function renderQuestion() {
  const box = $('#p-question');
  const q = state.current;
  if (!q) {
    box.hidden = true;
    $('#view-play').classList.remove('hat-bild', 'frage-durch');
    return;
  }
  box.hidden = false;
  $('#p-q-head').textContent = `${q.category} · ${q.value} Punkte`;
  setFrageText($('#p-q-text'), q.text);
  const img = $('#p-q-image');
  if (q.image) {
    if (img.getAttribute('src') !== q.image) img.src = q.image;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }
  // Bei Bildfragen tritt der Buzzer-Kreis zurück, damit das Bild ganz sichtbar
  // bleibt – und wenn die Frage durch ist, erst recht.
  $('#view-play').classList.toggle('hat-bild', !!q.image);
  $('#view-play').classList.toggle('frage-durch', q.step === 'result');

  const answer = $('#p-q-answer');
  answer.hidden = !q.revealed;
  answer.textContent = q.answer || '';

  // Der Zusatz stand bisher nur auf der Leinwand. Auf dem Handy ist er besser
  // aufgehoben: Genau darüber redet die Runde nach dem Auflösen.
  const note = $('#p-q-note');
  note.hidden = !(q.revealed && q.note);
  note.textContent = q.note || '';
}

function renderPicker() {
  const box = $('#p-picker');
  const canPick = state.phase === 'board' && state.you.isMyTurn && state.board;
  box.hidden = !canPick;
  if (!canPick) return;

  // Fragensatz mit in den Schlüssel: sonst zeigt ein neues Spiel mit gleicher
  // Feldbelegung noch die Kategorien des alten.
  const key = [
    state.setName, state.round,
    state.board.categories.map((c) => `${c.name}:${c.cells.map((x) => (x.used ? 1 : 0)).join('')}`).join('|'),
  ].join('#');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  state.board.categories.forEach((cat, catIdx) => {
    box.append(
      el('div', { class: 'pick-cat' },
        el('h3', {}, cat.name),
        el('div', { class: 'pick-values' },
          cat.cells.map((cell, rowIdx) =>
            el('button', {
              type: 'button',
              class: cell.used ? 'used' : '',
              onclick: (ev) => {
                if (cell.used) return;
                ev.currentTarget.classList.add('used');
                sound('pick');
                action('pick', { catIdx, rowIdx, quiet: true });
              },
            }, String(cell.value)),
          ),
        ),
      ),
    );
  });
}

function renderBuzzer(prev) {
  const q = state.current;
  const you = state.you;
  const status = $('#p-status');
  const label = $('#buzzer-label');

  buzzer.classList.remove('armed', 'won', 'locked');
  label.textContent = 'BUZZ';
  status.classList.remove('you');

  const lock = (text) => {
    buzzer.classList.add('locked');
    label.textContent = text;
  };

  if (!isOnline()) {
    status.textContent = 'Keine Verbindung – warte kurz …';
    lock('OFFLINE');
    return;
  }
  if (state.phase === 'lobby') {
    status.textContent = 'Warten auf den Start …';
    lock('BEREIT');
    return;
  }
  if (state.phase === 'roundEnd') { status.textContent = 'Runde vorbei – gleich geht’s weiter.'; lock('PAUSE'); return; }
  if (state.phase === 'gameOver') { status.textContent = 'Spiel beendet!'; lock('ENDE'); return; }

  if (state.phase === 'board') {
    status.textContent = you.isMyTurn
      ? 'Du bist dran – wähle ein Feld!'
      : `Am Zug: ${state.teams[state.turnIndex]?.name ?? '?'} …`;
    status.classList.toggle('you', you.isMyTurn);
    lock(you.isMyTurn ? 'DU WÄHLST' : 'GESPERRT');
    return;
  }

  if (!q) return;

  if (you.canBuzz) {
    buzzer.classList.add('armed');
    status.textContent = `Buzzer frei! ${q.halfValue} Punkte – oder ${q.halfValue} Abzug.`;
    status.classList.add('you');
    // An der eigenen Berechtigung festmachen, nicht am globalen Schritt: sonst
    // bleibt es stumm, wenn der Buzzer nach einem falschen Buzz erneut aufgeht.
    if (prev && !prev.you?.canBuzz) {
      vibrate([30, 50, 30]);
      sound('armed');
      flash();
      // Wer den Daumen schon aufliegen hat, soll nicht extra neu tippen müssen.
      if (pointerDown) pressBuzzer();
    }
    return;
  }

  if (q.step === 'buzz' && q.buzzedTeamId) {
    const team = state.teams.find((t) => t.id === q.buzzedTeamId);
    const mine = q.buzzedTeamId === you.teamId;
    buzzer.classList.add(mine ? 'won' : 'locked');
    label.textContent = mine ? 'DU!' : (team?.name || '').toUpperCase();
    status.textContent = mine ? 'Du warst zuerst – antworte!' : `${team?.name} war schneller.`;
    status.classList.toggle('you', mine);
    return;
  }

  if (q.step === 'primary') {
    const active = state.teams.find((t) => t.id === q.teamId);
    status.textContent = you.onTheHook
      ? 'Du bist dran – sag deine Antwort!'
      : `Am Zug: ${active?.name ?? '?'}. Buzzer noch gesperrt.`;
    status.classList.toggle('you', !!you.onTheHook);
    lock(you.onTheHook ? 'DU BIST DRAN' : 'GESPERRT');
    return;
  }

  if (q.step === 'buzz') {
    status.textContent = q.lockedOut.includes(you.teamId)
      ? 'Ihr hattet euren Versuch.'
      : 'Deine Frage – die anderen sind dran.';
    lock('GESPERRT');
    return;
  }

  // Die Lösung steht schon groß im Kasten – hier stattdessen das, was man sonst
  // nirgends sieht: was die Frage dem eigenen Team gebracht hat.
  const eigen = q.log.reduce((summe, e) => (e.teamId === you.teamId ? summe + e.delta : summe), 0);
  status.textContent = !you.teamId ? 'Frage beendet.'
    : eigen > 0 ? `+${eigen} Punkte für euch!`
    : eigen < 0 ? `${eigen} Punkte für euch.`
    : 'Diesmal nichts für euch.';
  status.classList.toggle('you', eigen > 0);
  lock('DURCH');
}

function renderScores() {
  const box = $('#p-scores');
  const activeId = state.teams[state.turnIndex]?.id;
  const key = state.teams.map((t) => `${t.id}:${t.score}`).join('|') + `#${activeId}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  for (const team of state.teams) {
    const cls = [
      'chip',
      team.id === state.you.teamId ? 'me' : '',
      team.id === activeId ? 'turn' : '',
    ].join(' ');
    box.append(el('span', { class: cls }, `${team.name}: ${team.score}`));
  }
}
