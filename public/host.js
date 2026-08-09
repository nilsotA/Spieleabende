import { $, el, connect, hostAction, toast, sound, installAudioUnlock, setFrageText } from '/common.js';
import { qrSvg } from '/qr.js';

let state = null;
let localSet = null;      // aktuell gewählter Satz aus einer Datei
let dateiSatz = null;     // zuletzt geladene Datei, bleibt in der Auswahl verfügbar
let lastScores = new Map();
let peek = false;         // Lösung auf dem großen Screen kurz sichtbar?
let standVorRunde = null; // Platzierung am Ende der vorletzten Runde, für den Endstand

const act = hostAction;

installAudioUnlock();

/* --------------------------------------------------------------- Verbindung */

connect({
  role: 'host',
  onState: (next) => {
    const prev = state;
    state = next;
    render(prev);
  },
  onEvent: (name, data) => {
    if (name === 'buzz') {
      sound('buzz');
      stageFlash(state?.teams.find((t) => t.id === data.teamId)?.color);
    }
  },
});

/** Kurzer Studioblitz in Teamfarbe – ein Element, kein Layout. */
function stageFlash(color) {
  const node = $('#stage-flash');
  node.style.setProperty('--team', color || 'var(--neon-1)');
  node.classList.remove('on');
  void node.offsetWidth;
  node.classList.add('on');
}

/* -------------------------------------------------------------------- Lobby */

$('#team-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('#team-name');
  act('addTeam', { name: input.value });
  input.value = '';
  input.focus();
});

$('#btn-reload-sets').addEventListener('click', loadSets);
$('#btn-start').addEventListener('click', () => {
  const payload = localSet ? { set: localSet } : { file: $('#set-select').value };
  act('startGame', payload);
});

$('#set-file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed?.rounds)) throw new Error('Das ist kein Fragensatz.');
    dateiSatz = parsed;
    localSet = parsed;
    const select = $('#set-select');
    // Vorhandenen Datei-Eintrag ersetzen statt einen zweiten anzulegen.
    select.querySelector('option[value="__local"]')?.remove();
    select.prepend(el('option', { value: '__local' }, `${parsed.name || file.name} (aus Datei)`));
    select.value = '__local';
    describeSet(localSet);
    toast('Fragensatz geladen.');
  } catch (err) {
    toast('Datei konnte nicht gelesen werden: ' + err.message, 'error');
  } finally {
    ev.target.value = ''; // dieselbe Datei soll erneut wählbar bleiben
  }
});

const MIX = '__mix';

$('#set-select').addEventListener('change', async (ev) => {
  if (ev.target.value === MIX) {
    localSet = null;
    $('#set-info').textContent = 'Zwölf Kategorien, beim Start frisch aus allen Sätzen gewürfelt.';
    return;
  }
  // Der geladene Satz haengt an der Option, nicht am Auswahl-Zeitpunkt: sonst
  // ist er nach einem Blick auf einen anderen Satz unwiederbringlich weg und
  // „Spiel starten" schickt den Platzhalter „__local" an den Server.
  if (ev.target.value === '__local') {
    localSet = dateiSatz;
    return describeSet(localSet);
  }
  localSet = null;
  try {
    const set = await (await fetch(`/api/set?file=${encodeURIComponent(ev.target.value)}`)).json();
    if (set.error) throw new Error(set.error);
    describeSet(set);
  } catch (err) {
    $('#set-info').textContent = err.message || '';
  }
});

for (const [id, key, parse] of [
  ['#set-turnmode', 'turnMode', (v) => v],
  ['#set-penalty', 'wrongPenalty', (v) => v],
  ['#set-buzzcorrect', 'buzzAfterCorrect', (v) => v === 'true'],
]) {
  $(id).addEventListener('change', (ev) => act('settings', { settings: { [key]: parse(ev.target.value) } }));
}

async function loadSets() {
  try {
    const sets = await (await fetch('/api/sets')).json();
    const select = $('#set-select');
    const keepLocal = select.querySelector('option[value="__local"]');
    select.innerHTML = '';
    if (keepLocal) select.append(keepLocal);
    if (!sets.length && !keepLocal) {
      select.append(el('option', { value: '' }, 'Keine Fragensätze gefunden'));
      return;
    }
    // Ab zwei brauchbaren Sätzen lohnt der Mix – darunter käme immer dasselbe Board.
    if (sets.filter((s) => !s.error).length >= 2) {
      select.append(el('option', { value: MIX }, '🎲 Zufallsmix aus allen Sätzen'));
    }
    for (const set of sets) {
      select.append(
        el('option', { value: set.file, disabled: !!set.error },
          set.error ? `${set.file} – ${set.error}` : `${set.name} (${set.questions} Fragen)`),
      );
    }
    select.dispatchEvent(new Event('change'));
  } catch {
    toast('Fragensätze konnten nicht geladen werden.', 'error');
  }
}

function describeSet(set) {
  if (!set) return;
  $('#set-info').innerHTML = '';
  (set.rounds || []).forEach((r, i) => {
    $('#set-info').append(
      el('div', {}, `Runde ${i + 1}: ${r.categories.map((c) => c.name).join(' · ')}`),
    );
  });
}

async function loadUrls() {
  try {
    const info = await (await fetch('/api/info')).json();
    const liste = $('#join-urls');
    liste.innerHTML = '';
    // Bei mehreren Netzwerkkarten kann der Host die richtige antippen.
    for (const url of info.urls) {
      liste.append(el('code', {
        class: 'url',
        tabindex: '0',
        role: info.urls.length > 1 ? 'button' : null,
        onclick: () => zeigeQr(url, liste),
      }, url));
    }
    zeigeQr(info.urls[0], liste);
    $('#remote-url').textContent = `${info.urls[0]}/remote`;
  } catch {
    /* egal */
  }
}

/** QR-Code auf die Mitspielen-Seite – Abtippen einer IP ist der lästigste Teil. */
function zeigeQr(basis, liste) {
  const ziel = `${basis}/play`;
  try {
    $('#join-qr').innerHTML = qrSvg(ziel, { ecl: 'M', quiet: 4 });
  } catch {
    $('#join-qr').hidden = true;
  }
  for (const node of liste.children) node.classList.toggle('aktiv', node.textContent === basis);
}

loadSets();
loadUrls();

/* ------------------------------------------------------------------ Render */

function render(prev) {
  if (!state) return;
  const inLobby = state.phase === 'lobby';
  $('#view-lobby').classList.toggle('active', inLobby);
  $('#view-game').classList.toggle('active', !inLobby);

  if (inLobby) {
    // Sonst schweben beim nächsten Spielstart Phantom-Abzüge über den Teams.
    lastScores.clear();
    // Zurückgesetzt wurde das bisher nur in renderScoreboard() – und die läuft
    // in der Lobby nie. Beim zweiten Spiel eines Ein-Runden-Satzes blieb das
    // Konfetti deshalb aus.
    konfettiGefallen = false;
    standVorRunde = null;
    return renderLobby();
  }

  const stage = $('.stage');
  const q = state.current;
  stage.classList.toggle('focused', !!q || state.phase === 'roundEnd' || state.phase === 'gameOver');
  stage.classList.toggle('buzzopen', !!q && q.step === 'buzz' && !q.buzzedTeamId);
  stage.classList.toggle('buzzhit', !!q && !!q.buzzedTeamId);
  if (q?.buzzedTeamId) {
    stage.style.setProperty('--team', state.teams.find((t) => t.id === q.buzzedTeamId)?.color || '#fff');
  }

  // Beim Endstand ist die Rundenanzeige nur noch Altpapier – und sie steht
  // ausgerechnet dort, wo das Konfetti herunterkommt. Nur der Inhalt geht weg,
  // der Platz bleibt: Das Kopf-Raster hat drei Spalten, und ohne die erste
  // rutscht das Logo aus der Mitte.
  $('.round-badge').classList.toggle('leer', state.phase === 'gameOver');

  renderBoard();
  renderQuestion(prev);
  renderPlayers();
  renderScoreboard();
  renderControls();
  if (!$('#menu').hidden) fillMenu();
}

function renderLobby() {
  const list = $('#lobby-teams');
  list.innerHTML = '';
  if (!state.teams.length) {
    list.append(el('li', { class: 'muted' }, 'Noch keine Teams. Lege oben mindestens zwei an.'));
  }
  for (const team of state.teams) {
    list.append(
      el('li', {},
        // color mitsetzen: Der Schein um den Punkt kommt aus currentColor.
        el('span', { class: 'dot', style: { background: team.color, color: team.color } }),
        el('span', { class: 'grow' },
          el('div', { class: 'tname' }, team.name),
          el('div', { class: 'tmembers' },
            team.members.length
              ? team.members.map((m) => (m.online ? m.name : `${m.name} (offline)`)).join(', ')
              : 'kein Handy verbunden'),
        ),
        el('button', { class: 'btn btn-sm btn-ghost', onclick: () => act('removeTeam', { teamId: team.id }) }, '✕'),
      ),
    );
  }
  $('#set-turnmode').value = state.settings.turnMode;
  $('#set-penalty').value = state.settings.wrongPenalty;
  $('#set-buzzcorrect').value = String(state.settings.buzzAfterCorrect);
  $('#btn-start').disabled = state.teams.length < 2;
}

function renderBoard() {
  const board = $('#board');
  const data = state.board;
  if (!data) return;
  const cols = data.categories.length;
  const rows = Math.max(...data.categories.map((c) => c.cells.length), 1);

  // Schlüssel aus dem Inhalt, nicht nur aus der Rundennummer: ein zweites Spiel
  // mit anderem Fragensatz hätte sonst weiter die alten Kategorien im Kopf.
  const key = [state.setName, state.round, data.categories.map((c) => `${c.name}/${c.cells.length}`).join('|')].join('#');
  // Nach einem Neubau sind alle Kacheln frisch – „war vorher schon benutzt" ist
  // dann für jedes Feld falsch, und ohne diese Merkung würde nach einem Reload
  // des Host-Screens das halbe Board gleichzeitig abschalten.
  const frischGebaut = board.dataset.key !== key;
  if (frischGebaut) {
    board.dataset.key = key;
    board.innerHTML = '';
    board.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    board.style.gridTemplateRows = `auto repeat(${rows}, minmax(0, 1fr))`;
    data.categories.forEach((cat, catIdx) => {
      board.append(el('div', { class: 'cat', style: { gridColumn: catIdx + 1, gridRow: 1 } },
        el('span', {}, cat.name)));
      cat.cells.forEach((cell, rowIdx) => {
        board.append(
          el('button', {
            class: 'tile',
            'data-cell': `${catIdx}-${rowIdx}`,
            // --r ist die Zeile: Je teurer das Feld, desto größer die Ziffer.
            style: { gridColumn: catIdx + 1, gridRow: rowIdx + 2, '--i': catIdx + rowIdx, '--r': rowIdx },
            onclick: () => {
              sound('pick');
              act('pick', { catIdx, rowIdx });
            },
          }, el('span', {}, String(cell.value))),
        );
      });
    });
  }

  data.categories.forEach((cat, catIdx) => {
    cat.cells.forEach((cell, rowIdx) => {
      const tile = board.querySelector(`[data-cell="${catIdx}-${rowIdx}"]`);
      if (!tile) return;
      const wasUsed = tile.classList.contains('used');
      tile.classList.toggle('used', cell.used);
      tile.disabled = cell.used || state.phase !== 'board';
      if (cell.used && !wasUsed && !frischGebaut) {
        tile.classList.add('picked');
        setTimeout(() => tile.classList.remove('picked'), 500);
      }
    });
  });

  $('#round-label').textContent = `Runde ${state.round} / ${state.roundCount}`;
  const mult = $('#round-mult');
  mult.textContent = data.multiplier > 1 ? `${data.multiplier}× Punkte` : '';
  mult.hidden = data.multiplier <= 1;
  // Die Runde mit den doppelten Punkten sah bisher aus wie die erste – nur mit
  // anderen Zahlen. Ein Klassenwechsel an der Bühne färbt Kanten und Schein um,
  // ohne dass irgendwo Text kleiner oder kontrastärmer wird.
  $('.stage').classList.toggle('doppelt', data.multiplier > 1);

  const active = state.teams[state.turnIndex];
  $('#turn-name').textContent = active ? active.name : '—';
  $('#turn-pill').hidden = !(state.phase === 'board' || state.phase === 'question');
  if (active) $('#turn-pill').style.setProperty('--team', active.color);
}

function renderQuestion(prev) {
  const box = $('#question');
  const panel = box.querySelector('.q-panel');
  const q = state.current;
  if (!q) {
    box.hidden = true;
    setBuzzIndicator('aus');
    return;
  }
  const neu = !prev?.current || prev.current.catIdx !== q.catIdx || prev.current.rowIdx !== q.rowIdx;
  box.hidden = false;
  if (neu) {
    peek = false; // die Lösung nicht von der Vorfrage her offen lassen
    // Das Wackeln von einer falschen Antwort blieb sonst als Klasse hängen –
    // und weil `.q-panel.wrong` spezifischer ist als `.q-panel`, wackelte danach
    // jede weitere Frage beim Aufklappen, statt aus ihrem Feld zu wachsen.
    panel.classList.remove('wrong');
    openFromTile(panel, q);
  }

  $('#q-head').textContent = `${q.category} ${q.value}`;
  setFrageText($('#q-text'), q.text);

  const img = $('#q-image');
  if (q.image) {
    if (img.getAttribute('src') !== q.image) img.src = q.image;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }

  const status = $('#q-status');
  status.innerHTML = '';
  const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '?';

  panel.classList.toggle('buzzopen', q.step === 'buzz' && !q.buzzedTeamId);
  // Hat jemand gedrückt, wechselt der Ring von Gold auf die Teamfarbe – die
  // Frage „wer denn jetzt?" ist damit beantwortet, bevor jemand liest.
  panel.classList.toggle('buzzed', !!q.buzzedTeamId && q.step === 'buzz');

  // Das Schild oben rechts nennt, wer jetzt antworten muss – nicht, wer das Feld
  // gewählt hat. Hat jemand gebuzzert, leuchtete dort sonst weiter der Name des
  // Zugteams, während ein ganz anderer Tisch reden musste.
  const dran = q.onTheHook ? state.teams.find((t) => t.id === q.onTheHook) : null;
  if (dran) {
    $('#turn-name').textContent = dran.name;
    $('#turn-pill').style.setProperty('--team', dran.color);
  }
  // Bei freiem Buzzer ist niemand am Zug. Das Schild nannte dann weiter das
  // Zugteam – ausgerechnet das eine, das jetzt nicht mehr drücken darf.
  if (q.step === 'buzz' && !q.buzzedTeamId) $('#turn-pill').hidden = true;

  if (q.step === 'primary') {
    status.append(el('div', { class: 'chip turn' }, `Am Zug: ${teamName(q.teamId)}`));
    setBuzzIndicator('idle');
  } else if (q.step === 'buzz' && !q.buzzedTeamId) {
    status.append(el('div', { class: 'chip buzzopen' }, `⚡ Buzzer frei · ${q.halfValue} Punkte`));
    setBuzzIndicator('armed');
  } else if (q.buzzedTeamId) {
    status.append(el('div', { class: 'chip buzzed' }, `${teamName(q.buzzedTeamId)} hat gebuzzert!`));
    setBuzzIndicator(q.step === 'buzz' ? 'hit' : 'idle');
  } else {
    setBuzzIndicator('idle');
  }

  for (const entry of q.log) {
    const label =
      entry.result === 'pass' ? 'wusste es nicht'
        : entry.result === 'correct' ? `richtig +${entry.delta}`
          : entry.delta ? `falsch ${entry.delta}` : 'falsch';
    status.append(el('div', { class: `chip log ${entry.result}` }, `${teamName(entry.teamId)}: ${label}`));
  }

  const answer = $('#q-answer');
  answer.hidden = !q.revealed;
  answer.textContent = q.revealed ? q.answer : '';
  const note = $('#q-note');
  note.hidden = !(q.revealed && q.note);
  note.textContent = q.note || '';

  // Tonsignale nur bei echten Übergängen derselben Frage.
  const prevQ = prev?.current;
  const sameQuestion = prevQ && prev.round === state.round && prevQ.catIdx === q.catIdx && prevQ.rowIdx === q.rowIdx;
  if (sameQuestion && prevQ.log.length < q.log.length) {
    const letzte = q.log[q.log.length - 1];
    sound(letzte.result === 'correct' ? 'correct' : 'wrong');
    if (letzte.result === 'wrong') {
      panel.classList.remove('wrong');
      void panel.offsetWidth;
      panel.classList.add('wrong');
    }
  }
  if (sameQuestion && !prevQ.revealed && q.revealed && !q.log.some((e) => e.result === 'correct')) {
    sound('reveal');
  }

  // Der Übergang „jetzt dürfen alle" ist der spannendste des Spiels und war auf
  // der Leinwand stumm – das aufsteigende Signal kannte nur das Handy. Am
  // Zustand festgemacht, nicht am Wertungsschritt: Nach einem falschen Buzz
  // geht der Buzzer erneut auf, und auch das gehört angesagt. Kurz verzögert,
  // damit es nicht in den Wertungston hineinfällt.
  const buzzerJetztFrei = q.step === 'buzz' && !q.buzzedTeamId;
  const buzzerVorherFrei = sameQuestion && prevQ.step === 'buzz' && !prevQ.buzzedTeamId;
  if (sameQuestion && buzzerJetztFrei && !buzzerVorherFrei) {
    setTimeout(() => sound('armed'), 180);
  }
}

/**
 * Die Frage kommt sichtbar aus dem Feld, das gewählt wurde: Panel von der
 * Position und Größe der Kachel auf Endgröße fahren.
 */
function openFromTile(panel, q) {
  const tile = $(`[data-cell="${q.catIdx}-${q.rowIdx}"]`);
  const p = panel.getBoundingClientRect();
  if (!tile || !p.width) return;
  const t = tile.getBoundingClientRect();
  panel.style.setProperty('--fx', `${t.left + t.width / 2 - (p.left + p.width / 2)}px`);
  panel.style.setProperty('--fy', `${t.top + t.height / 2 - (p.top + p.height / 2)}px`);
  panel.style.setProperty('--fs', (t.width / p.width).toFixed(3));
  // Animation neu anstoßen
  panel.style.animation = 'none';
  void panel.offsetWidth;
  panel.style.animation = '';
}

function setBuzzIndicator(mode) {
  const node = $('#buzz-indicator');
  node.classList.toggle('armed', mode === 'armed');
  node.classList.toggle('hit', mode === 'hit');
  // Ohne offene Frage kann niemand buzzern – dann hat der Kreis auf der
  // Leinwand auch nichts anzuzeigen und verschwindet ganz.
  node.classList.toggle('aus', mode === 'aus');
}

function renderPlayers() {
  const box = $('#players');
  const key = state.teams.map((t) => t.id).join('|');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    for (const team of state.teams) {
      box.append(
        el('div', { class: 'player', 'data-team': team.id, style: { '--team': team.color } },
          el('div', { class: 'pname' }, team.name),
          el('div', { class: 'pmembers' }, ''),
          el('div', { class: 'pscore' }, '0'),
        ),
      );
    }
    for (const id of [...lastScores.keys()]) {
      if (!state.teams.some((t) => t.id === id)) lastScores.delete(id);
    }
  }

  // Am Rundenende und beim Endstand ist niemand mehr am Zug. Der Scheinwerfer
  // stand trotzdem auf dem Team, das als Nächstes gewählt hätte – beim Endstand
  // also gern auf dem Letzten, während der Sieger unbeleuchtet danebenstand.
  const amZug = state.phase === 'board' || state.phase === 'question';
  const activeId = amZug ? state.teams[state.turnIndex]?.id : null;
  const bestScore = Math.max(...state.teams.map((t) => t.score));
  const gebuzzert = state.current?.step === 'buzz' && state.current?.buzzedTeamId;
  box.classList.toggle('someone-buzzed', !!gebuzzert);
  for (const team of state.teams) {
    const node = box.querySelector(`[data-team="${team.id}"]`);
    if (!node) continue;
    node.querySelector('.pmembers').textContent = team.members
      .map((m) => (m.online ? m.name : `${m.name} ⚪`))
      .join(', ');
    const scoreNode = node.querySelector('.pscore');
    const vorher = lastScores.get(team.id);
    if (vorher != null && vorher !== team.score) countUp(scoreNode, vorher, team.score);
    else scoreNode.textContent = team.score;
    scoreNode.classList.toggle('neg', team.score < 0);
    node.classList.toggle('active', team.id === activeId);
    node.classList.toggle('buzzed', state.current?.buzzedTeamId === team.id && state.current?.step === 'buzz');
    // Wer führt, war an den Pulten nicht zu erkennen – alle Punktepillen sahen
    // gleich aus, ob 0 oder 3950. Bei Gleichstand leuchten eben mehrere.
    node.classList.toggle('leader', state.teams.length > 1 && bestScore > 0 && team.score === bestScore);

    const before = lastScores.get(team.id);
    if (before != null && before !== team.score) {
      const delta = team.score - before;
      // Nur noch die fliegende Zahl über dem Pult: Die zweite, kleinere Anzeige
      // im Pult selbst hat nie jemand gesehen – sie lag unter dem clip-path des
      // Trapezes und flog beim Aufsteigen sofort in den abgeschnittenen Bereich.
      hitmark(delta, node);
      node.classList.add(delta > 0 ? 'gain' : 'loss');
      setTimeout(() => node.classList.remove('gain', 'loss'), 1700);
    }
    lastScores.set(team.id, team.score);
  }

  // Der Scheinwerfer liegt auf der Leiste und wandert zum Pult, das dran ist.
  // Am Pult selbst könnte er nicht hängen: Dessen clip-path (das Trapez)
  // schneidet auch die eigenen Pseudo-Elemente ab.
  // Am Ende gehört der Scheinwerfer dem Sieger – vorher dem, der reden muss.
  const imLicht = box.querySelector('.player.buzzed')
    || box.querySelector('.player.active')
    || (state.phase === 'gameOver' ? box.querySelector('.player.leader') : null);
  box.classList.toggle('spot', !!imLicht);
  if (imLicht) {
    box.style.setProperty('--spot-x', `${imLicht.offsetLeft + imLicht.offsetWidth / 2}px`);
    box.style.setProperty('--spot-w', `${imLicht.offsetWidth}px`);
  }
}

/**
 * Die Punktzahl steigt groß auf – aber über dem Pult des Teams, das sie bekommt,
 * nicht mitten über der Bühne: dort verdeckte sie den Fragetext, und man sah
 * ausserdem nicht, wem sie gehört.
 */
function hitmark(delta, karte) {
  const mark = el('div', { class: `hitmark ${delta > 0 ? '' : 'minus'}` }, `${delta > 0 ? '+' : ''}${delta}`);
  const kasten = karte.getBoundingClientRect();
  mark.style.left = `${kasten.left + kasten.width / 2}px`;
  mark.style.top = `${kasten.top}px`;
  document.body.append(mark);
  setTimeout(() => mark.remove(), 950);
}

/** Punkte laufen sichtbar hoch statt einfach umzuspringen. */
function countUp(node, von, bis, dauer = 600) {
  const start = performance.now();
  const schritt = (jetzt) => {
    const t = Math.min(1, (jetzt - start) / dauer);
    const ease = 1 - (1 - t) ** 3;
    node.textContent = Math.round(von + (bis - von) * ease);
    if (t < 1) requestAnimationFrame(schritt);
  };
  requestAnimationFrame(schritt);
}

function renderScoreboard() {
  const box = $('#scoreboard');
  const show = state.phase === 'roundEnd' || state.phase === 'gameOver';
  box.hidden = !show;
  if (!show) return;

  const final = state.phase === 'gameOver';
  $('#score-title').textContent = final ? 'Endstand' : `Runde ${state.round} beendet`;
  $('.scores-panel').classList.toggle('final', final);
  const list = $('#score-list');
  const ranked = [...state.teams].sort((a, b) => b.score - a.score);

  // Sieg heißt mehr Punkte als alle anderen – bei Gleichstand gibt es keinen.
  const geteilt = ranked.length > 1 && ranked[1].score === ranked[0].score;
  const sieger = $('#score-winner');
  sieger.hidden = !final;
  if (final) {
    sieger.textContent = geteilt
      ? `Unentschieden – ${ranked.filter((t) => t.score === ranked[0].score).map((t) => t.name).join(' und ')}`
      : `${ranked[0].name} gewinnt!`;
    sieger.classList.toggle('geteilt', geteilt);
  }

  const key = ranked.map((t) => `${t.id}:${t.score}`).join('|') + `#${state.phase}`;
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.innerHTML = '';
    ranked.forEach((team, i) => {
      // Beim Endstand baut sich die Liste von unten auf: Der Letzte zuerst, der
      // Sieger zuletzt. Vorher lief die Spannung rückwärts.
      const stufe = final ? ranked.length - 1 - i : i;
      // Runde 2 zählt doppelt – dort entscheidet sich der Abend. Aus vier
      // nackten Zahlen wird eine Geschichte, wenn danebensteht, wer sich um
      // wie viele Plätze geschoben hat.
      const vorher = final ? standVorRunde?.get(team.id) : null;
      const sprung = vorher ? vorher.rang - i : 0;
      list.append(
        el('li', { class: i === 0 ? 'first' : '', style: { '--i': stufe, '--team': team.color } },
          el('span', { class: 'rank' }, `${i + 1}`),
          el('span', { class: 'sname' }, team.name),
          // Nur wer sich bewegt hat, bekommt einen Pfeil. Vier Punkte für „nichts
          // passiert" wären bloß Rauschen in der wichtigsten Tabelle des Abends.
          sprung !== 0
            ? el('span', { class: `sprung ${sprung > 0 ? 'hoch' : 'runter'}` },
              sprung > 0 ? `▲ ${sprung}` : `▼ ${-sprung}`)
            : null,
          el('span', { class: 'pts' }, String(team.score)),
        ),
      );
    });
  }

  // Der Stand am Ende der vorletzten Runde ist die Vergleichsmarke. Der Server
  // kennt ihn nicht – der Host-Screen merkt ihn sich einfach beim Durchlaufen.
  if (!final) {
    standVorRunde = new Map(ranked.map((t, i) => [t.id, { score: t.score, rang: i }]));
  }
  $('#btn-next-round').hidden = final;
  $('#btn-new-game').hidden = !final;
  if (final && !konfettiGefallen) {
    konfettiGefallen = true;
    konfetti(ranked[0]?.color);
  }
  if (!final) konfettiGefallen = false;
}

let konfettiGefallen = false;

/** Einmalig beim Sieg – 60 Schnipsel, danach werden die Elemente entfernt. */
function konfetti(farbe) {
  const box = $('#confetti');
  const farben = [farbe || '#ffcf3d', '#ffcf3d', '#22e08a', '#3f86d8', '#ff2d55', '#fff'];
  for (let i = 0; i < 60; i++) {
    const teil = el('i', {
      style: {
        left: `${(i * 37) % 100}%`,
        background: farben[i % farben.length],
        '--dx': `${((i % 7) - 3) * 30}px`,
        '--rot': `${360 + (i % 5) * 180}deg`,
        animationDuration: `${2.2 + (i % 9) * 0.09}s`,
        animationDelay: `${(i % 12) * 0.06}s`,
      },
    });
    box.append(teil);
  }
  setTimeout(() => (box.innerHTML = ''), 4200);
}

/* --------------------------------------------------------------- Steuerung */

$('#btn-peek').addEventListener('click', () => {
  peek = !peek;
  renderControls();
});

function renderControls() {
  const hint = $('#control-hint');
  const bar = $('#control-buttons');
  const q = state.current;
  const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '?';

  // Die Leiste war der einzige Renderer ohne Schlüssel und baute sich bei jedem
  // Broadcast neu auf – auch wenn nur ein Handy beigetreten ist. Fällt so ein
  // Update zwischen Finger-runter und Klick, ist der Knopf weg und die Wertung
  // verpufft. Der Hinweistext darf sich weiter jedes Mal ändern.
  const key = [
    state.phase, q?.step, q?.buzzedTeamId, q?.teamId,
    (q?.lockedOut || []).join(','),
    state.teams.map((t) => `${t.id}:${t.name}`).join('|'),
  ].join('#');
  const neu = bar.dataset.key !== key;
  if (neu) {
    bar.dataset.key = key;
    bar.innerHTML = '';
  }
  const add = (...knoepfe) => { if (neu) bar.append(...knoepfe); };

  // Die Lösung gehört nicht ungefragt auf die Leinwand.
  const wrap = $('#solution-wrap');
  const solution = $('#solution');
  const showSolution = !!q && !!q.answer && !q.revealed;
  wrap.hidden = !showSolution;
  if (showSolution) {
    solution.textContent = `Lösung: ${q.answer}`;
    solution.classList.toggle('blurred', !peek);
  }

  if (state.phase === 'board') {
    hint.textContent = `Am Zug: ${teamName(state.teams[state.turnIndex]?.id)} – Feld anklicken oder auf dem Handy antippen.`;
    add(button('Zug überspringen', 'btn-ghost btn-sm', () => {
      const next = state.teams[(state.turnIndex + 1) % state.teams.length];
      act('setTurn', { teamId: next.id });
    }));
    return;
  }

  if (state.phase === 'roundEnd' || state.phase === 'gameOver') {
    hint.textContent = state.phase === 'gameOver' ? 'Spiel beendet.' : 'Bereit für die nächste Runde?';
    return;
  }

  if (!q) { hint.textContent = ''; return; }

  if (q.step === 'primary') {
    hint.textContent = `${teamName(q.teamId)} antwortet.`;
    add(
      button('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), '1'),
      button('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), '2'),
      button('Weiß nicht → Buzzer frei', 'btn-ghost', () => act('pass'), '3'),
    );
  } else if (q.step === 'buzz' && !q.buzzedTeamId) {
    hint.textContent = 'Buzzer ist frei.';
    for (const team of state.teams) {
      if (team.id === q.teamId || q.lockedOut.includes(team.id)) continue;
      add(button(`Buzz: ${team.name}`, 'btn-ghost btn-sm', () => act('buzzFor', { teamId: team.id })));
    }
    add(button('Keiner weiß es → auflösen', 'btn-primary', () => act('endQuestion'), '4'));
  } else if (q.buzzedTeamId && q.step === 'buzz') {
    hint.textContent = `${teamName(q.buzzedTeamId)} hat gebuzzert (±${q.halfValue}).`;
    add(
      button('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), '1'),
      button('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), '2'),
      button('Buzz zurücknehmen', 'btn-ghost btn-sm', () => act('resetBuzz')),
    );
  } else {
    hint.textContent = 'Frage beendet.';
    add(button('Weiter', 'btn-primary', () => act('close'), 'Leertaste'));
  }
}

function button(label, cls, onclick, key) {
  const node = el('button', { class: `btn ${cls}`, onclick }, label);
  if (key) node.append(el('kbd', {}, key));
  return node;
}

$('#btn-next-round').addEventListener('click', () => act('nextRound'));
$('#btn-new-game').addEventListener('click', () => act('backToLobby'));
$('#btn-menu').addEventListener('click', openMenu);
$('#btn-close-menu').addEventListener('click', closeMenu);
$('#menu').addEventListener('click', (ev) => {
  if (ev.target.id === 'menu') closeMenu();
});
$('#btn-abort').addEventListener('click', () => {
  if (confirm('Spiel wirklich beenden und zurück in die Lobby?')) {
    act('backToLobby');
    closeMenu();
  }
});

function openMenu() {
  fillMenu();
  $('#menu').hidden = false;
  // Alles dahinter stilllegen, sonst wandert der Tabulator aufs Board.
  $('#view-game').inert = true;
  $('#btn-close-menu').focus();
}

function closeMenu() {
  $('#menu').hidden = true;
  $('#view-game').inert = false;
}

function fillMenu() {
  const list = $('#menu-teams');
  list.innerHTML = '';
  for (const team of state.teams) {
    const offline = team.members.filter((m) => !m.online);
    list.append(
      el('li', {},
        el('span', { class: 'dot', style: { background: team.color } }),
        el('span', { class: 'tname' },
          team.name,
          offline.length
            ? el('span', { class: 'muted small' }, ` · ${offline.length} offline`)
            : null),
        el('span', { class: 'sc' }, String(team.score)),
        button('−100', 'btn-sm btn-ghost', () => act('adjustScore', { teamId: team.id, delta: -100 })),
        button('+100', 'btn-sm btn-ghost', () => act('adjustScore', { teamId: team.id, delta: 100 })),
        button('dran', 'btn-sm btn-ghost', () => act('setTurn', { teamId: team.id })),
        offline.length
          ? button('Offline entfernen', 'btn-sm btn-ghost', () => {
            for (const m of offline) act('removeMember', { teamId: team.id, clientId: m.clientId });
          })
          : null,
      ),
    );
  }
}

/* ------------------------------------------------------------ Tastatur */

document.addEventListener('keydown', (ev) => {
  // Eine gehaltene Taste feuert im Sekundentakt nach. Bei „2“ hieße das: erst
  // ist das Zugteam falsch, dann das Team, das gerade gebuzzert hat.
  if (ev.repeat) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (!state || state.phase === 'lobby') return;

  const menuOpen = !$('#menu').hidden;
  const key = ev.key.toLowerCase();

  if (key === 'escape') {
    ev.preventDefault();
    return menuOpen ? closeMenu() : openMenu();
  }
  // Solange das Menü offen ist, gehören die Tasten dem Menü.
  if (menuOpen) return;

  const q = state.current;
  if (!q) {
    if (key === ' ' && state.phase === 'roundEnd') { ev.preventDefault(); act('nextRound'); }
    return;
  }

  const judging = q.step === 'primary' || (q.step === 'buzz' && q.buzzedTeamId);
  if (key === '1' && judging) { ev.preventDefault(); act('judge', { correct: true }); }
  else if (key === '2' && judging) { ev.preventDefault(); act('judge', { correct: false }); }
  else if (key === '3' && q.step === 'primary') { ev.preventDefault(); act('pass'); }
  else if (key === '4' && q.step === 'buzz' && !q.buzzedTeamId) { ev.preventDefault(); act('endQuestion'); }
  else if (key === ' ' && q.step === 'result') { ev.preventDefault(); act('close'); }
  else if (key === 'l') { ev.preventDefault(); peek = !peek; renderControls(); }
});
