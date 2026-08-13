import {
  $, el, connect, action, toast, sound, vibrate, flash,
  installAudioUnlock, unlockAudio, keepScreenAwake, onConnectionChange, isOnline, setFrageText, setzeText,
  istStumm, setzeStumm, punkte, delta as vorzeichen } from '/common.js';

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
  if (!name) {
    // Vorher passierte hier gar nichts sichtbar außer der Browserblase.
    $('#my-name').focus();
    return toast('Bitte trag deinen Namen ein.', 'error');
  }
  if (!selectedTeam) return toast('Bitte ein Team auswählen.', 'error');
  document.activeElement?.blur?.(); // Tastatur wegräumen
  const res = await action('joinTeam', { teamId: selectedTeam, name });
  if (res.ok) {
    localStorage.setItem('quizduell.name', name);
    localStorage.setItem('quizduell.teamId', selectedTeam);
  }
});

$('#btn-leave').addEventListener('click', () => action('leaveTeam'));

/**
 * „Eigenes Team": Legt ein Team unter dem eigenen Namen an und tritt ihm bei.
 *
 * Ein Schritt statt zwei – der Name steht ja schon im Feld darüber. Wer zu
 * zweit spielt, tippt danach einfach auf das Team des anderen.
 */
async function eigenesTeam() {
  unlockAudio();
  keepScreenAwake();
  const name = $('#my-name').value.trim();
  if (!name) {
    $('#my-name').focus();
    return toast('Bitte trag deinen Namen ein.', 'error');
  }
  document.activeElement?.blur?.();
  const res = await action('eigenesTeam', { name });
  if (res.ok) localStorage.setItem('quizduell.name', name);
}

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
  $('#p-team').textContent = me ? `${me.wappen} ${me.name}` : '—';
  $('#p-name').textContent = (me?.members || []).map((m) => m.name).join(', ');
  renderWappen(me);

  // Der eigene Punktestand sprang lautlos von 0 auf 250 – der Moment, um den
  // das ganze Spiel geht, kam am Handy gar nicht an. Ausgelöst wird nur bei
  // einer echten Wertung: Beim Start eines neuen Spiels setzt der Server alle
  // Punkte auf 0, und dann soll nicht jedes Handy ein dickes Minus anzeigen.
  const vorher = prev?.teams?.find((t) => t.id === state.you.teamId);
  const gewertet = state.phase === 'question' && vorher && vorher.score !== me?.score;
  if (gewertet) punktesprung(me.score - vorher.score, vorher.score, me.score);
  else $('#p-score').textContent = punkte(me?.score ?? 0);
  // Teamwechsel lehnt der Server während einer Frage ab – Knopf dann ausblenden.
  $('#btn-leave').hidden = state.phase === 'question';

  renderQuestion();
  renderPicker();
  renderBuzzer(prev);
  renderBilanz(me);
  renderScores();
  zeigeMehr();

  // Der Buzzer tritt zurück, wann immer etwas anderes den Platz braucht und er
  // ohnehin nichts tun kann: beim Feldwählen (dort standen von sechs Kategorien
  // zwei im Bild), nach dem Auflösen und an den Rundenenden. Nur wenn wirklich
  // nichts anderes zu zeigen ist, bleibt er groß – dann ist er die Ansage.
  // In der Lobby bleibt er ebenfalls groß: Ein Probeknopf von 88 Pixeln wäre
  // kein Spielzeug, und etwas anderes ist dort ohnehin nicht zu sehen.
  const grosserKnopf = state.phase === 'lobby'
    || (state.phase === 'question' && state.current?.step !== 'result');
  $('#view-play').classList.toggle('knopf-ruht', !grosserKnopf);
  // Während die Feldwahl offensteht, hat der Buzzer nichts zu tun – er zeigt
  // „DU WÄHLST" und wiederholt damit die Zeile darüber. Auf einem iPhone SE
  // kostet er dabei ein Sechstel der Fläche, und von sechs Kategorien waren
  // dreieinhalb zu sehen. Bei der Wahl gehört der Platz den Feldern.
  $('#view-play').classList.toggle('waehlt', !$('#p-picker').hidden);
  frageInsBild();
}

/**
 * Holt die Frage an den oberen Rand des scrollenden Teils, wenn sie sonst nicht
 * ganz hineinpasst.
 *
 * Auf einem iPhone SE braucht eine sechszeilige Frage mehr Platz, als über dem
 * Buzzer übrig ist – gemessen stand die letzte Zeile im ausgeblendeten Rand,
 * ausgerechnet die mit dem Fragezeichen. Darüber steht die Teamkarte, die man
 * in genau diesem Moment am wenigsten braucht: Sie darf hinaufrutschen.
 * Erreichbar bleibt sie, es wird ja nur gescrollt.
 *
 * Angesteuert wird die Statuszeile, nicht der Fragenkasten: Darin steht, was der
 * Buzz einbringt und was er kostet. Genau die Zeile verschwand, als zuerst der
 * Kasten selbst nach oben geholt wurde.
 *
 * Nur beim Wechsel der Frage und beim Auflösen, nie bei jedem Update: Sonst
 * springt der Text unter dem Daumen weg, während jemand zurückgescrollt hat.
 */
let letzteFrageKennung = null;
function frageInsBild() {
  const sc = document.querySelector('.pscroll');
  const box = $('#p-question');
  const q = state.current;
  const kennung = q && !box.hidden ? `${q.category}#${q.value}#${q.revealed ? 'auf' : 'zu'}` : null;
  if (kennung === letzteFrageKennung) return;
  letzteFrageKennung = kennung;
  if (!sc) return;
  // Frage vorbei: zurück nach oben. Sonst steht man beim Feldwählen vor einem
  // Ausschnitt, dessen Kopfzeile irgendwo darüber hängt.
  if (!kennung) { sc.scrollTop = 0; zeigeMehr(); return; }
  requestAnimationFrame(() => {
    if (box.hidden) return;
    // Passt ohnehin alles, bleibt der Kopf stehen – ein Sprung ohne Gewinn wäre
    // nur Unruhe.
    if (sc.scrollHeight <= sc.clientHeight + 4) return;
    const ziel = $('#p-status');
    sc.scrollTop += ziel.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    zeigeMehr();
  });
}

/**
 * Blendet die Unterkante aus, solange unterhalb noch etwas steht – die einzige
 * Andeutung, dass sich das Scrollen lohnt. Erst nach dem Zeichnen messen: Vorher
 * hat der Browser die neuen Zeilen noch nicht gesetzt.
 */
function zeigeMehr() {
  const sc = document.querySelector('.pscroll');
  if (!sc) return;
  requestAnimationFrame(() => {
    sc.classList.toggle('mehr', sc.scrollHeight - sc.clientHeight - sc.scrollTop > 4);
  });
}
document.querySelector('.pscroll')?.addEventListener('scroll', zeigeMehr, { passive: true });
addEventListener('resize', zeigeMehr);

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
    feld.textContent = punkte(Math.round(von + (bis - von) * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(schritt);
  };
  requestAnimationFrame(schritt);

  feld.classList.remove('plus', 'minus');
  void feld.offsetWidth;
  feld.classList.add(delta > 0 ? 'plus' : 'minus');

  const flieger = el('span', { class: `p-delta ${delta > 0 ? 'plus' : 'minus'}` },
    vorzeichen(delta));
  feld.parentElement.append(flieger);
  clearTimeout(sprungZeit);
  sprungZeit = setTimeout(() => {
    flieger.remove();
    feld.classList.remove('plus', 'minus');
  }, 1600);

  vibrate(delta > 0 ? [30, 40, 30] : 120);
}

/**
 * Wappen des eigenen Teams aussuchen.
 *
 * Nur in der Lobby: Danach ist das Wappen das, woran man sein Team auf der
 * Leinwand wiedererkennt. Belegte Wappen stehen als `belegt` da – sichtbar,
 * aber nicht wählbar. Sie ganz auszublenden würde die Reihe bei jedem
 * Beitritt umsortieren, und man tippt daneben.
 */
function renderWappen(me) {
  const box = $('#p-wappen');
  box.hidden = !me || state.phase !== 'lobby';
  if (box.hidden) return;
  const auswahl = state.wappenAuswahl || [];
  // Die eigene Kennung gehört mit hinein: Nach „Team wechseln" ist die Reihe
  // dieselbe, aber ein anderes Wappen ist meins – und die Farbe eine andere.
  const key = `${me.id}#${me.wappen}#${state.teams.map((t) => t.wappen).join('')}#${auswahl.join('')}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  box.append(el('div', { class: 'muted small' }, 'Euer Wappen – so steht ihr auf der Leinwand'));
  const reihe = el('div', { class: 'wappen-reihe' });
  for (const w of auswahl) {
    const meins = w === me.wappen;
    const fremd = !meins && state.teams.find((t) => t.wappen === w);
    reihe.append(el('button', {
      type: 'button',
      class: `wappen-knopf ${meins ? 'meins' : ''} ${fremd ? 'belegt' : ''}`,
      disabled: !!fremd,
      // Der Rahmen trägt die Farbe des Teams, dem es gehört – auch der eigene.
      // „Vergeben" allein lässt einen suchen, wer es denn hat; die Farbe steht
      // auf der Leinwand an derselben Stelle wie das Wappen.
      style: { '--team': (fremd || (meins ? me : null))?.color || '' },
      'aria-pressed': meins ? 'true' : 'false',
      'aria-label': fremd ? `${w} – gehört schon ${fremd.name}` : `Wappen ${w} wählen`,
      onclick: () => {
        if (meins) return;
        vibrate(20); // dasselbe kurze Nicken wie beim Feldwählen
        action('wappen', { wappen: w });
      },
    }, w));
  }
  box.append(reihe);
}

function renderJoin() {
  const box = $('#team-choices');
  // Nur neu bauen, wenn sich wirklich etwas geändert hat – sonst geht ein
  // Antippen verloren, weil zwischendurch ein State-Update eintrudelt.
  const key = state.teams.map((t) => `${t.id}:${t.name}:${t.wappen}:${t.members.map((m) => m.name).join(',')}`).join('|')
    + `#${selectedTeam}#${state.phase}`;
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    if (!state.teams.length && state.phase !== 'lobby') {
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
          el('span', { class: 'tw', style: { '--team': team.color } }, team.wappen),
          el('span', {},
            el('div', {}, team.name),
            el('div', { class: 'sub' },
              team.members.length ? team.members.map((m) => m.name).join(', ') : 'noch frei'),
          ),
        ),
      );
    }
    // Ein eigenes Team anlegen, ohne auf den Host zu warten.
    //
    // Vorher musste er jedes Team vorher eintippen, und wer vor ihm den
    // QR-Code scannte, stand vor einer leeren Liste. Auf der Leinwand hießen
    // die Teams dann „Team 1" und „Team 2", weil das schneller ging als vier
    // Namen abzutippen. Jetzt tippt jeder seinen eigenen – der Host kann
    // weiterhin welche anlegen, umbenennen und entfernen.
    if (state.phase === 'lobby' && state.teams.length < 8) {
      box.append(
        el('button', {
          type: 'button',
          class: 'team-choice neu',
          onclick: eigenesTeam,
        },
          el('span', { class: 'dot plus' }, '+'),
          el('span', {},
            el('div', {}, 'Eigenes Team'),
            el('div', { class: 'sub' }, 'heißt wie du – für Zweierteams tippt der Zweite oben darauf'),
          ),
        ),
      );
    }
  }
  // Während einer offenen Frage steht die Teamzuordnung still. „Du kannst
  // trotzdem einsteigen" wäre dann ein Versprechen, das der Knopf gleich bricht.
  $('#join-hint').textContent =
    state.phase === 'lobby'
      ? 'Für Zweierteams wählt ihr beide dasselbe Team.'
      : state.phase === 'question'
        ? 'Gerade läuft eine Frage – gleich danach kannst du einsteigen.'
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
  // Die Stechfrage hat keinen Punktwert – „· 0 Punkte" wäre schlicht falsch.
  $('#p-q-head').textContent = q.stechen
    ? `Stechen · ${q.category}`
    : `${q.category} · ${q.value} Punkte`;
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
  // Zwei Betriebsarten. Normal tippt das Zugteam sein Feld hier an. Steht die
  // Feldwahl auf „nur Host", bleibt dieselbe Übersicht stehen – aber ohne
  // Knöpfe: Die Leute müssen ihr Feld ja ansagen, und dafür wollen sie sehen,
  // was noch offen ist. Ein Raster, das bei jedem Tipp mit einer Absage
  // antwortet, wäre schlimmer als keins; eine leere Handyfläche, während man
  // gerade dran ist, aber auch.
  const nurAnsehen = state.settings.feldwahl === 'host';
  // In der Pause verschwindet das Raster: Ein Tipp im Vorbeigehen prallt zwar
  // am Server ab, aber ein Raster, das nichts tut, sieht nach kaputt aus.
  const zeigen = state.phase === 'board' && state.you.isMyTurn && state.board && !state.pause;
  box.hidden = !zeigen;
  box.classList.toggle('nur-ansehen', nurAnsehen);
  if (!zeigen) return;

  // Fragensatz und Betriebsart mit in den Schlüssel: sonst zeigt ein neues
  // Spiel mit gleicher Feldbelegung noch die Kategorien des alten – und ein
  // Umschalten mitten im Spiel bliebe unbemerkt.
  const key = [
    state.setName, state.round, nurAnsehen ? 'ansehen' : 'waehlen',
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
          cat.cells.map((cell, rowIdx) => (nurAnsehen
            // Kein Knopf, sondern Text: Nichts an dieser Fläche soll aussehen,
            // als ließe sie sich drücken.
            ? el('span', { class: cell.used ? 'used' : '' }, String(cell.value))
            : el('button', {
              type: 'button',
              class: cell.used ? 'used' : '',
              onclick: (ev) => {
                if (cell.used) return;
                ev.currentTarget.classList.add('used');
                sound('pick');
                action('pick', { catIdx, rowIdx, quiet: true });
              },
            }, String(cell.value)))),
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

  // `tooearly` gehört mit in die Aufräumzeile. Fehlte sie, blieb die Klasse für
  // den Rest des Abends am Knopf kleben – und weil `.buzzer.tooearly` im
  // Stylesheet nach `.buzzer.armed` steht und dieselbe Spezifität hat, gewann
  // ihr `shake` über den Puls. Gemessen: Wer einmal zu früh gedrückt hatte,
  // bekam bei jeder weiteren Freigabe `animation-name: shake` und gar keine
  // laufende Animation mehr, während alle anderen `armedPulse` pulsten. Es traf
  // ausgerechnet den Eifrigen: Der Puls ist das einzige fortlaufende Signal
  // „du darfst jetzt drücken" – Ton, Blitz und Vibration gibt es nur im Moment
  // des Umschaltens. Das Wackeln selbst leidet nicht darunter, es wird in
  // pressBuzzer() ohnehin per remove/reflow/add neu gestartet.
  buzzer.classList.remove('armed', 'won', 'locked', 'fremd', 'probe', 'tooearly');
  label.textContent = 'BUZZ';
  status.classList.remove('you');

  const lock = (text) => {
    buzzer.classList.add('locked');
    label.textContent = text;
  };

  if (!isOnline()) {
    setzeText(status, 'Keine Verbindung – warte kurz …');
    lock('OFFLINE');
    return;
  }
  // Die Pause steht vor allem anderen: Wer in dem Moment aufs Handy schaut,
  // soll nicht rätseln, warum sein Buzzer nichts tut. Der Knopf sagt es selbst,
  // damit man dafür nicht zur Leinwand schauen muss.
  if (state.pause) {
    setzeText(status, 'Pause – gleich geht es weiter.');
    lock('PAUSE');
    return;
  }
  if (state.phase === 'lobby') {
    // Warten auf den Start ist die längste tote Zeit des Abends. Der Knopf darf
    // hier ausprobiert werden – er meldet nichts an den Server, aber er drückt
    // sich, summt und leuchtet. Nebenbei entsperrt das erste Antippen den Ton
    // auf iPhones, wo das ohne echte Geste nicht geht.
    buzzer.classList.add('probe');
    setzeText(status, 'Warten auf den Start – Buzzer ausprobieren?');
    label.textContent = 'PROBE';
    return;
  }
  if (state.phase === 'roundEnd') { setzeText(status, 'Runde vorbei – gleich geht’s weiter.'); lock('PAUSE'); return; }
  if (state.phase === 'gameOver') {
    const best = Math.max(...state.teams.map((t) => t.score));
    const spitze = state.teams.filter((t) => t.score === best);
    setzeText(status, state.stechenSieger
      ? (state.stechenSieger === you.teamId
        ? 'Ihr habt das Stechen gewonnen!'
        : `${state.teams.find((t) => t.id === state.stechenSieger)?.name ?? '?'} gewinnt das Stechen.`)
      // Gleichstand oben: Gleich kommt die Entscheidungsfrage – das Handy sagt
      // es, damit niemand den Buzzer weglegt.
      : spitze.length > 1 ? 'Gleichstand oben – gleich das Stechen!' : 'Spiel beendet!');
    lock('ENDE');
    return;
  }

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
    // Ruft nur der Host die Felder auf, gibt es hier nichts zu wählen – dann
    // wäre „wähle ein Feld!" eine Aufforderung, die das Handy gleich abweist.
    const selbstWaehlen = state.settings.feldwahl !== 'host';
    setzeText(status, you.isMyTurn
      ? (selbstWaehlen ? 'Du bist dran – wähle ein Feld!' : 'Ihr seid dran – sagt dem Host euer Feld!')
      : `Am Zug: ${state.teams[state.turnIndex]?.name ?? '?'} …`);
    status.classList.toggle('you', you.isMyTurn);
    lock(you.isMyTurn ? (selbstWaehlen ? 'DU WÄHLST' : 'IHR SEID DRAN') : 'GESPERRT');
    return;
  }

  if (!q) return;

  if (you.canBuzz) {
    buzzer.classList.add('armed');
    // Im Stechen geht es nicht um Punkte, sondern um den ganzen Abend.
    setzeText(status, q.stechen
      ? 'Stechen! Wer zuerst drückt und richtig liegt, gewinnt.'
      : `Buzzer frei! ${q.halfValue} Punkte – oder ${q.halfValue} Abzug.`);
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
    setzeText(status, mine
      ? `Du warst zuerst${knapp} – antworte!`
      : `${wer} war schneller${knapp}.`);
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
    setzeText(status, you.onTheHook
      ? 'Du bist dran – sag deine Antwort!'
      : `Am Zug: ${active?.name ?? '?'}. Buzzer noch gesperrt.`);
    status.classList.toggle('you', !!you.onTheHook);
    lock(you.onTheHook ? 'DU BIST DRAN' : 'GESPERRT');
    return;
  }

  if (q.step === 'buzz') {
    // Was der Fehlversuch gekostet hat, gehört hierher und nicht erst ans Ende
    // der Frage. Bisher hieß es nur „Ihr hattet euren Versuch." – während oben
    // still eine rote Zahl auftauchte, deren Grund nirgends stand. Gewinne
    // wurden benannt („+150 Punkte für euch!"), Verluste nicht.
    //
    // Ohne Abzug ist der Satz weiterhin richtig: Dann kostet „falsch" nichts,
    // und die Summe ist null.
    // Der Verlust zuerst, egal aus welchem Grund man draußen ist: Das Zugteam
    // steht gar nicht in `lockedOut` (es ist über `q.teamId` ausgeschlossen),
    // hat mit eingestelltem Abzug aber genauso Punkte verloren wie ein Team,
    // das danebengebuzzert hat.
    const eigen = q.log.reduce((summe, e) => (e.teamId === you.teamId ? summe + e.delta : summe), 0);
    // Im Stechen kostet ein Fehlversuch keine Punkte, sondern das Stechen –
    // und wer gar nicht mitspielt, wartet nur zu, statt „seinen Versuch"
    // gehabt zu haben.
    if (q.stechen) {
      const drin = q.log.some((e) => e.teamId === you.teamId);
      setzeText(status, drin
        ? 'Daneben – ihr seid raus aus dem Stechen.'
        : 'Das Stechen läuft ohne euch – Daumen drücken.');
      lock('GESPERRT');
      return;
    }
    setzeText(status, eigen < 0
      ? `Daneben – das kostet euch ${-eigen} Punkte. Die anderen sind noch dran.`
      : q.lockedOut.includes(you.teamId)
        ? 'Ihr hattet euren Versuch.'
        : 'Deine Frage – die anderen sind dran.');
    lock('GESPERRT');
    return;
  }

  // Die Lösung steht schon groß im Kasten – hier stattdessen das, was man sonst
  // nirgends sieht: was die Frage dem eigenen Team gebracht hat.
  const eigen = q.log.reduce((summe, e) => (e.teamId === you.teamId ? summe + e.delta : summe), 0);
  if (q.stechen) {
    setzeText(status, !state.stechenSieger
      ? 'Das wusste keiner – gleich kommt die nächste Frage.'
      : state.stechenSieger === you.teamId
        ? 'Ihr habt das Stechen gewonnen!'
        : `${state.teams.find((t) => t.id === state.stechenSieger)?.name ?? '?'} gewinnt das Stechen.`);
    status.classList.toggle('you', state.stechenSieger === you.teamId);
    lock('DURCH');
    return;
  }
  setzeText(status, !you.teamId ? 'Frage beendet.'
    : eigen > 0 ? `+${eigen} Punkte für euch!`
    : eigen < 0 ? `${eigen} Punkte für euch.`
    : 'Diesmal nichts für euch.');
  status.classList.toggle('you', eigen > 0);
  lock('DURCH');
}

/**
 * Die eigene Bilanz – nur am Rundenende und zum Schluss.
 *
 * Auf der Leinwand steht der Punktestand, und der sagt am Ende des Abends
 * nicht, wie er zustande kam: Wer viel geraten und viel danebengelegen hat,
 * steht dort gleich neben dem, der zweimal aufgemacht hat und sonst nichts.
 * Das gehört aufs eigene Handy, nicht auf den Beamer – dort schaut man auf
 * den Sieger, und sieben Tabellen daneben schaut sich niemand an.
 *
 * Nur in den Pausen: Während einer Frage will niemand Statistik lesen, und
 * unter dem Buzzer hat sie ohnehin keinen Platz.
 */
function renderBilanz(me) {
  const box = $('#p-bilanz');
  const zeigen = (state.phase === 'roundEnd' || state.phase === 'gameOver') && !!me;
  box.hidden = !zeigen;
  if (!zeigen) { box.dataset.key = ''; return; }

  // Ein Spielstand von vor dieser Buchhaltung bringt keine Bilanz mit.
  const b = me.bilanz || {};
  const zahl = (x) => Number(x) || 0;
  // `gepasst` steckt seit der Regelklarstellung in `falsch` mit drin – „weiß
  // nicht" zählt wie eine falsche Antwort. Hier also nicht doppelt zählen.
  const gestellt = zahl(b.richtig) + zahl(b.falsch);

  const key = [state.phase, state.round, me.id, JSON.stringify(b)].join('#');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';

  if (!gestellt) {
    box.append(el('p', { class: 'p-bilanz-leer' }, 'Noch nichts zu erzählen – die nächste Runde kommt.'));
    return;
  }

  const zeilen = [
    ['Richtig', zahl(b.richtig)],
    // Aufgeteilt statt übereinander: Beide zusammen ergeben die falschen
    // Antworten, und „daneben" meint dann wirklich das Danebengeratene.
    ['Daneben', Math.max(0, zahl(b.falsch) - zahl(b.gepasst))],
    ['Weiß nicht', zahl(b.gepasst)],
    // Nur zeigen, wenn es das überhaupt gab: Eine Reihe Nullen liest sich wie
    // ein Vorwurf, und beim Buzzern ist Nichtstun eine legitime Taktik.
    ...(zahl(b.geklaut) ? [['Geklaut', zahl(b.geklaut)]] : []),
    ...(zahl(b.daneben) ? [['Verbuzzert', zahl(b.daneben)]] : []),
  ];

  box.append(
    el('h2', {}, state.phase === 'gameOver' ? 'Euer Abend' : `Eure Runde ${state.round}`),
    el('div', { class: 'p-bilanz-gitter' }, ...zeilen.map(([wort, n]) => el('div', { class: 'p-bilanz-feld' },
      el('span', { class: 'p-bilanz-zahl' }, String(n)),
      el('span', { class: 'p-bilanz-wort' }, wort),
    ))),
    el('p', { class: 'p-bilanz-summe' }, summenzeile(zahl(b.geholt), zahl(b.verloren))),
  );
}

/** „−0 verloren" ist kein Satz, den jemand sagen würde. */
function summenzeile(geholt, verloren) {
  if (geholt && verloren) return `+${geholt} geholt · −${verloren} verloren`;
  if (geholt) return `+${geholt} geholt, nichts abgegeben`;
  if (verloren) return `−${verloren} verloren, noch nichts geholt`;
  return 'Noch keine Punkte bewegt';
}

function renderScores() {
  const box = $('#p-scores');
  const activeId = state.teams[state.turnIndex]?.id;
  // Die eigene Teamkennung gehört mit hinein: Sie entscheidet, welcher Chip
  // als „meiner" leuchtet. Nach „Team wechseln" ändert sich sonst nichts am
  // Schlüssel – kein Name, kein Wappen, kein Punktestand –, die Reihe wird
  // nicht neu gebaut, und die Markierung klebt am alten Team.
  const key = state.teams.map((t) => `${t.id}:${t.wappen}:${t.name}:${t.score}`).join('|')
    + `#${activeId}#${state.you?.teamId}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  for (const team of state.teams) {
    const cls = [
      'chip',
      team.id === state.you.teamId ? 'me' : '',
      team.id === activeId ? 'turn' : '',
    ].join(' ');
    box.append(el('span', { class: cls }, `${team.wappen} ${team.name}: ${punkte(team.score)}`));
  }
}
