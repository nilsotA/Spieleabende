// Host-Fernbedienung: zeigt Frage UND Lösung auf dem Handy des Hosts und
// erlaubt das Bewerten – damit die Lösung nie auf der Leinwand landet.
import {
  $, el, connect, hostAction, sound, vibrate, flash,
  installAudioUnlock, keepScreenAwake, setFrageText, setzeText, anschlussStand,
  aufzaehlung, punkte, starteUhr, verbergeSchluessel, lageSeit } from '/common.js';
// Der Schlüssel hat seinen Zweck erfüllt, sobald die Seite steht.
verbergeSchluessel();


let state = null;
/* Der Einsatz, den der Host für das Zugteam ansagt – nur auf diesem Gerät.
   Er reist als Nutzlast des Feldaufrufs mit, wie auf dem Handy; es gibt also
   keine Ansage, die irgendwo hängen bleiben könnte.

   Gemerkt wird die Team-ID, nicht bloß „ja": Ein Einsatz gehört einem Tisch.
   Wer ansagt und dann abgibt, hat nicht angesagt. */
let einsatzFuer = null;
/**
 * Die Uhr beim freien Buzzer – hier als Sekundenzahl in der Lagezeile.
 *
 * Der Host sieht den Balken auf der Leinwand; auf diesem Gerät geht es darum,
 * wann er auflösen kann. Gewertet wird nichts, entschieden wird am Tisch.
 */
let uhrStopp = null;
let uhrSchluessel = null;
let uhrText = '';

function renderUhr() {
  const q = state.current;
  const dauer = (state.settings?.buzzUhr || 0) * 1000;
  const laeuft = !!q && q.step === 'buzz' && !q.buzzedTeamId && dauer > 0 && !state.pause;
  const schluessel = laeuft ? `${q.catIdx}:${q.rowIdx}:${(q.lockedOut || []).length}` : null;
  if (!laeuft) {
    uhrStopp?.();
    uhrStopp = null;
    uhrSchluessel = null;
    return;
  }
  if (schluessel === uhrSchluessel) return;
  uhrStopp?.();
  uhrSchluessel = schluessel;
  uhrStopp = starteUhr(dauer, q.buzzOffenMs, (rest) => {
    const sek = Math.ceil(rest / 1000);
    setzeText($('#r-phase'), rest > 0 ? `${uhrText}  ⏱ ${sek}` : `${uhrText}  ⏱ Zeit ist um`);
  });
}

// Welche Frage zuletzt auf dem Schirm stand – siehe render(). Steht hier oben
// bei den übrigen Modulwerten, nicht erst vor render(): connect() weiter unten
// ruft render() zwar erst beim ersten Zustand vom Server auf, aber eine
// Deklaration, die nur deshalb rechtzeitig fertig ist, ist eine Falle für den
// Nächsten, der eine Zeile verschiebt.
let letzteFrage = null;

installAudioUnlock();
keepScreenAwake();

connect({
  role: 'host',
  // Auch die Fernbedienung ist ein Handy am Tunnel – siehe player.js.
  onStatus: (text) => {
    if (!state) setzeText($('#r-phase'), text);
  },
  onState: (next) => {
    state = next;
    render();
  },
  onEvent: (name) => {
    if (name !== 'buzz') return;
    sound('buzz');
    // In einer lauten Runde geht ein Handylautsprecher unter, und mit gestelltem
    // Klingelschalter kommt WebAudio auf dem iPhone gar nicht erst durch. Der
    // Host darf den Buzz aber auf keinen Fall verpassen.
    vibrate([40, 50, 40]);
    flash();
  },
});

const act = hostAction;

// Bewusst mit Rückfrage: Wer hier tippt, streicht eine Frage samt ihrer
// Wertungen. Zurücknehmen geht zwar, aber erst muss man merken, dass man
// danebengetippt hat.
$('#r-pause').addEventListener('click', () => act('pause', { an: !state?.pause }));

$('#r-discard').addEventListener('click', () => {
  const q = state?.current;
  if (!q) return;
  if (!confirm(`„${q.category} · ${q.value} Punkte" austauschen?\n\n`
    + 'Die Frage zählt nicht, alles was an ihr hing wird zurückgerechnet, und'
    + ' auf dem Feld liegt danach eine andere Frage.')) return;
  act('discard');
});

$('#r-undo').addEventListener('click', () => {
  if (performance.now() - rueckSeitWann < 400) return;
  act('undo');
});

function render() {
  if (!state) return;
  const q = state.current;
  const teamName = (id) => {
    const t = state.teams.find((x) => x.id === id);
    return t ? `${t.wappen} ${t.name}` : '?';
  };

  const phase = $('#r-phase');
  const box = $('#r-question');
  const bar = $('#r-buttons');

  // Wie auf dem Host-Screen: Die Leiste darf sich nicht bei jedem Broadcast neu
  // aufbauen. Der Server sendet auch, wenn irgendein Handy aus dem Standby
  // kommt oder wegfällt – fällt so ein Update zwischen Finger-runter und Tipp,
  // ist der Knopf weg und die Wertung verpufft. Ausgerechnet auf dem Gerät, mit
  // dem der Host den ganzen Abend steuert.
  const barKey = [
    state.phase, q?.step, q?.buzzedTeamId, q?.teamId,
    (q?.lockedOut || []).join(','),
    // Ob ein Team ein Handy am Netz hat, entscheidet über seinen
    // Vertreterknopf – ohne das im Schlüssel bliebe die Leiste stehen, wenn
    // jemand mitten in der Frage aufwacht oder wegfällt.
    state.teams.map((t) => `${t.id}:${t.name}:${t.wappen}:${t.members.some((m) => m.online !== false) ? 1 : 0}`).join('|'),
    state.turnIndex,
    // Im Endstand hängt die Leiste am Gleichstand und am Ausgang des Stechens.
    state.stechenSieger,
    state.teams.map((t) => t.score).join(','),
  ].join('#');
  const neueLeiste = bar.dataset.key !== barKey;
  if (neueLeiste) {
    bar.dataset.key = barKey;
    bar.innerHTML = '';
  }
  // Der Bezugspunkt für die Anlaufsperre kennt weder Handys noch Punktestand:
  // Nur was die Bedeutung der Wertungsknöpfe ausmacht, zählt hier.
  const wertungsLage = [
    state.phase, q?.step, q?.buzzedTeamId, q?.teamId,
    (q?.lockedOut || []).join(','), state.stechenSieger,
  ].join('#');
  const seit = lageSeit('leiste', wertungsLage);
  const setz = (...knoepfe) => { if (neueLeiste) bar.append(...knoepfe); };

  renderFeldwahl();

  // Eine neue Frage holt den Blick zurück nach oben.
  //
  // Der Host steht oft weiter unten in der Seite – bei den Punkteknöpfen oder
  // in der Feldübersicht. Ruft in dem Moment ein Handy sein Feld auf, baut die
  // Fernbedienung Frage, Lösung und Wertungsknöpfe zwar auf, aber der Blick
  // bleibt stehen: Gemessen lag der Fragenkasten dann 300 bis 600 Pixel über
  // dem Bildrand, und der Host sucht die Lösung, die er gerade vorlesen soll.
  // Nur beim Wechsel der Frage, nicht bei jedem Zustand – sonst risse es dem
  // Host die Seite unter dem Daumen weg, während er die Punkte korrigiert.
  // Ohne `behavior: 'smooth'`: keine Bewegung, nichts, was jemand mit
  // „Bewegung reduzieren" abbestellt hätte.
  //
  // Sichtbar schalten MUSS vor dem Messen stehen: Kommt die Frage aus dem
  // Nichts – genau der Fall, den dieser Absatz beschreibt –, war der Kasten
  // beim Messen noch `hidden`. Dann liefert getBoundingClientRect() lauter
  // Nullen, `top < 0` ist nie wahr, und gescrollt wurde kein einziges Mal.
  box.hidden = !q;
  const frageKey = q ? `${q.catIdx}:${q.rowIdx}:${q.stechen ? 's' : ''}` : null;
  if (frageKey && frageKey !== letzteFrage && box.getBoundingClientRect().top < 0) {
    scrollTo({ top: 0 });
  }
  letzteFrage = frageKey;

  // Streichen geht nur bei einer laufenden Brettfrage – eine Stechfrage hat
  // kein Feld, auf das etwas zurückfallen könnte.
  $('#r-discard').hidden = !q || !!q.stechen;
  // Pausieren geht ab dem Moment, in dem gespielt wird – auch mitten in einer
  // Frage; der Durst kommt nicht nur zwischen zwei Feldern.
  const pausenKnopf = $('#r-pause');
  pausenKnopf.hidden = state.phase === 'lobby';
  pausenKnopf.classList.toggle('laeuft', !!state.pause);
  setzeText(pausenKnopf, state.pause ? '▶ Weiterspielen' : '⏸ Pause');
  if (q) {
    $('#r-cat').textContent = q.stechen
      ? `Stechen · ${q.category}`
      : `${q.category} · ${q.value} Punkte${q.einsatz ? ' · ✦ Einsatz' : ''}${q.ersatzAus ? ` · Ersatz aus \u201e${q.ersatzAus}\u201c` : ''}`;
    setFrageText($('#r-text'), q.text);
    // Ohne Bild müsste der Host sich zur Leinwand umdrehen – genau das soll
    // die Fernbedienung ja ersparen.
    const bild = $('#r-image');
    if (q.image) {
      if (bild.getAttribute('src') !== q.image) bild.src = q.image;
      bild.hidden = false;
    } else {
      bild.hidden = true;
      bild.removeAttribute('src');
    }
    $('#r-answer').textContent = q.answer ?? '—';
    // Der Zusatz ist das, was der Host vorlesen soll („Nicht Sydney"). Auf der
    // Leinwand erscheint er erst nach dem Auflösen – hier steht er von Anfang
    // an, denn hier liest ihn nur der Host.
    const note = $('#r-note');
    note.hidden = !q.note;
    note.textContent = q.note || '';
    const log = $('#r-log');
    log.innerHTML = '';
    for (const entry of q.log) {
      // Wie auf der Leinwand: Im Stechen gibt es keine Punkte, also auch keine
      // Zahl – sonst steht hier „richtig +0" unter der entscheidenden Antwort.
      const label =
        entry.result === 'pass' ? (entry.delta ? `wusste es nicht ${punkte(entry.delta)}` : 'wusste es nicht')
          : entry.result === 'correct' ? (q.stechen ? 'richtig' : `richtig +${entry.delta}`)
            : q.stechen ? 'falsch – raus'
              : entry.delta ? `falsch ${punkte(entry.delta)}` : 'falsch';
      log.append(el('span', { class: `r-chip ${entry.result}` }, `${teamName(entry.teamId)}: ${label}`));
    }
  }

  phase.classList.remove('bereit');
  switch (state.phase) {
    case 'lobby': {
      // Der Host steht in der Lobby oft mit dem Handy am Tisch, während die
      // Gäste beitreten – dann soll er hier dieselbe Auskunft bekommen wie auf
      // der Leinwand, statt nur „geht am großen Screen".
      const stand = anschlussStand(state);
      setzeText(phase, stand.text
        ? `${stand.text}\nAnlegen und starten geht am großen Screen.`
        : 'Lobby – Teams anlegen und starten geht am großen Screen.');
      phase.classList.toggle('bereit', stand.bereit);
      break;
    }
    case 'board':
      setzeText(phase, state.settings.feldwahl === 'host'
        ? `Am Zug: ${teamName(state.teams[state.turnIndex]?.id)} – sie sagen an, du rufst auf.`
        : `Am Zug: ${teamName(state.teams[state.turnIndex]?.id)} – wählt ein Feld.`);
      // Eigener Bezugspunkt, nicht `seit`: Der gehört den Wertungsknöpfen und
      // kennt den Zugwechsel nicht – auf dem Brett steht dort die ganze Zeit
      // dieselbe Lage. Der Knopf baute sich aber bei jedem Wechsel neu auf und
      // war trotzdem sofort scharf. Gemessen: zweimal getippt im Abstand von
      // 250 ms, zwei Teams übersprungen statt einem.
      setz(big('Zug überspringen', 'btn-ghost', () => {
        const next = state.teams[(state.turnIndex + 1) % state.teams.length];
        act('setTurn', { teamId: next.id });
      }, lageSeit('zug', String(state.turnIndex))));
      break;
    case 'roundEnd':
      setzeText(phase, `Runde ${state.round} beendet.`);
      setz(big('Nächste Runde', 'btn-primary', () => act('nextRound'), seit));
      break;
    case 'gameOver': {
      const best = Math.max(...state.teams.map((t) => t.score));
      const spitze = state.teams.filter((t) => t.score === best);
      const offen = spitze.length > 1 && !state.stechenSieger;
      setzeText(phase, state.stechenSieger
        ? `Spiel beendet – ${teamName(state.stechenSieger)} hat das Stechen geholt.`
        : offen
          ? `Gleichstand: ${aufzaehlung(spitze.map((t) => `${t.wappen} ${t.name}`))}. Ein Stechen entscheidet.`
          : 'Spiel beendet.');
      // Bei Gleichstand steht die Entscheidungsfrage oben – erst danach der
      // Knopf, der den Abend wegräumt.
      //
      // `seit` statt der Knotengeburt – nicht, weil die Sperre sonst fehlte:
      // Beim Sprung in den Endstand sind das wirklich neue Knöpfe, und die
      // Geburt greift genauso (gemessen: Tipp 52 ms nach dem Sprung, beide Male
      // geschluckt). Aber die Leiste baut sich auch neu, wenn der Host im
      // Endstand noch Punkte korrigiert – der Punktestand steht in ihrem
      // Schlüssel. Dann waren beide Knöpfe 400 ms taub, obwohl sich an ihnen
      // nichts geändert hatte: gemessen, Tipp 19 ms nach der Korrektur, nichts
      // passiert. Ausgerechnet „Neues Spiel", die einzige Aktion des Abends,
      // die sich nicht zurücknehmen lässt, sieht dann kaputt aus – und wer
      // nachdrückt, hat die Sperre schon überstanden.
      if (offen) setz(big('⚡ Stechen starten', 'btn-primary', () => act('stechen'), seit));
      setz(big('Neues Spiel', 'btn-ghost', () => act('backToLobby'), seit));
      break;
    }
    case 'question':
      if (q.step === 'primary') {
        setzeText(phase, `${teamName(q.teamId)} antwortet.`);
        setz(
          big('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), seit),
          big('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), seit),
          big('Weiß nicht → Buzzer frei', 'btn-ghost', () => act('pass'), seit),
        );
      } else if (q.step === 'buzz' && !q.buzzedTeamId) {
        uhrText = q.stechen
          ? 'Stechen – wer zuerst drückt, antwortet.'
          : `Buzzer ist frei · ${q.halfValue} Punkte`;
        setzeText(phase, uhrText);
        // „Keiner weiß es" zuerst: Das ist der Knopf, der die Frage beendet,
        // und bei acht Teams stand er vorher unter sieben Vertreterknöpfen –
        // also außerhalb des Bildschirms, obwohl der Tisch längst wartet.
        setz(big(q.stechen ? 'Keiner weiß es → nächste Frage' : 'Keiner weiß es → auflösen',
          'btn-primary', () => act('endQuestion'), seit));
        // Vertreten wird nur, wer keinen eigenen Buzzer in der Hand hat.
        //
        // Eigener Bezugspunkt: Diese Knöpfe kommen und gehen mit der
        // Online-Lage, und genau dann sollen sie kurz taub sein. Die Geburt des
        // Knotens reicht dafür nicht – die Leiste baut sich schon neu, wenn
        // irgendein anderes Handy aufwacht, und dann standen unveränderte
        // Vertreterknöpfe 400 ms taub da.
        const vertreten = state.teams.filter((team) => team.id !== q.teamId
          && !q.lockedOut.includes(team.id)
          && !team.members.some((m) => m.online !== false));
        const vertreterSeit = lageSeit('vertreter',
          `${state.phase}#${q.step}#${vertreten.map((t) => t.id).join(',')}`);
        for (const team of vertreten) {
          setz(big(`Buzz: ${team.wappen} ${team.name}`, 'btn-ghost',
            () => act('buzzFor', { teamId: team.id }), vertreterSeit));
        }
      } else if (q.step === 'buzz' && q.buzzedTeamId) {
        setzeText(phase, q.stechen
          ? `${teamName(q.buzzedTeamId)} hat gebuzzert – richtig gewinnt, falsch ist raus.`
          : `${teamName(q.buzzedTeamId)} hat gebuzzert (±${q.halfValue}).`);
        setz(
          big('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), seit),
          big('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), seit),
          big('Buzz zurücknehmen', 'btn-ghost', () => act('resetBuzz'), seit),
        );
      } else if (q.stechen) {
        setzeText(phase, state.stechenSieger
          ? `${teamName(state.stechenSieger)} gewinnt den Abend.`
          : 'Das wusste keiner – zurück zum Endstand.');
        setz(big(state.stechenSieger ? 'Zum Endstand' : 'Weiter', 'btn-primary', () => act('close'), seit));
      } else {
        setzeText(phase, 'Frage beendet.');
        setz(big('Weiter', 'btn-primary', () => act('close'), seit));
      }
      break;
    default:
      setzeText(phase, '');
  }

  // Die Pause gehört ganz nach vorn – auch hier.
  //
  // Auf der Leinwand liegt das Pausenbild, die Handys sagen „Pause", nur die
  // Fernbedienung sagte weiter „Am Zug: Rot – wählt ein Feld." oder „Buzzer ist
  // frei". Ausgerechnet auf dem Gerät, das der Host in der Hand hält: Der
  // Knopf sprang zwar auf „▶ Weiterspielen" um, die Lage darüber widersprach
  // ihm aber. Der bisherige Text bleibt darunter stehen – nach der Küche will
  // der Host wissen, wo er weitermacht.
  if (state.pause) {
    setzeText(phase, `⏸ Pause – die Handys sind still.\n${phase.textContent}`.trim());
    phase.classList.remove('bereit');
  }

  renderRueckgaengig();
  // Nach dem Setzen der Lagezeile: Die Uhr hängt ihre Sekunden daran.
  renderUhr();

  const list = $('#r-teams');
  // Name und Wappen stehen in der Zeile, also gehören sie in den Schlüssel.
  // In der Lobby stehen alle Punktestände auf 0: Sucht sich dort ein Handy
  // sein Wappen aus oder benennt der Host ein Team um, änderte sich am
  // Schlüssel nichts, und die Liste auf der Fernbedienung fror ein.
  const key = state.teams.map((t) => `${t.id}:${t.name}:${t.wappen}:${t.score}`).join('|')
    + `#${state.turnIndex}`;
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.innerHTML = '';
    state.teams.forEach((team, i) => {
      list.append(
        el('li', { class: i === state.turnIndex ? 'turn' : '' },
          // Punkt und Name in einer Hülle: Auf schmalen Handys rutschen die
          // Knöpfe in eine zweite Zeile, und ohne die Hülle stünde der
          // Farbpunkt allein in der ersten. Auf breiten Screens ist die Hülle
          // per `display: contents` gar nicht da.
          el('span', { class: 'r-kopf' },
            el('span', { class: 'dot', style: { background: team.color } }),
            el('span', { class: 'grow' }, `${team.wappen} ${team.name}`)),
          // Beschriftet wie im Host-Menü: „−" allein sagt nicht, um wie viel.
          el('button', {
            class: 'btn btn-sm btn-ghost',
            'aria-label': `${team.name}: 100 Punkte abziehen`,
            onclick: () => act('adjustScore', { teamId: team.id, delta: -100 }),
          }, '−100'),
          el('span', { class: 'sc' }, punkte(team.score)),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            'aria-label': `${team.name}: 100 Punkte geben`,
            onclick: () => act('adjustScore', { teamId: team.id, delta: 100 }),
          }, '+100'),
          // Den Zug direkt setzen, statt sich mit „Zug überspringen" durch die
          // Reihe zu tippen – am Tisch ist meistens klar, wer als Nächstes soll.
          el('button', {
            class: 'btn btn-sm btn-ghost',
            'aria-label': `${team.name} ist als Nächstes dran`,
            onclick: () => act('setTurn', { teamId: team.id }),
          }, 'dran'),
        ),
      );
    });
  }
}

/**
 * Zurücknehmen auf dem Handy.
 *
 * Hier passiert die Fehlwertung am ehesten: Der Host hält das Handy in der
 * Hand, „Richtig“ und „Falsch“ liegen nebeneinander, und ein Tisch redet
 * dazwischen. Der Knopf steht deshalb nicht in der Knopfleiste, sondern
 * darüber – dort, wo nach einer Wertung kein Daumen mehr unterwegs ist – und
 * ist nach dem Erscheinen kurz taub, wie alle Knöpfe hier.
 */
let rueckSeitWann = 0;
let rueckWas = null;

function renderRueckgaengig() {
  const knopf = $('#r-undo');
  const was = state.rueckgaengig;
  knopf.hidden = !was;
  // Neu scharf bei jeder neuen zurücknehmbaren Aktion, nicht nur beim ersten
  // Auftauchen – nach der Feldwahl steht der Knopf schon da, und die Wertung
  // danach wechselt nur seine Beschriftung.
  if (was !== rueckWas) {
    rueckWas = was;
    rueckSeitWann = performance.now();
  }
  if (!was) return;
  setzeText(knopf, `↩ ${was} zurücknehmen`);
  // Auf dem Handy steht die Zahl nicht im Knopf – dort ist die Beschriftung
  // ohnehin lang genug –, aber eine Vorlesehilfe soll sie kennen.
  const tiefe = state.rueckwegTiefe || 1;
  knopf.setAttribute('aria-label',
    tiefe > 1 ? `${was} zurücknehmen – ${tiefe} Schritte möglich` : `${was} zurücknehmen`);
}

/**
 * Feldwahl auf dem Handy.
 *
 * Bisher konnte der Host alles von der Couch aus: vorlesen, werten, auflösen –
 * nur für das nächste Feld musste er jedes Mal zum Laptop. Das ist 24-mal pro
 * Runde und der einzige Grund, überhaupt aufzustehen.
 *
 * Eine Zeile je Kategorie statt eines Rasters wie auf der Leinwand: Sechs
 * Spalten nebeneinander ergeben auf einem 360er Handy Knöpfe von 50 Pixeln,
 * und die Kategorienamen wären nicht mehr zu lesen. Untereinander bleibt Platz
 * für den ganzen Namen und für Tippflächen, die man auch im Halbdunkel trifft.
 */
function renderFeldwahl() {
  const karte = $('#r-board');
  const liste = $('#r-board-list');
  // In der Pause verschwindet die Feldwahl – wie auf der Leinwand und auf dem
  // Handy. Der Server weist einen Feldaufruf in der Pause ohnehin ab
  // („Ihr seid gerade in der Pause", pickCell in game.js); hier stand die Liste
  // trotzdem scharf da, und ein Tipp im Vorbeigehen antwortete mit einem roten
  // Kasten. Eine Liste, die auf jeden Tipp mit einer Absage antwortet, sieht
  // nach kaputt aus – dieselbe Begründung wie beim Raster des Handys.
  const zeigen = state.phase === 'board' && !!state.board && !state.pause;
  // Vor dem Ausstieg: Eine scharfe Ansage gilt nur, solange das Brett steht.
  // Stünde sie weiter, verdoppelte der nächste Feldaufruf des Hosts ein Feld,
  // das niemand als Einsatz gemeint hat – nachgestellt auf der Leinwand, wo
  // derselbe Fehler saß.
  if (!zeigen) einsatzFuer = null;
  karte.hidden = !zeigen;
  if (!zeigen) {
    // Schlüssel löschen, damit die Wahl beim nächsten Auftauchen sicher neu
    // gebaut wird – zwischendurch kann eine ganze Runde gewechselt haben.
    liste.dataset.key = '';
    return;
  }

  const zugteam = state.teams[state.turnIndex];
  const darfEinsatz = state.settings.einsatz === 'runde' && zugteam?.einsatzOffen !== false;
  // Auch der Zugwechsel löscht die Ansage. Nachgestellt: Ansage für Anna, dann
  // „Zug überspringen" auf der Leinwand – der Schalter hier schrieb sich
  // klaglos auf Bea um und verdoppelte Beas nächstes Feld. Niemand hatte das
  // gesagt, und Beas Einsatz war für die Runde weg.
  if (!darfEinsatz || einsatzFuer !== zugteam?.id) einsatzFuer = null;
  const einsatzScharf = einsatzFuer !== null;

  // Der Schalterzustand gehört in den Schlüssel: Er färbt die Liste um und
  // verdoppelt jede Zahl darin. Ohne ihn bliebe die Liste stehen, und das
  // Antippen des Schalters zeigte keine Wirkung.
  const key = [state.setName, state.round, state.turnIndex,
    darfEinsatz ? (einsatzScharf ? 'e1' : 'e0') : 'e-', state.board.categories
      .map((c) => `${c.name}:${c.cells.map((z) => (z.used ? '1' : '0')).join('')}`).join('|')].join('#');
  if (liste.dataset.key === key) return;
  liste.dataset.key = key;
  liste.innerHTML = '';

  if (darfEinsatz) {
    liste.append(el('button', {
      type: 'button',
      class: `btn r-einsatz ${einsatzScharf ? 'an' : 'btn-ghost'}`,
      'aria-pressed': String(einsatzScharf),
      onclick: () => { einsatzFuer = einsatzScharf ? null : zugteam.id; renderFeldwahl(); },
    }, einsatzScharf
      ? `✦ Einsatz steht für ${zugteam.wappen} ${zugteam.name} – jetzt Feld wählen`
      : `✦ Einsatz für ${zugteam.wappen} ${zugteam.name}`));
  }

  for (const [catIdx, cat] of state.board.categories.entries()) {
    liste.append(
      el('div', { class: 'r-bcat' }, cat.name),
      el('div', { class: 'r-brow' }, ...cat.cells.map((cell, rowIdx) => el('button', {
        class: `r-bcell${cell.used ? ' used' : ''}`,
        type: 'button',
        disabled: cell.used,
        // Ohne Beschriftung liest ein Screenreader nur „300" – bei sechs
        // Kategorien untereinander sagt das nichts.
        'aria-label': `${cat.name}, ${cell.value} Punkte${cell.used ? ' – schon gespielt' : ''}`,
        onclick: () => {
          const mitEinsatz = einsatzFuer !== null
            && einsatzFuer === state.teams[state.turnIndex]?.id;
          einsatzFuer = null;
          act('pick', { catIdx, rowIdx, einsatz: mitEinsatz });
        },
      }, String(einsatzScharf ? cell.value * 2 : cell.value)))),
    );
  }
}

/**
 * Ein Knopf der Fernbedienung – mit Anlaufsperre.
 *
 * Die Leiste ist ein Raster: Nach einer Wertung steht an genau derselben Stelle
 * ein anderer Knopf. Wer „Weiter" tippt und den Daumen kurz danach noch einmal
 * absetzt, trifft „Neues Spiel" – und das Spiel ist weg. Deshalb ist ein frisch
 * erschienener Knopf 400 ms lang taub. Wer bewusst tippt, merkt davon nichts;
 * wer nachtippt, richtet keinen Schaden mehr an.
 */
function big(label, cls, onclick, seit) {
  // Ohne Bezugspunkt gilt die Geburt des Knotens – richtig für Knöpfe, die es
  // vorher wirklich nicht gab (Vertreterbuzzer), falsch für die Wertungsreihe.
  const geboren = seit ?? performance.now();
  return el('button', {
    class: `btn ${cls} r-big`,
    type: 'button',
    onclick: () => {
      if (performance.now() - geboren < 400) return;
      onclick();
    },
  }, label);
}

// Lebenszeichen für die Startwache (start-wache.js): Ab hier steht die Seite.
// Fehlt diese Zeile, weil das Modul vorher gestorben ist, meldet sich die
// Wache mit einer lesbaren Erklärung statt einer schwarzen Fläche.
window.quizduellLaeuft = true;
