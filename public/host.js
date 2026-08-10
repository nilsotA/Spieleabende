import {
  $, el, connect, hostAction, toast, sound, installAudioUnlock, keepScreenAwake,
  setFrageText, setzeText, istStumm, setzeStumm, anschlussStand,
  punkte, delta as vorzeichen } from '/common.js';
import { qrSvg } from '/qr.js';

let state = null;
let localSet = null;      // aktuell gewählter Satz aus einer Datei
let dateiSatz = null;     // zuletzt geladene Datei, bleibt in der Auswahl verfügbar
let lastScores = new Map();
let peek = false;         // Lösung auf dem großen Screen kurz sichtbar?
let standVorRunde = null; // Platzierung am Ende der vorletzten Runde, für den Endstand
let letzteRunde = null;   // zuletzt gesehene Rundennummer, für die Rundenansage
let fuehrend = null;      // wer zuletzt allein vorne lag, für den Führungswechsel
// Beim Absenden des Teamformulars gesetzt, beim nächsten Aufbau der Liste
// verbraucht: So scrollt nur der Host, der gerade getippt hat, und nicht jeder
// Host-Screen bei jedem Broadcast.
let gradAngelegt = false;

const act = hostAction;

installAudioUnlock();
// Der Host-Screen ist oft ein MacBook oder iPad, und während einer Frage fasst
// ihn niemand an – die Leinwand ging mitten im Spiel schwarz. Handy und
// Fernbedienung hielten sich längst wach, ausgerechnet die Bühne nicht.
keepScreenAwake();

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
  gradAngelegt = true;
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
  ['#set-feldwahl', 'feldwahl', (v) => v],
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
  // Zuerst der Satz über den Satz: Beim Auswählen ist die Frage „passt der zu
  // dieser Runde?", nicht „wie heißen die zwölf Kategorien". Seit es zwölf
  // Sätze sind, entscheidet sich das hier – und die Beschreibung stand bisher
  // nur auf der Startseite, die beim Spielen niemand offen hat.
  if (set.description) {
    $('#set-info').append(el('div', { class: 'satz-beschreibung' }, set.description));
  }
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
    // Bei mehreren Netzwerkkarten kann der Host die richtige antippen – dann ist
    // die Adresse ein echter Knopf. Bei nur einer gibt es nichts zu wählen: Sie
    // war trotzdem per Tab erreichbar und tat dort nichts, und mit `role=button`
    // ohne Tastaturbehandlung hätte auch die Auswahl auf Enter geschwiegen. Ein
    // <button> bringt beides von Haus aus mit.
    const waehlbar = info.urls.length > 1;
    for (const url of info.urls) {
      liste.append(waehlbar
        ? el('button', { class: 'url', type: 'button', onclick: () => zeigeQr(url, liste) }, ...adressTeile(url))
        : el('code', { class: 'url' }, ...adressTeile(url)));
    }
    zeigeQr(info.urls[0], liste);
    $('#remote-url').textContent = `${info.urls[0]}/remote`;
  } catch {
    /* egal */
  }
}

/**
 * Die Adresse mit einer Sollbruchstelle hinter dem „//“.
 *
 * Umbrechen darf sie notfalls überall – eine lange Hostnamen-Adresse muss
 * irgendwo hin. Ohne bevorzugte Stelle traf es aber ausgerechnet die Zahlen:
 * auf einem 1920er Schirm stand dort „http://192.0.2.2:3“ und darunter „210“.
 * Wer das abtippt, landet nirgends. Mit dem <wbr> bricht sie zuerst hinter dem
 * Schema um, und beide Hälften bleiben für sich lesbar.
 */
function adressTeile(url) {
  const i = url.indexOf('//');
  if (i < 0) return [url];
  return [url.slice(0, i + 2), el('wbr'), url.slice(i + 2)];
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
    letzterStechSieger = null;
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
  renderWiederhergestellt();
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
        el('button', {
          class: 'btn btn-sm btn-ghost',
          'aria-label': `Team „${team.name}" entfernen`,
          title: 'Team entfernen',
          onclick: () => act('removeTeam', { teamId: team.id }),
        }, '✕'),
      ),
    );
  }
  $('#set-turnmode').value = state.settings.turnMode;
  $('#set-penalty').value = state.settings.wrongPenalty;
  $('#set-buzzcorrect').value = String(state.settings.buzzAfterCorrect);
  $('#set-feldwahl').value = state.settings.feldwahl || 'team';
  $('#btn-start').disabled = state.teams.length < 2;
  renderAnschluss();
  // Das frisch angelegte Team ins Bild holen. Ab dem siebten Team reicht die
  // Karte bis unter die klebende „Spiel starten"-Leiste, und der Host sah vom
  // Team, das er gerade eingetippt hatte, nur noch einen verblassten Rest –
  // also genau in dem Moment nicht, in dem er wissen will, ob es geklappt hat.
  //
  // Gerechnet wird die Verdeckung selbst, statt `scrollIntoView` zu bitten:
  // Mit `block: 'nearest'` bricht der Browser ab, sobald das Element formal im
  // Sichtfeld liegt – und das tut es ja, es ist nur überdeckt. Der Rand aus
  // `scroll-margin-bottom` ändert daran nichts, weil es gar nicht erst zum
  // Ausrichten kommt.
  if (gradAngelegt) {
    gradAngelegt = false;
    const neu = list.lastElementChild;
    const leiste = $('.lobby-start');
    const box = $('#view-lobby');
    if (neu && leiste && box) {
      const drunter = neu.getBoundingClientRect().bottom - leiste.getBoundingClientRect().top;
      if (drunter > 0) {
        box.scrollBy({
          top: drunter + 8,
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      }
    }
  }
}

/** Zeichnet den Anschlussstand über dem Startknopf. Der Text kommt aus
    common.js, weil die Fernbedienung ihn genauso braucht. */
function renderAnschluss() {
  const zeile = $('#lobby-stand');
  if (!zeile) return;
  const { text, bereit } = anschlussStand(state);
  zeile.classList.toggle('bereit', bereit);
  setzeText(zeile, text);
}

/**
 * Frage, Lösung und Zusatz auf die Bühne herunterrechnen.
 *
 * Die mitgelieferten Sätze sind kurz gehalten, aber der Editor lädt zum
 * Selberschreiben ein – und dort tippt irgendwann jemand einen ganzen Absatz
 * als Frage. Gemessen: 393 Zeichen ergaben auf einem 900px-Screen einen Kasten
 * von 1036px, mit Lösung und Zusatz 1587px. Die Antwort stand damit weit unter
 * der Bildkante.
 *
 * Scrollen ist auf einer Leinwand keine Antwort: Was nicht draufsteht, liest
 * der Raum nicht, und niemand fasst den Beamer-Rechner mitten in der Frage an.
 * Also wird die Schrift so weit verkleinert, bis alles zwischen Bühnenrand und
 * Steuerleiste passt – in Schritten, nicht stufenlos, damit gleich lange Fragen
 * gleich groß bleiben und die Anzeige nicht bei jedem Pixel zappelt.
 *
 * Untergrenze 0,5: Darunter wäre es aus vier Metern ohnehin nicht mehr zu
 * lesen, und dann ist die Frage schlicht zu lang geschrieben.
 */
function passeFrageEin() {
  // Nach dem Zeichnen messen: Das Overlay wird im selben Durchlauf erst
  // sichtbar gemacht, und ein verstecktes Element hat keine Höhe. Der erste
  // Anlauf maß deshalb bei jeder frisch geöffneten Frage ins Leere und
  // verkleinerte gar nichts.
  requestAnimationFrame(() => {
    const overlay = document.querySelector('#question');
    const panel = overlay?.querySelector('.q-panel');
    if (!overlay || !panel || overlay.hidden) return;
    const stufen = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44];
    for (const stufe of stufen) {
      panel.style.setProperty('--frageskala', String(stufe));
      // Höhe erst nach dem Setzen lesen – das erzwingt den Umbruch. Gemessen
      // wird am Overlay: Es ist der Kasten, der sonst scrollen würde, und genau
      // das soll auf einer Leinwand nicht passieren.
      if (overlay.scrollHeight <= overlay.clientHeight + 1) break;
    }
    // Reicht auch die kleinste Stufe nicht, ist die Frage schlicht zu lang
    // geschrieben – dann entscheidet, was man sieht. Sichtbar sein muss die
    // Lösung: Die Frage hat der Host ohnehin vorgelesen.
    if (overlay.scrollHeight > overlay.clientHeight + 1) {
      const loesung = overlay.querySelector('#q-answer');
      if (loesung && !loesung.hidden) {
        loesung.scrollIntoView({ block: 'end', behavior: 'auto' });
      } else {
        overlay.scrollTop = 0;
      }
    }
  });
}

addEventListener('resize', passeFrageEin);

/**
 * Deutsche Aufzählung: „A", „A und B", „A, B und C".
 *
 * Bei einem Dreier-Gleichstand stand auf der Leinwand „A und B und C" – auf dem
 * einen Bildschirm des Abends, auf den am Ende alle schauen.
 *
 * Gedeckelt, weil ein Gleichstand über alle acht Teams möglich ist: Hat in einer
 * Runde niemand gepunktet, stehen alle bei null. Acht Namen in der Schlagzeile
 * wären keine Ansage mehr, sondern eine Liste.
 */
function aufzaehlung(namen, hoechstens = 3) {
  if (namen.length <= 1) return namen[0] || '';
  if (namen.length === 2) return `${namen[0]} und ${namen[1]}`;
  if (namen.length <= hoechstens) {
    return `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
  }
  return `${namen.slice(0, hoechstens - 1).join(', ')} und ${namen.length - (hoechstens - 1)} weitere`;
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
      katSchriftSpaeter = true;
      cat.cells.forEach((cell, rowIdx) => {
        board.append(
          el('button', {
            class: 'tile',
            'data-cell': `${catIdx}-${rowIdx}`,
            // --r ist die Zeile: Je teurer das Feld, desto größer die Ziffer.
            style: { gridColumn: catIdx + 1, gridRow: rowIdx + 2, '--i': catIdx + rowIdx, '--r': rowIdx },
            // Der Ton hängt am Zustandswechsel, nicht am Klick: Das Feld lässt
            // sich auch vom Handy des Hosts aus wählen, und dann klappte das
            // Panel auf der Leinwand stumm auf.
            onclick: () => act('pick', { catIdx, rowIdx }),
          }, el('span', {}, String(cell.value))),
        );
      });
    });
  }

  if (katSchriftSpaeter) {
    katSchriftSpaeter = false;
    // Erst nach dem Layout messen: Vorher steht die Spaltenbreite nicht fest.
    requestAnimationFrame(katSchriftAnpassen);
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

  // Das Stechen gehört zu keiner Runde – „Runde 2 / 2 · 2× Punkte" stünde
  // dort über einer Frage, für die es weder das eine noch das andere gibt.
  const imStechen = !!state.current?.stechen;
  $('#round-label').textContent = imStechen
    ? 'Stechen'
    : `Runde ${state.round} / ${state.roundCount}`;
  const mult = $('#round-mult');
  const zeigMult = data.multiplier > 1 && !imStechen;
  mult.textContent = zeigMult ? `${data.multiplier}× Punkte` : '';
  mult.hidden = !zeigMult;
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
  // Stechfragen haben kein Feld: Ohne den Zähler sähe die zweite
  // Entscheidungsfrage wie die erste aus und das Panel bliebe stehen.
  const kennung = (z, lauf) => (z.stechen ? `s${lauf}` : `${z.catIdx}-${z.rowIdx}`);
  const neu = !prev?.current
    || kennung(prev.current, prev.stechenLauf) !== kennung(q, state.stechenLauf);
  box.hidden = false;
  // Das Feld ist gewählt – egal ob auf der Leinwand angeklickt oder auf dem
  // Handy angetippt. `prev` ist nur beim allerersten Zustand leer: Ein Reload
  // des Host-Screens mitten in einer Frage baut das Panel ebenfalls neu auf,
  // und dann wäre der Ton gelogen.
  // Beim Stechen wurde kein Feld gewählt; dort übernimmt gleich das
  // aufsteigende Buzzer-Signal, und zwei Töne übereinander klängen nach Panne.
  if (neu && prev && !q.stechen) sound('pick');
  if (neu) {
    peek = false; // die Lösung nicht von der Vorfrage her offen lassen
    // Das Wackeln von einer falschen Antwort blieb sonst als Klasse hängen –
    // und weil `.q-panel.wrong` spezifischer ist als `.q-panel`, wackelte danach
    // jede weitere Frage beim Aufklappen, statt aus ihrem Feld zu wachsen.
    panel.classList.remove('wrong');
    openFromTile(panel, q);
  }

  // Beim Stechen steht kein Punktwert am Kopf – es gibt keinen.
  $('#q-head').textContent = q.stechen
    ? `Stechen · ${q.category}`
    : `${q.category} ${q.value}`;
  $('#q-head').classList.toggle('stechen', !!q.stechen);
  panel.classList.toggle('stechpanel', !!q.stechen);
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
  // Ist die Frage durch, muss niemand mehr antworten. Das Schild fiel dann auf
  // das Zugteam zurück – mit Stern, direkt neben der Zeile „Familie Ott: wusste
  // es nicht", während ein anderer Tisch gerade 150 Punkte kassiert hatte. Wer
  // die Frage geholt hat, steht ohnehin im Protokoll darunter.
  if (q.step === 'result') $('#turn-pill').hidden = true;

  if (q.step === 'primary') {
    status.append(el('div', { class: 'chip turn' }, `Am Zug: ${teamName(q.teamId)}`));
    setBuzzIndicator('idle');
  } else if (q.step === 'buzz' && !q.buzzedTeamId) {
    const dabei = state.teams.filter((t) => !q.lockedOut.includes(t.id));
    status.append(el('div', { class: 'chip buzzopen' }, q.stechen
      // Beim Stechen zählt nicht der Punktwert, sondern wer noch im Rennen ist.
      ? `⚡ Wer zuerst drückt: ${aufzaehlung(dabei.map((t) => t.name))}`
      : `⚡ Buzzer frei · ${q.halfValue} Punkte`));
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
    // „Weiß nicht" kostet dasselbe wie eine falsche Antwort. Der Abzug gehört
    // deshalb auch dahinter – sonst sieht der Tisch die Punkte wandern und
    // findet im Protokoll keinen Grund dafür.
    const label =
      entry.result === 'pass' ? (entry.delta ? `wusste es nicht ${punkte(entry.delta)}` : 'wusste es nicht')
        : entry.result === 'correct' ? `richtig +${entry.delta}`
          : entry.delta ? `falsch ${punkte(entry.delta)}` : 'falsch';
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
  // Stechfragen haben kein Feld – dort trennt sie der Zähler voneinander.
  const sameQuestion = prevQ && prev.round === state.round
    && prevQ.catIdx === q.catIdx && prevQ.rowIdx === q.rowIdx
    && !!prevQ.stechen === !!q.stechen && prev.stechenLauf === state.stechenLauf;
  if (sameQuestion && prevQ.log.length < q.log.length) {
    const letzte = q.log[q.log.length - 1];
    // Drei sehr verschiedene Ausgänge hatten denselben Ton. „Wusste es nicht"
    // klingt nach Achselzucken statt nach Fehlgriff – aber nur, solange es
    // nichts kostet. Ist ein Abzug eingestellt, ist es ein Fehlgriff, und dann
    // soll es auch so klingen.
    const wehgetan = letzte.delta < 0;
    sound(letzte.result === 'correct' ? 'correct'
      : letzte.result === 'pass' && !wehgetan ? 'passt' : 'wrong');
    if (wehgetan) {
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
  // Die Stechfrage ist der Sonderfall: Sie kommt neu auf den Schirm und der
  // Buzzer ist im selben Moment frei. Ohne diesen Zweig hörte man dort nur das
  // Blip einer gewählten Kachel – ausgerechnet beim Signal zum Losdrücken.
  // `prev` fehlt nur beim allerersten Zustand – ein Reload mitten im Stechen
  // soll das Signal nicht noch einmal geben.
  const stechenGeradeAuf = !!prev && !sameQuestion && q.stechen && buzzerJetztFrei;
  if ((sameQuestion && buzzerJetztFrei && !buzzerVorherFrei) || stechenGeradeAuf) {
    setTimeout(() => sound('armed'), 180);
  }

  // Zum Schluss auf die Bühne herunterrechnen – auch beim Auflösen, weil Lösung
  // und Zusatz erst dann dazukommen und den Kasten weiter wachsen lassen.
  passeFrageEin();
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
  // Wie weit liegt das Feld auseinander? Früher hing „führt" an `bestScore > 0`
  // – gemeint war „es hat noch niemand gepunktet, da führt auch keiner". Seit
  // der halbe Abzug voreingestellt ist, steht nach der ersten Runde aber
  // regelmäßig der ganze Tisch im Minus, und dann verschwand die Markierung,
  // obwohl mit −300 gegen −1500 sehr wohl jemand vorne liegt. Die Spanne sagt
  // dasselbe, ohne aufs Vorzeichen hereinzufallen: Zu Beginn stehen alle auf 0,
  // die Spanne ist 0, und niemand leuchtet.
  const spanne = bestScore - Math.min(...state.teams.map((t) => t.score));
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
    else scoreNode.textContent = punkte(team.score);
    scoreNode.classList.toggle('neg', team.score < 0);
    node.classList.toggle('active', team.id === activeId);
    node.classList.toggle('buzzed', state.current?.buzzedTeamId === team.id && state.current?.step === 'buzz');
    // Wer führt, war an den Pulten nicht zu erkennen – alle Punktepillen sahen
    // gleich aus, ob 0 oder 3950. Bei Gleichstand leuchten eben mehrere.
    // Nach einem Stechen leuchtet nur noch der, der es geholt hat – die
    // Punkte stehen ja gleich, entschieden ist es trotzdem.
    node.classList.toggle('leader', state.stechenSieger
      ? team.id === state.stechenSieger
      : state.teams.length > 1 && spanne > 0 && team.score === bestScore);

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
  //  · erst wenn das Feld 500 Punkte auseinanderliegt, darunter ist „Führung"
  //    eine einzige Frage wert und wechselt in der Anfangsphase ständig,
  //  · nur bei einem eindeutigen Wechsel, nicht bei Gleichstand,
  //  · verzögert, damit der fliegende Punktewert und der Wertungston durch sind,
  //  · ohne eigenen Ton, im selben Atemzug laufen schon zwei.
  const fuehrendJetzt = spanne > 0 && state.teams.filter((t) => t.score === bestScore).length === 1
    ? state.teams.find((t) => t.score === bestScore)
    : null;
  // Auch die Schwelle geht über die Spanne statt über den Höchststand: Ein Feld,
  // das 500 Punkte auseinanderliegt, hat seine Anfangsphase hinter sich – egal,
  // ob das oben oder unten von der Null passiert.
  if (fuehrendJetzt && fuehrend && fuehrendJetzt.id !== fuehrend && spanne >= 500
      && state.phase === 'question') {
    const name = fuehrendJetzt.name;
    setTimeout(() => ansagen('Führungswechsel', name, 1400), 900);
  }
  if (fuehrendJetzt) fuehrend = fuehrendJetzt.id;

  // Der Scheinwerfer liegt auf der Leiste und wandert zum Pult, das dran ist.
  // Am Pult selbst könnte er nicht hängen: Dessen clip-path (das Trapez)
  // schneidet auch die eigenen Pseudo-Elemente ab.
  // Am Ende gehört der Scheinwerfer dem Sieger – vorher dem, der reden muss.
  pruefeEnge(box);

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
 * Nebeneinander oder übereinander?
 *
 * Am Pult stehen Name und Punktzahl normalerweise nebeneinander – aus vier
 * Metern liest man dann beides in einem Blick. Bei acht Pulten auf einem
 * 1280er Beamer bleiben davon rund 140 Pixel pro Pult, und die Punktepille
 * nimmt sich zuerst, was sie braucht: gemessen blieben dem Namen 78 Pixel,
 * aus „Die Grübelmeister" wurde „DIE GRÜ…". Alle acht Namen waren so
 * verstümmelt, dass man die Teams nicht mehr auseinanderhalten konnte.
 *
 * Nur die Schrift zu verkleinern hilft nicht – dann sind beide unlesbar. Wird
 * es zu eng, stellt sich das Pult deshalb auf: Name oben über die volle
 * Breite, Punktzahl darunter, beide in voller Größe. Das kostet gut zwanzig
 * Pixel Höhe und gibt dem Namen die dreifache Breite.
 *
 * Entschieden wird nach der gemessenen Breite, nicht nach der Teamzahl: Sechs
 * Pulte auf 1920px haben reichlich Platz, sechs auf 1280px nicht.
 *
 * Gerechnet wird mit dem größten Punktestand, der kommen kann, nicht mit dem
 * aktuellen. Sonst stünde die Leiste den halben Abend nebeneinander und
 * klappte mitten im Spiel um, sobald jemand vierstellig wird – ausgerechnet
 * im Moment, in dem alle auf die Zahl schauen.
 */
function pruefeEnge(box) {
  const n = box.children.length;
  if (!n) return;
  const stil = getComputedStyle(box);
  const innen = box.clientWidth - parseFloat(stil.paddingLeft) - parseFloat(stil.paddingRight);
  const proPult = (innen - parseFloat(stil.columnGap || 0) * (n - 1)) / n;

  // Was ein Pult nebeneinander mindestens braucht. Beide Schriftgrade hängen an
  // der Fensterbreite, deshalb werden sie aus den angemeldeten Eigenschaften
  // abgelesen statt geschätzt – und zwar an der Wurzel, nicht am Pult: Im
  // gestapelten Pult steht ein kleinerer Grad, mit dem die Leiste sich selbst
  // zurückschalten und dann endlos flackern würde.
  // Ohne @property (Safari vor 16.4) liefert getComputedStyle das unausgerechnete
  // clamp() als Text zurück – parseFloat macht daraus NaN, und jeder Vergleich
  // damit ist falsch. Dann lieber am Pult selbst messen: Der Wert stimmt im
  // nebeneinanderstehenden Zustand, und aus dem heraus wird ja entschieden.
  const wurzel = getComputedStyle(document.documentElement);
  const proPultZahl = parseFloat(getComputedStyle(box.querySelector('.pscore')).fontSize);
  const proPultName = parseFloat(getComputedStyle(box.querySelector('.pname')).fontSize);
  const zahlGrad = parseFloat(wurzel.getPropertyValue('--pult-zahl')) || proPultZahl;
  const nameGrad = parseFloat(wurzel.getPropertyValue('--pult-name')) || proPultName;
  if (!zahlGrad || !nameGrad) return;

  // Vierzehn Zeichen des Teamnamens sollen stehen bleiben. Die Zahl ist nicht
  // gegriffen: „Die Grübelmeister", „Die Unbestechlichen" und „Die Nachzügler"
  // gehen erst ab dem fünften Zeichen auseinander, und wer sich einen Namen
  // ausdenkt, stellt gern etwas Gemeinsames voran. Bei elf Zeichen – der alten
  // Annahme – standen an allen drei Pulten „DIE …" und sonst nichts.
  // Großbuchstabe in Halbfett plus Sperrung misst 0,67 em, eine tabellarische
  // Ziffer der Pille 0,62 em, und der größte Punktestand („-1000") sind fünf.
  const noetig = 14 * 0.67 * nameGrad + 11 /* Spalte */ + 27 /* Pillenpolster */
    + 32 /* Pultpolster */ + 5 * 0.62 * zahlGrad;
  box.classList.toggle('eng', proPult < noetig);
}

// Beim Ziehen des Fensters ändert sich die Breite, ohne dass ein neuer
// Spielstand kommt – sonst bliebe die Leiste bis zum nächsten Zug falsch.
addEventListener('resize', () => {
  const box = $('#players');
  if (box) pruefeEnge(box);
  katSchriftAnpassen();
});

/**
 * Lange Kategorienamen so weit herunterrechnen, dass kein Wort zerschnitten wird.
 *
 * Auf dem Schild stand „NACHBARLÄNDE / R" und „FORTGESCHRITT / ENE": Passt ein
 * einzelnes Wort nicht in die Spalte, bricht der Browser es irgendwo – der
 * saubere Trennstrich käme aus `hyphens: auto`, und dafür braucht er ein
 * Silbenwörterbuch für Deutsch, das längst nicht überall installiert ist.
 *
 * Statt darauf zu hoffen, misst der Screen das längste Wort und nimmt die
 * Schrift so weit zurück, bis es in eine Zeile passt. Nur so weit wie nötig,
 * und nie unter 12 px – darunter ist auf der Leinwand ohnehin nichts mehr zu
 * lesen, dann bleibt der Umbruch als kleineres Übel.
 */
let katSchriftSpaeter = false;
function katSchriftAnpassen() {
  for (const node of document.querySelectorAll('#board .cat')) {
    const ziel = node.querySelector('span') || node;
    ziel.style.fontSize = '';
    const wort = ziel.textContent.trim().split(/\s+/)
      .reduce((a, b) => (b.length > a.length ? b : a), '');
    if (wort.length < 8) continue;
    const stil = getComputedStyle(node);
    const platz = node.clientWidth
      - parseFloat(stil.paddingLeft) - parseFloat(stil.paddingRight);
    if (!(platz > 0)) continue;
    const probe = document.createElement('span');
    probe.textContent = wort;
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:0;top:0';
    ziel.appendChild(probe);
    // Buchstabenabstand und Schriftgröße wachsen beide mit em, die Breite
    // skaliert also fast linear – aber eben nur fast: Schriftrasterung rundet,
    // und „FORTGESCHRITTENE" landete nach einem Schritt auf 192 px bei 189 px
    // Platz. Deshalb nachfassen, bis es passt. Zwei Pixel Luft, damit nicht
    // genau auf der Kante gelandet wird.
    for (let versuch = 0; versuch < 4; versuch++) {
      const breit = probe.getBoundingClientRect().width;
      if (breit <= platz) break;
      const jetzt = parseFloat(getComputedStyle(ziel).fontSize);
      const neu = Math.max(12, Math.floor(jetzt * ((platz - 2) / breit) * 100) / 100);
      if (neu >= jetzt) break; // unter 12 px wird nicht weiter geschrumpft
      ziel.style.fontSize = `${neu}px`;
    }
    probe.remove();
  }
}

/**
 * Die Punktzahl steigt groß auf – aber über dem Pult des Teams, das sie bekommt,
 * nicht mitten über der Bühne: dort verdeckte sie den Fragetext, und man sah
 * ausserdem nicht, wem sie gehört.
 */
function hitmark(delta, karte) {
  const mark = el('div', { class: `hitmark ${delta > 0 ? '' : 'minus'}` }, vorzeichen(delta));
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
    node.textContent = punkte(Math.round(von + (bis - von) * ease));
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
  const stechSieger = state.stechenSieger || null;
  // Beim ersten Endstand fiel das Konfetti auf ein Unentschieden. Jetzt hat der
  // Abend wirklich einen Sieger – dafür darf die Fanfare noch einmal kommen.
  if (stechSieger && stechSieger !== letzterStechSieger) {
    letzterStechSieger = stechSieger;
    konfettiGefallen = false;
  }
  const ranked = [...state.teams].sort((a, b) => b.score - a.score
    // Wie beim Server: Wer das Stechen geholt hat, steht vor den Punktgleichen.
    || (a.id === stechSieger ? -1 : 0) || (b.id === stechSieger ? 1 : 0));

  // Sieg heißt mehr Punkte als alle anderen – bei Gleichstand gibt es keinen,
  // solange ihn nicht ein Stechen entschieden hat.
  const punktGleich = ranked.length > 1 && ranked[1].score === ranked[0].score;
  const geteilt = punktGleich && !stechSieger;
  const sieger = $('#score-winner');
  sieger.hidden = false;
  if (final && stechSieger) {
    // Der Abend ist entschieden, obwohl die Zahlen gleich stehen – das muss die
    // Zeile sagen, sonst liest sich die Tafel wie ein Widerspruch.
    sieger.textContent = `Sieg im Stechen: ${state.teams.find((t) => t.id === stechSieger)?.name || '?'}`;
  } else if (final) {
    // „Die Grübelmeister gewinnt!" – die meisten Teamnamen sind Plural, und ob
    // einer es ist, weiß man einem frei getippten Namen nicht an. Statt zu
    // raten eine Form, die für jeden Namen stimmt: „Sieg für …" braucht kein
    // Verb, das sich nach der Zahl richtet.
    sieger.textContent = geteilt
      ? `Unentschieden – ${aufzaehlung(ranked.filter((t) => t.score === ranked[0].score).map((t) => t.name))}`
      : `Sieg für ${ranked[0].name}!`;
  } else {
    // Halbzeit hatte bisher keine Überschrift – nur eine Liste und einen Knopf.
    // Dabei ist das der Moment, in dem der Raum Luft holt und darüber redet,
    // wer vorn liegt. Der Bildschirm darf das aussprechen.
    sieger.textContent = geteilt
      ? `Kopf an Kopf – ${aufzaehlung(ranked.filter((t) => t.score === ranked[0].score).map((t) => t.name))}`
      : `Zur Halbzeit vorn: ${ranked[0].name}`;
  }
  // Die Schlagzeile des Endstands ist die größte Schrift des Abends. Zur
  // Halbzeit ist es eine Zwischenmeldung und keine Krönung – deshalb eine
  // Nummer kleiner, in derselben Form wie ein geteilter Sieg.
  sieger.classList.toggle('geteilt', geteilt || !final);

  // Was auf dem Brett der nächsten Runde noch liegt. Ohne diese Zeile liest
  // sich ein Rückstand von 3300 wie ein verlorener Abend – dabei zählt Runde 2
  // doppelt, und meistens ist noch alles offen. Gerechnet, nicht behauptet.
  const halbzeit = $('#halbzeit-hinweis');
  if (halbzeit) {
    halbzeit.hidden = final;
    if (!final) {
      const jetzigeSumme = (state.board?.categories || [])
        .reduce((n, c) => n + c.cells.reduce((m, z) => m + z.value, 0), 0);
      const jetzigerMult = state.board?.multiplier || 1;
      const naechsterMult = state.round + 1 <= 1 ? 1 : 2;
      const naechsteSumme = Math.round(jetzigeSumme * (naechsterMult / jetzigerMult));
      const rueckstand = ranked.length > 1 ? ranked[0].score - ranked[ranked.length - 1].score : 0;
      const zahl = (n) => n.toLocaleString('de-DE');
      setzeText(halbzeit, naechsteSumme
        ? `In Runde ${state.round + 1} liegen ${zahl(naechsteSumme)} Punkte auf dem Brett`
          + `${rueckstand > 0 && rueckstand < naechsteSumme ? ` – der Rückstand von ${zahl(rueckstand)} ist aufholbar.` : '.'}`
        : '');
    }
  }

  // Geteilte Plätze: Bei gleichem Punktestand steht dieselbe Zahl davor, und
  // der nächste Platz überspringt entsprechend (1, 1, 3). Vorher zählte die
  // Liste stur die Position durch – bei Gleichstand widersprach der Bildschirm
  // sich selbst: Die Ansage sagte „Unentschieden", die Liste kürte einen davon
  // mit Krone zum Ersten und setzte den anderen auf Platz 2. Die Pulte unten
  // hatten es die ganze Zeit richtig, dort leuchteten beide.
  const raenge = ranked.map((t, i) => i);
  for (let i = 1; i < ranked.length; i++) {
    // Nach einem Stechen teilt der Sieger den ersten Platz mit niemandem mehr –
    // dafür war es ja da. Die Punktgleichen darunter rücken auf Platz 2.
    const zusammen = ranked[i].score === ranked[i - 1].score
      && !(stechSieger && raenge[i - 1] === 0);
    raenge[i] = zusammen ? raenge[i - 1] : i;
  }
  const platz = (i) => raenge[i] + 1;

  const key = ranked.map((t) => `${t.id}:${t.score}`).join('|') + `#${state.phase}#${stechSieger || ''}`;
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
      const sprung = vorher ? vorher.rang - raenge[i] : 0;
      list.append(
        el('li', { class: raenge[i] === 0 ? 'first' : '', style: { '--i': stufe, '--team': team.color } },
          el('span', { class: 'rank' }, `${platz(i)}`),
          el('span', { class: 'sname' }, team.name),
          // Nur wer sich bewegt hat, bekommt einen Pfeil. Vier Punkte für „nichts
          // passiert" wären bloß Rauschen in der wichtigsten Tabelle des Abends.
          sprung !== 0
            ? el('span', { class: `sprung ${sprung > 0 ? 'hoch' : 'runter'}` },
              sprung > 0 ? `▲ ${sprung}` : `▼ ${-sprung}`)
            : null,
          el('span', { class: 'pts' }, punkte(team.score)),
        ),
      );
    });
  }

  // Der Stand am Ende der vorletzten Runde ist die Vergleichsmarke. Der Server
  // kennt ihn nicht – der Host-Screen merkt ihn sich einfach beim Durchlaufen.
  if (!final) {
    standVorRunde = new Map(ranked.map((t, i) => [t.id, { score: t.score, rang: raenge[i] }]));
  }
  zeigeRekorde(final, ranked);
  $('#btn-next-round').hidden = final;
  $('#btn-new-game').hidden = !final;
  // Ein Abend, der mit „Unentschieden" endet, endet nicht wirklich. Der Knopf
  // steht nur da, wenn er gebraucht wird: am Ende, bei Gleichstand an der
  // Spitze, und solange das Stechen nicht schon entschieden ist.
  const stechKnopf = $('#btn-stechen');
  if (stechKnopf) stechKnopf.hidden = !(final && geteilt);
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

  /** „A und B" – ab drei wird gezählt, sonst sprengt eine Zeile das Panel. */
  const nenne = (teams) => {
    const n = teams.map((t) => t.name);
    if (n.length <= 2) return n.join(' und ');
    return `${n[0]}, ${n[1]} und ${n.length - 2} weitere`;
  };


  if (r.schnellsterBuzz) {
    const s = (r.schnellsterBuzz.ms / 1000).toFixed(2).replace('.', ',');
    zeilen.push(['⚡ Schnellster Buzz', `${r.schnellsterBuzz.name} – ${s} s`]);
  }
  // Die längste Serie über alle Teams; bei Gleichstand nennt sie alle.
  const best = Math.max(0, ...ranked.map((t) => t.serieBest || 0));
  if (best >= 3) {
    zeilen.push(['🔥 Längste Serie',
      `${nenne(ranked.filter((t) => (t.serieBest || 0) === best))} – ${best}× in Folge`]);
  }
  if (r.teuersterReinfall) {
    const t = r.teuersterReinfall;
    zeilen.push(['💸 Teuerster Reinfall', `${name(t.teamId)} – ${punkte(t.delta)} bei ${t.kategorie} ${t.wert}`]);
  }

  /* Die drei oben brauchen alle einen Sonderfall: einen echten Handy-Buzz, drei
     richtige in Folge oder einen Abzug. Bei acht Teams tritt keiner davon
     zuverlässig ein – dann stand am Ende des Abends gar nichts da, ausgerechnet
     bei der größten Runde. Die folgenden rechnen aus der Bilanz, die jedes Team
     ohnehin führt, und finden fast immer jemanden. */

  const bilanz = (t) => t.bilanz || {};
  const zahl = (x) => Number(x) || 0;

  /** Bestenauslese mit geteiltem Platz – „und" statt eines willkürlichen Ersten. */
  const spitze = (teams, wert, mindestens) => {
    const infrage = teams.filter((t) => wert(t) >= mindestens);
    if (!infrage.length) return null;
    const best = Math.max(...infrage.map(wert));
    if (best < mindestens) return null;
    return { best, wer: infrage.filter((t) => wert(t) === best) };
  };

  // Wer sich die meisten Punkte am fremden Feld geholt hat. Genau die Zahl, mit
  // der am Tisch geprahlt wird – und sie hat nichts damit zu tun, wer gewinnt.
  const dieb = spitze(ranked, (t) => zahl(bilanz(t).geklautPunkte), 1);
  if (dieb) {
    zeilen.push(['🥷 Bester Dieb', `${nenne(dieb.wer)} – ${dieb.best} Punkte per Buzzer`]);
  }

  // Trefferquote statt Trefferzahl: Wer selten, aber sicher antwortet, taucht
  // sonst nirgends auf. Mindestens fünf Antworten, sonst gewinnt ein Zufall.
  const quote = (t) => {
    const b = bilanz(t);
    const versuche = zahl(b.richtig) + zahl(b.falsch);
    return versuche >= 5 ? zahl(b.richtig) / versuche : 0;
  };
  const bank = spitze(ranked, quote, 0.5);
  if (bank) {
    const prozent = Math.round(bank.best * 100);
    zeilen.push(['🎯 Sicherste Bank', `${nenne(bank.wer)} – ${prozent} % richtig`]);
  }

  // Ab zwei Mal, damit ein einzelnes „weiß nicht" niemanden zum Titelträger macht.
  const ehrlich = spitze(ranked, (t) => zahl(bilanz(t).gepasst), 2);
  if (ehrlich) {
    zeilen.push(['🤷 Ehrlichste Haut', `${nenne(ehrlich.wer)} – ${ehrlich.best}× „weiß nicht"`]);
  }

  // Bei vielen Teams frisst die Rangliste den Platz. Vier Auszeichnungen sind
  // dann genug – gekürzt wird am Ende, wo die am wenigsten überraschenden
  // stehen. Vorne bleibt, was der Abend Besonderes hergab.
  const voll = ranked.length + zeilen.length >= 11;
  if (voll) zeilen.length = Math.min(zeilen.length, 4);

  box.hidden = zeilen.length === 0;
  // Acht Teams und fünf Auszeichnungen passen nicht mehr locker untereinander –
  // dann rücken Zeilen und Auszeichnungen zusammen. Die Schwelle liegt beim
  // gemessenen Fall: darunter bleibt das Panel großzügig.
  document.querySelector('.scores-panel').classList.toggle('voll', voll);
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
let letzterStechSieger = null;

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

/**
 * Der Knopf zum Zurücknehmen.
 *
 * Bewusst außerhalb der Aktionsleiste: Die baut sich bei jedem Phasenwechsel
 * neu auf, und ein Knopf, der genau dort auftaucht, wo eben noch „Richtig“
 * stand, fängt sich den nachtippenden Daumen ein. Aus demselben Grund ist er
 * nach dem Erscheinen kurz taub – wer bewusst hinlangt, merkt davon nichts.
 */
let undoSeitWann = 0;
let undoWas = null;

function renderUndo() {
  const knopf = $('#btn-undo');
  const was = state.rueckgaengig;
  knopf.hidden = !was;
  // Neu scharf bei jeder neuen zurücknehmbaren Aktion, nicht nur beim ersten
  // Auftauchen: Nach der Feldwahl steht der Knopf schon da, und die Wertung
  // danach wechselt nur seine Beschriftung. Wäre nur das Erscheinen der
  // Auslöser, wäre er den ganzen Abend über scharf – gesperrt genau einmal,
  // beim allerersten Zug.
  if (was !== undoWas) {
    undoWas = was;
    undoSeitWann = performance.now();
  }
  if (!was) return;
  knopf.title = `${was} zurücknehmen`;
  knopf.setAttribute('aria-label', `${was} zurücknehmen`);
}

$('#btn-undo').addEventListener('click', () => {
  if (performance.now() - undoSeitWann < 400) return;
  act('undo');
});

function renderControls() {
  renderUndo();
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
    // Ob ein Team ein Handy am Netz hat, entscheidet über seinen Vertreterknopf –
    // ohne das im Schlüssel bliebe die Leiste stehen, wenn jemand mitten in der
    // Frage aufwacht oder wegfällt.
    state.teams.map((t) => `${t.id}:${t.name}:${t.members.some((m) => m.online !== false) ? 1 : 0}`).join('|'),
    // Nach dem Stechen steht ein anderer Knopf da als davor.
    state.stechenSieger,
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
    // Steht die Feldwahl auf „nur Host", wäre „oder auf dem Handy antippen" eine
    // Zusage, die das Handy gleich zurücknimmt.
    setzeText(hint, state.settings.feldwahl === 'host'
      ? `Am Zug: ${teamName(state.teams[state.turnIndex]?.id)} – sie sagen an, du klickst das Feld.`
      : `Am Zug: ${teamName(state.teams[state.turnIndex]?.id)} – Feld anklicken oder auf dem Handy antippen.`);
    add(button('Zug überspringen', 'btn-ghost btn-sm', () => {
      const next = state.teams[(state.turnIndex + 1) % state.teams.length];
      act('setTurn', { teamId: next.id });
    }));
    return;
  }

  if (state.phase === 'roundEnd' || state.phase === 'gameOver') {
    const spitze = state.teams.filter((t) => t.score === Math.max(...state.teams.map((x) => x.score)));
    setzeText(hint, state.phase !== 'gameOver'
      ? 'Bereit für die nächste Runde?'
      : state.stechenSieger
        ? 'Spiel beendet – im Stechen entschieden.'
        : spitze.length > 1
          // Der Knopf steht mitten auf der Leinwand; hier steht, wofür er gut ist.
          ? 'Gleichstand – „Stechen" holt die Entscheidungsfrage.'
          : 'Spiel beendet.');
    return;
  }

  if (!q) { setzeText(hint, ''); return; }

  if (q.step === 'primary') {
    // Steht ein Abzug im Raum, gehört er in die Zeile: „Weiß nicht" kostet
    // dasselbe wie eine falsche Antwort, und beim Drücken will man wissen,
    // wie viel das gerade ist.
    const abzug = { half: q.halfValue, full: q.value }[state.settings.wrongPenalty] || 0;
    setzeText(hint, abzug
      ? `${teamName(q.teamId)} antwortet. Falsch oder „weiß nicht" kostet ${abzug}.`
      : `${teamName(q.teamId)} antwortet.`);
    add(
      button('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), '1'),
      button('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), '2'),
      button('Weiß nicht → Buzzer frei', 'btn-ghost', () => act('pass'), '3'),
    );
  } else if (q.step === 'buzz' && !q.buzzedTeamId) {
    setzeText(hint, q.stechen ? 'Stechen läuft – wer zuerst drückt, antwortet.' : 'Buzzer ist frei.');
    // Vertreterknöpfe für alle, die keinen eigenen Buzzer in der Hand haben.
    // Wer ein Handy am Netz hat, drückt selbst – und mit acht Teams standen hier
    // sonst sieben Knöpfe voller Teamnamen, die die Leiste auf vier Reihen
    // aufgeblasen und der Bühne über 70px geklaut haben.
    const vertreten = state.teams.filter((team) => team.id !== q.teamId
      && !q.lockedOut.includes(team.id)
      && !team.members.some((m) => m.online !== false));
    const aufschriften = knopfAufschriften(vertreten);
    vertreten.forEach((team, i) => add(buzzKnopf(team, aufschriften[i])));
    add(button(q.stechen ? 'Keiner weiß es → nächste Frage' : 'Keiner weiß es → auflösen',
      'btn-primary', () => act('endQuestion'), '4'));
  } else if (q.buzzedTeamId && q.step === 'buzz') {
    // Im Stechen gibt es keine Punkte zu gewinnen, sondern den Abend.
    setzeText(hint, q.stechen
      ? `${teamName(q.buzzedTeamId)} hat gebuzzert – richtig gewinnt, falsch ist raus.`
      : `${teamName(q.buzzedTeamId)} hat gebuzzert (±${q.halfValue}).`);
    add(
      button('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), '1'),
      button('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), '2'),
      button('Buzz zurücknehmen', 'btn-ghost btn-sm', () => act('resetBuzz')),
    );
  } else if (q.stechen) {
    // Nach der Stechfrage geht es zurück in den Endstand – mit Sieger oder für
    // die nächste Frage. Der Knopf sagt, was von beidem gleich passiert.
    setzeText(hint, state.stechenSieger
      ? `${teamName(state.stechenSieger)} gewinnt den Abend.`
      : 'Das wusste keiner – zurück zum Endstand.');
    add(button(state.stechenSieger ? 'Zum Endstand' : 'Weiter', 'btn-primary', () => act('close'), 'Leertaste'));
  } else {
    setzeText(hint, 'Frage beendet.');
    add(button('Weiter', 'btn-primary', () => act('close'), 'Leertaste'));
  }
}

function button(label, cls, onclick, key) {
  const node = el('button', { class: `btn ${cls}`, onclick }, label);
  if (key) node.append(el('kbd', {}, key));
  return node;
}

/**
 * Der Knopf, mit dem der Host für ein Team ohne Handy buzzert.
 *
 * Er zeigt die Teamfarbe und einen Kurznamen statt „Buzz: Die Unbestechlichen".
 * Die Farbe steht auch am Pult, das ist aus zwei Metern der schnellere Weg zum
 * richtigen Knopf als ein langer Name – und acht davon passen in eine Reihe.
 * Der volle Name bleibt als Titel dran, für den Fall, dass zwei Teams sich
 * ähnlich nennen.
 */
function buzzKnopf(team, aufschrift) {
  const node = el('button', {
    class: 'btn btn-ghost btn-sm buzz-fuer',
    title: `Buzz für ${team.name}`,
    'aria-label': `Buzz für ${team.name}`,
    onclick: () => act('buzzFor', { teamId: team.id }),
  },
    el('span', { class: 'dot', style: { background: team.color } }),
    aufschrift,
  );
  return node;
}

/** „Die Grübelmeister" → „Grübelmeister", „Team Donnerbalken" → „Donnerbalken". */
function kurzTeam(name) {
  const ohneArtikel = String(name).replace(/^(die|der|das|team)\s+/i, '');
  const wort = ohneArtikel.split(/\s+/)[0] || name;
  return wort.length > 13 ? `${wort.slice(0, 12)}…` : wort;
}

/**
 * Aufschriften für eine Reihe Vertreterknöpfe – so kurz wie möglich, aber
 * unterscheidbar.
 *
 * „Solo Sarah" und „Solo Timo" wurden beide zu „Solo": zwei gleich beschriftete
 * Knöpfe nebeneinander, an denen nur der Farbpunkt hing. Kollidiert das erste
 * Wort, steht bei den Betroffenen der ganze Name.
 */
function knopfAufschriften(teams) {
  const kurz = teams.map((t) => kurzTeam(t.name));
  const wieOft = new Map();
  for (const k of kurz) wieOft.set(k, (wieOft.get(k) || 0) + 1);
  return teams.map((t, i) => {
    if (wieOft.get(kurz[i]) === 1) return kurz[i];
    const voll = String(t.name);
    return voll.length > 16 ? `${voll.slice(0, 15)}…` : voll;
  });
}

$('#btn-next-round').addEventListener('click', () => act('nextRound'));
$('#btn-stechen').addEventListener('click', () => act('stechen'));
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
  // Oben anfangen. Bei acht Teams ist die Karte länger als der Bildschirm, und
  // „Schließen" steht ganz unten – ein schlichtes focus() hätte den Knopf ins
  // Bild gescrollt und das Menü damit am Ende aufgemacht: Der Host sieht als
  // Erstes „Spiel beenden" statt der Teamliste, wegen der er es geöffnet hat.
  $('.menu-card').scrollTop = 0;
  $('#btn-close-menu').focus({ preventScroll: true });
  menuRandPruefen();
}

function closeMenu() {
  $('#menu').hidden = true;
  $('#view-game').inert = false;
  // Fokus dorthin zurück, wo er hergekommen ist – sonst steht er nach dem
  // Schließen im Nichts und der nächste Tabulator fängt oben wieder an.
  $('#btn-menu').focus();
}

function fillMenu() {
  fuelleSpickzettel();
  menuRandPruefen();
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
        el('span', { class: 'sc' }, punkte(team.score)),
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

/**
 * Blendet die Unterkante des Menüs aus, solange darunter noch etwas steht.
 * Erst nach dem Zeichnen messen – vorher kennt der Browser die neue Höhe nicht.
 */
function menuRandPruefen() {
  const karte = document.querySelector('.menu-card');
  if (!karte) return;
  requestAnimationFrame(() => {
    karte.classList.toggle('mehr', karte.scrollHeight - karte.clientHeight - karte.scrollTop > 4);
  });
}
document.querySelector('.menu-card')?.addEventListener('scroll', menuRandPruefen, { passive: true });
addEventListener('resize', menuRandPruefen);

/**
 * Der Spickzettel im Menü.
 *
 * Die Punkteregeln standen nur in der Lobby. Mitten im Abend musste der Host
 * sie aus dem Kopf erklären – und bei acht Leuten fragt garantiert jemand nach,
 * meistens genau dann, wenn gerade jemand gebuzzert hat.
 *
 * Gebaut wird er aus dem Zustand, nicht aus festem Text: Abzug, Zugfolge und
 * „Buzzern nach richtiger Antwort" sind einstellbar. Ein starrer Zettel wäre
 * für jede Runde falsch, in der jemand etwas anderes gewählt hat – und ein
 * falscher Spickzettel ist schlimmer als keiner.
 *
 * Wenn eine Frage offensteht, stehen ihre echten Zahlen oben: Zur Diskussion
 * kommt es immer bei der konkreten Frage, nicht bei der Regel im Allgemeinen.
 */
function fuelleSpickzettel() {
  const s = state.settings || {};
  const q = state.current;
  const zeilen = [];

  if (q?.stechen) {
    zeilen.push(['Stechen', 'richtig gewinnt den Abend, falsch ist raus – keine Punkte', true]);
  } else if (q) {
    zeilen.push(['Diese Frage', `${q.category} ${q.value} · gebuzzert ${q.halfValue}`, true]);
  }
  zeilen.push(['Zugteam richtig', 'volle Punkte']);
  // „Weiß nicht" zählt wie eine falsche Antwort – deshalb eine Zeile für beides
  // statt zwei, die man nebeneinanderhalten muss.
  zeilen.push(['Zugteam falsch oder „weiß nicht"', {
    none: 'kein Abzug',
    half: 'halbe Punkte Abzug',
    full: 'volle Punkte Abzug',
  }[s.wrongPenalty] || 'kein Abzug']);
  zeilen.push(['Danach buzzern', 'richtig gibt die Hälfte, falsch kostet die Hälfte']);
  zeilen.push(['Vor der Antwort', 'ist der Buzzer für alle anderen gesperrt']);
  zeilen.push(['Feld aufrufen', s.feldwahl === 'host'
    ? 'nur der Host – die Teams sagen an'
    : 'das Team am Zug, auf seinem Handy']);
  zeilen.push(['Nächster Zug', s.turnMode === 'keepOnCorrect'
    ? 'wer richtig liegt, bleibt dran'
    : 'reihum']);
  if (s.buzzAfterCorrect) {
    zeilen.push(['Nach richtig', 'die anderen dürfen trotzdem noch buzzern']);
  }
  zeilen.push(['Runde 2', state.round >= 2 ? 'läuft – alles zählt doppelt' : 'zählt doppelt',
    state.round >= 2]);
  zeilen.push(['Gleichstand am Ende', 'ein Stechen entscheidet: Buzzer frei, richtig gewinnt']);

  const liste = $('#spick-regeln');
  const key = JSON.stringify(zeilen);
  if (liste.dataset.key !== key) {
    liste.dataset.key = key;
    liste.innerHTML = '';
    for (const [wort, text, jetzt] of zeilen) {
      liste.append(
        el('dt', { class: jetzt ? 'jetzt' : '' }, wort),
        el('dd', { class: jetzt ? 'jetzt' : '' }, text),
      );
    }
  }

  const tasten = $('#spick-tasten');
  if (tasten.dataset.key) return;
  tasten.dataset.key = 'fest';
  for (const [taste, was] of [
    ['1', 'Richtig'],
    ['2', 'Falsch'],
    ['3', 'Zugteam weiß es nicht → wie falsch, Buzzer frei'],
    ['4', 'Keiner weiß es → auflösen'],
    ['L', 'Lösung kurz aufdecken (alle sehen sie)'],
    ['Leer', 'Weiter / nächste Runde'],
    ['F', 'Vollbild'],
    ['Esc', 'dieses Menü'],
  ]) {
    tasten.append(
      el('dt', {}, el('span', { class: 'spick-taste' }, taste)),
      el('dd', {}, was),
    );
  }
}

/* ------------------------------- Hinweis auf einen alten Spielstand ------ */

/**
 * Der Server holt den letzten Stand von der Platte zurück – gedacht für den
 * Absturz mitten im Abend. Wer aber am nächsten Wochenende aufmacht, sah das
 * alte Board samt Punkten und keine Erklärung dazu: Der Hinweis stand nur im
 * Terminal, und das ist beim Spieleabend minimiert oder läuft auf einem anderen
 * Rechner. Der Balken sagt, von wann der Stand ist, und bietet beides an.
 */
let wiederWeggeklickt = false;

function zeitwort(ms) {
  const dann = new Date(ms);
  const jetzt = new Date();
  const uhr = dann.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const tage = Math.round((new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate())
    - new Date(dann.getFullYear(), dann.getMonth(), dann.getDate())) / 86400000);
  if (tage === 0) return `von heute, ${uhr} Uhr`;
  if (tage === 1) return `von gestern, ${uhr} Uhr`;
  return `vom ${dann.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}, ${uhr} Uhr`;
}

function renderWiederhergestellt() {
  const balken = $('#wiederhergestellt');
  const wann = state.wiederhergestellt;
  balken.hidden = !wann || wiederWeggeklickt;
  if (balken.hidden) return;
  const punkte = state.teams.map((t) => `${t.name} ${t.score}`).join(' · ');
  setzeText($('#wieder-text'),
    `Spielstand ${zeitwort(wann)} wiederhergestellt${punkte ? ` – ${punkte}` : ''}`);
}

$('#btn-wieder-zu').addEventListener('click', () => {
  wiederWeggeklickt = true;
  $('#wiederhergestellt').hidden = true;
});
$('#btn-wieder-neu').addEventListener('click', () => {
  if (!confirm('Alten Spielstand verwerfen und neu anfangen?')) return;
  wiederWeggeklickt = true;
  act('backToLobby');
});

/* ------------------------------------------------------------ Vollbild */

/**
 * Vollbild – für den Fall, dass die Bühne selbst das MacBook ist.
 *
 * Dann schaut der ganze Tisch auf einen 13-Zöller, auf dem ein Drittel des
 * oberen Randes aus Tableiste und Adresszeile besteht und unten das Dock
 * hereinragt. Ein Tastendruck räumt das weg, und das Board bekommt den Platz.
 *
 * Safari kennt das Ganze nur mit `webkit`-Vorsilbe, und auf dem iPhone gar
 * nicht – deshalb erscheint der Knopf nur, wo es wirklich geht, statt ins
 * Leere zu greifen.
 */
const vollbildGeht = () => !!(document.documentElement.requestFullscreen
  || document.documentElement.webkitRequestFullscreen);

function imVollbild() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function schalteVollbild() {
  try {
    if (imVollbild()) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    }
  } catch {
    /* Manche Browser lehnen es ohne Geste ab – dann bleibt eben alles wie es ist. */
  }
}

function zeigeVollbildKnopf() {
  const knopf = $('#btn-vollbild');
  if (!knopf) return;
  knopf.hidden = !vollbildGeht();
  const drin = imVollbild();
  setzeText(knopf, drin ? '⤡' : '⛶');
  knopf.title = drin ? 'Vollbild verlassen (Taste F)' : 'Vollbild (Taste F)';
  knopf.setAttribute('aria-label', drin ? 'Vollbild verlassen' : 'Vollbild einschalten');
}

$('#btn-vollbild').addEventListener('click', schalteVollbild);
// Der Hinweis steht nur da, wo die Taste auch etwas tut – und nicht mehr,
// sobald das Vollbild schon läuft.
const vollbildTipp = () => { $('#vollbild-tipp').hidden = !vollbildGeht() || imVollbild(); };
vollbildTipp();
// Auch das Verlassen per Escape oder Systemtaste soll den Knopf umstellen.
const vollbildWechsel = () => { zeigeVollbildKnopf(); vollbildTipp(); };
document.addEventListener('fullscreenchange', vollbildWechsel);
document.addEventListener('webkitfullscreenchange', vollbildWechsel);
zeigeVollbildKnopf();

/* ------------------------------------------------------------ Tastatur */

document.addEventListener('keydown', (ev) => {
  // Eine gehaltene Taste feuert im Sekundentakt nach. Bei „2“ hieße das: erst
  // ist das Zugteam falsch, dann das Team, das gerade gebuzzert hat.
  if (ev.repeat) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

  const key = ev.key.toLowerCase();
  // Vollbild schon in der Lobby: Wer die Bühne aufräumt, tut das, bevor der
  // erste Gast auf die Leinwand schaut – nicht mittendrin.
  if (key === 'f' && vollbildGeht()) { ev.preventDefault(); return schalteVollbild(); }

  if (!state || state.phase === 'lobby') return;

  const menuOpen = !$('#menu').hidden;

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
