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
 * Drei kleine Sachen, die alle drei am selben Ort sitzen: dort, wo jemand
 * hinsieht.
 *
 * 1. Die Brettfelder hießen für Tastatur und Vorlesehilfe nur „100“, „200“,
 *    „300“, „500“ – vierundzwanzig Knöpfe mit vier verschiedenen Namen. Die
 *    Kategorie steht in einem eigenen Kasten daneben, mit nichts verknüpft.
 *    Gemessen, jetzt: 24 verschiedene Namen von 24 Feldern.
 *
 * 2. Die hochlaufende Punktzahl war die einzige Bewegung im Spiel, die sich
 *    über „Bewegung reduzieren“ hinwegsetzte: Javascript rechnet sie Bild für
 *    Bild, und die Regel in style.css kappt nur CSS. Konfetti, Blitz, Uhr und
 *    das Scrollen im Editor fragen die Einstellung ab. Gemessen mit
 *    reduzierter Bewegung: 120 ms nach der Wertung steht schon die Endzahl;
 *    ohne sie steht dort 43 von 100.
 *
 * 3. Die Startseite zählte unlesbare Fragensätze mit und listete sie als
 *    spielbar auf – mit dem nackten Dateinamen als Namen. Gemessen mit einem
 *    absichtlich kaputten Satz: vorher „22 Fragensätze“ und der Dateiname in
 *    der Liste, jetzt 21 und nicht darin. Der Host-Screen macht es seit jeher
 *    richtig: Dort steht der Eintrag ausgegraut und ist nicht wählbar.
 */
test('drei Stellen sagen jetzt, was sie meinen', () => {
  const host = ohneKommentare(lies('host.js'));

  // 1. Die Brettfelder tragen die Kategorie im Namen.
  const kachel = host.slice(host.indexOf("class: 'tile'"));
  const bis = kachel.indexOf('String(cell.value)');
  assert.ok(bis > 0, 'der Feldknopf sollte auffindbar bleiben');
  assert.match(kachel.slice(0, bis), /'aria-label': `\$\{cat\.name\}/,
    'ohne die Kategorie heißen 24 Knöpfe viermal dasselbe');

  // 2. Beide Zählwerke fragen die Einstellung ab.
  for (const [datei, fn] of [['host.js', 'function countUp'], ['player.js', 'function punktesprung']]) {
    const js = ohneKommentare(lies(datei));
    const ab = js.indexOf(fn);
    assert.ok(ab > 0, `${datei}: ${fn} sollte auffindbar bleiben`);
    assert.match(js.slice(ab, ab + 400), /wenigerBewegung\(\)/,
      `${datei}: Javascript-Bewegung erreicht die Regel in style.css nicht`);
  }

  // 3. Die Startseite lässt kaputte Sätze draußen.
  const start = lies('index.html');
  assert.match(start, /filter\(\(s\) => !s\.error\)/,
    'ein unlesbarer Satz gehört nicht in die Zählung und nicht in die Liste');
});

/*
 * Der Tonschalter des Handys sagt, woran man ist.
 *
 * `#btn-ton` trug ein festes `aria-label="Töne auf diesem Handy an oder aus"`.
 * Umgeschaltet wurden nur Emoji und Titel – und ein aria-label schlägt beides.
 * Eine Vorlesehilfe las vor und nach dem Antippen wortgleich dasselbe vor; der
 * einzige Zustandsträger erreichte sie gar nicht.
 *
 * Auf dem Host-Screen ist dieselbe Schaltfläche seit jeher richtig gebaut:
 * kein aria-label, der Zustand steht im Text („🔇 Ton aus“ / „🔊 Ton an“).
 *
 * Gemessen im Browser – jetzt:
 *   vorher:  🔊  „Töne auf diesem Handy sind an – zum Ausschalten antippen“
 *   nachher: 🔇  „Töne auf diesem Handy sind aus – zum Einschalten antippen“
 */
test('der Tonschalter des Handys nennt seinen Zustand', () => {
  const js = ohneKommentare(lies('player.js'));
  const ab = js.indexOf('function zeigeTon()');
  assert.ok(ab > 0, 'zeigeTon sollte auffindbar bleiben');
  const rumpf = js.slice(ab, ab + 700);
  assert.match(rumpf, /setAttribute\('aria-label'/,
    'der Name muss mit dem Zustand wechseln – sonst hört eine Vorlesehilfe zweimal dasselbe');
  assert.match(rumpf, /aria-pressed/, 'und der Schalter sagt, ob er gedrückt ist');
});

/*
 * Die Tür-Seite bestreitet keinen Weg, den das Spiel selbst anbietet.
 *
 * Sie schloss mit „Eine Adresse zum Abtippen gibt es bewusst nicht." Das
 * stimmt nicht: Beim Spiel über den Tunnel zeigt der Host-Screen genau dafür
 * die vollständige Zeile samt Schlüssel und schreibt dazu „Öffnet das Handy
 * nichts, tippt genau diese Zeile ab". Wer an der Kamera scheitert, wurde von
 * der Tür-Seite also zurück zum QR-Code geschickt – zu dem, an dem er gerade
 * gescheitert war.
 */
test('die Tür-Seite und der Host-Screen sagen dasselbe', () => {
  const zugang = fs.readFileSync(path.join(PUBLIC, '..', 'server', 'zugang.js'), 'utf8');
  const tuer = zugang.slice(zugang.indexOf('Diese Runde ist privat'));
  assert.ok(tuer, 'die Tür-Seite sollte auffindbar bleiben');
  assert.doesNotMatch(tuer.slice(0, 600), /gibt es bewusst nicht/,
    'der Host-Screen bietet diese Adresse an – die Tür darf sie nicht bestreiten');
  assert.match(tuer.slice(0, 600), /Abtippen/,
    'der Ausweichweg gehört genannt');

  // Und der Host-Screen bietet ihn wirklich an – sonst trüge die Behauptung
  // oben ins Leere.
  assert.match(ohneKommentare(lies('host.js')), /tippt genau diese Zeile ab/,
    'der Host-Screen sollte den Ausweichweg weiter anbieten');
});

/*
 * Ein Funkloch bei der Feldwahl bleibt nicht stumm.
 *
 * Das Handy schickt die Feldwahl mit `quiet: true` – und das war richtig: Die
 * Absagen des Servers fängt die Oberfläche vorher ab. In der Pause und wenn
 * ein anderes Team dran ist, gibt es gar kein Raster; bei „nur Host“ steht es
 * ohne Knöpfe da. Beides steht so in den Kommentaren von renderPicker, und
 * gemessen stimmt es. Übrig bleiben Wettläufe – jemand war eine
 * Zehntelsekunde schneller –, und die sieht man am Brett.
 *
 * Ein Funkloch sieht man dort nicht. `quiet: true` verschluckte auch
 * „Keine Verbindung zum Server“: Der Knopf wurde einfach wieder hell, als
 * hätte man danebengetippt, und beim zweiten Versuch passierte dasselbe.
 * Gemessen im Browser mit blockierter Verbindung – vorher: keine Meldung,
 * jetzt: „Keine Verbindung zum Server“.
 */
test('eine Feldwahl ohne Verbindung sagt es dem Handy', () => {
  const js = ohneKommentare(lies('player.js'));
  const ab = js.indexOf("action('pick'");
  assert.ok(ab > 0, 'die Feldwahl sollte auffindbar bleiben');
  const stelle = js.slice(ab, ab + 400);

  // Die Absagen bleiben still – dafür sorgt die Oberfläche, nicht ein Toast.
  assert.match(stelle, /quiet: true/,
    'die abgefangenen Absagen gehören weiter nicht auf den Schirm');
  // Das Funkloch aber nicht.
  assert.match(stelle, /antwort\.offline/,
    'ohne Verbindung muss das Handy es sagen – sonst sieht es aus wie danebengetippt');
});

/*
 * Wer `aria-modal` sagt, muss auch stilllegen – und wieder freigeben.
 *
 * Zwei Dialoge nannten sich `role="dialog" aria-modal="true"` und ließen
 * trotzdem alles dahinter erreichbar:
 *
 * Der Zusammenfassungs-Dialog auf der Leinwand war die schlimmere Hälfte.
 * Escape ist dort fest als Menü-Umschalter verdrahtet, und einen Zweig für
 * diesen Dialog gab es nicht. Solange der Fokus im Textfeld stand, griff die
 * Ausnahme für Eingabefelder und Escape tat gar nichts; sobald er woanders
 * lag, öffnete Escape das Menü HINTER dem Dialog. Gemessen:
 *
 *   Dialog offen, Fokus im Textfeld   → Escape: nichts
 *   Fokus aus dem Textfeld genommen   → Escape: Menü OFFEN, Dialog auch noch
 *
 * Zwei übereinanderliegende Dialoge, und mit der Tastatur kam man aus der Lage
 * nicht mehr heraus.
 *
 * Der Baukasten des Editors schloss zwar mit Escape, legte aber nichts still
 * (der Tabulator wanderte durch 48 Fragefelder dahinter) und gab den Fokus
 * beim Schließen nirgends zurück.
 *
 * `openMenu()` im Host-Screen macht es seit jeher richtig – die Zeile
 * `$('#view-game').inert = true` mit dem Kommentar „sonst wandert der
 * Tabulator aufs Board“. Beide Dialoge folgen ihr jetzt.
 */
test('die Dialoge legen still, was hinter ihnen liegt', () => {
  const host = ohneKommentare(lies('host.js'));

  // Escape nimmt sich den obersten Dialog zuerst.
  const esc = host.slice(host.indexOf("if (key === 'escape')"));
  assert.ok(esc, 'der Escape-Zweig sollte auffindbar bleiben');
  const bisMenu = esc.indexOf('menuOpen ?');
  assert.ok(bisMenu > 0, 'der Menü-Umschalter sollte auffindbar bleiben');
  assert.match(esc.slice(0, bisMenu), /zusammenfassung/,
    'sonst öffnet Escape das Menü hinter dem offenen Dialog');

  // Und der Dialog legt dahinter still – dieselbe Zeile wie openMenu().
  assert.match(host, /function zeigeZusammenfassung\(an\)[\s\S]{0,400}?\$\('#view-game'\)\.inert = an;/,
    'der Zusammenfassungs-Dialog muss stilllegen, was hinter ihm liegt');

  const editor = ohneKommentare(lies('editor.js'));
  assert.match(editor, /function zeigeBaukastenDialog\(an\)[\s\S]{0,400}?\.inert = an;/,
    'der Baukasten muss stilllegen, was hinter ihm liegt');

  /*
   * Und jeder Weg hinaus muss durch dieselbe Tür.
   *
   * Der Baukasten hat drei: Escape, der Schließen-Knopf und das Holen einer
   * Kategorie. Der dritte setzte `hidden = true` direkt – hätte er das nach
   * dem Stilllegen weiter getan, wäre der Editor bis zum Neuladen unbedienbar
   * gewesen. Im Browser nachgemessen: Nach dem Holen lässt sich wieder tippen.
   */
  assert.doesNotMatch(editor, /\$\('#baukasten'\)\.hidden = true/,
    'jeder Weg aus dem Baukasten gehört über zeigeBaukastenDialog()');
  assert.doesNotMatch(host, /\$\('#zusammenfassung'\)\.hidden = (true|false)/,
    'jeder Weg aus dem Dialog gehört über zeigeZusammenfassung()');
});

/*
 * Die Buzzer-Uhr steht nicht im Vorlesebereich.
 *
 * `#p-status` und `#r-phase` tragen `role="status" aria-live="polite"`.
 * role="status" heißt implizit aria-atomic: Eine Vorlesehilfe liest bei jeder
 * Änderung den GANZEN Bereich neu vor. Genau dorthin schrieb der Uhr-Tick
 * jede Sekunde – bei der größten einstellbaren Uhr dreißig vollständige
 * Vorlesevorgänge desselben Satzes hintereinander. Weil `polite` sich staut
 * statt zu unterbrechen, hängt die Ansage, wer tatsächlich gebuzzert hat,
 * dahinter.
 *
 * Gemessen im Browser: Die Lagezeile las sich als
 * „Buzzer frei! 50 Punkte – oder 50 Abzug.  ⏱ 30“, dann „… 29“, dann „… 27“.
 * Jetzt steht dort unverändert „Buzzer frei! 50 Punkte – oder 50 Abzug.“,
 * während die Uhr daneben weiterläuft.
 *
 * Nebenbei sieht es besser aus: Vorher brach die Zeile auf dem Handy mitten in
 * der Uhr um („… Abzug. ⏱“ / „27“), jetzt bleibt „⏱ 27“ zusammen.
 */
test('die Buzzer-Uhr tickt neben der Lagezeile, nicht darin', () => {
  for (const [seite, zeile, uhr] of [
    ['player.html', 'p-status', 'p-uhr'],
    ['remote.html', 'r-phase', 'r-uhr'],
  ]) {
    const html = lies(seite);
    // Die Lagezeile bleibt ein Vorlesebereich – sie soll ja angesagt werden.
    assert.match(html, new RegExp(`id="${zeile}"[^>]*aria-live="polite"`),
      `${seite}: die Lagezeile bleibt ein Vorlesebereich`);
    // Die Uhr ist ein eigenes Element daneben, und zwar ein stummes.
    assert.match(html, new RegExp(`id="${uhr}"[^>]*aria-hidden="true"`),
      `${seite}: die Uhr gehört aus dem Vorlesebereich heraus`);
    // Und sie steht NICHT innerhalb der Lagezeile.
    const ab = html.indexOf(`id="${zeile}"`);
    const zu = html.indexOf('</span>', ab);
    assert.ok(zu > ab, `${seite}: die Lagezeile sollte ein span mit Ende sein`);
    assert.ok(html.indexOf(`id="${uhr}"`) > zu,
      `${seite}: die Uhr steht sonst doch wieder im Vorlesebereich`);
  }

  // Und das Javascript schreibt den Takt auch wirklich dorthin.
  for (const [datei, uhr] of [['player.js', 'p-uhr'], ['remote.js', 'r-uhr']]) {
    const js = ohneKommentare(lies(datei));
    const ab = js.indexOf('const sek = Math.ceil');
    assert.ok(ab > 0, `${datei}: der Uhr-Tick sollte auffindbar bleiben`);
    assert.match(js.slice(ab, ab + 300), new RegExp(`#${uhr}`),
      `${datei}: der Takt gehört in die Uhr`);
  }
});

/*
 * Im Endstand stehen die Punktzahlen auf einer Linie.
 *
 * Das Raster der Endstandszeile erklärt vier Spalten. Den Platzsprung hängte
 * host.js aber nur an, wenn sich wirklich etwas bewegt hatte – Zeilen ohne
 * Pfeil hatten also drei Kinder in einem Vier-Spalten-Raster. Die Punktzahl
 * rutschte eine Spalte nach links, samt der Fuge zur leeren vierten.
 *
 * Gemessen auf 1280×720 mit sechs Teams, drei davon mit Platzwechsel:
 *
 *   mit Pfeil   Punktzahl endet bei 1134
 *   ohne Pfeil  Punktzahl endet bei 1120
 *
 * 14 Pixel Zickzack in der Zahlenspalte, die am Ende der ganze Raum
 * vergleicht – und der Sieger ist besonders oft betroffen, denn wer schon nach
 * Runde 1 führte, hat keinen Sprung.
 *
 * Die Spalte bleibt jetzt immer stehen, sichtbar aber leer: `min-width: 3.2ch`
 * hält sie offen, und ein Pfeil für „nichts passiert" wäre nach dem Kommentar
 * an der Stelle bloß Rauschen. Dass die Klasse `gleich` im Stylesheet seit
 * jeher steht, zeigt, dass es so gemeint war.
 */
test('der Endstand hält die Spalte für den Platzsprung immer frei', () => {
  const js = ohneKommentare(lies('host.js'));

  // Der Platzsprung darf nicht mehr an einer Bedingung hängen, die ihn ganz
  // weglässt – genau daran hing der Versatz.
  assert.doesNotMatch(js, /sprung !== 0\s*\?[\s\S]{0,200}?:\s*null/,
    'ein weggelassenes Feld verschiebt die Punktzahl um eine Spalte');

  // Stattdessen: immer ein Element, mit drei möglichen Zuständen.
  const stelle = js.slice(js.indexOf("class: `sprung"));
  assert.ok(stelle.startsWith('class: `sprung'), 'das Sprung-Element sollte auffindbar bleiben');
  assert.match(stelle.slice(0, 120), /gleich/,
    'ohne Platzwechsel gehört die Klasse `gleich` dorthin – sie steht seit jeher im Stylesheet');

  // Und das Stylesheet erklärt weiterhin vier Spalten – sonst trüge die
  // Behauptung oben ins Leere.
  const css = fs.readFileSync(path.join(PUBLIC, 'host.css'), 'utf8');
  assert.match(css, /\.scores-panel\.final \.score-list li \{ grid-template-columns: [^;]*auto auto;/,
    'vier Spalten, und die letzte ist die Punktzahl');
  assert.match(css, /\.score-list \.sprung\.gleich/,
    'den Zustand `gleich` gibt es im Stylesheet');
});

/*
 * Die Leertaste gehört dem Knopf, auf dem der Fokus steht.
 *
 * Der Buzzer nimmt die Leertaste für sich, sobald jemand beigetreten ist –
 * samt `preventDefault`. Damit aktivierte sie keinen anderen Knopf der Seite
 * mehr. Gemessen mit einem Laptop als Buzzer: Fokus auf dem Tonschalter,
 * Leertaste – nichts. Fokus auf „Team wechseln“, Leertaste – nichts. Beide
 * mit der Tastatur unerreichbar, ohne jede Rückmeldung.
 *
 * Der Code kannte das Problem schon: Die Zeile darüber hält die Leertaste vor
 * dem Beitreten frei, „sonst schluckt das preventDefault das Aktivieren der
 * Team-Kacheln, und am Laptop kommt man mit der Tastatur nicht mehr ins
 * Spiel“. Nach dem Beitreten galt dieselbe Überlegung – nur die Regel nicht.
 *
 * Die Ausnahme für den Buzzer selbst ist gemessen nötig, nicht vorsorglich:
 * Er hängt an `pointerdown` auf #buzz-zone, nicht an `click`. Der Klick, den
 * der Browser aus der Leertaste macht, läuft bei ihm ins Leere – ohne die
 * Ausnahme buzzte die Leertaste nicht mehr, sobald der Fokus auf dem Buzzer
 * stand. Genau dort landet man am Laptop nach einem Tabulator.
 */
test('die Leertaste lässt andere Knöpfe des Handys in Ruhe', () => {
  const js = ohneKommentare(lies('player.js'));
  const handler = js.slice(js.indexOf("addEventListener('keydown'"));
  const bis = handler.indexOf('pressBuzzer();');
  assert.ok(bis > 0, 'der Leertasten-Handler sollte auffindbar bleiben');
  const rumpf = handler.slice(0, bis);

  // Eingabefelder waren schon vorher ausgenommen – das muss so bleiben.
  assert.match(rumpf, /INPUT/, 'Eingabefelder behalten die Leertaste');
  // Und jetzt auch jedes andere Bedienelement.
  assert.match(rumpf, /closest\(/,
    'steht der Fokus auf einem Bedienelement, gehört ihm die Leertaste');
  assert.match(rumpf, /button/, 'Köpfe wie <button> gehören in die Liste');
  // Der Buzzer ist die Ausnahme von der Ausnahme.
  assert.match(rumpf, /buzzer\.contains\(/,
    'der Buzzer selbst muss die Leertaste behalten – er hört auf pointerdown, nicht auf click');
});

/*
 * Jede Seite muss die Farben kennen, die ihr Stylesheet benutzt.
 *
 * Eine ungültige `var()` ist in CSS keine Kleinigkeit: Die ganze Deklaration
 * wird zu `unset` – und sie fällt NICHT auf die allgemeinere Regel zurück, die
 * sie überstimmt hat, sondern auf den Anfangswert. Aus einem Knopf wird dann
 * Text ohne Fläche.
 *
 * Genau das stand in remote.css: Der Pausenknopf holte sich seinen goldenen
 * Verlauf aus `--gold-hell` und `--gold`, und die beiden standen nur in
 * host.css – die lädt remote.html nie. Gemessen im Browser: In der Pause hatte
 * „▶ Weiterspielen“ background-image: none, durchsichtigen Rahmen und die
 * Schriftfarbe #3a2a00 auf fast schwarzem Grund. Der Knopf, mit dem der Host
 * die Pause beendet, sah aus wie eine Bildunterschrift.
 *
 * Geprüft wird je Seite gegen die Stylesheets, die SIE lädt – nicht gegen
 * alle. Ein Rückfallwert (`var(--x, gelb)`) zählt als in Ordnung, den setzt
 * jemand bewusst.
 *
 * Kommentare werden vorher entfernt. Ohne das meldete der Wächter prompt eine
 * Farbe, die nur im Kommentar über diesem Fund vorkam – gemessen beim ersten
 * Lauf.
 */
test('jede Seite kennt die Farben, die ihr Stylesheet benutzt', () => {
  const ohneCssKommentare = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const seiten = ['index.html', 'host.html', 'player.html', 'remote.html', 'editor.html'];
  const klagen = [];

  for (const seite of seiten) {
    const html = lies(seite);
    const stylesheets = [...html.matchAll(/<link[^>]+href="\/([^"]+\.css)"/g)].map((m) => m[1]);
    assert.ok(stylesheets.length, `${seite}: kein Stylesheet gefunden – stimmt das Muster noch?`);

    let css = '';
    for (const datei of stylesheets) css += ohneCssKommentare(lies(datei));

    // Alles, was irgendwo in diesen Dateien gesetzt wird – auch auf anderen
    // Selektoren als :root, etwa `--bildhoehe` am Fragekasten.
    const gesetzt = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));

    // Und was die Seite selbst aus Javascript setzt.
    const skripte = [...html.matchAll(/<script[^>]+src="\/([^"]+\.js)"/g)].map((m) => m[1]);
    let js = '';
    for (const datei of skripte) {
      js += lies(datei);
      // Module, die von dort aus geladen werden, gehören dazu.
      for (const m of js.matchAll(/from\s+['"]\/([^'"]+\.js)['"]/g)) {
        try { js += lies(m[1]); } catch { /* gibt es nicht, dann eben nicht */ }
      }
    }
    for (const m of js.matchAll(/setProperty\(\s*['"](--[a-z0-9-]+)/g)) gesetzt.add(m[1]);

    // Nur var() OHNE Rückfallwert: ein Komma in der Klammer heißt, jemand hat
    // an den Fall gedacht.
    for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) {
      if (!gesetzt.has(m[1])) {
        klagen.push(`${seite} (lädt ${stylesheets.join(', ')}): ${m[1]} wird benutzt, aber nirgends gesetzt`);
      }
    }
  }
  assert.deepEqual([...new Set(klagen)], []);
});

/*
 * Der Editor warnt bei derselben Länge, die der Testlauf verlangt.
 *
 * Es gab zwei Zahlen für dieselbe Sache. Der Testlauf über die mitgelieferten
 * Sätze lässt 105 Zeichen Fragetext zu; der Editor sagte bis 180 Zeichen
 * „alles gut“. Die 180 waren an der ZUGEKLAPPTEN Frage gemessen – und das ist
 * der falsche Moment: Aufgedeckt stehen Lösung und Zusatz im selben Kasten,
 * und genau dann wird vorgelesen. Neu gemessen, echter Browser, 1280×720,
 * aufgedeckt:
 *
 *   Fragetext:     80    100    120    140    160    180 Zeichen
 *   Zusatz:      15px   14px   14px   12px   10px    9px
 *
 * host.css über den Zusatz: „14px waren dafür aus vier Metern zu wenig.“ Bei
 * 180 Zeichen steht er auf 9. Die mitgelieferten Sätze merken davon nichts –
 * ihre längste Frage der 1008 hat 101 Zeichen. Wer aber eigene Fragen schreibt,
 * hat nur den Editor: Für seinen Satz läuft kein Testlauf.
 *
 * Deshalb hält dieser Test die beiden Zahlen zusammen. Wer die eine ändert,
 * muss die andere mitnehmen – oder neu messen.
 */
test('Editor und Testlauf meinen dieselbe Fragenlänge', () => {
  const js = ohneKommentare(lies('editor.js'));
  const imEditor = Number(/const LEINWAND_GRENZE = (\d+)/.exec(js)?.[1]);
  assert.ok(Number.isFinite(imEditor), 'die Grenze im Editor sollte auffindbar bleiben');

  const pruefung = fs.readFileSync(path.join(PUBLIC, '..', 'test', 'questions.test.js'), 'utf8');
  const imTestlauf = Number(/GRENZEN = \{ text: (\d+)/.exec(pruefung)?.[1]);
  assert.ok(Number.isFinite(imTestlauf), 'die Grenze im Testlauf sollte auffindbar bleiben');

  assert.equal(imEditor, imTestlauf,
    `Editor warnt ab ${imEditor}, der Testlauf verlangt ${imTestlauf} – zwei Zahlen für dieselbe Leinwand`);

  // Und der Hinweis muss sagen, worum es wirklich geht: Der Kasten schrumpft
  // erst, wenn Lösung und Zusatz dazukommen. Stand da nur „wird klein“, klang
  // es nach einer Frage, die man auch einfach lang lassen kann.
  assert.match(js, /Lösung und Zusatz dazukommen/,
    'der Hinweis im Editor soll den aufgedeckten Zustand nennen');
});

/*
 * Am Endstand wird in einer bestimmten Reihenfolge nachgegeben.
 *
 * host.css gibt die Regel selbst vor – „vom Entbehrlichsten her“, und die
 * Schrift der Rangliste zuletzt, weil sie „das Einzige ist, was aus vier
 * Metern wirklich zählt“. `voll` und `sehr-voll` ändern nur Abstände,
 * `extrem-voll` als Einziges die Schriftgröße. Also: beide Abstandsstufen,
 * dann das Wegnehmen von Auszeichnungen, dann erst die Schrift.
 *
 * `sehr-voll` stand trotzdem NACH dem Wegnehmen. Gemessen im Browser, sechs
 * Teams, ganzer Abend durchgespielt:
 *
 *              vorher     danach
 *   1280×720    0 von 4    2 von 4
 *   1366×768    1 von 4    4 von 4
 *   1280×800    2 von 4    4 von 4
 *   1024×768    3 von 4    4 von 4
 *
 * Auf dem gewöhnlichsten Beamer stand am Ende eines ganzen Abends also keine
 * einzige Auszeichnung – nur die Zeile, dass es sechs davon gibt. Das ist der
 * Teil, den man am nächsten Tag noch erzählt.
 *
 * Geprüft wird die Reihenfolge in der Quelle: Was sie bewirkt, sieht man nur
 * in einem echten Browser mit einem zu Ende gespielten Abend – hier steht
 * dafür fest, dass niemand sie versehentlich zurückdreht.
 */
test('der Endstand gibt in der richtigen Reihenfolge nach', () => {
  const js = ohneKommentare(lies('host.js'));
  const rumpf = js.slice(js.indexOf('function passeStandEin'));
  assert.ok(rumpf.startsWith('function passeStandEin'), 'passeStandEin sollte auffindbar bleiben');

  const sehrVoll = rumpf.indexOf("classList.add('sehr-voll')");
  const wegnehmen = rumpf.indexOf('zeilen[i].hidden = true');
  const extremVoll = rumpf.indexOf("classList.add('extrem-voll')");
  for (const [was, wo] of [['sehr-voll', sehrVoll], ['das Wegnehmen', wegnehmen], ['extrem-voll', extremVoll]]) {
    assert.ok(wo >= 0, `${was} sollte es in passeStandEin weiter geben`);
  }

  assert.ok(sehrVoll < wegnehmen,
    'enger stellen kostet nur Luft – das gehört vor das Wegnehmen der Auszeichnungen');
  assert.ok(wegnehmen < extremVoll,
    'die Schrift der Rangliste gibt zuletzt nach – sie zählt aus vier Metern als Einzige');

  // Und die Begründung dafür hängt daran, dass `sehr-voll` wirklich nur
  // Abstände ändert. Käme dort eine Schriftgröße hinzu, wäre die Reihenfolge
  // falsch herum – ohne dass es jemandem auffällt.
  const css = fs.readFileSync(path.join(PUBLIC, 'host.css'), 'utf8');
  const stufe = css.split('\n').filter((z) => z.includes('.scores-panel.sehr-voll'));
  assert.ok(stufe.length, 'die Stufe sehr-voll sollte es weiter geben');
  for (const zeile of stufe) {
    assert.doesNotMatch(zeile, /font-size/,
      'sehr-voll darf nur Abstände ändern – sonst gehört es nicht vor das Wegnehmen');
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
    /*
     * Geprüft wird die Kopfzeile, nicht bloß der Bezeichner.
     *
     * Hier stand einmal nur `/ersatzAus/` gegen die ganze Datei. Damit hätte
     * auch ein `const ersatzAus = q.ersatzAus;` ohne jede Verwendung gereicht,
     * oder ein Zweig, den nie jemand erreicht – der Test wäre grün geblieben,
     * während auf dem Handy weiter „Uni-Latein · 500 Punkte" über einer Frage
     * aus einem ganz anderen Fach stünde.
     */
    const js = ohneKommentare(lies(datei));
    /*
     * Zeilenweise statt mit einer Klammer-Regex: Die Kopfzeile ist ein
     * Template-Literal mit verschachtelten Backticks, daran bricht jedes
     * `[^`]*` ab – und zwar mitten drin, VOR der Stelle, um die es geht.
     *
     * Und der Anker muss genau sein. Ein schlichtes `includes('${q.category}')`
     * trifft in allen drei Dateien zuerst etwas anderes: auf der Leinwand den
     * Stechen-Zweig, auf dem Handy den Schlüssel des Neuaufbaus, auf der
     * Fernbedienung die Rückfrage vor dem Austausch. Keine dieser Zeilen
     * nennt je eine Herkunft – der Wächter hätte also die falsche Zeile
     * geprüft und wäre auch bei gutem Code rot geworden. Die Kopfzeile ist
     * der Sonst-Zweig des Stechen-Fragezeichens, und den gibt es genau einmal.
     */
    const kandidaten = js.split('\n').filter((z) => z.trim().startsWith(': `${q.category}'));
    assert.equal(kandidaten.length, 1,
      `${datei}: die Kopfzeile der Frage sollte genau einmal auffindbar sein`);
    const kopf = kandidaten[0];
    assert.match(kopf, /q\.ersatzAus \? ` · Ersatz aus/,
      `${datei}: die Kategorie über der Frage verschweigt, dass sie ausgetauscht wurde`);
  }
});

/*
 * Und dasselbe für den Einsatz: Auf welcher Frage einer liegt, gehört auf jeden
 * Schirm. Gemessen fehlte es zuerst ausgerechnet auf der Fernbedienung – dem
 * Gerät, mit dem der Host wertet: Dort stand „Schule von damals · 600 Punkte",
 * während Leinwand und Handy „· ✦ Einsatz" trugen.
 */
test('auf welcher Frage ein Einsatz liegt, sagt jeder Schirm', () => {
  for (const [datei, muster] of [
    ['host.js', /q\.einsatz \? ' · ✦ EINSATZ'/],
    ['player.js', /q\.einsatz \? ' · ✦ Einsatz'/],
    ['remote.js', /q\.einsatz \? ' · ✦ Einsatz'/],
  ]) {
    assert.match(ohneKommentare(lies(datei)), muster,
      `${datei}: die Kopfzeile der Frage verschweigt den Einsatz`);
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

/*
 * Auch die Leinwand sagt, wenn ihr Bildschirm dunkel werden kann.
 *
 * keepScreenAwake() hält den Screen offen – aber `navigator.wakeLock` gibt es
 * nur im sicheren Kontext. Auf localhost ist er gegeben; ein iPad als
 * Host-Screen erreicht die Seite jedoch nur über die WLAN-Adresse, und dort
 * nicht. Der Aufruf läuft dann per `?.` ins Leere, lautlos. Gemessen:
 * localhost → wakeLock object, WLAN-Adresse → undefined.
 *
 * Das Handy sagt das in genau dieser Lage seit jeher (schlafHinweis in
 * player.js), der große Screen schwieg – während das Handbuch vier Zeilen nach
 * der Einladung zum iPad „Der Bildschirm bleibt an" verspricht.
 */
test('der Host-Screen warnt vor der fehlenden Bildschirmsperre', () => {
  assert.match(lies('host.html'), /id="schlaf-tipp"/,
    'host.html: der Hinweis fehlt – auf dem iPad geht die Leinwand sonst unangekündigt aus');

  const js = ohneKommentare(lies('host.js'));
  assert.match(js, /schlaf-tipp'\)\.hidden\s*=\s*!!navigator\.wakeLock/,
    'der Hinweis muss an der Verfügbarkeit der Sperre hängen, nicht fest stehen');

  // Und das Handbuch darf das Versprechen nicht ohne Vorbehalt geben.
  // Es liegt im Wurzelverzeichnis, nicht in public/ – lies() hilft hier nicht.
  const readme = fs.readFileSync(path.join(PUBLIC, '..', 'README.md'), 'utf8');
  const stelle = readme.indexOf('Der Bildschirm bleibt an.');
  assert.ok(stelle > 0, 'die Stelle im Handbuch sollte es weiterhin geben');
  assert.match(readme.slice(stelle, stelle + 600), /localhost|sicheren Kontext/,
    'das Handbuch verspricht die Sperre auch dort, wo der Browser sie nicht gibt');
});

/*
 * Der Einsatz-Schalter muss das Raster wirklich umbauen.
 *
 * renderPicker() baut #p-picker nur neu, wenn sich `box.dataset.key` ändert –
 * eine bewusste Sperre, damit ein hereintrudelnder Spielstand kein Antippen
 * verschluckt. Stünde der Schalterzustand nicht im Schlüssel, bliebe das Raster
 * beim Umlegen stehen: Der Schalter leuchtete golden, die Felder zeigten weiter
 * die einfachen Zahlen, und niemand wüsste, ob der Einsatz nun steht. Dasselbe
 * gilt für die Feldliste der Fernbedienung.
 */
test('der Einsatz steht im Schlüssel der Feldraster', () => {
  const spieler = ohneKommentare(lies('player.js'));
  const pickerKey = /const key = \[\s*state\.setName,[\s\S]*?\]\.join\('#'\);/.exec(spieler)?.[0] || '';
  assert.ok(pickerKey, 'der Schlüssel des Rasters sollte auffindbar bleiben');
  assert.match(pickerKey, /einsatzScharf/,
    'player.js: ohne den Schalter im Schlüssel baut sich das Raster nie neu');

  const fern = ohneKommentare(lies('remote.js'));
  const listenKey = /const key = \[state\.setName,[\s\S]*?\]\.join\('#'\);/.exec(fern)?.[0] || '';
  assert.ok(listenKey, 'der Schlüssel der Feldliste sollte auffindbar bleiben');
  assert.match(listenKey, /einsatzScharf/,
    'remote.js: dasselbe für die Feldliste der Fernbedienung');
});

/*
 * Eine Ansage, die nicht mitgegangen ist, darf nicht stumm verschwinden.
 *
 * Der Einsatz liegt nur im Gerät, das ihn ansagt. Nachgestellt: Anna stellt auf
 * ihrem Handy „✦ Einsatz steht", ruft ihr Feld aber laut in den Raum, und der
 * Host klickt es auf der Leinwand an. Die Frage kam mit 500 statt 1000 herein,
 * Annas Einsatz war noch offen – und auf ihrem Schirm stand kein Wort dazu.
 * Gemessen: keine einzige Meldung, kein Stern in der Kopfzeile.
 *
 * Verloren ist dabei nichts, es ist nur nicht passiert. Ein Hinweis in dem
 * Moment macht daraus zehn Sekunden: zurücknehmen, Feld selbst antippen.
 */
test('das Handy sagt Bescheid, wenn der Einsatz nicht mitgegangen ist', () => {
  const js = ohneKommentare(lies('player.js'));
  const stelle = /if \(einsatzScharf && !darf && q[\s\S]{0,400}?toast\([^)]*nicht mitgegangen[\s\S]{0,80}?\);/.exec(js)?.[0] || '';
  assert.ok(stelle, 'der Hinweis sollte in renderEinsatz stehen');
  assert.match(stelle, /!q\.einsatz/,
    'nur wenn die Frage OHNE Einsatz hereinkam – sonst meldet es sich beim eigenen Tipp');
  assert.match(stelle, /q\.teamId === state\?\.you\?\.teamId/,
    'und nur beim eigenen Feld');
  assert.doesNotMatch(stelle, /kam vom Host/,
    'der Satz darf niemanden beschuldigen – in einem Zweierteam tippt auch das andere Handy');
  // Und er muss VOR dem Entschärfen stehen, sonst ist einsatzScharf schon weg.
  const reihenfolge = /if \(einsatzScharf && !darf[\s\S]*?if \(!darf\) einsatzScharf = false;/.test(js);
  assert.ok(reihenfolge, 'der Hinweis muss vor dem Entschärfen stehen');
});

/*
 * „Zug überspringen" braucht einen eigenen Bezugspunkt für die Anlaufsperre.
 *
 * `seit` gehört den Wertungsknöpfen; sein Bezugspunkt kennt Phase, Schritt und
 * Buzzer, aber nicht den Zugwechsel – auf dem Brett steht dort die ganze Zeit
 * dieselbe Lage. Der Knopf baute sich bei jedem Wechsel trotzdem neu auf und
 * war sofort scharf. Gemessen auf der Fernbedienung: zweimal getippt im
 * Abstand von 250 ms, zwei Teams übersprungen statt einem. Mit 700 ms kommt
 * der zweite Tipp weiter durch.
 */
test('„Zug überspringen" hat seine eigene Anlaufsperre', () => {
  for (const datei of ['remote.js', 'host.js']) {
    const js = ohneKommentare(lies(datei));
    /*
     * Der Bezugspunkt wird bei JEDEM Aufbau neu signiert, nicht nur im
     * Board-Zweig – und die Phase steht darin.
     *
     * Erste Fassung war `lageSeit('zug', String(state.turnIndex))`, und der
     * Aufruf stand unten im Board-Zweig. Damit lief der Eimer zwischen zwei
     * Feldern nicht mit, und bei Zugart „Wer trifft, bleibt dran" ändert sich
     * der Zugindex nach einer richtigen Antwort gar nicht. Gemessen: Anna
     * trifft, bleibt dran, der Host tippt „Weiter", der Daumen setzt kurz
     * danach noch einmal auf dieselbe Fläche – und Anna hatte den gerade
     * verdienten Zug verloren.
     */
    assert.match(js, /const zugSeit = lageSeit\('zug', `\$\{state\.phase\}#\$\{state\.turnIndex\}`\);/,
      `${datei}: die Signatur braucht die Phase, sonst läuft sie über eine Frage hinweg nicht mit`);
    assert.match(js, /Zug überspringen'[\s\S]{0,260}?zugSeit\)/,
      `${datei}: und der Knopf muss sie bekommen`);
    // Der Aufruf gehört VOR die Phasenweiche der Leiste: Im Board-Zweig
    // gelesen, wird er zwischen zwei Feldern nie aktualisiert.
    const leiste = datei === 'host.js'
      ? js.slice(js.indexOf('function renderControls()'))
      : js.slice(js.indexOf("lageSeit('leiste'"));
    const bisZurWeiche = leiste.slice(0, leiste.indexOf("state.phase === 'board'"));
    assert.ok(bisZurWeiche.length > 0 && bisZurWeiche.length < leiste.length,
      `${datei}: die Phasenweiche der Leiste sollte auffindbar bleiben`);
    assert.match(bisZurWeiche, /const zugSeit = lageSeit\('zug'/,
      `${datei}: der Bezugspunkt muss vor der Phasenweiche gezogen werden`);
  }
});

/*
 * Die Zusammenfassung enthält alle Auszeichnungen – auch die, für die auf der
 * Leinwand kein Platz war.
 *
 * Bei vielen Teams wurde die Liste gekürzt, BEVOR sie im DOM stand – und die
 * Zusammenfassung zum Weiterschicken liest genau von dort. Gemessen mit sechs
 * Teams und sechs Auszeichnungen: vier im DOM, vier im Text, zwei nirgends. Die
 * Restzeile darunter versprach dabei „4 weitere Auszeichnungen stehen in der
 * Zusammenfassung" – von den beiden anderen erfuhr niemand.
 *
 * Jetzt stehen alle im DOM; weggerückt wird nur fürs Auge.
 */
test('alle Auszeichnungen stehen im DOM, auch die weggerückten', () => {
  const js = ohneKommentare(lies('host.js'));
  assert.doesNotMatch(js, /zeilen\.length = Math\.min\(zeilen\.length, 4\)/,
    'gekürzt werden darf erst beim Anzeigen, nicht vor dem Bauen');
  assert.match(js, /const zuviel = voll && i >= 4;/,
    'die überzähligen werden markiert statt weggeworfen');
  assert.match(js, /class: `rekord\$\{zuviel \? ' rekord-zuviel' : ''\}`/,
    'und bekommen ihre Klasse');
  assert.match(js, /for \(const z of zeilen\) z\.hidden = z\.classList\.contains\('rekord-zuviel'\);/,
    'passeStandEin darf sie nicht wieder einblenden');
  assert.match(js, /if \(r\.classList\.contains\('rekord-rest'\)\) continue;/,
    'die Restzeile selbst gehört nicht in den Text – sie hätte dort eine leere Zeile hinterlassen');
});

/*
 * Umbenennen war versprochen, aber nirgends abzuschicken.
 *
 * In der Lobby steht „Hier kannst du sie genauso anlegen, umbenennen und
 * entfernen", und das Handbuch sagt dasselbe. `renameTeam` gibt es im Server
 * seit jeher – abgeschickt hat die Aktion keine einzige Seite. Der einzige Weg
 * war: Team entfernen und neu anlegen lassen, wobei das Handy seine
 * Teamzugehörigkeit verliert und Farbe wie Wappen neu vergeben werden.
 */
test('die Lobby kann ein Team auch wirklich umbenennen', () => {
  const js = ohneKommentare(lies('host.js'));
  assert.match(js, /act\('renameTeam', \{ teamId: team\.id, name: neuerName \}\)/,
    'sonst ist das Versprechen in der Lobby und im Handbuch eine Lüge');
  assert.match(js, /title: 'Team umbenennen'/, 'und der Knopf braucht eine Aufschrift');
});

/*
 * Der Editor zählt zwei verschiedene Fehler – und muss sie auch so nennen.
 *
 * Die Lösung steht in der NACHBARFRAGE derselben Kategorie, oder sie steht in
 * der eigenen Frage. Beides landete in einer Zahl, beschriftet mit dem Satz für
 * den ersten Fall. Gemessen: ein einziger Selbstverräter, und darüber stand „1
 * Lösung steht schon in einer anderen Frage derselben Kategorie" – der Autor
 * sucht dann in den Nachbarfragen, wo nichts ist.
 *
 * Und der Warnbalken „Zwischenspeicher voll" stand außerhalb der klebenden
 * Leiste. Er erscheint, während jemand Frage 40 von 48 tippt – also weit unten
 * auf der Seite; oben angeheftet hat ihn dort nie jemand gesehen, und genau
 * dann wird nichts mehr gesichert. Sein Rat war obendrein halb falsch: „Auf dem
 * Server speichern" verweigert save(), solange ein Feld leer ist, und leer sind
 * beim Schreiben fast immer welche.
 */
test('der Editor benennt die zwei Arten von verratener Lösung getrennt', () => {
  const js = ohneKommentare(lies('editor.js'));
  assert.match(js, /let inNachbarfrage = 0;/, 'die Nachbarfragen brauchen eine eigene Zahl');
  assert.match(js, /let imEigenenText = 0;/, 'die Selbstverräter auch');
  assert.match(js, /wörtlich in ihrer eigenen Frage/, 'und einen eigenen Satz');
  assert.match(js, /inNachbarfrage && imEigenenText/, 'beide zusammen brauchen beide Sätze');
});

/*
 * Der Baukasten liest den Vorrat einmal ein – und danach nie wieder.
 *
 * Nachgestellt: Der Host öffnet einmal ⇱ Holen (204 Kategorien aus 17 Sätzen),
 * lädt dann „Kopfnuss", korrigiert eine Lösung und speichert. Holt er sich
 * dieselbe Kategorie danach im selben Tab per ⇱ Holen dazu, kam wortwörtlich
 * die Fassung von vorher zurück – samt der Lösung, die er gerade repariert hat.
 * Nach dem Speichern zeigt der Baukasten jetzt 216 Kategorien aus 18 Sätzen.
 */
test('ein Speichern macht den Vorrat des Baukastens ungültig', () => {
  const js = ohneKommentare(lies('editor.js'));
  const erfolg = /toast\(`Gespeichert als \$\{data\.file\}`\);[\s\S]{0,200}?loadSetList\(\);/.exec(js)?.[0] || '';
  assert.ok(erfolg, 'der Erfolgszweig von save() sollte auffindbar bleiben');
  assert.match(erfolg, /baukastenDaten = null;/,
    'sonst holt der Baukasten die Fassung von vor dem Speichern');
});

test('der Warnbalken des Editors steht in der klebenden Leiste', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'editor.html'), 'utf8');
  const leiste = /<div class="bar">[\s\S]*?\n  <\/div>/.exec(html)?.[0] || '';
  assert.ok(leiste, 'die klebende Leiste sollte auffindbar bleiben');
  assert.match(leiste, /id="speicher-warnung"/,
    'außerhalb sieht ihn niemand, der gerade Frage 40 tippt');
  assert.match(leiste, /„Herunterladen“: Das geht auch mit halb gefülltem Satz/,
    'der Rat muss auch stimmen, wenn noch Felder leer sind');
});

/*
 * „⏱ Zeit ist um" bleibt stehen, bis die Frage vorbei ist.
 *
 * starteUhr() hört bei null auf zu ticken – der Satz wird genau einmal
 * geschrieben. Solange Lagezeile und Uhr derselbe Knoten waren, übermalte ihn
 * der nächste beliebige Rundruf; danach stand dort wieder „Buzzer ist frei ·
 * 50 Punkte", als liefe die Uhr noch, und er kam nie wieder. Gemessen auf
 * Fernbedienung und Handy. Der Buzzer bleibt dabei offen – die abgelaufene Uhr
 * ist genau der Hinweis an den Host, dass er jetzt auflösen darf.
 *
 * Dagegen stand früher ein Gedächtnis (`uhrSuffix`), das bei jedem Neuaufbau
 * der Zeile wieder angeklebt wurde. Seit die Uhr ein eigenes Feld hat, kann der
 * Neuaufbau sie gar nicht mehr treffen: Er schreibt in einen anderen Knoten.
 * Im Browser nachgemessen – Uhr abgelaufen, dann tritt ein drittes Handy bei:
 * Auf Handy und Fernbedienung stand danach weiterhin „⏱ Zeit ist um".
 */
test('die abgelaufene Buzzer-Uhr bleibt stehen', () => {
  for (const [datei, uhr] of [['remote.js', 'r-uhr'], ['player.js', 'p-uhr']]) {
    const js = ohneKommentare(lies(datei));
    assert.match(js, /\u23f1 Zeit ist um/, `${datei}: den Satz muss es geben`);

    // Der Takt schreibt ausschließlich in die Uhr – nur deshalb hält der Satz.
    const tick = js.slice(js.indexOf('const sek = Math.ceil'));
    const bis = tick.indexOf('});');
    assert.ok(bis > 0, `${datei}: der Uhr-Tick sollte auffindbar bleiben`);
    assert.match(tick.slice(0, bis), new RegExp(`setzeText\\(\\$\\('#${uhr}'\\)`),
      `${datei}: der Takt gehört in die Uhr, nicht in die Lagezeile`);

    // Und beim Abschalten wird sie geleert – sonst bliebe „Zeit ist um" auch
    // dann stehen, wenn die Frage längst vorbei ist.
    assert.match(js, new RegExp(`uhrSchluessel = null;\\s*\\n\\s*setzeText\\(\\$\\('#${uhr}'\\), ''\\);`),
      `${datei}: beim Abschalten der Uhr gehört ihr Feld geleert`);

    // Das Gedächtnis von früher darf nicht zurückkommen: Es las nur noch sich
    // selbst und würde beim nächsten Leser wie ein lebender Zustand aussehen.
    assert.doesNotMatch(js, /uhrSuffix/,
      `${datei}: der Anhang ist seit dem eigenen Uhrfeld überflüssig`);
  }
});

/*
 * Die Rundenansage geht nur vorwärts.
 *
 * Sie ist die einzige Vollbildansage des Abends und auf zweimal budgetiert
 * (siehe ansagen() in host.js). Nimmt der Host den Rundenwechsel zurück, ging
 * sie noch einmal auf – gemessen „Runde 1 / Los geht's!" über dem Rundenende,
 * mit Ton, obwohl gerade gar nichts losgeht.
 */
test('die Rundenansage feuert nicht beim Zurücknehmen', () => {
  const js = ohneKommentare(lies('host.js'));
  assert.match(js, /const neueRunde = frischGebaut && letzteRunde !== null && state\.round > letzteRunde;/,
    'mit `!==` statt `>` feuert sie auch rückwärts');
});

/*
 * Vier Knöpfe, die zu oft taub waren – und einer, der zu lange scharf stand.
 *
 * Die Anlaufsperre soll verhindern, dass ein Knopf unter dem Daumen
 * ausgetauscht wird. Sie zählt ab dem Moment, in dem sich die BEDEUTUNG ändert;
 * hängt sie stattdessen an der Geburt des Knotens, schlägt sie auch dann zu,
 * wenn sich gar nichts geändert hat. Gemessen im Browser, jeweils mit
 * Gegenprobe auf dem alten Stand:
 *
 *   Menü: Der Zugindex stand im Schlüssel, obwohl keine Zeile ihn anzeigt –
 *   „dran" baute die Reihe neu (Schlüssel …#0 → …#1), der „+100"-Knopf war ein
 *   frischer Knoten. Genau die Knöpfe, die der Kommentar dort ausdrücklich
 *   verschonen will.
 *
 *   Vertreterknöpfe: Geht das Handy des ZUGTEAMS weg, ändert sich an ihnen
 *   nichts – es steht nie in ihrer Liste. Die Leiste baut sich trotzdem neu,
 *   weil die Online-Lage in ihrem Schlüssel steht. Sofort danach gedrückt:
 *   ohne eigenen Bezugspunkt kam der Buzz nicht an, mit kommt er an.
 *
 *   „Keiner weiß es → auflösen" hatte gar keinen Bezugspunkt, obwohl es zur
 *   Wertungsreihe gehört – die Fernbedienung macht das seit jeher richtig.
 */
test('die Knöpfe der Leinwand hängen an der Lage, nicht an ihrer Geburt', () => {
  const js = ohneKommentare(lies('host.js'));

  const menue = /function fillMenu\(\)[\s\S]*?const seit = lageSeit\('menu', key\);/.exec(js)?.[0] || '';
  assert.ok(menue, 'fillMenu und sein Schlüssel sollten auffindbar bleiben');
  assert.doesNotMatch(menue, /state\.turnIndex/,
    'der Zugindex zeigt in dieser Liste nichts an und baut sie nur grundlos neu');

  assert.match(js, /lageSeit\('vertreter',/,
    'die Vertreterknöpfe brauchen einen eigenen Bezugspunkt');
  assert.match(js, /buzzKnopf\(team, aufschriften\[i\], vertreterSeit\)/,
    'und müssen ihn auch bekommen');
  assert.match(js, /function buzzKnopf\(team, aufschrift, seit = performance\.now\(\)\)/,
    'buzzKnopf muss eine Anlaufsperre überhaupt kennen');

  assert.match(js, /'Keiner weiß es → auflösen',\s*\n?\s*'btn-primary', \(\) => act\('endQuestion'\), '4', seit\)/,
    '„Keiner weiß es" gehört zur Wertungsreihe und damit an deren Bezugspunkt');
});

test('die Vertreterknöpfe der Fernbedienung haben denselben Bezugspunkt', () => {
  const js = ohneKommentare(lies('remote.js'));
  assert.match(js, /lageSeit\('vertreter',/, 'auch hier');
  assert.match(js, /act\('buzzFor', \{ teamId: team\.id \}\), vertreterSeit\)/,
    'und die Knöpfe müssen ihn mitbekommen');
});

/*
 * In der Pause verschwindet die Feldwahl – auf allen drei Schirmen.
 *
 * Der Server weist einen Feldaufruf in der Pause ab („Ihr seid gerade in der
 * Pause", pickCell). Auf der Fernbedienung stand die Liste trotzdem scharf da;
 * ein Tipp im Vorbeigehen antwortete mit einem roten Kasten. Eine Liste, die
 * auf jeden Tipp mit einer Absage antwortet, sieht nach kaputt aus – dieselbe
 * Begründung, mit der das Raster des Handys längst verschwindet.
 */
test('die Feldwahl der Fernbedienung verschwindet in der Pause', () => {
  const fern = ohneKommentare(lies('remote.js'));
  assert.match(fern, /const zeigen = state\.phase === 'board' && !!state\.board && !state\.pause;/,
    'sonst prallt jeder Tipp am Server ab');
  const handy = ohneKommentare(lies('player.js'));
  assert.match(handy, /const zeigen = state\.phase === 'board' &&[^;]*!state\.pause;/,
    'auf dem Handy war es immer schon so');
});

/*
 * Die Zusammenfassung darf jedes „weiß nicht" nur einmal zählen.
 *
 * `bilanz.falsch` zählt alles, was nicht getroffen wurde – auch jedes „weiß
 * nicht" (passQuestion ruft verrechneFalsch). Für die Punkte ist das genau
 * richtig, beide kosten dasselbe. In der Zeile der Zusammenfassung stand es
 * aber roh daneben: Gemessen „1 richtig, 3 falsch, 2× weiß nicht" für vier
 * gespielte Fragen – sechs Zahlen für vier Fragen. Über einen ganzen Abend:
 * 16 + 32 + 32 = 80 statt 48.
 *
 * Das Handy rechnet dieselbe Differenz seit jeher (player.js, „Daneben").
 */
test('die Zusammenfassung zählt „weiß nicht" nicht doppelt', () => {
  const js = ohneKommentare(lies('host.js'));
  const block = /function zusammenfassung\(\)[\s\S]*?\n\}/.exec(js)?.[0] || '';
  assert.ok(block, 'zusammenfassung() sollte auffindbar bleiben');
  assert.match(block, /Math\.max\(0, \(b\.falsch \|\| 0\) - gepasst\)/,
    'ohne den Abzug liest sich die Zeile wie doppelt so viele Fragen');
  assert.doesNotMatch(block, /\$\{b\.falsch \|\| 0\} falsch/,
    'die rohe Zahl gehört nicht in die Zeile');
});

/*
 * Der Notweg muss auch aufmachen können, wenn der Strom SPÄTER abreißt.
 *
 * `stromKam` hieß „ist je ein Zustand angekommen" und entschied gleichzeitig,
 * ob der Notweg noch aufmachen darf – ein Riegel, der nur in eine Richtung
 * fällt. Nach dem ersten Zustand lief die Schleife des Notwegs nie wieder
 * (`while … && !stromKam`), und der Fehler-Zweig des Stroms lag hinter
 * `if (!stromKam)`. Reißt der Strom später ab und kommt nicht wieder – ein
 * Netz, das lange Verbindungen kappt –, steht das Handy für den Rest des
 * Abends auf einem alten Stand.
 *
 * Zwei getrennte Fragen also: ob es je klappte (nur für die Wortwahl) und ob
 * er GERADE trägt (dafür der Notweg).
 */
test('der Notweg hängt daran, ob der Strom gerade trägt', () => {
  const js = ohneKommentare(lies('common.js'));
  assert.match(js, /let stromLaeuft = false;/, 'die zweite Frage braucht eine eigene Antwort');
  assert.match(js, /while \(notwegLaeuft && !stromLaeuft\)/,
    'die Schleife darf nicht an „je gelaufen" hängen');
  assert.match(js, /if \(notwegLaeuft \|\| stromLaeuft\) return;/,
    'und das Aufmachen auch nicht');
  const fehlerZweig = /source\.addEventListener\('error'[\s\S]*?\n  \}\);/.exec(js)?.[0] || '';
  assert.ok(fehlerZweig, 'der Fehler-Zweig des Stroms sollte auffindbar bleiben');
  assert.doesNotMatch(fehlerZweig, /if \(!stromKam\)/,
    'der Notweg darf nicht nur beim allerersten Fehlschlag aufmachen');
  assert.match(fehlerZweig, /notwegAuf\(/, 'er muss ihn überhaupt aufmachen');

  /*
   * Und „offline" heißt: kein Weg trägt.
   *
   * Der Browser baut einen abgewiesenen Strom im Sekundentakt neu auf, und jeder
   * Fehlschlag rief `setOnline(false)`. Gemessen mit einem Handy, dessen Strom
   * vollständig abgewiesen wurde: Es trat bei, sah das Spiel starten und bekam
   * die Frage – und zeigte dabei „Keine Verbindung – warte kurz …", weil das
   * `setOnline(true)` aus `nimm()` jede Sekunde überschrieben wurde. Jetzt
   * steht dort, was wirklich los ist.
   */
  assert.doesNotMatch(fehlerZweig, /setOnline\(false\)/,
    'ein abgewiesener Strom allein macht das Handy nicht offline – hole() meldet das');
});

/*
 * Im Stechen gibt es keine Punkte – dann gehört auch keine Zahl in die Zeile.
 *
 * Gemessen auf der Leinwand, unter der Antwort, die den ganzen Abend
 * entschieden hat: „🦊 Anna: richtig +0". Der Server schreibt dort bewusst
 * `delta: 0` (game.js, der `q.stechen`-Zweig in judge); die Oberflächen setzten
 * das ungeprüft hinter ein Pluszeichen. Auf der Fernbedienung stand dasselbe.
 *
 * Und „falsch" heißt im Stechen mehr als sonst: Wer danebenliegt, ist raus.
 */
test('das Protokoll schreibt im Stechen keine Nullpunkte', () => {
  for (const datei of ['host.js', 'remote.js']) {
    const js = ohneKommentare(lies(datei));
    const zeile = /const label =\s*\n?\s*entry\.result === 'pass'[\s\S]*?;/.exec(js)?.[0] || '';
    assert.ok(zeile, `${datei}: die Protokollzeile sollte auffindbar bleiben`);
    assert.match(zeile, /q\.stechen \? 'richtig'/,
      `${datei}: ohne diesen Zweig steht „richtig +0" auf dem Schirm`);
    assert.match(zeile, /q\.stechen \? 'falsch – raus'/,
      `${datei}: und „falsch" darf sagen, was es im Stechen bedeutet`);
  }
});

/*
 * „Geklaut" ist nur, was dem Zugteam auch wirklich weggenommen wurde.
 *
 * Steht „Buzzer auch nach richtig" an, punktet das Zugteam voll und der Buzzer
 * geht trotzdem auf. Gemessen auf der Leinwand: Anna richtig +500, Bea buzzert
 * nach und bekommt +250 – und das Protokoll schrieb „🐻 Bea: schnappt sich
 * +250 von 🦊 Anna", während Anna ihre 500 behielt. Dazu blitzte die Bühne in
 * Beas Farbe, als wäre gerade etwas passiert.
 */
test('der Klau-Moment prüft, ob das Zugteam überhaupt verloren hat', () => {
  const js = ohneKommentare(lies('host.js'));
  assert.match(js, /const zugteamTraf = q\.log\.some\(\(e\) => e\.result === 'correct' && e\.teamId === q\.teamId\);/,
    'die Protokollzeile braucht den Blick auf das Zugteam');
  assert.match(js, /const geklaut = fremd && !zugteamTraf;/,
    'ohne diesen Zusatz behauptet die Zeile einen Diebstahl, den es nicht gab');
  assert.match(js, /const zugteamHatGetroffen = q\.log\.some\([\s\S]{0,120}?\);\s*if \(letzte\.result === 'correct'[\s\S]{0,160}?&& !zugteamHatGetroffen\) \{\s*stageFlash/,
    'und der Blitz darf genauso wenig feuern');
});

/*
 * Der Einsatz überstimmt den eingestellten Abzug – und die Leinwand muss das
 * an der Zeile zeigen, an der der Host sich beim Drücken orientiert.
 *
 * Gemessen, bevor es stand: Bei einem Einsatz auf ein 500er-Feld stand dort
 * „kostet 500", während der Server 1000 abzog.
 */
test('die Abzugszeile der Steuerleiste kennt den Einsatz', () => {
  const js = ohneKommentare(lies('host.js'));
  const zeile = /const abzug = [\s\S]*?;/.exec(js)?.[0] || '';
  assert.ok(zeile, 'die Abzugsrechnung sollte auffindbar bleiben');
  assert.match(zeile, /q\.einsatz/,
    'ohne diesen Zweig behauptet die Leinwand die Hälfte dessen, was der Server abzieht');
});

/*
 * Eine scharfe Einsatz-Ansage darf die Feldwahl nicht überleben.
 *
 * Nachgestellt im Browser: Der Host legt den Schalter der Steuerleiste um, das
 * Team ruft sein Feld aber selbst auf dem Handy auf – ohne Einsatz, völlig
 * richtig. Danach stand der Schalter weiter auf Gold, und der nächste Klick des
 * Hosts auf ein Feld verdoppelte es und verbrauchte den Einsatz des Teams:
 * gemessen 400 statt 200 Punkte, ohne dass jemand das entschieden hätte.
 * Dieselbe Lücke saß in der Feldliste der Fernbedienung, hinter ihrem frühen
 * Ausstieg.
 *
 * Geprüft wird, dass das Entschärfen NICHT in einer Phasenweiche steckt,
 * sondern an einer Stelle, die jeder Aufbau durchläuft.
 */
test('der Einsatz-Schalter entschärft sich, sobald das Brett weg ist', () => {
  const host = ohneKommentare(lies('host.js'));
  const leiste = /function renderControls\(\)[\s\S]*?\n  const key = \[/.exec(host)?.[0] || '';
  assert.ok(leiste, 'renderControls und sein Schlüssel sollten auffindbar bleiben');
  assert.match(leiste, /state\.phase !== 'board'[\s\S]*?einsatzFuer = null/,
    'host.js: das Entschärfen muss vor dem Schlüssel stehen, nicht im Board-Zweig');

  const fern = ohneKommentare(lies('remote.js'));
  const vorAusstieg = /function renderFeldwahl\(\)[\s\S]*?if \(!zeigen\) \{/.exec(fern)?.[0] || '';
  assert.ok(vorAusstieg, 'renderFeldwahl sollte auffindbar bleiben');
  assert.match(vorAusstieg, /if \(!zeigen\) einsatzFuer = null;/,
    'remote.js: das Entschärfen muss VOR dem frühen Ausstieg stehen');
});

/*
 * Und sie darf den Zugwechsel nicht überleben.
 *
 * Nachgestellt im Browser, beide Geräte: Anna sagt den Einsatz an, überlegt es
 * sich anders, der Host drückt „Zug überspringen" – jetzt ist Bea dran. Der
 * Schalter stand weiter auf Gold; auf der Fernbedienung schrieb er sich sogar
 * klaglos auf „✦ Einsatz steht für 🐻 Bea" um. Beas erstes Feld ging dann
 * verdoppelt ins Spiel und ihr Einsatz war für die Runde weg: gemessen Kachel
 * 200 → Wert 400, einsatzOffen false, ohne dass jemand das gesagt hätte.
 *
 * Ein Ja/Nein kann das nicht auffangen – ein Einsatz gehört einem Tisch.
 * Deshalb merken sich beide Geräte die Team-ID und vergleichen sie mit dem,
 * der gerade am Zug ist. Das Handy braucht das nicht: Dort hängt der Schalter
 * an `you.darfEinsatz`, und das prüft der Server ohnehin gegen das Zugteam.
 */
test('der Einsatz-Schalter gehört einem Team, nicht dem Gerät', () => {
  const host = ohneKommentare(lies('host.js'));
  assert.match(host, /let einsatzFuer = null;/,
    'host.js: die Ansage muss die Team-ID festhalten, nicht bloß „ja"');
  assert.match(host, /einsatzFuer === state\?\.teams\?\.\[state\.turnIndex\]\?\.id/,
    'host.js: die Ansage gilt nur, solange dasselbe Team am Zug ist');
  const tile = /onclick: \(\) => \{\s*const mitEinsatz = einsatzSteht\(\);/.exec(host)?.[0] || '';
  assert.ok(tile, 'host.js: der Feldklick muss über einsatzSteht() gehen, nicht über ein rohes Ja/Nein');

  const fern = ohneKommentare(lies('remote.js'));
  assert.match(fern, /let einsatzFuer = null;/,
    'remote.js: dasselbe für die Fernbedienung');
  assert.match(fern, /if \(!darfEinsatz \|\| einsatzFuer !== zugteam\?\.id\) einsatzFuer = null;/,
    'remote.js: der Zugwechsel muss die Ansage löschen');
  assert.match(fern, /const mitEinsatz = einsatzFuer !== null\s*&& einsatzFuer === state\.teams\[state\.turnIndex\]\?\.id;/,
    'remote.js: auch der Feldklick prüft noch einmal gegen das Zugteam');
});

/*
 * Der Einsatz lässt sich mitten im Spiel abschalten – dann muss der Knopf weg.
 *
 * Die Steuerleiste baut sich nur bei Schlüsselwechsel neu. Ohne die Einstellung
 * im Schlüssel bliebe ein „✦ Einsatz" stehen, das der Server längst abweist.
 */
test('die Einsatz-Einstellung steht im Schlüssel der Steuerleiste', () => {
  const host = ohneKommentare(lies('host.js'));
  const key = /const key = \[\s*state\.phase, q\?\.step,[\s\S]*?\]\.join\('#'\);/.exec(host)?.[0] || '';
  assert.ok(key, 'der Schlüssel der Steuerleiste sollte auffindbar bleiben');
  assert.match(key, /state\.settings\.einsatz/,
    'ohne die Einstellung im Schlüssel überlebt der Knopf das Abschalten');
});

/*
 * Und der Schalter der Steuerleiste muss beim Umlegen auch anders aussehen.
 *
 * Dieselbe Falle wie bei den Feldrastern: Die Leiste baut sich nur neu, wenn
 * sich ihr Schlüssel ändert. Gemessen stand nach dem Klick weiter „✦ Einsatz"
 * auf dem Knopf, obwohl der Einsatz scharf war – der Host hätte es erst am
 * verdoppelten Feld gemerkt.
 */
test('der Einsatz steht im Schlüssel der Steuerleiste', () => {
  const host = ohneKommentare(lies('host.js'));
  const key = /const key = \[\s*state\.phase, q\?\.step,[\s\S]*?\]\.join\('#'\);/.exec(host)?.[0] || '';
  assert.ok(key, 'der Schlüssel der Steuerleiste sollte auffindbar bleiben');
  assert.match(key, /einsatzScharf/,
    'ohne den Schalter im Schlüssel behält der Knopf seine Beschriftung');
});

/*
 * Deutsche Anführungszeichen – auch im Programmtext, nicht nur in den Sätzen.
 *
 * Für die Fragensätze steht das schon fest (questions.test.js, „Anführungs-
 * zeichen werden deutsch geschlossen"). Die Sätze, die das Spiel selbst sagt,
 * kamen dabei nie vor – und dort standen zehn Stellen mit einem „ vorn und
 * einem geraden " hinten:
 *
 *   „Erde & Weltall · 500 Punkte" austauschen?          (Host und Fernbedienung)
 *   „Blitzrunde" wird durch „Hauptstädte" ersetzt.      (Editor, dreimal)
 *   Doppelte Punkte – und falsch oder „weiß nicht" …    (Handy)
 *   Erst werten oder über „auflösen" beenden.           (Serverfehler, als Toast)
 *   „Spiel beenden" im Host-Menü verwirft ihn.          (Terminal)
 *   … die linke Schaltfläche, „LTS")                    (Terminal)
 *
 * Auf dem Beamer steht so ein Satz in 40 Pixeln, und ein gerades Zeichen neben
 * einem deutschen fällt dort auf wie ein Tippfehler. Der Fragetext daneben
 * macht es ja richtig.
 *
 * Kommentare bleiben ausdrücklich außen vor: In ihnen ist „…" die Hausschrift,
 * dreihundertfünfzigmal. Geprüft wird nur, was jemand zu sehen bekommt – also
 * die Zeichenketten. Deshalb liest der Wächter den Quelltext zeichenweise und
 * nicht mit einem Muster über die ganze Zeile: `'https://nodejs.org'` sieht für
 * jedes Kommentar-Muster aus wie ein Zeilenkommentar.
 */
function zeichenketten(quelle) {
  const treffer = [];
  // Oben auf dem Stapel liegt, worin wir gerade stecken. Eine Einsetzung
  // `${…}` in einem Template ist wieder gewöhnlicher Code – und darin darf ein
  // weiteres Template stehen. Ohne Stapel fiele der Wächter genau dort heraus.
  const stapel = [{ art: 'code', klammern: 0 }];
  const oben = () => stapel[stapel.length - 1];
  let i = 0;
  let zeile = 1;
  while (i < quelle.length) {
    const c = quelle[i];
    const s = oben();
    if (s.art === 'code') {
      if (c === '\n') { zeile += 1; i += 1; continue; }
      if (c === '/' && quelle[i + 1] === '/') {
        while (i < quelle.length && quelle[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && quelle[i + 1] === '*') {
        i += 2;
        while (i < quelle.length && !(quelle[i] === '*' && quelle[i + 1] === '/')) {
          if (quelle[i] === '\n') zeile += 1;
          i += 1;
        }
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { stapel.push({ art: 'text', ende: c, zeile, text: '' }); i += 1; continue; }
      if (c === '{') { s.klammern += 1; i += 1; continue; }
      if (c === '}') {
        if (s.klammern > 0) s.klammern -= 1;
        else if (stapel.length > 1) stapel.pop(); // Ende der Einsetzung
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '\\') {
      s.text += quelle.slice(i, i + 2);
      if (quelle[i + 1] === '\n') zeile += 1;
      i += 2;
      continue;
    }
    if (c === s.ende) { treffer.push({ zeile: s.zeile, text: s.text }); stapel.pop(); i += 1; continue; }
    if (s.ende === '`' && c === '$' && quelle[i + 1] === '{') {
      stapel.push({ art: 'code', klammern: 0 });
      i += 2;
      continue;
    }
    if (c === '\n') zeile += 1;
    s.text += c;
    i += 1;
  }
  return treffer;
}

test('was das Spiel selbst sagt, schließt seine Anführungszeichen deutsch', () => {
  const WURZEL = path.join(PUBLIC, '..');
  const dateien = [
    ...fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js')).map((f) => path.join('public', f)),
    ...fs.readdirSync(path.join(WURZEL, 'server')).filter((f) => f.endsWith('.js')).map((f) => path.join('server', f)),
  ].sort();
  assert.ok(dateien.length >= 10, 'es sollten alle Seiten- und Serverdateien geprüft werden');

  const gemischt = [];
  for (const datei of dateien) {
    for (const { zeile, text } of zeichenketten(fs.readFileSync(path.join(WURZEL, datei), 'utf8'))) {
      // Jedes „ braucht ein “, bevor ein gerades Zeichen kommt.
      let auf = false;
      for (const c of text) {
        if (c === '„') auf = true;
        else if (c === '“') auf = false;
        else if (c === '"' && auf) {
          gemischt.push(`${datei}:${zeile}  ${text.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
          break;
        }
      }
    }
  }
  assert.deepEqual(gemischt, []);
});

/*
 * Die kopierte Zusammenfassung und die Bilanz auf dem Handy zählen dasselbe –
 * also sollen sie es auch gleich nennen.
 *
 * Beide lesen `team.bilanz`, und beide rechnen `falsch − gepasst`, damit ein
 * „weiß nicht" nicht zweimal auftaucht. Nur hießen die Zahlen verschieden: auf
 * dem Handy „Daneben" und „Geklaut", in der Zusammenfassung „falsch" und
 * „gebuzzert". Wer abends seine Bilanz gelesen hatte und am nächsten Tag den
 * kopierten Text im Gruppenchat, verglich zwei Aufstellungen, die dieselben
 * vier Zahlen anders nannten – und „gebuzzert" ist obendrein falsch: `geklaut`
 * zählt nur die Buzzer, die getroffen haben.
 *
 * `bilanz.daneben` ist die Falle dabei: Das ist der danebengegangene Buzzer
 * („Verbuzzert"), nicht die daneben gegangene Antwort.
 */
test('Zusammenfassung und Handy-Bilanz nennen dieselben Zahlen gleich', () => {
  const host = ohneKommentare(lies('host.js'));
  const handy = ohneKommentare(lies('player.js'));

  const block = /zeilen\.push\('', 'Bilanz'\);[\s\S]*?zeilen\.push\(`\$\{t\.wappen\}/.exec(host)?.[0] || '';
  assert.ok(block, 'der Bilanzblock der Zusammenfassung sollte auffindbar bleiben');
  for (const wort of ['richtig', 'daneben', 'weiß nicht', 'geklaut', 'verbuzzert']) {
    assert.ok(block.includes(`} ${wort}\``) || block.includes(`}× ${wort}\``),
      `die Zusammenfassung sollte die Zahl „${wort}“ nennen`);
  }
  assert.ok(!/\bfalsch`/.test(block) && !/× gebuzzert`/.test(block),
    'die alten Wörter „falsch" und „gebuzzert" gehören nicht mehr in die Zusammenfassung');

  // Und dieselbe Differenz auf beiden Seiten – sonst liefe die eine der
  // anderen davon, sobald jemand die Rechnung an einer Stelle ändert.
  assert.match(block, /Math\.max\(0, \(b\.falsch \|\| 0\) - gepasst\)/,
    'die Zusammenfassung rechnet „daneben" als falsch − gepasst');
  assert.match(handy, /\['Daneben', Math\.max\(0, zahl\(b\.falsch\) - zahl\(b\.gepasst\)\)\]/,
    'das Handy rechnet dieselbe Differenz');
  assert.match(block, /const verbuzzert = b\.daneben \|\| 0;/,
    '`bilanz.daneben` ist der verbuzzerte Versuch – unter diesem Namen gelesen, nicht als „daneben"');
});

/*
 * Zwei Netze, die sich nicht widersprechen dürfen.
 *
 * Nach acht Sekunden ohne Lebenszeichen legt die Startwache den Vorhang „Die
 * Seite konnte nicht starten." über die Seite. Vier Sekunden später prüfte der
 * zweite Zeitgeber nur `quizduellSpielt` – und schrieb unter den Vorhang einen
 * Streifen, der mit „Die Seite steht" anfängt. Zwei Diagnosen auf einem Handy,
 * das jemand dem Gastgeber hinhält, und beide können nicht stimmen.
 */
test('der Streifen „Die Seite steht" erscheint nur, wenn sie das tut', () => {
  const wache = fs.readFileSync(path.join(PUBLIC, 'start-wache.js'), 'utf8');
  // `lebt()` bringt eigene Klammern mit – deshalb sparsam bis zum `) return;`.
  const zweiter = /setTimeout\(function \(\) \{\s*if \([\s\S]*?\) return;\s*window\.quizduellPanne\(/.exec(wache)?.[0] || '';
  assert.ok(zweiter, 'der zweite Zeitgeber sollte auffindbar bleiben');
  assert.match(zweiter, /gemeldet \|\|/,
    'hat die Wache die Seite schon für tot erklärt, darf der Streifen nicht mehr kommen');
  assert.match(zweiter, /!lebt\(\)/,
    'ohne Lebenszeichen steht die Seite nicht – dann ist der Satz des Streifens falsch');
  assert.match(zweiter, /window\.quizduellSpielt === true/,
    'und mit Spielstand braucht es ihn ohnehin nicht');
});

/*
 * Die Frage muss aus ihrem eigenen Feld aufklappen – nicht aus dem vorigen.
 *
 * `.q-panel` trägt `animation: panelOpen … both`. Das `both` legt die
 * Anfangslage schon an, bevor das erste Bild läuft: Sobald das Panel sichtbar
 * wird, steht es zusammengeschrumpft auf der Kachel, die in `--fx/--fy/--fs`
 * steht – und das sind noch die Werte der Vorfrage, die `schliesseFrage`
 * hineingeschrieben hat. Wer in diesem Moment misst, misst die alte Kachel.
 *
 * Im Browser nachgestellt, 1600 × 900, Feld 0-0 spielen und danach 3-2 wählen:
 * Das Panel wurde mit 229 × 76 px gemessen statt mit seinen 1233 px Ruhebreite,
 * daraus wurde --fs 1,0 und --fx 730 px, und die Frage schob sich von rechts
 * ins Bild – der erste Bildausschnitt lag 613 px neben der gewählten Kachel und
 * ragte aus dem Bild heraus. Nach dem Richten: 10 px neben der Kachelmitte.
 *
 * Deshalb steht hier die Reihenfolge fest: `animation = 'none'` und die alten
 * Eckwerte weg, erst dann messen.
 */
test('das Fragepanel misst sich, bevor es sich bewegt', () => {
  const js = lies('host.js');
  const fn = /function openFromTile\(panel, q\) \{[\s\S]*?\n\}/.exec(js)?.[0] || '';
  assert.ok(fn, 'openFromTile sollte auffindbar bleiben');

  const anim = fn.indexOf("panel.style.animation = 'none'");
  const messung = fn.indexOf('panel.getBoundingClientRect()');
  assert.ok(anim >= 0, 'die laufende Bewegung muss abgestellt werden');
  assert.ok(messung >= 0, 'das Panel muss gemessen werden');
  assert.ok(anim < messung,
    'erst die Bewegung abstellen, dann messen – sonst misst man die Kachel der Vorfrage');

  const eckwerte = fn.indexOf("removeProperty");
  assert.ok(eckwerte >= 0 && eckwerte < messung,
    'auch --fx/--fy/--fs gehören vor der Messung weg, sonst hält `both` die alte Anfangslage');

  // Und der Rückweg ohne Kachel darf das Panel nicht bewegungslos zurücklassen.
  const abbruch = /if \(!tile \|\| !p\.width\) \{[\s\S]*?\}/.exec(fn)?.[0] || '';
  assert.match(abbruch, /panel\.style\.animation = '';/,
    'auch beim Abbruch muss die Bewegung wieder freigegeben werden');
});

/*
 * Werte, die beschrieben und nie gelesen werden.
 *
 * Sie entstehen nicht beim Schreiben, sondern beim Umbauen: Die Uhr auf Handy
 * und Fernbedienung hängte ihre Sekunden früher an die Lagezeile, und damit
 * dort „⏱ Zeit ist um" einen Rundruf überlebte, merkte sich `uhrText` den
 * Grundtext. Seit die Uhr einen eigenen Knoten hat, kann ein Neuaufbau sie gar
 * nicht mehr treffen – das Gedächtnis war überflüssig, blieb aber stehen und
 * wurde weiter befüllt. In qr.js stand daneben eine zweite Kapazitätstabelle,
 * die niemand mit der ersten verglich.
 *
 * Beides ist harmlos und trotzdem schlecht: Wer die Datei liest, hält so einen
 * Wert für einen Teil der Mechanik und sucht, wo er wirkt.
 *
 * Geprüft werden nur Modulwerte – am Zeilenanfang deklariert, ohne `export`.
 * Ein Fund heißt nicht „weg damit", sondern „nachsehen": Entweder fehlt der
 * Gebrauch, oder der Wert ist ein Rest.
 */
test('kein Modulwert wird beschrieben, ohne je gelesen zu werden', () => {
  const WURZEL = path.join(PUBLIC, '..');
  const dateien = [
    ...fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js')).map((f) => path.join('public', f)),
    ...fs.readdirSync(path.join(WURZEL, 'server')).filter((f) => f.endsWith('.js')).map((f) => path.join('server', f)),
  ].sort();

  const tot = [];
  for (const datei of dateien) {
    const zeilen = fs.readFileSync(path.join(WURZEL, datei), 'utf8').split('\n');
    const namen = [];
    zeilen.forEach((z, i) => {
      const m = /^(let|const|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(z);
      if (m) namen.push([m[2], i + 1]);
    });
    for (const [name, zeile] of namen) {
      const muster = new RegExp(`\\b${name}\\b`, 'g');
      let gelesen = 0;
      zeilen.forEach((z, i) => {
        if (i + 1 === zeile) return;                       // die Deklaration selbst
        if (!muster.test(z)) return;
        muster.lastIndex = 0;
        if (/^\s*(\/\/|\*|\/\*)/.test(z)) return;          // im Kommentar steht er absichtlich
        if (new RegExp(`^\\s*${name}\\s*=[^=]`).test(z)) return; // reine Zuweisung
        gelesen += 1;
      });
      if (!gelesen) tot.push(`${datei}:${zeile}  ${name}`);
    }
  }
  assert.deepEqual(tot, []);
});

/*
 * Die Vertreter-Buzzknöpfe brauchen ihre Anlaufsperre bei JEDER Frage.
 *
 * Jeder Knopf der Fernbedienung ist nach dem Erscheinen 400 ms taub – gegen
 * den Daumen, der schon auf dem Weg war, als der Knopf noch etwas anderes
 * bedeutete. Als Bezugspunkt diente für die Vertreterknöpfe eine Signatur aus
 * Phase, Schritt und den vertretenen Teams; berechnet wurde sie aber NUR im
 * Buzzer-Zweig. Zwischen zwei Fragen lief sie damit nicht mit, und bei der
 * nächsten Frage war sie unverändert – sobald ein Team ohne Handy dabei ist
 * und der Zug zwischen zwei Teams MIT Handy wechselt.
 *
 * Im Browser nachgestellt, drei Teams, Grün ohne Handy, jedes Mal 120 ms nach
 * dem Erscheinen getippt:
 *
 *   vorher   Frage 1  nichts passiert · Frage 2  gebuzzert für Grün
 *   nachher  Frage 1  nichts passiert · Frage 2  nichts passiert
 *
 * und der bewusste Tipp nach 1,2 s geht beide Male durch.
 *
 * Genau dieselbe Lehre steht zwei Zeilen darüber schon bei `zugSeit`: Ein
 * Bezugspunkt, der nur in einem Zweig gelesen wird, läuft zwischen den Zweigen
 * nicht mit. Deshalb stehen jetzt beide oben.
 */
test('der Bezugspunkt der Vertreterknöpfe läuft außerhalb des Buzzer-Zweigs mit', () => {
  const js = ohneKommentare(lies('remote.js'));
  const zug = js.indexOf("lageSeit('zug'");
  const vertreter = js.indexOf("lageSeit('vertreter'");
  // Die Schleife, die die Knöpfe baut – die steht im Buzzer-Zweig.
  const knoepfe = js.indexOf('for (const team of vertreten)');
  assert.ok(zug > 0 && vertreter > 0 && knoepfe > 0,
    'alle drei Stellen sollten auffindbar bleiben');
  assert.ok(vertreter < knoepfe,
    'der Bezugspunkt gehört vor die Knöpfe, nicht mitten zwischen sie');
  assert.ok(vertreter > zug && vertreter - zug < 1600,
    'er gehört zu den anderen Bezugspunkten nach oben – dort läuft er bei jedem Rundruf mit');

  // Und die Liste, aus der die Signatur entsteht, muss dort auch ohne Frage
  // etwas Sinnvolles ergeben – sonst wirft der Aufbau auf dem Brett.
  const liste = /const vertreten = [\s\S]*?;\n/.exec(js)?.[0] || '';
  assert.ok(liste, 'die Liste der vertretenen Teams sollte auffindbar bleiben');
  assert.match(liste, /q && q\.step === 'buzz'/,
    'ohne offene Frage ist niemand zu vertreten – das muss die Liste selbst wissen');
  assert.match(liste, /q\.lockedOut \|\| \[\]/,
    'und sie darf sich nicht auf ein Feld verlassen, das es dort nicht gibt');
});

/*
 * Was der Editor markiert, und was das Handbuch darüber sagt.
 *
 * „Als Faustzahl: Frage bis 105, Lösung bis 70, Zusatz bis 145 Zeichen –
 * darüber sagt es der Editor." Gesagt hat er es nur zur Frage: Die Lösung war
 * ohne jede Grenze, der Zusatz lief bis zum maxlength von 200, und rot wurde
 * nie etwas. Wer einen eigenen Satz schreibt, hat aber nur den Editor – für
 * seinen Satz läuft kein Testlauf.
 *
 * Im Browser nachgemessen, dieselbe Zeile mit drei Belegungen:
 *
 *   Frage 120 ROT  · Lösung 4        · Zusatz 5
 *   Frage 12       · Lösung 95 ROT   · Zusatz 5
 *   Frage 12       · Lösung 4        · Zusatz 190 ROT
 *
 * Gesperrt wird weiterhin nichts – geschrieben ist geschrieben.
 */
test('der Editor misst alle drei Felder an denselben Zahlen wie der Testlauf', () => {
  const js = ohneKommentare(lies('editor.js'));
  const tabelle = /const GRENZEN = \{[^}]*\}/.exec(js)?.[0] || '';
  assert.ok(tabelle, 'die Grenzen des Editors sollten auffindbar bleiben');
  assert.match(tabelle, /frage: LEINWAND_GRENZE/);
  assert.match(tabelle, /antwort: 70/);
  assert.match(tabelle, /zusatz: 145/);

  // Und dieselben Zahlen im Testlauf über die mitgelieferten Sätze.
  const pruefung = fs.readFileSync(path.join(PUBLIC, '..', 'test', 'questions.test.js'), 'utf8');
  const bar = /GRENZEN = \{ text: (\d+), answer: (\d+), note: (\d+) \}/.exec(pruefung);
  assert.ok(bar, 'die Schranken des Testlaufs sollten auffindbar bleiben');
  assert.deepEqual(bar.slice(1, 4).map(Number), [105, 70, 145],
    'Editor und Testlauf messen dieselbe Leinwand – die Zahlen gehören zusammen');

  // Alle drei Felder müssen auch wirklich markiert werden.
  for (const art of ['frage', 'antwort', 'zusatz']) {
    assert.ok(js.includes(`laengeMarkieren(ev.target, '${art}')`),
      `das Feld „${art}" muss beim Tippen gemessen werden`);
  }
});

/*
 * „Neues Spiel" fragt nach – auf beiden Geräten.
 *
 * Es ist der einzige Zug des Abends, der sich nicht zurücknehmen lässt: Er
 * räumt Punkte, Bilanzen, Auszeichnungen, den Rückweg und die Sicherung ab.
 * Auf der Leinwand steht er am Endstand direkt neben „📋 Zusammenfassung"
 * (host.html) – also neben dem Knopf, den der Host in dem Moment wirklich
 * sucht; der Text für den Gruppenchat ist danach nicht mehr zu holen. Auf der
 * Fernbedienung liegt er einen Daumenbreit neben „⚡ Stechen starten".
 *
 * Das Handbuch sagt seit jeher, der Knopf frage nach. Er tat es nicht.
 */
test('„Neues Spiel" fragt auf Leinwand und Fernbedienung nach', () => {
  const host = ohneKommentare(lies('host.js'));
  const neu = /\$\('#btn-new-game'\)\.addEventListener\('click', \(\) => \{[\s\S]*?\n\}\);/.exec(host)?.[0] || '';
  assert.ok(neu, 'der Knopf sollte auffindbar bleiben');
  assert.match(neu, /confirm\(/, 'ohne Rückfrage ist der Abend einen Fehlgriff entfernt');
  assert.match(neu, /if \(!confirm[\s\S]*?\) return;/, 'und bei „Abbrechen" muss er wirklich nichts tun');

  const fern = ohneKommentare(lies('remote.js'));
  const fernNeu = /big\('Neues Spiel',[\s\S]*?\}, seit\)\)/.exec(fern)?.[0] || '';
  assert.ok(fernNeu, 'auch auf der Fernbedienung sollte er auffindbar bleiben');
  assert.match(fernNeu, /if \(!confirm[\s\S]*?\) return;/);
});
