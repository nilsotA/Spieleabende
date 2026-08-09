import {
  $, el, connect, hostAction, toast, sound, installAudioUnlock, setFrageText,
  istStumm, setzeStumm } from '/common.js';
import { qrSvg } from '/qr.js';

let state = null;
let localSet = null;      // aktuell gewählter Satz aus einer Datei
let dateiSatz = null;     // zuletzt geladene Datei, bleibt in der Auswahl verfügbar
let lastScores = new Map();
let peek = false;         // Lösung auf dem großen Screen kurz sichtbar?
let standVorRunde = null; // Platzierung am Ende der vorletzten Runde, für den Endstand
let letzteRunde = null;   // zuletzt gesehene Rundennummer, für die Rundenansage
let fuehrend = null;      // wer zuletzt allein vorne lag, für den Führungswechsel

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

/**
 * Kurze Ansage quer über die Leinwand. Die einzige Stelle, an der das Spiel den
 * Raum unterbricht – deshalb nur zum Rundenwechsel und deshalb kurz: Nach 1,8
 * Sekunden ist die Wand wieder frei, ohne dass jemand etwas drücken muss.
 */
let ansageZeit = null;
function ansagen(zeile1, zeile2 = '', dauer = 1800) {
  const box = $('#ansage');
  box.style.setProperty('--dauer', `${dauer}ms`);
  $('#ansage-1').textContent = zeile1;
  $('#ansage-2').textContent = zeile2;
  $('#ansage-2').hidden = !zeile2;
  box.hidden = false;
  box.classList.remove('an');
  void box.offsetWidth; // Neustart der Animation erzwingen
  box.classList.add('an');
  clearTimeout(ansageZeit);
  ansageZeit = setTimeout(() => {
    box.classList.remove('an');
    box.hidden = true;
  }, dauer);
}

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
    letzteRunde = null;
    fuehrend = null;
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
  // Nur bei einer wirklich neuen Runde tönen, nicht bei jedem Neuaufbau: Ein
  // Reload des Host-Screens baut das Board ebenfalls neu, und dann wäre die
  // Ansage gelogen.
  // Zwei Fälle sollen tönen: der Spielstart und jeder Rundenwechsel. Nicht
  // tönen darf ein Reload des Host-Screens – der baut das Board ebenfalls neu.
  // Unterschieden wird am Board selbst: Beim echten Anfang ist noch kein Feld
  // gespielt, nach einem Reload mittendrin schon.
  const nochNichtsGespielt = data.categories.every((c) => c.cells.every((z) => !z.used));
  const neueRunde = frischGebaut && letzteRunde !== null && letzteRunde !== state.round;
  const spielStart = frischGebaut && letzteRunde === null && state.round === 1 && nochNichtsGespielt;
  if (neueRunde || spielStart) {
    sound('rundenstart');
    ansagen(`Runde ${state.round}`, data.multiplier > 1 ? 'Ab jetzt zählt alles doppelt' : 'Los geht’s!');
  }
  letzteRunde = state.round;
  if (frischGebaut) {
    board.dataset.key = key;
    board.innerHTML = '';
    board.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    board.style.gridTemplateRows = `auto repeat(${rows}, minmax(0, 1fr))`;
    data.categories.forEach((cat, catIdx) => {
      // --c ist die Spalte: Die Schilder gehen von links nach rechts an, erst
      // danach klappen die Panels auf. Vorhang auf statt „alles ist plötzlich da".
      board.append(el('div', { class: 'cat', style: { gridColumn: catIdx + 1, gridRow: 1, '--c': catIdx } },
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
      // pickCell markiert das Feld schon beim Anklicken als gespielt. Optisch
      // bleibt es an, solange seine Frage offen ist – sonst schaltet es hinter
      // dem Scrim ab, wo es niemand sieht, und der Rückweg landet auf einem
      // Feld, das längst schwarz ist. Gesperrt ist es trotzdem: `disabled`
      // hängt unverändert an cell.used, nachfassen kann also niemand.
      const offeneFrage = state.current?.catIdx === catIdx && state.current?.rowIdx === rowIdx;
      tile.classList.toggle('used', cell.used && !offeneFrage);
      tile.disabled = cell.used || state.phase !== 'board';
    });
  });

  // Am Ende einer Runde steht ein einziges Feld auf sonst schwarzer Wand, und
  // niemand sagt dem Raum, dass jetzt die letzte Frage kommt. Weil pickCell das
  // Feld schon beim Anklicken als gespielt markiert, kann „genau eins offen"
  // während einer laufenden Frage gar nicht auftreten.
  const offen = data.categories.reduce((n, c) => n + c.cells.filter((z) => !z.used).length, 0);
  board.classList.toggle('finale', offen === 1 && state.phase === 'board');

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
    // Der Rückweg ist der meistgesehene Übergang des Abends – 24-mal pro Runde –
    // und war der einzige harte Schnitt. Jetzt fährt das Panel in sein Feld
    // zurück, und das Feld geht genau dabei aus.
    if (prev?.current && !box.hidden) return schliesseFrage(box, panel, prev.current);
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
    // Wie knapp war es? Das Buzzer-Rennen endete bisher ohne Ergebnis.
    const zeit = q.buzzMs != null ? ` · ${(q.buzzMs / 1000).toFixed(2).replace('.', ',')} s` : '';
    status.append(el('div', { class: 'chip buzzed' }, `${teamName(q.buzzedTeamId)} hat gebuzzert!${zeit}`));
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
  // Wenn erst das Zugteam passt und danach alle anderen danebenliegen, ist das
  // der Moment, in dem der ganze Raum lacht. Auf der Leinwand sah er bisher aus
  // wie jede andere Auflösung.
  const keiner = q.revealed && q.log.length > 0 && !q.log.some((e) => e.result === 'correct');
  $('#q-keiner').hidden = !keiner;

  const note = $('#q-note');
  note.hidden = !(q.revealed && q.note);
  note.textContent = q.note || '';

  // Tonsignale nur bei echten Übergängen derselben Frage.
  const prevQ = prev?.current;
  const sameQuestion = prevQ && prev.round === state.round && prevQ.catIdx === q.catIdx && prevQ.rowIdx === q.rowIdx;
  if (sameQuestion && prevQ.log.length < q.log.length) {
    const letzte = q.log[q.log.length - 1];
    // Drei sehr verschiedene Ausgänge hatten denselben Ton. „Wusste es nicht"
    // kostet standardmäßig nichts und darf nicht klingen wie ein Fehlgriff.
    sound(letzte.result === 'correct' ? 'correct' : letzte.result === 'pass' ? 'passt' : 'wrong');
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

/**
 * Umkehrung von openFromTile: Das Panel fährt in das Feld zurück, aus dem es
 * kam. Erst danach schaltet die Kachel ab – vorher lag sie hinter dem Scrim
 * bei 20 % Deckkraft, ihre Abschalt-Animation hat deshalb nie jemand gesehen.
 *
 * Das Board ist während der 320 ms schon wieder anklickbar: Die Klasse `zu`
 * nimmt dem Overlay die Klicks, sonst würde der Host beim schnellen Weiterspielen
 * ins Leere tippen.
 */
let schliessZeit = null;
function schliesseFrage(box, panel, altQ) {
  const tile = $(`[data-cell="${altQ.catIdx}-${altQ.rowIdx}"]`);
  const p = panel.getBoundingClientRect();
  if (!tile || !p.width) {
    box.hidden = true;
    setBuzzIndicator('aus');
    return;
  }
  const t = tile.getBoundingClientRect();
  panel.style.setProperty('--fx', `${t.left + t.width / 2 - (p.left + p.width / 2)}px`);
  panel.style.setProperty('--fy', `${t.top + t.height / 2 - (p.top + p.height / 2)}px`);
  panel.style.setProperty('--fs', (t.width / p.width).toFixed(3));
  box.classList.add('zu');
  panel.style.animation = 'panelZu 320ms var(--ease) forwards';
  setBuzzIndicator('aus');

  // Jetzt erst darf die Kachel ausgehen – sichtbar, vor freier Wand.
  tile.classList.add('picked');

  clearTimeout(schliessZeit);
  schliessZeit = setTimeout(() => {
    box.hidden = true;
    box.classList.remove('zu');
    panel.style.animation = '';
    tile.classList.remove('picked');
  }, 320);
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
          el('div', { class: 'pserie', hidden: true }, ''),
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

    // Beim freien Buzzer sitzen mehrere Tische mit dem Finger über dem Handy.
    // Auf der Leinwand war davon nichts zu sehen – dabei ist das das Rennen.
    const q = state.current;
    const buzzOffen = q?.step === 'buzz' && !q.buzzedTeamId;
    node.classList.toggle('scharf', !!buzzOffen && team.id !== q.teamId && !q.lockedOut.includes(team.id));
    node.classList.toggle('raus', !!q && q.step === 'buzz' && q.lockedOut.includes(team.id));

    // Serie: erst ab drei richtigen in Folge, sonst klebt bei zwei Teams
    // dauernd ein Abzeichen an irgendeinem Pult.
    const serie = node.querySelector('.pserie');
    serie.hidden = (team.serie || 0) < 3;
    serie.textContent = `${team.serie || 0}× in Folge`;

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

  // Überholmanöver: Zwei Zahlen tauschen die Plätze, und wenn gerade niemand
  // auf die Leiste schaut, merkt es keiner. Bewusst gedämpft – bei 48 Fragen
  // darf so eine Ansage nicht zur Gewohnheit werden:
  //  · erst ab 500 Punkten Vorsprungsniveau, darunter ist „Führung" eine
  //    einzige Frage wert und wechselt in der Anfangsphase ständig,
  //  · nur bei einem eindeutigen Wechsel, nicht bei Gleichstand,
  //  · verzögert, damit der fliegende Punktewert und der Wertungston durch sind,
  //  · ohne eigenen Ton, im selben Atemzug laufen schon zwei.
  const fuehrendJetzt = bestScore > 0 && state.teams.filter((t) => t.score === bestScore).length === 1
    ? state.teams.find((t) => t.score === bestScore)
    : null;
  if (fuehrendJetzt && fuehrend && fuehrendJetzt.id !== fuehrend && bestScore >= 500
      && state.phase === 'question') {
    const name = fuehrendJetzt.name;
    setTimeout(() => ansagen('Führungswechsel', name, 1400), 900);
  }
  if (fuehrendJetzt) fuehrend = fuehrendJetzt.id;

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
  if (!show) {
    rundeAbgepfiffen = false; // vor dem Aussteigen, sonst wird nie zurückgesetzt
    return;
  }

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
  zeigeRekorde(final, ranked);
  $('#btn-next-round').hidden = final;
  $('#btn-new-game').hidden = !final;
  if (final && !konfettiGefallen) {
    konfettiGefallen = true;
    // Der Endstand baut sich von unten auf – erst rollt die Trommel, und wenn
    // der Sieger oben ankommt, kommt die Fanfare samt Konfetti dazu.
    sound('trommel');
    const bisSieger = Math.max(0, (ranked.length - 1) * 280 + 250);
    setTimeout(() => {
      sound('fanfare');
      konfetti(ranked[0]?.color);
    }, bisSieger);
  }
  // Das Rundenende war völlig stumm – nur der Endstand bekam etwas zu hören.
  if (!final && !rundeAbgepfiffen) {
    rundeAbgepfiffen = true;
    sound('rundenende');
  }
  if (!final) konfettiGefallen = false;
}

/**
 * Drei Auszeichnungen unter dem Endstand – das, was man am nächsten Tag noch
 * erzählt. Gezeigt wird nur, was es wirklich gab: Wo nichts passiert ist,
 * steht auch keine Zeile.
 */
function zeigeRekorde(final, ranked) {
  const box = $('#rekorde');
  const r = state.rekorde;
  if (!final || !r) {
    box.hidden = true;
    return;
  }
  const name = (id) => state.teams.find((t) => t.id === id)?.name || '?';
  const zeilen = [];

  if (r.schnellsterBuzz) {
    const s = (r.schnellsterBuzz.ms / 1000).toFixed(2).replace('.', ',');
    zeilen.push(['⚡ Schnellster Buzz', `${r.schnellsterBuzz.name} – ${s} s`]);
  }
  // Die längste Serie über alle Teams; bei Gleichstand nennt sie alle.
  const best = Math.max(0, ...ranked.map((t) => t.serieBest || 0));
  if (best >= 3) {
    const wer = ranked.filter((t) => (t.serieBest || 0) === best).map((t) => t.name).join(' und ');
    zeilen.push(['🔥 Längste Serie', `${wer} – ${best}× in Folge`]);
  }
  if (r.teuersterReinfall) {
    const t = r.teuersterReinfall;
    zeilen.push(['💸 Teuerster Reinfall', `${name(t.teamId)} – ${t.delta} bei ${t.kategorie} ${t.wert}`]);
  }

  box.hidden = zeilen.length === 0;
  if (box.dataset.key === JSON.stringify(zeilen)) return;
  box.dataset.key = JSON.stringify(zeilen);
  box.innerHTML = '';
  zeilen.forEach(([titel, text], i) => {
    box.append(el('div', { class: 'rekord', style: { '--i': i } },
      el('span', { class: 'rk-titel' }, titel),
      el('span', { class: 'rk-text' }, text)));
  });
}

let konfettiGefallen = false;
let rundeAbgepfiffen = false;

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

/* Der Ton hängt am Gerät, nicht am Spiel: Der Beamer steht im Wohnzimmer, die
   Handys liegen zwischen den Leuten – wer stumm will, stellt sein eigenes stumm. */
function zeigeTonSchalter() {
  $('#btn-ton').textContent = istStumm() ? '🔇 Ton aus' : '🔊 Ton an';
}
$('#btn-ton').addEventListener('click', () => {
  setzeStumm(!istStumm());
  zeigeTonSchalter();
  if (!istStumm()) sound('pick'); // kurz hören, dass er wieder da ist
});
zeigeTonSchalter();

function openMenu() {
  fillMenu();
  zeigeTonSchalter();
  $('#menu').hidden = false;
  // Alles dahinter stilllegen, sonst wandert der Tabulator aufs Board.
  $('#view-game').inert = true;
  $('#btn-close-menu').focus();
}

function closeMenu() {
  $('#menu').hidden = true;
  $('#view-game').inert = false;
  // Fokus dorthin zurück, wo er hergekommen ist – sonst steht er nach dem
  // Schließen im Nichts und der nächste Tabulator fängt oben wieder an.
  $('#btn-menu').focus();
}

function fillMenu() {
  const list = $('#menu-teams');
  // Solange das Menü offen ist, läuft das bei jedem Broadcast – auch wenn nur
  // ein Handy aus dem Standby kommt. Ohne Schlüssel würden dabei die Knöpfe
  // unter dem Finger des Hosts ausgetauscht, während er Punkte korrigiert.
  const key = state.teams.map((t) => `${t.id}:${t.name}:${t.score}:${t.members.filter((m) => !m.online).length}`).join('|')
    + `#${state.turnIndex}`;
  if (list.dataset.key === key) return;
  list.dataset.key = key;
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
