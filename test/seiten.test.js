/*
 * Wachhunde für die Seiten selbst.
 *
 * Anlass: Beim Spiel über den Tunnel blieb auf dem Handy eines Gastes eine
 * vollkommen leere dunkle Seite stehen. Ursache war ein `localStorage`-Zugriff
 * beim Laden des Moduls – in einem privaten Fenster wirft der, das Skript
 * stirbt, und weil alle Ansichten erst per JavaScript sichtbar geschaltet
 * werden, bleibt buchstäblich nichts übrig.
 *
 * Ein Browser lässt sich hier nicht starten. Diese Tests lesen deshalb die
 * Dateien: Sie halten die beiden Regeln fest, die den Fall unmöglich machen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const lies = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');

// Kommentare zählen nicht mit: In ihnen steht der Name absichtlich.
function ohneKommentare(quelle) {
  return quelle
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SEITEN = ['player.js', 'host.js', 'remote.js', 'common.js'];

test('kein ungeschützter Zugriff auf localStorage', () => {
  for (const datei of SEITEN) {
    const zeilen = ohneKommentare(lies(datei)).split('\n');
    const treffer = zeilen
      .map((z, i) => [i + 1, z])
      .filter(([, z]) => /localStorage/.test(z));
    // In common.js gehören genau die beiden Zeilen in lies()/merke() dazu –
    // die stehen dort in try/catch. Überall sonst läuft der Zugriff über
    // diese beiden Funktionen.
    const erlaubt = datei === 'common.js' ? 2 : 0;
    assert.equal(
      treffer.length,
      erlaubt,
      `${datei}: localStorage steht in Zeile(n) ${treffer.map(([n]) => n).join(', ')} `
      + '– im privaten Modus wirft schon der Zugriff, und das Modul stirbt beim Laden. '
      + 'Bitte lies()/merke() aus common.js benutzen.',
    );
  }
});

test('jede Seite hat die Startwache und gibt ein Lebenszeichen', () => {
  for (const [seite, skript] of [
    ['player.html', 'player.js'],
    ['host.html', 'host.js'],
    ['remote.html', 'remote.js'],
  ]) {
    const html = lies(seite);
    assert.match(
      html,
      /<script src="\/start-wache\.js"><\/script>/,
      `${seite} lädt die Startwache nicht – ein Absturz beim Laden bliebe eine leere Seite`,
    );
    // Die Wache muss vor dem Modul stehen, sonst verpasst sie dessen Fehler.
    assert.ok(
      html.indexOf('/start-wache.js') < html.indexOf(`/${skript}`),
      `${seite}: die Startwache muss vor ${skript} geladen werden`,
    );
    assert.match(
      ohneKommentare(lies(skript)),
      /window\.quizduellLaeuft = true;/,
      `${skript} meldet der Startwache nicht, dass die Seite steht – sie würde grundlos anschlagen`,
    );
  }
});

test('die Startwache selbst ist kein Modul und hat keine Importe', () => {
  const quelle = lies('start-wache.js');
  assert.doesNotMatch(quelle, /\bimport\b|\bexport\b/, 'sonst stirbt sie an demselben Problem wie das Modul');
  assert.match(quelle, /window\.quizduellLaeuft/, 'sie muss das Lebenszeichen abfragen');
});

test('die Spieleransicht zeigt die Anmeldung schon vor dem ersten Spielstand', () => {
  assert.match(
    ohneKommentare(lies('player.js')),
    /\$\('#view-join'\)\.classList\.add\('active'\)/,
    'ohne diese Zeile bleibt das Handy leer, solange die Verbindung hakt',
  );
});

/*
 * Der Notweg und der Meldeweg.
 *
 * Anlass: Beim Spiel über den Tunnel bekam ein iPhone nie einen Spielstand –
 * die Anmeldung stand da, aber ohne ein einziges Team und ohne ein Wort dazu.
 * Ein Ereignisstrom ist eine Antwort, die nie endet; wird sie unterwegs
 * gepuffert oder abgewiesen, passiert auf dem Handy gar nichts. Seitdem holt
 * sich die Seite den Zustand notfalls selbst ab und sagt, woran es hängt.
 */

test('bleibt der Ereignisstrom stumm, holt die Seite den Zustand selbst', () => {
  const quelle = ohneKommentare(lies('common.js'));
  assert.match(quelle, /\/api\/state\?clientId=/, 'ohne diesen Notweg hängt der Abend am Ereignisstrom allein');
  assert.match(quelle, /setTimeout\(\s*\(\)\s*=>\s*notwegAuf\(/, 'der Notweg muss von selbst aufmachen, nicht erst auf einen Fehler warten');
  assert.match(quelle, /addEventListener\('error'[\s\S]{0,400}notwegAuf\(/, 'und auch dann, wenn der Strom abgewiesen wird');
  assert.match(quelle, /stromKam = true;[\s\S]{0,120}notwegZu\(\)/, 'sobald der Strom liefert, muss der Notweg wieder zumachen');
});

test('ein Fehler beim Zeichnen verschwindet nicht mehr lautlos', () => {
  const quelle = ohneKommentare(lies('common.js'));
  assert.match(
    quelle,
    /try \{\s*onState\(sicht\);[\s\S]{0,120}\} catch \(err\) \{\s*panne\(err/,
    'wirft das Zeichnen, fror die Seite bisher ein und behauptete dabei, alles sei in Ordnung',
  );
  assert.match(quelle, /window\.quizduellPanne\?\.\(/, 'der Meldeweg führt zur Startwache');
  assert.match(ohneKommentare(lies('start-wache.js')), /window\.quizduellPanne = function/, 'und die muss ihn bereitstellen');
});

test('die Handys sagen, woran es hängt, solange kein Spielstand da ist', () => {
  for (const datei of ['player.js', 'remote.js']) {
    assert.match(
      ohneKommentare(lies(datei)),
      /onStatus:\s*\(text\)\s*=>/,
      `${datei}: ohne diese Zeile steht auf dem Handy eine leere Anmeldung ohne Erklärung`,
    );
  }
});

test('was oben über allem liegt, rechnet den Streifen unter der Uhr mit', () => {
  // Die Handyseiten stehen auf `viewport-fit=cover`: Die Layoutfläche reicht
  // bis unter Statusleiste und Notch. Ein Kasten mit `top: 0` sitzt dort also
  // hinter der Uhrzeit. Gemessen: Der Offline-Balken ist 43 px hoch, der
  // verdeckte Streifen auf iPhones ab dem X 44 bis 59 px – der Balken war
  // vollständig unsichtbar, den ganzen Abend, ohne dass es jemandem auffiel.
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  for (const regel of ['.offline', '.pannenstreifen', '.startwache']) {
    const block = new RegExp(`\\${regel} \\{[^}]*\\}`).exec(css)?.[0] || '';
    assert.ok(block, `${regel} steht nicht in style.css`);
    assert.match(
      block,
      /env\(safe-area-inset-top, 0px\)/,
      `${regel} liegt sonst hinter der Statusleiste – mit Rückfallwert, sonst fällt die ganze Regel weg`,
    );
  }
});

/*
 * Die Auskunft, die auf dem Foto fehlte.
 *
 * Ein Gastgeber schickt ein Bild seines Handys – mehr bekommt eine
 * Ferndiagnose nicht. Auf diesem Bild muss stehen, ob die Verbindung steht und
 * bloß nichts kommt, ob sie abgewiesen wird oder ob sie abreißt. Sonst kostet
 * dieselbe Frage wieder einen Abend.
 */

test('die Anmeldung hat eine Verbindungszeile, die nie leer ist', () => {
  const html = lies('player.html');
  assert.match(html, /id="verbindung"[^>]*>Verbinde mit dem Spiel/, 'sie muss schon im HTML einen Satz tragen – vor dem ersten Skript');
  assert.match(html, /id="verbindung"[^>]*aria-live/, 'und vorgelesen werden');
  // Und sie darf nicht am Hinweissatz von renderJoin() hängen: Der wird beim
  // ersten Spielstand überschrieben, die Verbindungszeile soll den ganzen
  // Abend schreibbar bleiben.
  assert.match(
    ohneKommentare(lies('player.js')),
    /onStatus:\s*\(text\)\s*=>\s*setzeText\(\$\('#verbindung'\)/,
    'die Statusmeldung gehört in die eigene Zeile, nicht in #join-hint',
  );
});

test('das Handy kann seine Lage berichten', () => {
  assert.match(lies('player.html'), /id="btn-lage"/, 'ohne Knopf keine Auskunft');
  const js = ohneKommentare(lies('player.js'));
  for (const zeile of ['Bau', 'Adresse', 'Weg', 'Strom', 'Fehler', 'Gerät']) {
    assert.match(js, new RegExp(`\`${zeile}\\s`), `der Lagebericht braucht die Zeile „${zeile}"`);
  }
  assert.match(ohneKommentare(lies('common.js')), /export function verbindungsLage/, 'die Zahlen kommen aus common.js');
  assert.match(ohneKommentare(lies('common.js')), /padding-top:env\(safe-area-inset-top/, 'der Rand oben wird gemessen, nicht geraten');
});

test('das zweite Lebenszeichen kommt erst mit dem ersten Spielstand', () => {
  assert.match(
    ohneKommentare(lies('common.js')),
    /onState\(sicht\);[\s\S]{0,80}window\.quizduellSpielt = true;/,
    'es darf erst fallen, wenn wirklich gezeichnet wurde – „Modul durchgelaufen" reicht nicht',
  );
  assert.match(
    ohneKommentare(lies('start-wache.js')),
    /quizduellSpielt === true\) return;/,
    'und die Wache muss danach fragen, sonst ist sie nach 40 ms blind',
  );
});

test('der Notweg macht handlungsfähig und wird am Buzzer schneller', () => {
  const quelle = ohneKommentare(lies('common.js'));
  // Ohne den Nachweis sieht das Handy alles und darf nichts: Schon das Öffnen
  // des Stroms legt für die Kennung ein Geheimnis an, ausgeliefert wird es aber
  // nur über genau den Strom, der nicht ankommt.
  assert.match(
    quelle,
    /merkeGeheim\(sicht\.geheim\)/,
    'ohne diese Zeile prallt jeder Zug mit „Dieses Gerät gehört jemand anderem" ab',
  );
  // Und der Takt: Zwischen den Fragen gemächlich, am Buzzer schnell – sonst
  // verliert jedes Handy im Notweg jeden Wettlauf gegen eine Live-Verbindung.
  assert.match(quelle, /ABFRAGE_TAKT_HEISS = (\d+)/, 'es braucht einen schnellen Takt');
  const ruhig = Number(/ABFRAGE_TAKT = (\d+)/.exec(quelle)[1]);
  const heiss = Number(/ABFRAGE_TAKT_HEISS = (\d+)/.exec(quelle)[1]);
  assert.ok(heiss < ruhig, `der schnelle Takt (${heiss}) muss kürzer sein als der ruhige (${ruhig})`);
  assert.ok(heiss <= 500, `${heiss} ms sind am Buzzer zu träge`);
  assert.match(quelle, /sicht\.phase === 'question'/, 'umgeschaltet wird an der laufenden Frage');
});

test('das Handy lässt seine Anfrage liegen, statt im Takt zu fragen', () => {
  const quelle = ohneKommentare(lies('common.js'));
  assert.match(quelle, /&seit=\$\{letzteNummer\}/, 'ohne „seit" kann der Server die Anfrage nicht halten');
  assert.match(quelle, /async function notwegSchleife/, 'die Schleife ersetzt den Wecker');
  // Und der Riegel gegen das Freidrehen: Antwortet ein Server sofort und
  // unverändert, darf die Schleife nicht so schnell fragen, wie die Leitung
  // hergibt. Genau das ist bei einer Gegenprobe passiert.
  assert.match(quelle, /haeltNichts = warten && letzteNummer != null && letzteNummer === vorher/);
  assert.match(quelle, /letzteNummer == null \|\| haeltNichts\) await schlaf/);
});

/*
 * Der goldene Rand bei freigegebenem Buzzer.
 *
 * Gemeldet als „sieht unclean aus", und beim Nachmessen waren es zwei Fehler:
 * Der Ring saß 3px neben der Kante (Kästchen um 3px nach außen UND 3px breiter
 * Schatten), sodass am Rand drei Linien nebeneinander standen – und er wurde
 * über das Kategorieschild gemalt, weil ein Pseudo-Element nach den Kindern an
 * die Reihe kommt. Der gelbe Strich lief quer durch „UNI-LATEIN 500".
 */

test('der goldene Rand liegt bündig auf der Kante', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'host.css'), 'utf8');
  const block = (wahl) => new RegExp(`\\${wahl} \\{[^}]*\\}`).exec(css)?.[0] || '';
  const wert = (b, eigenschaft) => new RegExp(`${eigenschaft}:\\s*([^;]+);`).exec(b)?.[1]?.trim();

  const panel = block('.q-panel');
  const ring = block('.q-panel::after');
  assert.ok(panel && ring, 'Panel und Ring müssen beide in host.css stehen');
  assert.equal(wert(ring, 'inset'), '0', 'der Ring darf nicht neben der Kante schweben');
  assert.equal(
    wert(ring, 'border-radius'),
    wert(panel, 'border-radius'),
    'gleicher Radius wie das Panel – sonst laufen die Ecken auseinander',
  );
});

test('das Kategorieschild liegt über dem Rand, nicht darunter', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'host.css'), 'utf8');
  const zIndex = (wahl) => {
    const b = new RegExp(`\\${wahl} \\{[^}]*\\}`).exec(css)?.[0] || '';
    return Number(/z-index:\s*(-?\d+)/.exec(b)?.[1] ?? 'NaN');
  };
  const schild = zIndex('.q-head');
  const ring = zIndex('.q-panel::after');
  assert.ok(Number.isFinite(schild), '.q-head braucht einen z-index');
  assert.ok(Number.isFinite(ring), '.q-panel::after braucht einen z-index');
  assert.ok(schild > ring, `das Schild (${schild}) muss über dem Ring (${ring}) liegen`);
});

test('der Knopf verspricht einen Austausch – und der Server hält ihn', () => {
  for (const seite of ['host.html', 'remote.html']) {
    assert.match(
      lies(seite),
      /Frage austauschen/,
      `${seite}: „Feld bleibt offen" war die halbe Wahrheit – dieselbe Frage kam Wort für Wort zurück`,
    );
  }
});

/*
 * Ein einzelnes Team ist noch kein Duell.
 *
 * „Spiel starten" bleibt gesperrt, solange nur ein Team dasteht (host.js:
 * `teams.length < 2`). Die Zeile darüber meldete in genau dieser Lage aber
 * „1 Handy verbunden – alle 1 Teams sind dabei." – grün gesetzt, weil `bereit`
 * galt. Der Host las also „alles da", drückte auf einen toten Knopf und suchte
 * den Fehler bei den Handys, statt den zweiten Namen eintippen zu lassen.
 * Nebenbei stand da deutsch falsch „alle 1 Teams".
 *
 * Die Zeile steht auf Leinwand UND Fernbedienung – beide holen sie hier.
 */
test('mit einem Team meldet die Lobby nicht „alles bereit"', async () => {
  const { anschlussStand } = await import('../public/common.js');
  const team = (name, amHandy) => ({
    id: name, name, members: amHandy ? [{ name, online: true }] : [],
  });

  for (const teams of [[team('Nils', true)], [team('Nils', false)]]) {
    const { text, bereit } = anschlussStand({ teams });
    assert.equal(bereit, false,
      `ein Team darf nie „bereit" sein – der Startknopf ist dann gesperrt: „${text}"`);
    assert.match(text, /zweites Team/,
      `die Zeile muss den wahren Grund nennen, nicht die Handys: „${text}"`);
  }

  // Ab zwei Teams bleibt es beim alten Satz – und der zählt richtig.
  const zwei = anschlussStand({ teams: [team('Nils', true), team('Mira', true)] });
  assert.equal(zwei.bereit, true);
  assert.match(zwei.text, /alle 2 Teams sind dabei/);

  // „alle 1 Teams" darf in keiner Lage mehr herauskommen.
  for (const teams of [[], [team('A', true)], [team('A', true), team('B', false)]]) {
    assert.doesNotMatch(anschlussStand({ teams }).text, /alle 1 Teams/);
  }
});

/*
 * Die Herkunft einer Ersatzfrage steht auf allen drei Schirmen.
 *
 * `viewFor` schickt `ersatzAus` ausdrücklich an alle mit – der Kommentar dort
 * sagt „Auch die Handys zeigen die Herkunft: Auf dem kleinen Schirm steht sonst
 * eine Kategorie, zu der die Frage nicht passt." Leinwand und Fernbedienung
 * taten es, das Handy nicht: Dort stand nach einem Austausch „Uni-Latein · 500
 * Punkte" über einer Frage aus einem ganz anderen Fach.
 */
test('nach einem Austausch nennt jeder Schirm die Herkunft der Frage', () => {
  for (const datei of ['host.js', 'player.js', 'remote.js']) {
    assert.match(
      ohneKommentare(lies(datei)),
      /ersatzAus/,
      `${datei}: die Kategorie über der Frage verschweigt, dass sie ausgetauscht wurde`,
    );
  }
});

/*
 * „Noch zu früh" darf nicht dem Zugteam und nicht in der Pause erscheinen.
 *
 * Der Zweig hing allein an `step === 'primary'` und nicht daran, WER tippt. Das
 * Zugteam hat in dieser Phase `canBuzz: false` und `onTheHook: true`; auf
 * seinem Knopf steht „DU BIST DRAN". Ein Tipp darauf ließ ihn rütteln und hielt
 * ihm „erst muss das Zugteam antworten" vor – sie sind das Zugteam.
 *
 * Dieselbe Bedingung machte die Pausenzeile unerreichbar: `canBuzz` enthält
 * `!pause` schon serverseitig (game.js, viewFor), also fiel jeder Tipp während
 * der Pause in denselben Zweig – Rütteln inklusive, obwohl auf dem Knopf
 * „PAUSE" steht und der Kommentar daneben ausdrücklich Stille verlangt.
 *
 * Geprüft wird die Reihenfolge im Quelltext: Ein Browser läuft hier nicht, und
 * der Handler ist nicht ausgeführt zu bekommen.
 */
test('der Buzzer weist weder das Zugteam noch die Pause zurecht', () => {
  const quelle = ohneKommentare(lies('player.js'));
  const zuFrueh = quelle.indexOf('Noch zu früh');
  assert.ok(zuFrueh > 0, 'die Meldung sollte es weiterhin geben – für alle anderen');

  // Der Pausen-Ausstieg muss VOR der Meldung stehen, sonst ist er unerreichbar.
  const pausenAusstieg = quelle.lastIndexOf('state?.pause) return', zuFrueh);
  assert.ok(pausenAusstieg > 0 && pausenAusstieg < zuFrueh,
    'in der Pause muss der Buzzer schweigen, bevor „Noch zu früh" drankommt');

  // Und das Zugteam muss vorher abgefangen sein.
  const amZug = quelle.lastIndexOf('onTheHook', zuFrueh);
  assert.ok(amZug > 0 && amZug < zuFrueh,
    'wer selbst am Zug ist, darf „erst muss das Zugteam antworten" nie lesen');
});

/*
 * Die Knopfreihe des Endstands muss erreichbar bleiben.
 *
 * Gemessen auf 1280×720 mit acht Teams und Gleichstand an der Spitze: Der
 * Endstand war 94 px zu hoch, die ganze Knopfreihe lag unterhalb des Kastens,
 * und die Punkteleiste (z-index 2) lag darüber – „📋 Zusammenfassung", „Neues
 * Spiel" und „⚡ Stechen" waren weder zu sehen noch zu treffen. Unten stand
 * dabei „Gleichstand – ‚Stechen' holt die Entscheidungsfrage." für einen Knopf,
 * den niemand drücken konnte. Acht Teams entstehen von selbst, seit jedes Handy
 * sich sein eigenes Team anlegen darf.
 *
 * Zwei Dinge halten das jetzt: die klebende Reihe als Rettungsanker und zwei
 * weitere Verkleinerungsstufen, damit es gar nicht erst dazu kommt.
 */
test('die Knopfreihe des Endstands klebt am unteren Rand', () => {
  assert.match(lies('host.html'), /class="row endstand-aktionen"/,
    'host.html: die Knopfreihe braucht ihre Klasse, sonst greift die Regel nicht');

  const css = lies('host.css');
  const block = /\.scores-panel \.endstand-aktionen \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(block, /position:\s*sticky/,
    'ohne sticky rutscht die Reihe bei vielen Teams aus dem Kasten');
  assert.match(block, /bottom:\s*0/, 'sticky ohne bottom klebt nirgends');
  assert.match(block, /background:/,
    'ohne eigenen Grund laufen die Teamnamen durch die Knöpfe hindurch');
});

test('der Endstand gibt in Stufen nach, nicht auf einen Schlag', () => {
  const css = lies('host.css');
  const js = ohneKommentare(lies('host.js'));
  for (const stufe of ['voll', 'sehr-voll', 'extrem-voll']) {
    assert.ok(css.includes(`.scores-panel.${stufe} `),
      `host.css: die Stufe „${stufe}" fehlt`);
    assert.ok(js.includes(`'${stufe}'`),
      `host.js: die Stufe „${stufe}" wird nie gesetzt`);
  }
  // Erst enger stellen, dann die Schrift: Eine einzige große Stufe ließ bei
  // sechs Teams ein Drittel des Kastens leer, während die Schrift ohne Not
  // geschrumpft war. Deshalb darf nur die letzte Stufe an die Schriftgröße.
  const drei = /\.scores-panel\.sehr-voll \.score-list li \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.doesNotMatch(drei, /font-size/,
    'die dritte Stufe stellt nur enger – die Schrift gibt erst die vierte nach');
});
