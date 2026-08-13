import {
  $, $$, el, connect, hostAction, toast, sound, installAudioUnlock, keepScreenAwake,
  setFrageText, setzeText, istStumm, setzeStumm, anschlussStand, aufzaehlung,
  punkte, delta as vorzeichen, starteUhr, verbergeSchluessel } from '/common.js';
// Der Schlüssel hat seinen Zweck erfüllt, sobald die Seite steht.
verbergeSchluessel();

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
  ['#set-buzzuhr', 'buzzUhr', (v) => Number(v)],
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

/**
 * Die Adresse, unter der dieser Bildschirm selbst erreicht wurde.
 *
 * Der Server kennt nur seine eigenen Netzwerkkarten. Das reicht im Heimnetz –
 * aber nicht, sobald etwas dazwischensteht: ein Tunnel, ein vorgelagerter
 * Server, ein Rechnername statt einer Zahl. Dann führte der QR-Code auf eine
 * Adresse aus dem lokalen Netz, die von außen niemand erreicht, während die
 * Adresse, über die der Host gerade selbst hier gelandet ist, nachweislich
 * funktioniert – er benutzt sie ja in diesem Moment.
 *
 * `localhost` und Konsorten fallen raus: Auf dem Handy führt das ins eigene
 * Gerät. Genau deshalb steht hier nicht einfach `location.origin`.
 */
function eigeneHerkunft() {
  const h = location.hostname;
  if (!h || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') return null;
  return location.origin;
}

// Die beiden Schlüssel des Abends – leer, solange im Heimnetz gespielt wird.
// Sie kommen vom Server und stehen nur diesem Bildschirm zur Verfügung.
let schluessel = '';
let hostSchluessel = '';
// Hat der Host selbst eine Adresse angetippt? Dann redet ihm das Nachfragen
// unten nicht mehr hinein.
let handverlesen = false;
// Wie oft wurde schon nachgefragt, ob der Tunnel inzwischen steht.
let tunnelFragen = 0;
const TUNNEL_FRAGEN_MAX = 30; // gut eine Minute, dann kommt keiner mehr

async function loadUrls() {
  try {
    const info = await (await fetch('/api/info')).json();
    schluessel = info.schluessel || '';
    hostSchluessel = info.hostSchluessel || '';
    const liste = $('#join-urls');
    liste.innerHTML = '';
    // Die eigene Herkunft zuerst: Sie ist die einzige Adresse, von der wir
    // wissen, dass sie funktioniert. Doppelte fallen weg – im Heimnetz ist sie
    // meist eine der Adressen, die der Server ohnehin nennt, und rückt damit
    // nur nach vorn.
    // Läuft ein Tunnel, gehört seine Adresse an die erste Stelle – der QR-Code
    // nimmt immer die erste. Die eigene Herkunft ist das Mittel gegen eine
    // unerreichbare Serveradresse; mit Tunnel gibt es aber schon eine, die
    // nachweislich von außen trägt. Ohne diese Zeile drängte sich die Herkunft
    // davor, sobald der Host seinen Bildschirm über die Heimnetz-Adresse
    // geöffnet hatte – und die Gäste von auswärts scannten einen QR-Code, der
    // in ein WLAN führt, in dem sie nicht sind.
    const tunnel = info.urls.find((u) => u.startsWith('https://'));
    tunnelVorhanden = !!tunnel;
    const eigen = eigeneHerkunft();
    info.urls = [...new Set([
      ...(tunnel ? [tunnel] : []),
      ...(eigen ? [eigen] : []),
      ...info.urls,
    ])];
    // Bei mehreren Netzwerkkarten kann der Host die richtige antippen – dann ist
    // die Adresse ein echter Knopf. Bei nur einer gibt es nichts zu wählen: Sie
    // war trotzdem per Tab erreichbar und tat dort nichts, und mit `role=button`
    // ohne Tastaturbehandlung hätte auch die Auswahl auf Enter geschwiegen. Ein
    // <button> bringt beides von Haus aus mit.
    const waehlbar = info.urls.length > 1;
    for (const url of info.urls) {
      liste.append(waehlbar
        ? el('button', {
          class: 'url',
          type: 'button',
          onclick: () => { handverlesen = true; zeigeQr(url, liste); },
        }, ...adressTeile(url))
        : el('code', { class: 'url' }, ...adressTeile(url)));
    }
    // Der Punkt „andere Adresse" hilft nur, wenn es überhaupt eine zweite gibt.
    const mehrere = $('#kein-handy-adresse');
    if (mehrere) mehrere.hidden = !waehlbar;
    // Beim Spiel über den Tunnel hängt am Ziel ein Schlüssel. Die Adresse im
    // Kästchen darunter führt dann nur bis zur verschlossenen Tür – wer sie
    // abtippt, weil die Kamera zickt, braucht die vollständige Zeile.
    if (schluessel) {
      const oben = $('#join-hinweis');
      if (oben) oben.textContent = 'Scannen – das ist beim Spiel übers Internet der Weg hinein:';
      const nachsatz = $('#qr-ziel-nachsatz');
      if (nachsatz) {
        nachsatz.textContent = 'Öffnet das Handy nichts, tippt genau diese Zeile ab – '
          + 'die kurze Adresse darüber reicht heute nicht, der Schlüssel gehört dazu.';
      }
    }
    // Nur wenn es gar keine Adresse gibt, steht hier ein Platzhalter. Diese
    // Zeile lief früher hinter zeigeQr() und überschrieb deren Ergebnis: Beim
    // Spiel über den Tunnel stand danach eine Fernbedienungs-Adresse ohne
    // Hostschlüssel da – gemessen, sie führte auf die verschlossene Tür.
    if (info.urls.length && !handverlesen) zeigeQr(info.urls[0], liste);
    else if (!info.urls.length) $('#remote-url').textContent = '…/remote';

    // Der Tunnel braucht ein paar Sekunden, bis er seine Adresse nennt. Wer in
    // dieser Zeit den Host-Screen selbst aufmacht – ungeduldig, oder weil er
    // ihn vorhin schon offen hatte –, bekam einen QR-Code auf die Heimnetz-
    // Adresse und behielt ihn den ganzen Abend: Die Gäste von auswärts wären
    // an einer Adresse gelandet, die es für sie nicht gibt. Deshalb wird
    // nachgefragt, bis der Tunnel da ist – und danach nie wieder.
    const tunnelDa = tunnelVorhanden;
    zeigeTunnel(tunnelDa); // deckt den Fall ab, dass gar keine Adresse gezeigt wird
    if (schluessel && !tunnelDa && !handverlesen && tunnelFragen < TUNNEL_FRAGEN_MAX) {
      tunnelFragen += 1;
      setTimeout(loadUrls, 2000);
    }
  } catch {
    /* egal */
  }
}

/**
 * Sagt in der Lobby, woran man ist – aber nur beim Spiel über den Tunnel.
 *
 * Ohne diese Zeile stünde die Auskunft ausschließlich im Terminalfenster, und
 * das ist am Spieleabend minimiert oder steht auf einem anderen Rechner. Der
 * Host sähe eine https-Adresse im Kästchen und wüsste trotzdem nicht, ob sie
 * schon trägt.
 */
function zeigeTunnel(da) {
  const box = $('#tunnel-lage');
  if (!box) return;
  if (!schluessel) {
    box.hidden = true; // im Heimnetz gibt es nichts zu melden
    return;
  }
  box.hidden = false;
  // Grün nur, wenn der QR-Code auch wirklich durch den Tunnel führt. Tippt der
  // Host die Heimnetz-Adresse an, während ein Tunnel läuft, stimmte die
  // Erfolgsmeldung nicht mehr zu dem, was auf der Leinwand steht.
  const durchDenTunnel = da && !!gezeigteAdresse?.startsWith('https://');
  box.classList.toggle('steht', durchDenTunnel);
  if (da && !durchDenTunnel) {
    box.textContent = '🌍 Der Tunnel läuft – dieser QR-Code führt aber ins Heimnetz.';
  } else if (da) box.textContent = '🌍 Über das Internet – eure Gäste brauchen kein gemeinsames WLAN.';
  else if (tunnelFragen >= TUNNEL_FRAGEN_MAX) {
    box.textContent = '🌍 Kein Tunnel – heute geht es nur im Heimnetz. Fehlt cloudflared?';
  } else box.textContent = '🌍 Der Tunnel wird aufgebaut … der QR-Code stellt sich gleich um.';
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
// Welche Adresse gerade im QR-Code steht – die Lagezeile richtet sich danach.
let gezeigteAdresse = null;
// Ob der Server überhaupt eine Tunneladresse nennt.
let tunnelVorhanden = false;

function zeigeQr(basis, liste) {
  gezeigteAdresse = basis;
  const ziel = `${basis}/play${schluessel ? `?k=${schluessel}` : ''}`;
  try {
    $('#join-qr').innerHTML = qrSvg(ziel, { ecl: 'M', quiet: 4 });
  } catch {
    $('#join-qr').hidden = true;
  }
  // Damit man vergleichen kann, was das Handy nach dem Scannen anzeigt.
  const zielZeile = $('#qr-ziel');
  if (zielZeile) zielZeile.textContent = ziel;
  // Die Fernbedienung zieht mit. Sie stand bisher fest auf der ersten Adresse,
  // während QR-Code und Zielzeile umschalteten – und umgeschaltet wird genau
  // dann, wenn die erste die falsche ist: Auf einem Rechner mit VPN-, Docker-
  // oder VirtualBox-Karte steht dort eine Adresse, die im Heimnetz niemand
  // erreicht. Der Host schickt seine Gäste dann richtig los und tippt sich
  // selbst die unerreichbare ein.
  const fernZiel = `${basis}/remote${hostSchluessel ? `?h=${hostSchluessel}` : ''}`;
  const fern = $('#remote-url');
  if (fern) fern.textContent = fernZiel;
  // Läuft ein Tunnel, hängt am Ende der Fernbedienungs-Adresse ein Schlüssel,
  // den niemand abtippt – und abtippen soll ihn auch keiner. Dann steht dort
  // ein zweiter QR-Code, den der Host mit seinem eigenen Handy scannt.
  // Die Lagezeile hängt an der Adresse, die hier gerade gesetzt wurde – tippt
  // der Host mitten im Tunnelabend die Heimnetz-Adresse an, soll sie das sagen.
  zeigeTunnel(tunnelVorhanden);
  const fernQr = $('#remote-qr');
  if (fernQr) {
    fernQr.hidden = !hostSchluessel;
    if (hostSchluessel) {
      try {
        fernQr.querySelector('.remote-qr-bild').innerHTML = qrSvg(fernZiel, { ecl: 'M', quiet: 3 });
      } catch {
        fernQr.hidden = true;
      }
    }
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
    // Auch der Board-Schlüssel gehört zurückgesetzt. Er überlebte den Weg
    // durch die Lobby, und beim zweiten Spiel mit demselben Satz war der
    // Schlüssel deshalb noch derselbe: Das Board galt als „nicht frisch
    // gebaut", und die Rundenansage samt Ton blieb aus.
    $('#board').dataset.key = '';
    // Der Wiederhergestellt-Balken folgt auch in der Lobby dem Zustand.
    //
    // Er lag früher hinter dieser Weiche und wurde dort nie erreicht: Wer auf
    // „Neues Spiel" drückte, landete in der Lobby – und der goldene Balken mit
    // dem Punktestand des gerade verworfenen Spiels blieb als feste Pille quer
    // über dem Logo hängen, bis jemand die Seite neu lud.
    renderWiederhergestellt();
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
  renderPause();
  renderUhr();
  renderControls();
  renderWiederhergestellt();
  if (!$('#menu').hidden) fillMenu();
}

/**
 * Die Uhr beim freien Buzzer – wenn der Host sie eingeschaltet hat.
 *
 * Sie wertet nichts. Sie zeigt dem Raum, dass die Zeit läuft, und dem Host, dass
 * er auflösen kann; entschieden wird weiter am Tisch. Genau deshalb steht sie
 * auch nicht als eigenes Element auf der Bühne, sondern übernimmt den goldenen
 * Lichtbalken, der ohnehin „Buzzer ist frei" bedeutet: Er zieht sich zur Mitte
 * zusammen, statt einfach dazustehen.
 */
let uhrStopp = null;
let uhrSchluessel = null;

function renderUhr() {
  const q = state.current;
  const dauer = (state.settings.buzzUhr || 0) * 1000;
  const laeuft = !!q && q.step === 'buzz' && !q.buzzedTeamId && dauer > 0 && !state.pause;
  // Neu gestartet wird nur, wenn wirklich eine andere Buzz-Phase beginnt –
  // sonst setzte jeder Zustand vom Server die Uhr zurück, und ein Handy, das
  // aus dem Standby kommt, schenkte dem Raum zehn Sekunden.
  const schluessel = laeuft ? `${q.catIdx}:${q.rowIdx}:${(q.lockedOut || []).length}` : null;
  const stage = $('.stage');
  if (!laeuft) {
    uhrStopp?.();
    uhrStopp = null;
    uhrSchluessel = null;
    stage.classList.remove('uhr-laeuft', 'uhr-aus');
    stage.style.removeProperty('--uhr');
    return;
  }
  if (schluessel === uhrSchluessel) return;
  uhrStopp?.();
  uhrSchluessel = schluessel;
  stage.classList.add('uhr-laeuft');
  stage.classList.remove('uhr-aus');
  uhrStopp = starteUhr(dauer, q.buzzOffenMs, (rest, anteil) => {
    stage.style.setProperty('--uhr', String(anteil));
    if (rest > 0) return;
    stage.classList.remove('uhr-laeuft');
    stage.classList.add('uhr-aus');
  });
}

/**
 * Das Pausenbild.
 *
 * Es liegt über allem, auch über einer offenen Frage – wer in die Küche geht,
 * soll die Lösung nicht im Vorbeigehen mitlesen. Und weil beim Zurückkommen
 * zuerst „wie steht's?" gefragt wird, steht der Stand hier noch einmal in einer
 * Zeile, obwohl er an den Pulten ohnehin klebt.
 */
function renderPause() {
  const schirm = $('#pause');
  schirm.hidden = !state.pause;
  // Darüberlegen reicht nicht: Der Schleier des Overlays ist durchsichtig, und
  // im Bild lugte die Lösungsbox der offenen Frage unter dem Pausenfeld hervor.
  // In der Pause zeigt die Leinwand die Pause – und sonst nichts. Beim
  // Weiterspielen stellt der nächste Durchlauf beides von selbst wieder her,
  // denn renderQuestion und renderScoreboard laufen vor dieser Zeile.
  if (state.pause) {
    $('#question').hidden = true;
    $('#scoreboard').hidden = true;
  }
  if (!state.pause) return;
  const stand = [...state.teams]
    .sort((a, b) => b.score - a.score)
    .map((t) => `${t.wappen} ${t.name} ${punkte(t.score)}`)
    .join('   ·   ');
  setzeText($('#pause-stand'), stand);
}

function renderLobby() {
  const list = $('#lobby-teams');
  list.innerHTML = '';
  if (!state.teams.length) {
    list.append(el('li', { class: 'muted' },
      'Noch keine Teams. Sie erscheinen hier, sobald die Handys eins anlegen – oder du legst sie oben selbst an.'));
  }
  for (const team of state.teams) {
    list.append(
      el('li', {},
        // color mitsetzen: Der Schein um den Punkt kommt aus currentColor.
        el('span', { class: 'dot', style: { background: team.color, color: team.color } }),
        el('span', { class: 'grow' },
          el('div', { class: 'tname' }, `${team.wappen} ${team.name}`),
          el('div', { class: 'tmembers' },
            team.members.length
              ? team.members.map((m) => (m.online ? m.name : `${m.name} (offline)`)).join(', ')
              : 'kein Handy verbunden'),
        ),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          'aria-label': `Team „${team.name}“ entfernen`,
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
  $('#set-buzzuhr').value = String(state.settings.buzzUhr || 0);
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
/**
 * Wie viele Handys da sind – und was zu tun ist, wenn keins kommt.
 *
 * Die Zeile über dem Startknopf sagt seit jeher, wer verbunden ist. Was sie
 * nicht sagte: was man tut, wenn nach fünf Minuten immer noch niemand da ist.
 * Genau dort bleibt ein Abend hängen, und der häufigste Grund steht in keiner
 * Fehlermeldung, weil er gar nicht bis zum Server kommt – die Windows-Firewall
 * blockt die Verbindung, bevor sie ankommt.
 *
 * Die Hilfe steht deshalb nicht von Anfang an da: Bis das erste Handy kommt,
 * ist alles normal, und drei Absätze Fehlersuche neben dem QR-Code lesen sich
 * wie eine Warnung. Sie erscheint erst, wenn eine Minute lang niemand verbunden
 * war, und verschwindet, sobald sich eins meldet.
 */
const HILFE_NACH_MS = 60000;
let ohneHandySeit = null;

function renderAnschluss() {
  const zeile = $('#lobby-stand');
  if (!zeile) return;
  const { text, bereit } = anschlussStand(state);
  zeile.classList.toggle('bereit', bereit);
  setzeText(zeile, text);

  const hilfe = $('#kein-handy');
  if (!hilfe) return;
  const verbunden = (state.wartende || 0)
    + state.teams.reduce((n, t) => n + t.members.filter((m) => m.online).length, 0);
  if (verbunden > 0) {
    ohneHandySeit = null;
    hilfe.hidden = true;
    return;
  }
  if (ohneHandySeit == null) {
    ohneHandySeit = performance.now();
    // Ohne diesen Wecker bliebe die Hilfe aus, solange sich sonst nichts tut –
    // und wenn kein Handy kommt, tut sich genau gar nichts.
    setTimeout(() => { if (state?.phase === 'lobby') renderAnschluss(); }, HILFE_NACH_MS + 200);
  }
  hilfe.hidden = performance.now() - ohneHandySeit < HILFE_NACH_MS;
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
    // Ein Wort, das in keine Zeile passt, bricht der Browser nicht – es steht
    // einfach über den Rand hinaus. Gemessen auf einem 1024er-Beamer:
    // „Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz" ragte
    // 930 Pixel aus einem 886 Pixel breiten Kasten, quer über die halbe
    // Leinwand. Deutsch macht solche Wörter, und der Editor lädt dazu ein.
    //
    // Die Breite gehört deshalb in dieselbe Rechnung wie die Höhe. Sie hilft
    // hier auch wirklich: Das Wort schrumpft mit der Schrift, der Kasten nicht.
    //
    // Gemessen wird durchweg in Layoutmaßen (offsetHeight, offsetLeft,
    // scrollWidth) – nie über getBoundingClientRect. Das Panel fährt beim
    // Öffnen aus der Kachel heran, und während dieser Animation zeigt
    // getBoundingClientRect eine Lage, die es hinterher gar nicht mehr gibt.
    // Gemessen wurde damit ein Kasten, der weit unter die Bühne ragte: Eine
    // Bildfrage landete auf Stufe 0,52 statt 0,84 – das Bild war dauerhaft ein
    // Drittel zu klein, obwohl der Platz da war. Layoutmaße kennen keine
    // Transformationen.
    const ovStil = getComputedStyle(overlay);
    const platzHoch = overlay.clientHeight
      - parseFloat(ovStil.paddingTop || 0) - parseFloat(ovStil.paddingBottom || 0);
    // Das Kopfschild sitzt halb über der oberen Panelkante und zählt in
    // offsetHeight nicht mit – sein Überstand gehört trotzdem in die Rechnung.
    const kopf = panel.querySelector('.q-head');
    const kopfUeber = kopf ? kopf.offsetHeight / 2 : 0;
    const hochPasst = () => panel.offsetHeight + kopfUeber <= platzHoch + 1;
    const querPasst = () => {
      const rechts = panel.clientWidth - parseFloat(getComputedStyle(panel).paddingRight || 0);
      for (const sel of ['#q-text', '#q-answer', '#q-note']) {
        const n = overlay.querySelector(sel);
        if (!n || n.hidden) continue;
        // Nicht die Breite des Kastens mit der des Panels vergleichen: Der
        // Textblock ist auf 26 Zeichen begrenzt und steht mittig, das zu lange
        // Wort läuft aus ihm nach rechts heraus. Maßgeblich ist also, wo es
        // tatsächlich endet – linke Kante des Blocks plus seine Inhaltsbreite.
        if (n.offsetLeft + n.scrollWidth > rechts + 1) return false;
      }
      return true;
    };
    // Bei einer Bildfrage ist das Bild die Frage. Es bekommt deshalb keinen
    // festen Anteil der Bildschirmhöhe, sondern alles, was nach Kopfschild,
    // Fragetext und Protokollzeile übrig bleibt. Gerechnet wird zweistufig:
    // erst der Kasten ohne Bild, dann der Rest ans Bild.
    const bild = overlay.querySelector('#q-image');
    const hatBild = !!bild && !bild.hidden;
    const bildAus = () => panel.style.setProperty('--bildhoehe', '0px');
    const restHoehe = () => platzHoch - kopfUeber - panel.offsetHeight;

    const stufen = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44];
    const letzte = stufen[stufen.length - 1];
    const lauf = () => {
      for (const stufe of stufen) {
        panel.style.setProperty('--frageskala', String(stufe));
        if (hatBild) bildAus();
        // Höhe erst nach dem Setzen lesen – das erzwingt den Umbruch. Verglichen
        // wird mit dem freien Platz der Bühne: Was darüber hinausgeht, müsste
        // gescrollt werden, und das gibt es auf einer Leinwand nicht.
        if (!hochPasst() || !querPasst()) continue;
        // Bleibt für das Bild weniger als vier Zehntel der Bühne, ist die Frage
        // eine Stufe zu groß geschrieben: Ein Bild, das kleiner ist als die
        // Schrift darüber, kann der Raum nicht mehr erkennen.
        if (!hatBild || stufe === letzte || restHoehe() >= platzHoch * 0.4) return true;
      }
      return false;
    };
    // Erst ganz ohne Umbruch im Wort versuchen – das ist die schönere Lösung
    // und reicht für alles, was ein Mensch freiwillig tippt. Nur wenn selbst
    // die kleinste Stufe zu breit bleibt, wird gebrochen; und dann von vorn,
    // damit die Schrift nicht winzig bleibt, obwohl mit Umbruch längst wieder
    // die volle Größe passt.
    panel.classList.remove('bricht');
    if (!lauf()) {
      panel.classList.add('bricht');
      lauf();
    }
    // Und jetzt der Rest ans Bild – auch dann, wenn oben keine Stufe gepasst
    // hat. Sonst bliebe die Höhe auf null stehen und das Bild verschwände.
    if (hatBild) panel.style.setProperty('--bildhoehe', `${Math.max(0, Math.floor(restHoehe()))}px`);
    else panel.style.removeProperty('--bildhoehe');
    // Reicht auch die kleinste Stufe nicht, ist die Frage schlicht zu lang
    // geschrieben – dann entscheidet, was man sieht. Sichtbar sein muss die
    // Lösung: Die Frage hat der Host ohnehin vorgelesen.
    if (!hochPasst()) {
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

// Ein Bild, das noch nicht geladen ist, hat keine Höhe – die Rechnung oben
// misst dann einen Kasten ohne Bild und ist fertig, bevor das Bild überhaupt
// da ist. Sobald es steht, wird noch einmal gerechnet.
$('#q-image')?.addEventListener('load', passeFrageEin);

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
  $('#turn-name').textContent = active ? `${active.wappen} ${active.name}` : '—';
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
  // Den Aufräum-Timer der Vorfrage abbestellen.
  //
  // Beim Schließen läuft 320 ms lang die Zuklapp-Bewegung, danach räumt ein
  // Timer auf: `box.hidden = true`. Das Board ist in dieser Zeit aber schon
  // wieder anklickbar – ausdrücklich so gewollt, damit der Host zügig
  // weiterspielen kann. Ruft in diesen 320 ms jemand das nächste Feld auf,
  // baute sich die neue Frage auf und der alte Timer blendete sie sofort
  // wieder aus: leere Bühne, obwohl die Frage läuft, und der Host kann nichts
  // vorlesen. Die Handys zeigten sie derweil ganz normal an.
  clearTimeout(schliessZeit);
  schliessZeit = null;
  box.classList.remove('zu');
  // Was der Timer noch erledigt hätte: Die Kachel der Vorfrage darf ihre
  // Abschalt-Animation nicht behalten, sonst liefe sie beim nächsten Aufbau
  // des Boards erneut.
  for (const kachel of $$('.tile.picked')) kachel.classList.remove('picked');
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
  // Mit Wappen: Im Protokoll stehen nach einer Buzzer-Runde bis zu acht Zeilen
  // untereinander, und die unterscheiden sich sonst nur durch den Namen ganz
  // vorne. Das Zeichen findet das Auge schneller als das gelesene Wort.
  const teamName = (id) => {
    const t = state.teams.find((x) => x.id === id);
    return t ? `${t.wappen} ${t.name}` : '?';
  };

  panel.classList.toggle('buzzopen', q.step === 'buzz' && !q.buzzedTeamId);
  // Hat jemand gedrückt, wechselt der Ring von Gold auf die Teamfarbe – die
  // Frage „wer denn jetzt?" ist damit beantwortet, bevor jemand liest.
  panel.classList.toggle('buzzed', !!q.buzzedTeamId && q.step === 'buzz');

  // Das Schild oben rechts nennt, wer jetzt antworten muss – nicht, wer das Feld
  // gewählt hat. Hat jemand gebuzzert, leuchtete dort sonst weiter der Name des
  // Zugteams, während ein ganz anderer Tisch reden musste.
  const dran = q.onTheHook ? state.teams.find((t) => t.id === q.onTheHook) : null;
  if (dran) {
    $('#turn-name').textContent = `${dran.wappen} ${dran.name}`;
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
  // Name und Wappen gehören mit in den Schlüssel: Beides lässt sich in der
  // Lobby noch ändern, und die Pulte werden nicht neu gebaut, solange dieselben
  // Teams dastehen. Vorher zeigte die Leiste nach einem „Zurück zur Lobby" mit
  // Umbenennen noch den alten Namen.
  const key = state.teams.map((t) => `${t.id}:${t.name}:${t.wappen}`).join('|');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    for (const team of state.teams) {
      box.append(
        el('div', { class: 'player', 'data-team': team.id, style: { '--team': team.color } },
          el('div', { class: 'pname', 'data-voll': team.name },
            el('span', { class: 'pwappen' }, team.wappen), team.name),
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
    // Wer allein spielt, nennt sein Team gern nach sich selbst. Am Pult stand
    // dann „OLEK" und darunter noch einmal „Olek" – eine Zeile, die nichts
    // sagt. Ausnahme: das abgemeldete Handy. Das ⚪ ist die einzige Stelle, an
    // der der Spielleiter sieht, dass dieser Tisch gerade keinen Buzzer hat.
    const einerAllein = team.members.length === 1 && team.members[0].online
      && team.members[0].name.trim().toLowerCase() === team.name.trim().toLowerCase();
    node.querySelector('.pmembers').textContent = einerAllein ? '' : team.members
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
  // Reihenfolge ist Pflicht: pruefeEnge entscheidet über die Aufstellung,
  // pultSchriftAnpassen setzt darin den Grad, und pultNamenAnpassen kürzt erst,
  // wenn der endgültige Grad steht.
  pruefeEnge(box);
  pultSchriftAnpassen(box);
  pultNamenAnpassen(box);

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
 * Lange Teamnamen am Pult: erst kürzen, dann erst die Auslassung.
 *
 * Aus einem echten Abend: „Die Namen waren etwas abgeschnitten und nicht ganz
 * auf der Fläche, das sah unsauber aus.“ Nachgestellt bei sechs Teams auf
 * 1366 Pixeln – so breit ist ein 1920er Windows-Bildschirm bei 125 Prozent
 * Skalierung: Da stand „TEAM DONNERBAL…“ und „DIE UNBESTECHLIC…“, und der Rest
 * lief bis an die schräge Schulter des Trapezes.
 *
 * Zwei Stufen, beide erst nach der Messung und jede nur, wenn die vorige nicht
 * reicht:
 *   1. „Die“, „Der“, „Das“, „Team“ am Anfang weg – die tragen nichts zur
 *      Unterscheidung bei, und der Rest passt meistens ganz.
 *   2. Nur noch das erste Wort. Genau so beschriftet die Leiste schon die
 *      Vertreterknöpfe, und wer im Team sitzt, steht ohnehin eine Zeile
 *      darunter. Ein ganzes Wort liest sich aus vier Metern deutlich besser
 *      als dasselbe Wort mit abgesägtem Ende.
 * Bleibt es dann immer noch zu lang – ein einzelnes langes Wort auf einem
 * schmalen Pult –, greifen wie bisher die Auslassungspunkte.
 *
 * Kollisionen bleiben ausgeschlossen: Eine Kurzform wird nur genommen, wenn
 * kein anderes Pult sie ebenfalls anzeigen könnte. Sonst stünde bei „Die
 * Nachzügler“ und „Team Nachzügler“ zweimal dasselbe.
 */
function pultNamenAnpassen(box) {
  const pulte = [...box.querySelectorAll('.player .pname')];
  if (!pulte.length) return;
  const voll = pulte.map((n) => n.dataset.voll || n.textContent.trim());
  const stufen = voll.map((name) => {
    const ohneFueller = String(name).replace(/^(die|der|das|team)\s+/i, '').trim() || String(name);
    const erstesWort = ohneFueller.split(/\s+/)[0] || ohneFueller;
    return [...new Set([String(name), ohneFueller, erstesWort])];
  });
  // Was könnte sonst noch irgendwo stehen? Alles aus den Ketten der anderen.
  const belegt = stufen.map((_, i) => new Set(
    stufen.filter((__, j) => j !== i).flat().map((s) => s.toLowerCase()),
  ));

  pulte.forEach((node, i) => {
    const schreib = (text) => {
      // Nur den Textknoten hinter dem Wappen austauschen, das Wappen bleibt.
      const letzter = node.lastChild;
      if (letzter && letzter.nodeType === 3) letzter.textContent = text;
      else node.append(document.createTextNode(text));
    };
    for (const kandidat of stufen[i]) {
      if (kandidat !== stufen[i][0] && belegt[i].has(kandidat.toLowerCase())) break;
      schreib(kandidat);
      if (node.scrollWidth <= node.clientWidth + 1) return;
    }
  });
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
  // Gelesen wird der Boden, nicht der gewachsene Grad: pultSchriftAnpassen
  // vergrößert die Schrift erst, nachdem hier entschieden wurde, und würde die
  // Leiste sonst mit ihrem eigenen Ergebnis wieder ins Gestapelte kippen.
  const wurzel = getComputedStyle(document.documentElement);
  const proPultZahl = parseFloat(getComputedStyle(box.querySelector('.pscore')).fontSize);
  const proPultName = parseFloat(getComputedStyle(box.querySelector('.pname')).fontSize);
  const zahlGrad = parseFloat(wurzel.getPropertyValue('--pult-zahl-boden')) || proPultZahl;
  const nameGrad = parseFloat(wurzel.getPropertyValue('--pult-name-boden')) || proPultName;
  if (!zahlGrad || !nameGrad) return;

  // Vierzehn Zeichen des Teamnamens sollen stehen bleiben. Die Zahl ist nicht
  // gegriffen: „Die Grübelmeister", „Die Unbestechlichen" und „Die Nachzügler"
  // gehen erst ab dem fünften Zeichen auseinander, und wer sich einen Namen
  // ausdenkt, stellt gern etwas Gemeinsames voran. Bei elf Zeichen – der alten
  // Annahme – standen an allen drei Pulten „DIE …" und sonst nichts.
  // Großbuchstabe in Halbfett plus Sperrung misst 0,67 em, eine tabellarische
  // Ziffer der Pille 0,62 em, und der größte Punktestand („-1000") sind fünf.
  // Das Wappen steht davor und nimmt sich rund 1,3 em (Glyphe plus Abstand) –
  // dafür reichen zwölf Zeichen statt vierzehn. Das ist eine bewusste
  // Verrechnung: Ein Bildzeichen sagt aus zehn Metern mehr über „wer ist das"
  // als die dreizehnte und vierzehnte Silbe eines Namens, der ohnehin gekürzt
  // dasteht. So bleibt die Schwelle zum gestapelten Pult genau da, wo sie war –
  // vier Teams auf einem 1366er-Beamer stehen weiter nebeneinander.
  const noetig = (12 * 0.67 + 1.3) * nameGrad + 11 /* Spalte */ + 27 /* Pillenpolster */
    + 32 /* Pultpolster */ + 5 * 0.62 * zahlGrad;
  box.classList.toggle('eng', proPult < noetig);

  // Passen die Pulte nicht mehr nebeneinander, kommt eine zweite Reihe.
  //
  // Die Mindestbreite stand fest auf 92px. Acht Pulte brauchen damit samt Fugen
  // rund 849px – auf einem hochkant gehaltenen iPad (768px), das der
  // Host-Screen ausdrücklich unterstützt, lief die Leiste über: Das achte Pult
  // stand gemessen bei 734–826, also 58 seiner 92 Pixel hinter der
  // Fensterkante, und von seiner Punktepille fehlten 34. Erreichbar war es nur
  // durch seitliches Schieben – auf einer Leinwand, die der ganze Raum ansieht,
  // ist ein Punktestand hinter der Kante aber schlicht nicht da.
  //
  // Sie enger zu stellen allein hätte das Loch nur verschoben: Bei 82px je Pult
  // fehlten den Namen gemessen bis zu 97 Pixel, sie standen also mitten im Wort
  // abgeschnitten da – und schon bei den bisherigen 92px waren es 87. Zwei
  // Reihen zu vier Pulten geben jedem rund 180px, und damit stehen die Namen
  // wieder ganz da. Kleiner wird dabei nichts: Die Schriftgrade hält
  // pultSchriftAnpassen() weiter an ihrem Boden.
  const MIN_PULT = 92; // dieselbe Zahl wie in host.css als Rückfallwert
  const zweireihig = proPult < MIN_PULT && n > 2;
  const proReihe = zweireihig ? Math.ceil(n / 2) : n;
  // Ein Pixel Luft: Bei exakt aufgehender Rechnung entschied das Runden des
  // Browsers, ob vier oder drei Pulte in eine Reihe passen – gemessen kamen
  // dabei drei Reihen statt zweier heraus.
  const breite = (innen - parseFloat(stil.columnGap || 0) * (proReihe - 1)) / proReihe - 1;
  box.classList.toggle('zweireihig', zweireihig);
  box.style.setProperty('--pult-min', `${Math.floor(breite)}px`);

  // Die schräge Schulter des Trapezes zieht mit der Pultbreite mit, die
  // Polsterung tat es nicht – Begründung und Messwerte stehen in host.css bei
  // `.player`. Gestapelte Pulte sind schmal, dort schneidet nichts: gemessen
  // blieb der Inhalt in jeder Lage von 152 bis 410 Pixeln Pultbreite innerhalb
  // der Fläche. Deshalb greift die Rechnung nur nebeneinander, und auch dort
  // erst ab rund 510 Pixeln Pultbreite – enge Vier-Team-Leisten verlieren
  // keinen Pixel Namensbreite.
  if (box.classList.contains('eng')) box.style.removeProperty('--pult-polster');
  else box.style.setProperty('--pult-polster', `${Math.max(16, Math.ceil(proPult * 0.0276) + 2)}px`);
}

/**
 * Wie groß darf die Schrift am Pult sein?
 *
 * Die clamp()-Grade hängen allein an der Fensterbreite und wissen nichts davon,
 * wie viele Pulte nebeneinanderstehen. Zwei Teams auf einem 1920er Schirm
 * bekommen damit denselben Namen in 16,8 Pixeln wie acht Teams – obwohl das
 * Pult 907 statt 220 Pixel breit ist. Auf dem Bild vom Spielabend stand „OLEK"
 * als Flüstern neben einer dreimal so großen 2350, mit 600 Pixeln Leere
 * dazwischen. Die Datei sagt an anderer Stelle selbst, woran das zu messen ist:
 * „Die Leinwand steht vier Meter weg – kleiner heißt hier unlesbar."
 *
 * Gerechnet wird deshalb hier statt in CSS: Nur host.js kennt die Zahl der
 * Pulte, und nur gemessen lässt sich sagen, was ein Pult wirklich trägt. Vier
 * Grenzen, die kleinste gewinnt, und der Boden aus host.css bleibt der Boden –
 * kleiner als bisher wird nie etwas.
 *
 *  1. Breite, an den echten Namen gemessen. Nicht an einer Zeichenzahl: Ein
 *     Ansatz von zwölf Zeichen wächst genau bis zwölf Zeichen und schneidet
 *     dem dreizehnten den Kopf ab – aus einem abgeschnittenen Namen wurden so
 *     gemessen drei. Gewachsen wird nur in Platz, der wirklich frei ist,
 *     deshalb kann kein Name durch das Wachsen verlorengehen.
 *  2. Höhe. Die Leiste nimmt sich ihre Höhe vom Brett, also hängt die Grenze an
 *     der Fensterhöhe: höchstens 14 Prozent. Das ist billiger, als es klingt –
 *     der Schriftgrad der Kacheln hängt an der Fensterbreite, nicht an der
 *     Bretthöhe. Die Kachel verliert Weißraum, keine Lesbarkeit.
 *  3. Lesbarkeit. Über 1,9rem Name bringt Wachsen nichts mehr: Auf einer zwei
 *     Meter breiten Leinwand sind das rund 21 mm Versalhöhe, und die übliche
 *     Schwelle für vier Meter Abstand liegt bei 20.
 *  4. Der Boden. Unter die bisherigen Grade geht es nie.
 *
 * Das Verhältnis Zahl zu Name rückt dabei von 2,76 auf 2,3 zusammen. Die Zahl
 * bleibt das Größte auf der Leiste – sie ist das, worauf der Raum schaut –,
 * aber der Name hört auf, ihr Anhängsel zu sein.
 */
const PULT_R = 2.3;              // Punktzahl geteilt durch Teamname
const PULT_MITGLIED = 0.75;      // Mitgliederzeile, Anteil am Teamnamen
const PULT_NAME_MAX = 1.9;       // rem – ab hier bringt Wachsen nichts mehr
const PULT_LEISTE_MAX = 0.14;    // Anteil der Fensterhöhe, den die Leiste nehmen darf

function pultSchriftAnpassen(box) {
  const pulte = [...box.querySelectorAll('.player')];
  if (!pulte.length) return;
  for (const p of ['--pult-zahl', '--pult-name', '--pult-mitglied']) box.style.removeProperty(p);

  const stil = getComputedStyle(box);
  const wurzel = getComputedStyle(document.documentElement);
  const bodenZahl = parseFloat(stil.getPropertyValue('--pult-zahl-boden'));
  const bodenName = parseFloat(wurzel.getPropertyValue('--pult-name-boden'));
  const bodenMit = parseFloat(wurzel.getPropertyValue('--pult-mitglied-boden'));
  // Ohne @property (Safari vor 16.4) kommt das unausgerechnete clamp() als Text
  // zurück und parseFloat macht daraus NaN. Dann bleibt es beim CSS-Wert, statt
  // mit NaN zu rechnen – denselben Weg geht pruefeEnge schon.
  if (!bodenZahl || !bodenName || !bodenMit) return;

  const eng = box.classList.contains('eng');
  const spalte = eng ? 0 : parseFloat(getComputedStyle(pulte[0]).columnGap) || 0;

  // Gemessen wird am vollen Namen: Ein bereits gekürzter Name bräuchte weniger
  // Platz, das Wachstum fiele größer aus, und beim nächsten Durchlauf stünde er
  // wieder gekürzt da – die Leiste würde sich hochschaukeln.
  for (const pult of pulte) {
    const nm = pult.querySelector('.pname');
    const letzter = nm.lastChild;
    if (nm.dataset.voll && letzter && letzter.nodeType === 3) letzter.textContent = nm.dataset.voll;
  }

  // Name und Mitgliederzeile stehen in einer gedehnten Spalte – `scrollWidth`
  // liefert dort die Breite des Kastens, nicht die des Textes, und für „OLEK"
  // kämen 711 statt 80 Pixel heraus. Deshalb wird für die Messung kurz auf
  // `max-content` gestellt: `offsetWidth` ist ein Layoutmaß und damit
  // unempfindlich gegen die Transformationen, die auf den Pulten liegen.
  // Erst alle umstellen, dann alle lesen, dann alle zurück – so kostet es ein
  // erzwungenes Layout statt eines pro Pult.
  const felder = pulte.map((pult) => ({
    nm: pult.querySelector('.pname'),
    mi: pult.querySelector('.pmembers'),
    sc: pult.querySelector('.pscore'),
  }));
  for (const f of felder) { f.nm.style.width = 'max-content'; f.mi.style.width = 'max-content'; }
  const roh = felder.map((f) => ({ name: f.nm.offsetWidth, mitglied: f.mi.offsetWidth }));
  for (const f of felder) { f.nm.style.removeProperty('width'); f.mi.style.removeProperty('width'); }

  const bedarf = pulte.map((pult, i) => {
    const pStil = getComputedStyle(pult);
    const scStil = getComputedStyle(felder[i].sc);
    // Das Polster der Pille steht in rem und wächst nicht mit dem Grad mit.
    const pillePolster = parseFloat(scStil.paddingLeft) + parseFloat(scStil.paddingRight);
    // Gerechnet wird mit dem größten Punktestand, der kommen kann („−1000"),
    // nicht mit dem aktuellen – genau wie in pruefeEnge und aus demselben
    // Grund: Sonst schrumpfte die Schrift im Laufe des Abends jedes Mal, wenn
    // eine Pille eine Stelle dazubekommt, und die ganze Leiste zappelte.
    // Gemessen wanderte die Leistenhöhe so binnen einer Runde von 124 über 118
    // auf 108 Pixel. Die Ziffern stehen tabellarisch, also ist die Breite einer
    // Ziffer die Breite jeder anderen.
    const stellen = Math.max(1, felder[i].sc.textContent.trim().length);
    const jeZiffer = Math.max(0, felder[i].sc.offsetWidth - pillePolster) / stellen;
    return {
      platz: pult.clientWidth - parseFloat(pStil.paddingLeft) - parseFloat(pStil.paddingRight) - spalte,
      name: roh[i].name,
      mitglied: roh[i].mitglied,
      ziffern: jeZiffer * 5,
      pillePolster,
    };
  });

  // 1. Breite. Nebeneinander teilen sich Name und Pille die Zeile, gestapelt
  //    steht jedes für sich auf voller Breite.
  const ausBreite = Math.min(...bedarf.map((b) => {
    if (eng) {
      const ausName = (b.platz * PULT_R * bodenName) / Math.max(1, b.name);
      const ausPille = ((b.platz - b.pillePolster) * bodenZahl) / Math.max(1, b.ziffern);
      return Math.min(ausName, ausPille);
    }
    const jeZahl = b.name / (PULT_R * bodenName) + b.ziffern / bodenZahl;
    return (b.platz - b.pillePolster) / Math.max(0.001, jeZahl);
  }));

  // 2. Höhe. Zwei Proben statt einer Rechnung aus Zeilenhöhen und Polstern: Die
  //    Leistenhöhe hängt linear am Schriftgrad, zwei Punkte legen die Gerade
  //    fest, und das stimmt auch noch, wenn später jemand ein Polster ändert.
  const setzen = (zahl, name, mitglied) => {
    box.style.setProperty('--pult-zahl', `${zahl}px`);
    box.style.setProperty('--pult-name', `${name}px`);
    box.style.setProperty('--pult-mitglied', `${mitglied}px`);
  };
  const hoeheBei = (zahl) => {
    setzen(zahl, zahl / PULT_R, (zahl / PULT_R) * PULT_MITGLIED);
    return box.offsetHeight;
  };
  const h1 = hoeheBei(bodenZahl);
  const h2 = hoeheBei(bodenZahl * 2);
  const steigung = (h2 - h1) / bodenZahl;
  const ausHoehe = steigung > 0
    ? (innerHeight * PULT_LEISTE_MAX - (h1 - steigung * bodenZahl)) / steigung
    : Infinity;

  // 3. Lesbarkeitsdeckel.
  const rem = parseFloat(wurzel.fontSize) || 16;
  const zahl = Math.max(bodenZahl, Math.min(ausBreite, ausHoehe, PULT_NAME_MAX * rem * PULT_R));

  // Der Name darf nur so weit mit, wie nach der Pille wirklich Platz bleibt –
  // sonst holte das engere Verhältnis 2,3 zurück, was Grenze 1 gerade verhindert.
  const nameAusBreite = Math.min(...bedarf.map((b) => {
    const pille = eng ? 0 : b.ziffern * (zahl / bodenZahl) + b.pillePolster;
    return ((b.platz - pille) * bodenName) / Math.max(1, b.name);
  }));
  const name = Math.max(bodenName, Math.min(zahl / PULT_R, nameAusBreite));
  const mitgliedAusBreite = Math.min(...bedarf.map((b) => {
    const pille = eng ? 0 : b.ziffern * (zahl / bodenZahl) + b.pillePolster;
    return ((b.platz - pille) * bodenMit) / Math.max(1, b.mitglied);
  }));
  const mitglied = Math.max(bodenMit, Math.min(name * PULT_MITGLIED, mitgliedAusBreite));
  setzen(zahl, name, mitglied);
}

// Beim Ziehen des Fensters ändert sich die Breite, ohne dass ein neuer
// Spielstand kommt – sonst bliebe die Leiste bis zum nächsten Zug falsch.
addEventListener('resize', () => {
  const box = $('#players');
  if (box) {
    pruefeEnge(box);
    pultSchriftAnpassen(box);
    pultNamenAnpassen(box);
  }
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
    // Weiche Trennzeichen eines früheren Durchgangs zuerst wieder heraus: Beim
    // Ziehen des Fensters läuft das hier erneut, und sonst sammelten sich die
    // Trennstellen von jeder Zwischenbreite an.
    if (ziel.textContent.includes('\u00AD')) {
      ziel.textContent = ziel.textContent.replace(/\u00AD/g, '');
    }
    // Den Text jetzt festhalten: Gleich hängt die Messsonde als Kind in
    // diesem Element, und `textContent` liefert dann beides hintereinander.
    const roh = ziel.textContent;
    const wort = roh.trim().split(/\s+/)
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
    // Reicht auch die kleinste Stufe nicht, bricht der Browser das Wort
    // irgendwo – ohne Trennstrich, weil dafür ein Silbenwörterbuch für Deutsch
    // nötig wäre, das längst nicht überall installiert ist. Auf einem Board mit
    // acht Kategorien stand auf einem 1024er-Schirm gemessen „NACHBARLÄ /
    // NDER", „FORTGESCHR / ITTENE" und „TIERISCHE SUPERKRÄFT / E".
    //
    // Ein weiches Trennzeichen an der Stelle, an der ohnehin umbrochen wird,
    // macht daraus „NACHBARLÄ- / NDER": Die Trennung sitzt nicht auf der Silbe,
    // aber der Strich sagt „das Wort geht weiter", und genau das fehlte. Der
    // Browser bevorzugt diese Stelle gegenüber einem beliebigen Schnitt.
    // Dieselben zwei Pixel Luft wie oben: „SUPERKRÄFTE" maß auf einem
    // 1024er-Schirm 96 Pixel bei 97 Pixeln Platz, galt damit als passend – und
    // brach in der Zeile trotzdem um, weil das Kästchen den letzten Punkt
    // anders rundet als die Messung.
    if (probe.getBoundingClientRect().width > platz - 2) {
      ziel.textContent = mitTrennstrichen(roh, probe, platz);
    }
    probe.remove();
  }
}

/**
 * Weiche Trennzeichen dort einsetzen, wo der Text sonst hart abgeschnitten
 * würde – gemessen, nicht geraten: Für jedes zu lange Wort wird der längste
 * Anfang gesucht, der noch in die Spalte passt.
 *
 * `probe` ist ein bereits eingehängtes, unsichtbares Element in derselben
 * Schrift; darüber wird gemessen, ohne dass jemand etwas blinken sieht.
 */
function mitTrennstrichen(text, probe, platz) {
  const SHY = '\u00AD';
  return text.split(/(\s+)/).map((teil) => {
    if (/^\s*$/.test(teil)) return teil;
    probe.textContent = teil;
    if (probe.getBoundingClientRect().width <= platz - 2) return teil;
    let rest = teil;
    let raus = '';
    // Höchstens vier Trennungen: Ein Wort, das danach immer noch nicht passt,
    // ist für diese Spalte ohnehin verloren, und die Schleife soll enden.
    for (let runde = 0; runde < 4 && rest.length > 3; runde++) {
      let passt = 1;
      for (let i = 2; i < rest.length; i++) {
        probe.textContent = `${rest.slice(0, i)}-`;
        if (probe.getBoundingClientRect().width > platz - 2) break;
        passt = i;
      }
      // Mindestens zwei Buchstaben müssen mit hinüber. Sonst stünde bei
      // „Wie wahrscheinlich?" ein Trennstrich vor dem einzelnen Fragezeichen –
      // gemessen wurde genau diese Stelle vorgeschlagen.
      if (passt < 2 || passt >= rest.length) break;
      if (!/[\p{L}\p{N}].*[\p{L}\p{N}]/u.test(rest.slice(passt))) break;
      raus += rest.slice(0, passt) + SHY;
      rest = rest.slice(passt);
      probe.textContent = rest;
      if (probe.getBoundingClientRect().width <= platz - 2) break;
    }
    return raus + rest;
  }).join('');
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
      // Die Zahl kommt vom Server: Nur er kennt die nächste Runde. Hier stand
      // eine Hochrechnung aus dem laufenden Brett – die stimmte nur, solange
      // beide Runden gleich viele Kategorien haben.
      const naechsteSumme = state.naechsteSumme || 0;
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
          el('span', { class: 'sname' }, `${team.wappen} ${team.name}`),
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
  passeStandEin();
  $('#btn-next-round').hidden = final;
  $('#btn-new-game').hidden = !final;
  $('#btn-zusammenfassung').hidden = !final;
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
 * Passt der Endstand auf die Bühne? Nachgemessen statt geschätzt.
 *
 * Ob eng gestellt wurde, entschied bisher allein die Zeilenzahl: ab elf Zeilen
 * enger, darunter großzügig. Das ist eine Schätzung, und sie ging schief. Fünf
 * Teams auf einem 720p-Beamer – ein ganz gewöhnlicher Spieleabend – ergaben
 * neun Zeilen, also „passt schon": Gemessen war das Panel 564 Pixel hoch bei
 * 550 Pixeln Platz. Abgeschnitten wird von unten, und unten stehen die
 * Auszeichnungen und die ganze Knopfreihe. „📋 Zusammenfassung" und „Neues
 * Spiel" endeten 22 Pixel hinter der Kante – lautlos, ohne Bildlaufbalken, ohne
 * Hinweis. Der Host sieht einen Endstand, unter dem es nicht weitergeht.
 *
 * Nachgegeben wird in Stufen, vom Entbehrlichsten her: erst enger stellen, dann
 * die Auszeichnungen von hinten wegnehmen. Kleiner wird dabei nichts – es geht
 * nur Polsterung weg und zuletzt eine Zeile, die ohnehin schon gekürzt wird.
 *
 * Gemessen wird in Layoutmaßen, nie über getBoundingClientRect: Die Liste fährt
 * beim Aufbau von unten herein, und während dieser Bewegung zeigt
 * getBoundingClientRect eine Lage, die es hinterher nicht mehr gibt.
 */
function passeStandEin() {
  requestAnimationFrame(() => {
    const feld = $('#scoreboard');
    const panel = feld?.querySelector('.scores-panel');
    if (!feld || !panel || feld.hidden) return;
    const stil = getComputedStyle(feld);
    const platz = feld.clientHeight
      - parseFloat(stil.paddingTop || 0) - parseFloat(stil.paddingBottom || 0);
    if (!platz) return;
    // Das Kopfschild sitzt halb über der oberen Panelkante und zählt in
    // offsetHeight nicht mit – sein Überstand gehört trotzdem dazu.
    const kopf = panel.querySelector('.q-head');
    const kopfUeber = kopf ? kopf.offsetHeight / 2 : 0;
    const passt = () => panel.offsetHeight + kopfUeber <= platz + 1;

    // Erst alles zurück auf großzügig, sonst bliebe eine einmal weggenommene
    // Auszeichnung den Rest des Abends weg.
    const rekorde = $('#rekorde');
    const zeilen = rekorde ? [...rekorde.children] : [];
    for (const z of zeilen) z.hidden = false;
    panel.classList.remove('voll');
    if (passt()) return;

    panel.classList.add('voll');
    for (let i = zeilen.length - 1; i >= 0 && !passt(); i--) zeilen[i].hidden = true;
  });
}

// Ein gedrehtes iPad oder ein Fenster, das schmaler gezogen wird, ändert den
// Platz – dann gilt die Rechnung von eben nicht mehr.
addEventListener('resize', passeStandEin);

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
  // Mit Wappen wie in der Rangliste direkt darüber – die beiden Listen stehen
  // untereinander im selben Kasten, und dieselben Teams sollen darin gleich
  // aussehen.
  const name = (id) => {
    const t = state.teams.find((x) => x.id === id);
    return t ? `${t.wappen} ${t.name}` : '?';
  };
  const zeilen = [];

  // Dieselbe Aufzählung wie überall sonst. Hier stand eine zweite, eigene
  // Fassung, und die zählte schon ab drei Namen: Bei genau drei Teams – der
  // häufigsten Runde überhaupt – hieß die Auszeichnung „🦊 A, 🐻 B und 1
  // weitere". Das ist grammatisch falsch und länger, als die drei einfach zu
  // nennen. `aufzaehlung` fängt genau diesen Fall ab und zählt erst ab vier.
  const nenne = (teams) => aufzaehlung(teams.map((t) => `${t.wappen} ${t.name}`));


  if (r.schnellsterBuzz) {
    const s = (r.schnellsterBuzz.ms / 1000).toFixed(2).replace('.', ',');
    // Im Rekord steht der Name, wie er zum Zeitpunkt des Buzzes hieß. Das
    // Wappen kommt aus dem Team, falls es das noch gibt.
    const wer = state.teams.find((t) => t.id === r.schnellsterBuzz.teamId);
    zeilen.push(['⚡ Schnellster Buzz',
      `${wer ? `${wer.wappen} ${wer.name}` : r.schnellsterBuzz.name} – ${s} s`]);
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
    zeilen.push(['🤷 Ehrlichste Haut', `${nenne(ehrlich.wer)} – ${ehrlich.best}× „weiß nicht“`]);
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
  // Wie viele Schritte noch gehen, steht im Titel: Seit der Rückweg ein Stapel
  // ist, kann der Host mehrfach tippen – ohne die Zahl weiß er nicht, ob der
  // nächste Tipp noch etwas bewirkt.
  const tiefe = state.rueckwegTiefe || 1;
  const zusatz = tiefe > 1 ? ` (${tiefe} Schritte möglich)` : '';
  knopf.title = `${was} zurücknehmen${zusatz}`;
  knopf.setAttribute('aria-label', `${was} zurücknehmen${zusatz}`);
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
  // Mit Wappen wie überall sonst – die Leiste ist die Zeile, auf die der Host
  // schaut, während der Raum auf die Pulte schaut.
  const teamName = (id) => {
    const t = state.teams.find((x) => x.id === id);
    return t ? `${t.wappen} ${t.name}` : '?';
  };

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
  // Der Bezugspunkt für die Anlaufsperre kennt die Handys nicht.
  //
  // Die Leiste baut sich auch neu, wenn nur ein Handy aus dem Standby kommt
  // oder wegfällt – daran hängen die Vertreterknöpfe. Die Wertungsknöpfe
  // stehen dabei unverändert an derselben Stelle, wurden aber trotzdem
  // 400 ms taub, weil sie frische Knoten waren. Gemessen: Handy sperrt sich,
  // Host drückt „Richtig" – nichts passiert. Deshalb zählt hier nur, was die
  // Bedeutung der Knöpfe ausmacht.
  const wertungsLage = [
    state.phase, q?.step, q?.buzzedTeamId, q?.teamId,
    (q?.lockedOut || []).join(','), state.stechenSieger,
  ].join('#');
  const seit = lageSeit('leiste', wertungsLage);
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
          ? 'Gleichstand – „Stechen“ holt die Entscheidungsfrage.'
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
      ? `${teamName(q.teamId)} antwortet. Falsch oder „weiß nicht“ kostet ${abzug}.`
      : `${teamName(q.teamId)} antwortet.`);
    add(
      button('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), '1', seit),
      button('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), '2', seit),
      button('Weiß nicht → Buzzer frei', 'btn-ghost', () => act('pass'), '3', seit),
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
      button('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), '1', seit),
      button('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), '2', seit),
      button('Buzz zurücknehmen', 'btn-ghost btn-sm', () => act('resetBuzz'), null, seit),
    );
  } else if (q.stechen) {
    // Nach der Stechfrage geht es zurück in den Endstand – mit Sieger oder für
    // die nächste Frage. Der Knopf sagt, was von beidem gleich passiert.
    setzeText(hint, state.stechenSieger
      ? `${teamName(state.stechenSieger)} gewinnt den Abend.`
      : 'Das wusste keiner – zurück zum Endstand.');
    add(button(state.stechenSieger ? 'Zum Endstand' : 'Weiter', 'btn-primary', () => act('close'), 'Leertaste', seit));
  } else {
    setzeText(hint, 'Frage beendet.');
    add(button('Weiter', 'btn-primary', () => act('close'), 'Leertaste', seit));
  }
}

/**
 * Ein Knopf der Steuerleiste – 400 ms lang taub, so wie auf der Fernbedienung.
 *
 * Die Leiste tauscht sich mitten im Zug aus: Buzzert ein Handy, während der
 * Host schon auf „Keiner weiß es → auflösen" zielt, stehen im selben Moment
 * „Richtig ✓ / Falsch ✗ / Buzz zurücknehmen" dort. Der Klick, den niemand mehr
 * abbremsen kann, landet dann auf einem Knopf, den der Host nie gemeint hat –
 * nachgestellt gab er dem Team, das gerade gebuzzert hatte, ein „Falsch" samt
 * 50 Punkten Abzug. Der Lage-Riegel greift dagegen nicht: Die Kennung kommt aus
 * demselben Zustand, der den Knopf getauscht hat, passt also.
 *
 * Die Fernbedienung kennt diesen Schutz längst (big() in remote.js), der
 * Zurücknehmen-Knopf auch – die Leiste auf der Leinwand war die letzte ohne.
 */
function button(label, cls, onclick, key, seit = performance.now()) {
  const node = el('button', {
    class: `btn ${cls}`,
    onclick: () => {
      if (performance.now() - seit < 400) return;
      onclick();
    },
  }, label);
  if (key) node.append(el('kbd', {}, key));
  return node;
}

/**
 * Seit wann diese Lage gilt – der Bezugspunkt für die Anlaufsperre oben.
 *
 * Die Sperre schützt davor, dass ein Knopf unter dem Daumen ausgetauscht wird.
 * Sie hing bisher an der Geburt des Knotens, und das war zu streng: Die Leisten
 * bauen sich auch neu, wenn sich nur eine Zahl geändert hat. Im Menü hieß das,
 * dass jede angekommene Punktekorrektur die Knöpfe erneuerte und damit für
 * 400 ms taub machte – gemessen kamen von drei zügigen Tipps auf „+100" genau
 * einer an, von fünf zwei. Wer 300 Punkte nachtragen wollte, trug 100 nach.
 *
 * Gezählt wird deshalb ab dem Moment, in dem sich die Bedeutung geändert hat.
 * Bleibt die Knopfreihe dieselbe, bleibt auch ihr Bezugspunkt stehen, und der
 * ist längst abgelaufen.
 */
const lagenSeit = new Map();
function lageSeit(name, signatur) {
  const alt = lagenSeit.get(name);
  if (!alt || alt.signatur !== signatur) {
    lagenSeit.set(name, { signatur, seit: performance.now() });
    return performance.now();
  }
  return alt.seit;
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
    // `color` mit setzen: Der Schein um den Punkt kommt aus currentColor
    // (host.css .buzz-fuer .dot). Ohne das erbte er die Textfarbe des Knopfes
    // und leuchtete weißlich – bei acht Knöpfen nebeneinander war die
    // Teamfarbe damit genau am auffälligsten Teil nicht abzulesen.
    el('span', { class: 'dot', style: { background: team.color, color: team.color } }),
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
/**
 * Der Abend als Text, zum Weiterschicken.
 *
 * Endstand, Auszeichnungen und Bilanz stehen am Ende auf der Leinwand – und
 * sind zehn Minuten später weg. Am nächsten Tag fragt jemand im Gruppenchat
 * „wie ging das nochmal aus?", und die Antwort ist ein Foto vom Fernseher.
 *
 * Rangliste und Auszeichnungen werden aus dem gelesen, was auf der Leinwand
 * steht, nicht ein zweites Mal berechnet: Sonst gäbe es zwei Fassungen
 * derselben Auswertung, und die eine liefe der anderen irgendwann davon. Die
 * Bilanz je Team kommt aus dem Spielstand, die steht ohnehin nirgends.
 */
function zusammenfassung() {
  const zeilen = [];
  zeilen.push('Quizduell – Spieleabend');
  const wann = new Date().toLocaleDateString('de-DE',
    { day: '2-digit', month: 'long', year: 'numeric' });
  zeilen.push(`${state.setName || 'Fragensatz'} · ${wann}`);
  zeilen.push('');

  const sieger = $('#score-winner');
  if (sieger && !sieger.hidden && sieger.textContent.trim()) zeilen.push(sieger.textContent.trim());

  for (const li of $('#score-list').children) {
    // Die Zeile steht als Platz / Name / Punkte im DOM; zusammengesetzt ergibt
    // das genau das, was der Raum gerade gelesen hat.
    const teile = [...li.children].map((n) => n.textContent.trim()).filter(Boolean);
    // Der Platz steht auf der Leinwand als bloße Ziffer in einer eigenen Spalte.
    // In einer Textzeile braucht er den Punkt, sonst liest sich „1 🐻 Rakete
    // Gladbach 8400" wie zwei Zahlen um einen Namen herum.
    if (/^\d+$/.test(teile[0] || '')) teile[0] += '.';
    zeilen.push(teile.join(' '));
  }

  const rek = $('#rekorde');
  if (rek && !rek.hidden && rek.children.length) {
    zeilen.push('', 'Auszeichnungen');
    for (const r of rek.children) {
      zeilen.push([...r.children].map((n) => n.textContent.trim()).join(': '));
    }
  }

  zeilen.push('', 'Bilanz');
  for (const t of [...state.teams].sort((a, b) => b.score - a.score)) {
    const b = t.bilanz || {};
    const teile = [
      `${b.richtig || 0} richtig`,
      `${b.falsch || 0} falsch`,
      `${b.gepasst || 0}× weiß nicht`,
    ];
    if (b.geklaut) teile.push(`${b.geklaut}× gebuzzert`);
    if (t.serieBest >= 3) teile.push(`beste Serie ${t.serieBest}`);
    zeilen.push(`${t.wappen} ${t.name}: ${teile.join(', ')}`);
  }
  return zeilen.join('\n');
}

$('#btn-zusammenfassung').addEventListener('click', async () => {
  const text = zusammenfassung();
  // Die Zwischenablage gibt es nur im sicheren Kontext. Auf localhost – dem
  // Normalfall für den Host-Screen – ist das gegeben; wer die Seite über die
  // WLAN-Adresse geöffnet hat, bekommt sie nicht. Dann der Rückfallweg, statt
  // einer Fehlermeldung ohne Ausweg.
  try {
    await navigator.clipboard.writeText(text);
    toast('Zusammenfassung kopiert.', 'ok');
  } catch {
    const feld = $('#zus-text');
    feld.value = text;
    $('#zusammenfassung').hidden = false;
    feld.focus();
    feld.select();
  }
});
$('#btn-zus-zu').addEventListener('click', () => { $('#zusammenfassung').hidden = true; });
$('#zusammenfassung').addEventListener('click', (ev) => {
  if (ev.target.id === 'zusammenfassung') $('#zusammenfassung').hidden = true;
});

$('#btn-new-game').addEventListener('click', () => act('backToLobby'));
$('#btn-menu').addEventListener('click', openMenu);
$('#btn-close-menu').addEventListener('click', closeMenu);
$('#menu').addEventListener('click', (ev) => {
  if (ev.target.id === 'menu') closeMenu();
});
$('#btn-pause').addEventListener('click', () => {
  act('pause', { an: !state.pause });
  closeMenu();
});

// Mit Rückfrage: Wer hier tippt, streicht eine Frage samt ihrer Wertungen.
// Zurücknehmen geht zwar, aber erst muss man merken, dass man danebentippte.
$('#btn-discard').addEventListener('click', () => {
  const q = state.current;
  if (!q) return;
  if (!confirm(`„${q.category} · ${q.value} Punkte" streichen?\n\n`
    + 'Die Frage zählt nicht, das Feld bleibt offen, und alles, was an ihr hing,'
    + ' wird zurückgerechnet.')) return;
  act('discard');
  closeMenu();
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
  // Streichen geht nur bei einer laufenden Brettfrage – eine Stechfrage hat
  // kein Feld, auf das etwas zurückfallen könnte.
  $('#btn-discard').hidden = !state.current || !!state.current.stechen;
  setzeText($('#btn-pause'), state.pause ? '▶ Weiterspielen' : '⏸ Pause');
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
  // Der Punktestand steht bewusst NICHT im Schlüssel – sonst baut jede
  // angekommene Korrektur die Reihe neu, und die frischen Knöpfe wären wieder
  // taub. Er wird stattdessen nachgetragen, so wie die Mitgliederzeile am Pult.
  // Die Zahl der abgemeldeten Geräte gehört dagegen hinein: Von ihr hängt ab,
  // ob es den Knopf „Offline entfernen" überhaupt gibt.
  const key = state.teams.map((t) => `${t.id}:${t.name}:${t.wappen}:${t.members.some((m) => !m.online) ? 1 : 0}`).join('|')
    + `#${state.turnIndex}`;
  const seit = lageSeit('menu', key);
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.innerHTML = '';
    for (const team of state.teams) {
      const offline = team.members.filter((m) => !m.online);
      list.append(
        el('li', { 'data-team': team.id },
          el('span', { class: 'dot', style: { background: team.color } }),
          el('span', { class: 'tname' },
            `${team.wappen} ${team.name}`,
            offline.length
              ? el('span', { class: 'muted small offline-zahl' }, ` · ${offline.length} offline`)
              : null),
          el('span', { class: 'sc' }, punkte(team.score)),
          button('−100', 'btn-sm btn-ghost', () => act('adjustScore', { teamId: team.id, delta: -100 }), null, seit),
          button('+100', 'btn-sm btn-ghost', () => act('adjustScore', { teamId: team.id, delta: 100 }), null, seit),
          button('dran', 'btn-sm btn-ghost', () => act('setTurn', { teamId: team.id }), null, seit),
          offline.length
            ? button('Offline entfernen', 'btn-sm btn-ghost', () => {
              const weg = (state.teams.find((t) => t.id === team.id)?.members || []).filter((m) => !m.online);
              for (const m of weg) act('removeMember', { teamId: team.id, clientId: m.clientId });
            }, null, seit)
            : null,
        ),
      );
    }
  }
  // Punktestand und Zahl der abgemeldeten Geräte nachtragen, ohne die Reihe
  // anzufassen – die Knöpfe bleiben damit stehen und bedienbar.
  for (const zeile of list.children) {
    const team = state.teams.find((t) => t.id === zeile.dataset.team);
    if (!team) continue;
    setzeText(zeile.querySelector('.sc'), punkte(team.score));
    const offline = team.members.filter((m) => !m.online).length;
    const zahl = zeile.querySelector('.offline-zahl');
    if (zahl) setzeText(zahl, ` · ${offline} offline`);
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
  zeilen.push(['Zugteam falsch oder „weiß nicht“', {
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
  if (s.buzzUhr) {
    zeilen.push(['Uhr beim Buzzer', `${s.buzzUhr} Sekunden – sie zeigt nur die Zeit, gewertet wird nichts`]);
  }
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
  // Der häufigste Fall ist nicht der nächste Samstag, sondern der Absturz
  // mitten im Abend: Server weg, Server wieder da, und der Host hat die ganze
  // Zeit davorgesessen. „Spielstand von heute, 21:14 Uhr wiederhergestellt"
  // klingt dann nach einem alten Stand von irgendwann – gemeint ist „von vor
  // zehn Sekunden". Unter fünf Minuten sagt der Balken das auch so.
  const minuten = Math.round((jetzt - dann) / 60000);
  if (minuten < 1) return 'von gerade eben';
  if (minuten < 5) return `von vor ${minuten === 1 ? 'einer Minute' : `${minuten} Minuten`}`;
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
  // Strg, Cmd und Alt gehören dem Browser, nicht dem Spiel.
  //
  // Ohne diese Zeile feuerten die Spieltasten als Teil ganz gewöhnlicher
  // Browser-Kürzel mit: Strg+1 bis Strg+4 (Tab wechseln) wertete die laufende
  // Frage, Strg+L (Adresszeile) deckte die Lösung auf der Leinwand auf, und
  // Strg+F schaltete aufs Vollbild und schluckte die Suchleiste gleich mit.
  // Der Browser führt sein Kürzel dabei trotzdem aus – die Wertung passiert
  // also hinter dem Rücken des Hosts, der nur den Tab wechseln wollte.
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
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
