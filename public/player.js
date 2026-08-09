import {
  $, el, connect, action, toast, sound, vibrate, flash,
  installAudioUnlock, unlockAudio, keepScreenAwake, onConnectionChange, isOnline, setFrageText,
  istStumm, setzeStumm } from '/common.js';

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

/* Stumm gilt pro Gerät: Wer neben dem Beamer sitzt, braucht seinen Buzzerton
   nicht doppelt – und das Handy vibriert ja ohnehin. */
const tonKnopf = $('#btn-ton');
function zeigeTon() {
  tonKnopf.textContent = istStumm() ? '🔇' : '🔊';
  tonKnopf.title = istStumm() ? 'Töne sind aus' : 'Töne sind an';
}
tonKnopf.addEventListener('click', () => {
  unlockAudio(); // echte Nutzergeste – sonst bleibt es auf iOS stumm
  setzeStumm(!istStumm());
  zeigeTon();
  if (!istStumm()) sound('pick');
});
zeigeTon();

/* ------------------------------------------------------------------ Buzzer */

const buzzer = $('#buzzer');
let buzzLock = false;

async function pressBuzzer() {
  if (buzzLock) return;

  // Probelauf in der Lobby: alles fühlt sich echt an, nur der Server erfährt
  // nichts davon.
  if (state?.phase === 'lobby') {
    vibrate(45);
    sound('buzz');
    buzzer.classList.remove('probeHit');
    void buzzer.offsetWidth;
    buzzer.classList.add('probeHit');
    return;
  }

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
  // Das Eindrücken hing an :active des Kreises – wer daneben traf, löste den
  // Buzz aus, ohne dass sich irgendetwas bewegte. Die Zone führt es jetzt mit.
  buzzer.classList.add('gedrueckt');
  pressBuzzer();
});
for (const evt of ['pointerup', 'pointercancel', 'pointerleave']) {
  $('#buzz-zone').addEventListener(evt, () => {
    pointerDown = false;
    buzzer.classList.remove('gedrueckt');
  });
}
document.addEventListener('keydown', (ev) => {
  if (ev.key !== ' ' || ev.repeat) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  // Vor dem Beitreten gehört die Leertaste der Anmeldung: Sonst schluckt das
  // preventDefault das Aktivieren der Team-Kacheln, und am Laptop kommt man
  // mit der Tastatur nicht mehr ins Spiel.
  if (!state?.you?.teamId) return;
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
    // Nur meckern, wenn das Team wirklich weg ist. „Team wechseln" erzeugt
    // denselben Zustand – dafür einen roten Fehlerkasten zu zeigen, wäre eine
    // Beschwerde über etwas, das man selbst gerade angetippt hat.
    if (prev?.you?.teamId && !state.teams.some((t) => t.id === prev.you.teamId)) {
      toast('Dein Team gibt es nicht mehr – bitte neu wählen.', 'error');
      selectedTeam = null;
    }
    return renderJoin();
  }

  const me = state.teams.find((t) => t.id === state.you.teamId);
  $('#p-team').textContent = me?.name || '—';
  $('#p-name').textContent = (me?.members || []).map((m) => m.name).join(', ');

  // Der eigene Punktestand sprang lautlos von 0 auf 250 – der Moment, um den
  // das ganze Spiel geht, kam am Handy gar nicht an. Ausgelöst wird nur bei
  // einer echten Wertung: Beim Start eines neuen Spiels setzt der Server alle
  // Punkte auf 0, und dann soll nicht jedes Handy ein dickes Minus anzeigen.
  const vorher = prev?.teams?.find((t) => t.id === state.you.teamId);
  const gewertet = state.phase === 'question' && vorher && vorher.score !== me?.score;
  if (gewertet) punktesprung(me.score - vorher.score, vorher.score, me.score);
  else $('#p-score').textContent = me?.score ?? 0;
  // Teamwechsel lehnt der Server während einer Frage ab – Knopf dann ausblenden.
  $('#btn-leave').hidden = state.phase === 'question';

  renderQuestion();
  renderPicker();
  renderBuzzer(prev);
  renderScores();

  // Der Buzzer tritt zurück, wann immer etwas anderes den Platz braucht und er
  // ohnehin nichts tun kann: beim Feldwählen (dort standen von sechs Kategorien
  // zwei im Bild), nach dem Auflösen und an den Rundenenden. Nur wenn wirklich
  // nichts anderes zu zeigen ist, bleibt er groß – dann ist er die Ansage.
  // In der Lobby bleibt er ebenfalls groß: Ein Probeknopf von 88 Pixeln wäre
  // kein Spielzeug, und etwas anderes ist dort ohnehin nicht zu sehen.
  const grosserKnopf = state.phase === 'lobby'
    || (state.phase === 'question' && state.current?.step !== 'result');
  $('#view-play').classList.toggle('knopf-ruht', !grosserKnopf);
}

/**
 * Der eigene Punktesprung, direkt in der Hand: Die Zahl läuft hoch statt zu
 * springen, daneben fliegt der Zuwachs weg, und das Handy summt kurz. Ein
 * Vollbildblitz wäre hier zu viel – man schaut ohnehin schon auf das Gerät.
 */
let sprungZeit = null;
function punktesprung(delta, von, bis) {
  const feld = $('#p-score');
  const start = performance.now();
  const schritt = (jetzt) => {
    const t = Math.min(1, (jetzt - start) / 500);
    feld.textContent = Math.round(von + (bis - von) * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(schritt);
  };
  requestAnimationFrame(schritt);

  feld.classList.remove('plus', 'minus');
  void feld.offsetWidth;
  feld.classList.add(delta > 0 ? 'plus' : 'minus');

  const flieger = el('span', { class: `p-delta ${delta > 0 ? 'plus' : 'minus'}` },
    `${delta > 0 ? '+' : ''}${delta}`);
  feld.parentElement.append(flieger);
  clearTimeout(sprungZeit);
  sprungZeit = setTimeout(() => {
    flieger.remove();
    feld.classList.remove('plus', 'minus');
  }, 1600);

  vibrate(delta > 0 ? [30, 40, 30] : 120);
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
    $('#view-play').classList.remove('hat-bild');
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
  // bleibt. Ob er ganz ruht, entscheidet render() für alle Fälle gemeinsam.
  $('#view-play').classList.toggle('hat-bild', !!q.image);

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

  buzzer.classList.remove('armed', 'won', 'locked', 'fremd', 'probe');
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
    // Warten auf den Start ist die längste tote Zeit des Abends. Der Knopf darf
    // hier ausprobiert werden – er meldet nichts an den Server, aber er drückt
    // sich, summt und leuchtet. Nebenbei entsperrt das erste Antippen den Ton
    // auf iPhones, wo das ohne echte Geste nicht geht.
    buzzer.classList.add('probe');
    status.textContent = 'Warten auf den Start – Buzzer ausprobieren?';
    label.textContent = 'PROBE';
    return;
  }
  if (state.phase === 'roundEnd') { status.textContent = 'Runde vorbei – gleich geht’s weiter.'; lock('PAUSE'); return; }
  if (state.phase === 'gameOver') { status.textContent = 'Spiel beendet!'; lock('ENDE'); return; }

  if (state.phase === 'board') {
    // Die stillste Stelle des Abends: Nach „Weiter" steht das Board wieder da,
    // und der Tisch wartet, bis jemand merkt, dass er wählen soll – bisher
    // musste der Host das 48-mal laut sagen. Das Handy meldet sich jetzt selbst,
    // aber nur beim Übergang, nicht bei jedem Update derselben Lage.
    if (you.isMyTurn && !(prev?.phase === 'board' && prev.you?.isMyTurn)) {
      vibrate([25, 60, 25]);
      sound('armed');
      flash();
    }
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
    // „Zu spät" und „noch gesperrt" waren derselbe graue Teller. Jetzt trägt der
    // Knopf die Farbe des Teams, das schneller war.
    buzzer.classList.add(mine ? 'won' : 'fremd');
    if (!mine) buzzer.style.setProperty('--fremd', team?.color || '#55617a');
    label.textContent = mine ? 'DU!' : (team?.name || '').toUpperCase();
    // Wie knapp war es? Das Rennen endete für die Verlierer bisher wortlos.
    const knapp = q.buzzMs != null ? ` (${(q.buzzMs / 1000).toFixed(2).replace('.', ',')} s)` : '';
    // Wer genau gedrückt hat, steht in q.buzzedBy – bei Zweierteams ist das die
    // interessantere Angabe. Der Teamname steht ohnehin groß auf dem Knopf, also
    // hier nicht doppelt. Beim Host-Buzz trägt buzzedBy den Teamnamen; dann
    // bleibt es beim Team, sonst stünde dort „Team Rakete war schneller" zweimal.
    const wer = q.buzzedBy && q.buzzedBy !== team?.name ? q.buzzedBy : team?.name;
    status.textContent = mine
      ? `Du warst zuerst${knapp} – antworte!`
      : `${wer} war schneller${knapp}.`;
    status.classList.toggle('you', mine);
    // Nur beim Übergang tönen, nicht bei jedem Update derselben Lage.
    if (prev && !(prev.current?.step === 'buzz' && prev.current?.buzzedTeamId)) {
      if (mine) { vibrate([40, 40, 80]); sound('correct'); }
      else if (!q.lockedOut.includes(you.teamId) && q.teamId !== you.teamId) sound('zuspaet');
    }
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
