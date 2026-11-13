/*
 * Die Aktionen des Spiels – getrennt von dem, was sie ausliefert.
 *
 * Bis hierher stand das alles in index.js und hing an dessen Variablen: ein
 * Spielstand, ein Rückweg, ein Laptop. Für das Spiel im Netz reicht das nicht –
 * dort gibt es viele Räume, und jede Anfrage lädt ihren Raum aus dem Speicher,
 * statt ihn im Arbeitsspeicher vorzufinden. Deshalb arbeitet alles hier auf
 * einem `raum`, den der Aufrufer mitbringt:
 *
 *   raum.state                Spielstand (siehe game.js)
 *   raum.rueckWeg             [{ state, was, am }, …] – hinten liegt der nächste Rückschritt
 *   raum.bilder               Map id → { type, buffer }, eingebettete Bilder des Satzes
 *   raum.gezeigteBilder       Set der Dateien aus data/bilder, die schon auf dem Brett lagen
 *   raum.gespielt             Kategoriemarke → Zeitpunkt, über Abende hinweg
 *   raum.heuteGemerkt         Set der Marken, die in diesem Spiel schon vermerkt sind
 *   raum.wiederhergestelltAm  nur am Laptop: wann der Stand zurückgeholt wurde
 *   raum.dienste              was nur die Umgebung kann, siehe unten
 *
 * Der Laptop-Server (index.js) reicht seine Variablen über ein solches Objekt
 * durch, der Netz-Server (online.js) baut es je Anfrage aus dem Speicher.
 *
 * Dienste, die die Umgebung stellt:
 *   hostToast(text, level)      Meldung nur an Leinwand und Fernbedienung
 *   ereignis(name, daten)       kurzes Signal an alle, z. B. der Buzz
 *   sichereBilder()             eingebettete Bilder haltbar machen
 *   vergissSicherung()          gesicherten Spielstand verwerfen
 *   sichereGespielt()           das Gedächtnis über Abende haltbar machen
 *   geaendert()                 der Stand hat sich geändert – ausliefern
 *   hostOhneVerbindung(id)      optional: Host-Gerät, dessen Leitung gerade neu aufbaut
 */
import path from 'node:path';

import * as G from './game.js';
import {
  loadSet, normalizeSet, externalizeImages, mixSet, stechenFrage, ersatzFrage,
  ersatzKategorie, kategorieMarke,
} from './questions.js';

export const MIX = '__mix'; // Kennung für das gewürfelte Board

/** Ein leerer Raum – was jede Umgebung mindestens mitbringen muss. */
export function neuerRaum(dienste = {}) {
  return {
    state: G.createState(),
    rueckWeg: [],
    bilder: new Map(),
    gezeigteBilder: new Set(),
    gespielt: {},
    heuteGemerkt: new Set(),
    wiederhergestelltAm: null,
    dienste: {
      hostToast() {}, ereignis() {}, geaendert() {},
      async sichereBilder() {}, async vergissSicherung() {}, async sichereGespielt() {},
      ...dienste,
    },
  };
}

/** Merkt sich das Bild der laufenden Frage, falls es eine Datei ist. */
export function merkeBild(raum) {
  const bild = raum.state.current?.image;
  if (typeof bild === 'string' && bild.startsWith('/bilder/')) {
    raum.gezeigteBilder.add(path.basename(bild));
  }
}

/** Vermerkt Kategorien als gespielt; schreibt nur, wenn etwas neu ist. */
function merkeGespielt(raum, namen) {
  let neu = false;
  for (const name of namen) {
    const marke = kategorieMarke(name);
    if (!marke || raum.heuteGemerkt.has(marke)) continue;
    raum.heuteGemerkt.add(marke);
    raum.gespielt[marke] = Date.now();
    neu = true;
  }
  if (neu) raum.dienste.sichereGespielt();
}

export const HOST_ACTIONS = new Set([
  'addTeam', 'renameTeam', 'removeTeam', 'removeMember', 'adjustScore', 'setTurn',
  'startGame', 'judge', 'pass', 'openBuzz', 'reveal', 'endQuestion',
  'close', 'nextRound', 'backToLobby', 'settings', 'resetBuzz', 'buzzFor',
  'undo', 'stechen', 'discard', 'pause', 'tauscheKategorie', 'vergessen',
]);

/**
 * Zurücknehmen – mehrere Stufen.
 *
 * Am Spieleabend passiert genau ein Fehler zuverlässig: „Richtig“ statt
 * „Falsch“, und schon hat der falsche Tisch 500 Punkte. Über das Menü ließe
 * sich das in Hunderterschritten zurechtklopfen, aber Serie und Bilanz blieben
 * verkehrt – und der Tisch diskutiert derweil.
 *
 * Gesichert wird der ganze Zustand vor jedem Zug, der das Spiel verändert. Ein
 * Fragensatz misst rund 8 KB und Bilder liegen als Dateien daneben, das kostet
 * also nichts. Eine Stufe genügt: Wer zwei Züge zurück will, hat ein anderes
 * Problem, und mehr Stufen laden dazu ein, sich blind rückwärts zu klicken.
 */
/* Züge, die sich auf genau eine Situation der laufenden Frage beziehen.
   Punktekorrekturen und „dran" stehen bewusst nicht dabei: Die macht der Host
   absichtlich und oft, während sich nebenher etwas bewegt. */
const LAGEGEBUNDEN = new Set(['judge', 'pass', 'openBuzz', 'reveal', 'endQuestion', 'close', 'resetBuzz',
  'buzzFor', 'discard']);

/* Ein Buzz steht bewusst NICHT im Rückweg. Sonst legte sich jeder Buzz über
   die Wertung davor: Nach „Falsch“ für das Zugteam ist der Buzzer sofort
   offen, irgendwer drückt immer, und „↩ Wertung zurücknehmen“ wurde zu
   „↩ Buzz zurücknehmen“ – das den Buzzer wieder öffnete, worauf sofort der
   nächste drückte. Der Protest „das war doch richtig!“ ließ sich so am Abend
   kaum noch einlösen. Einen falschen Buzz nimmt „Buzz zurücknehmen“
   (resetBuzz) zurück; die Wertung davor ein einziges Zurücknehmen. */
export const RUECKNEHMBAR = new Set([
  'pick', 'judge', 'pass', 'openBuzz', 'reveal', 'endQuestion', 'close',
  'nextRound', 'adjustScore', 'setTurn', 'resetBuzz',
  'stechen', 'tauscheKategorie',
]);

/**
 * Der Rückweg ist ein Stapel, keine einzelne Schublade.
 *
 * Mit nur einem gemerkten Zug war jeder Fehler, der erst eine Frage später
 * auffällt, nicht mehr zurückzunehmen – und genau so fallen sie auf: „Moment,
 * das war doch gar nicht falsch." Übrig blieb die Punktekorrektur von Hand, und
 * damit stimmen Bilanz und Rekorde am Ende nicht mehr, weil die nicht an den
 * Punkten hängen, sondern an den Wertungen.
 *
 * Fünfundzwanzig Schritte reichen für jede Reue eines Abends und kosten nichts:
 * Ein Spielstand misst gemessen rund 10 kB, der ganze Stapel also 250 kB.
 * Er wird nicht mitgesichert – nach einem Neustart des Servers gibt es nichts
 * zurückzunehmen, das war auch vorher so.
 */
export const RUECKWEG_TIEFE = 25;

/**
 * Einen früheren Spielstand übernehmen, ohne den Raum mit zurückzudrehen.
 *
 * Wer inzwischen beigetreten oder rausgeflogen ist, bleibt es auch:
 * Zurückgenommen wird der Spielzug, nicht der Raum – sonst wirft ein
 * Rückschritt das Handy hinaus, das sich zwei Sekunden vorher verbunden hat.
 * Und Teams, die es im Schnappschuss noch gar nicht gab, bleiben ebenfalls.
 * Sonst warf ein „Zurücknehmen" genau das Team hinaus, das sich ein Handy
 * zwei Sekunden vorher selbst angelegt hat – samt Gerät: Der Host tippt in der
 * Lobby auf „dran", jemand legt sein Team an, der Host nimmt den Zugwechsel
 * zurück, und das Team ist weg. Nachgestellt.
 */
/**
 * Die Uhren einer zurückgeholten Frage laufen dort weiter, wo sie standen.
 *
 * Ein Schnappschuss trägt die Startzeiten von damals. Holte „Zurücknehmen" die
 * Antwortphase zurück – der Host hatte versehentlich „falsch" gedrückt –,
 * rechnete die Antwortuhr ab dem ursprünglichen Aufrufen und zeigte meist
 * sofort „Zeit ist um", obwohl das Zugteam eben noch mittendrin war. Dieselbe
 * Rechnung wie bei der Pause: Alle Zeitpunkte wandern um die Spanne zwischen
 * Sichern und Zurückholen. `buzzedAt` wandert mit, damit die angezeigte
 * Reaktionszeit (`buzzedAt − buzzOpenedAt`) dieselbe bleibt.
 *
 * Einträge ohne Zeitpunkt (aus einem Stand vor dieser Regel) bleiben, wie sie
 * sind.
 */
function holeUhrenNach(st, gesichertAm) {
  const q = st.current;
  if (!q || !gesichertAm) return;
  const versatz = Math.max(0, Date.now() - gesichertAm);
  for (const feld of ['gestelltAm', 'buzzOpenedAt', 'buzzedAt']) {
    if (q[feld]) q[feld] += versatz;
  }
}

function uebernimm(alt, jetztStand) {
  for (const team of alt.teams) {
    const jetzt = jetztStand.teams.find((t) => t.id === team.id);
    if (!jetzt) continue;
    team.members = jetzt.members;
    /*
     * Name und Wappen gehören auch dem Raum, nicht dem Spielzug.
     *
     * Beides lässt sich nur in der Lobby ändern – und dort gibt es
     * zurücknehmbare Züge: „dran" setzen und Punkte korrigieren. Zwei Sachen
     * gemessen:
     *
     * Ein Team taufte sich um („Rot" → „Die Grübelmeister"), der Host nahm
     * danach einen Zugwechsel zurück, und der Name war wieder „Rot".
     *
     * Schlimmer beim Wappen: Rot wechselt von 🦊 auf 🐼, ein Handy legt danach
     * sein eigenes Team an und bekommt das frei gewordene 🦊. Ein
     * „Zurücknehmen" holte Rots 🦊 zurück – und dann trugen zwei Teams
     * dasselbe Wappen. Auf der Leinwand ist genau das die Art, wie der Raum
     * die Tische auseinanderhält.
     */
    team.name = jetzt.name;
    team.wappen = jetzt.wappen;
  }
  // Entfernte Teams bleiben entfernt.
  //
  // Bisher schützte nur die Gegenrichtung: Teams, die es im Schnappschuss noch
  // nicht gab, blieben. Ein Team, das der Host inzwischen weggeräumt hat, stand
  // nach einem „Zurücknehmen" dagegen wieder da – samt seiner damaligen
  // Mitglieder. Nachgestellt: Anna legt ihr eigenes Team an, wechselt dann zu
  // Bernd, der Host räumt Annas leeres Team weg und nimmt danach einen
  // Zugwechsel zurück. Danach gab es Annas Team wieder, und Annas Handy stand
  // in zwei Teams gleichzeitig. Teams anzulegen und zu entfernen geht nur in
  // der Lobby und steht in keinem Rückweg – der Raum gehört also dem Jetzt,
  // genau wie die Mitglieder und die Pause.
  const jetztIds = new Set(jetztStand.teams.map((t) => t.id));
  alt.teams = alt.teams.filter((t) => jetztIds.has(t.id));
  const bekannt = new Set(alt.teams.map((t) => t.id));
  for (const team of jetztStand.teams) {
    if (!bekannt.has(team.id)) alt.teams.push(team);
  }
  // Wie in removeTeam: Der Zeiger aufs Zugteam darf nicht hinter das Ende der
  // Liste zeigen – dort wäre der nächste Feldaufruf kein abgelehnter Zug,
  // sondern ein Absturz.
  if (alt.turnIndex >= alt.teams.length) alt.turnIndex = 0;
  // Die Pause gehört zum Raum, nicht zum Spielzug.
  //
  // Sie fuhr bisher aus dem Schnappschuss mit: Wer in der Pause eine
  // Fehlwertung zurücknahm – genau wozu die Pause da ist –, hob damit die
  // Pause auf. Auf der Leinwand stand wieder die offene Frage, Feldwahl und
  // Buzzer waren wieder scharf, während der halbe Tisch in der Küche stand.
  // In der Gegenrichtung noch unangenehmer: Ein Rückschritt auf einen
  // Schnappschuss aus einer früheren Pause fror das laufende Spiel wieder ein,
  // ohne dass jemand Pause gedrückt hätte.
  alt.pause = jetztStand.pause;
  alt.pauseSeit = jetztStand.pauseSeit;
  // Was einmal auf dem Tisch lag, ist verbraucht – auch wenn der Zug
  // zurückgenommen wird.
  //
  // Beide Listen merken sich Fragetexte, die es heute schon gab: eingewechselte
  // Ersatzfragen und Stechfragen. Führen sie mit dem Schnappschuss zurück, wird
  // eine gerade gezogene Frage wieder ziehbar – und ausgerechnet das Streichen,
  // das eine schlechte Frage loswerden soll, könnte sie zurückholen. Der Preis
  // ist eine Frage weniger im Vorrat, und davon gibt es reichlich.
  alt.ersatzTexte = jetztStand.ersatzTexte;
  alt.stechenTexte = jetztStand.stechenTexte;
  // Die Regeln gehören dem Abend, nicht dem Spielzug.
  //
  // `settings` steht mit Absicht NICHT in RUECKNEHMBAR: Eine Einstellung soll
  // sich nicht zurücknehmen lassen, sie ist ja kein Zug. Sie fuhr aber im
  // Schnappschuss mit, und damit tat es jedes beliebige „Zurücknehmen".
  //
  // Nachgestellt: Abzug steht auf „halbe". Der Host wertet aus Versehen
  // „Richtig" auf ein 500er-Feld. Der Tisch beschwert sich, dass falsche
  // Antworten zu teuer sind – der Host stellt im Menü den Abzug auf „keiner"
  // und schaltet den Einsatz ein. Dann fällt die Fehlwertung auf, und er nimmt
  // sie zurück. Gemessen: Die 500 Punkte gingen richtig weg, und mit ihnen
  // stumm beide Menü-Änderungen; auf den Handys verschwand der Einsatz-Knopf
  // wieder, ohne dass irgendwo etwas gestanden hätte.
  //
  // Dass sie dem Raum gehören, sagt das Spiel ohnehin schon an anderer Stelle:
  // backToLobby trägt sie über ein ganzes neues Spiel hinweg mit (game.js,
  // `fresh.settings = raum.state.settings`).
  alt.settings = jetztStand.settings;
  return alt;
}

/** Menschenlesbar, damit der Knopf sagt, was er zurücknimmt. */
function benenne(type, vorher) {
  const team = vorher.current?.onTheHook
    ? vorher.teams.find((t) => t.id === vorher.current.onTheHook)?.name
    : null;
  switch (type) {
    case 'judge': return team ? `Wertung für ${team}` : 'Wertung';
    case 'pass': return 'Weiß nicht';
    case 'pick': return 'Feldwahl';
    case 'close': return 'Frage abschließen';
    case 'endQuestion': return 'Auflösen';
    case 'nextRound': return 'Rundenwechsel';
    case 'adjustScore': return 'Punktekorrektur';
    case 'setTurn': return 'Zugwechsel';
    case 'resetBuzz': return 'Buzz zurücksetzen';
    case 'stechen': return 'Stechen starten';
    case 'tauscheKategorie': return 'Kategorietausch';
    default: return 'letzte Aktion';
  }
}

export async function handleAction(raum, clientId, body, isHost) {
  const type = String(body.type || '');

  if (HOST_ACTIONS.has(type) && !isHost) {
    // Ein schlafendes Handy verliert seinen Ereignisstrom. Tippt der Host gleich
    // nach dem Aufwecken, ist die Verbindung noch nicht wieder da – das ist kein
    // Rechteproblem, und „Nur der Host darf das“ wäre ein Schreck ohne Grund.
    // Die Rechte selbst hängen weiterhin allein an der offenen Verbindung; hier
    // steht nur, welche der beiden Lagen der Absender vor sich hat.
    if (body.role === 'host' && raum.dienste.hostOhneVerbindung?.(clientId)) {
      throw new G.GameError('Verbindung wird gerade neu aufgebaut – gleich noch einmal tippen.');
    }
    throw new G.GameError('Nur der Host darf das.');
  }

  // Wertungen, die sich auf eine überholte Lage beziehen, prallen ab. Der
  // Client schickt die Kennung mit, die er auf dem Schirm hatte; passt sie
  // nicht mehr, war der Druck für die vorige Situation gedacht – typischerweise
  // „Richtig" für das Zugteam, während schon jemand gebuzzert hat. Ohne die
  // Angabe (ältere, im Browser hängengebliebene Seite) bleibt alles wie bisher.
  if (LAGEGEBUNDEN.has(type) && typeof body.lage === 'string'
      && body.lage !== G.lageSignatur(raum.state)) {
    throw new G.GameError('Da hat sich gerade etwas geändert – schau kurz auf den Screen.');
  }

  // Erst sichern, dann handeln – aber übernommen wird der Schnappschuss erst,
  // wenn der Zug auch durchgegangen ist.
  //
  // Vorher stand er sofort im Rückweg, und ein abgelehnter Zug hat damit
  // den Rückweg überschrieben: Host wertet „Richtig" für Rot (100 Punkte,
  // Knopf sagt „Wertung für Rot"), tippt gleich darauf auf ein Feld, das
  // gerade nicht wählbar ist – der Knopf sagt danach „Feldwahl", und
  // Zurücknehmen ließ die 100 Punkte stehen. Gemessen und nachgestellt. Der
  // Kommentar an dieser Stelle beschrieb schon immer das gewünschte Verhalten;
  // der Code tat es nur nicht.
  const schnappschuss = RUECKNEHMBAR.has(type)
    ? { state: structuredClone(raum.state), was: benenne(type, raum.state), am: Date.now() }
    : null;

  switch (type) {
    /**
     * Zurücknehmen – aber das, was auf dem Knopf steht.
     *
     * Der Knopf ist der einzige im Haus, der seinen Inhalt nennt: „↩ Wertung
     * für Rot zurücknehmen". Geschickt hat er trotzdem nur `undo`, und der
     * Server nahm stur das oberste Element. Dazwischen passt ein Buzz – auch
     * der steht im Rückweg (RUECKNEHMBAR). Gemessen: Host tippt auf
     * „↩ Wertung für Rot zurücknehmen", ein Handy buzzert in derselben
     * Sekunde, und zurückgenommen wird der Buzz. Die Fehlwertung steht weiter
     * auf der Leinwand, und der Knopf heißt jetzt wieder so wie vorhin.
     *
     * Also denselben Weg wie bei den Wertungen (`lage` weiter oben): Der
     * Absender schickt mit, was er zurückzunehmen glaubte. Passt es nicht mehr,
     * prallt der Zug ab, statt etwas anderes zu treffen. Ohne die Angabe – eine
     * ältere, im Browser hängengebliebene Seite – bleibt alles wie bisher.
     */
    case 'undo': {
      if (!raum.rueckWeg.length) throw new G.GameError('Es gibt nichts zurückzunehmen.');
      const oben = raum.rueckWeg.at(-1);
      if (typeof body.was === 'string' && body.was !== oben.was) {
        throw new G.GameError(
          `Inzwischen ist etwas dazwischengekommen (${oben.was}) – schau kurz auf den Screen.`,
        );
      }
      const eintrag = raum.rueckWeg.pop();
      raum.state = uebernimm(eintrag.state, raum.state);
      holeUhrenNach(raum.state, eintrag.am);
      break;
    }

    /**
     * Eine ganze Spalte gegen eine andere Kategorie tauschen.
     *
     * Für den Zufallsmix gedacht: Der weiß nichts vom letzten Abend und legt
     * gern eine Kategorie hin, die alle schon kennen. Bisher half dann nur
     * „Neues Spiel" und neu würfeln – und das warf die fünf guten Spalten mit
     * weg. Geht aber genauso bei jedem festen Satz.
     *
     * Dieselbe Reihenfolge wie bei „Frage austauschen": erst prüfen, dann die
     * Sätze laden, dann prüfen, ob das Brett noch dasselbe ist. Ein `undo` oder
     * ein Feldaufruf vom zweiten Gerät dazwischen weist `raum.state.board` neu zu
     * oder belegt ein Feld – beides fängt die zweite Prüfung.
     */
    case 'tauscheKategorie': {
      const catIdx = Number(body.catIdx);
      G.pruefeKategorieTausch(raum.state, catIdx);
      const brett = raum.state.board;
      const namen = [];
      const gestellt = [];
      for (const runde of raum.state.questionSet?.rounds || []) {
        for (const cat of runde.categories) {
          namen.push(cat.name);
          for (const f of cat.questions) gestellt.push(f.text);
        }
      }
      const bleiben = brett.categories.filter((_, i) => i !== catIdx).map((c) => c.name);
      const spalten = brett.categories.map((c) => c.name).join('\n');
      const neu = await ersatzKategorie({
        runde: raum.state.round,
        belegt: bleiben,
        // Alles, was in diesem Spiel steht – auch die andere Runde: Die
        // Kategorie, die in Runde 2 ohnehin noch kommt, soll nicht vorzeitig
        // auftauchen –, dazu was heute schon weggetauscht wurde.
        ausgeschlossen: [...namen, ...(raum.state.abgewaehlt || [])],
        schonGestellt: [...gestellt, ...(raum.state.stechenTexte || []), ...(raum.state.ersatzTexte || [])],
        zuletzt: raum.gespielt,
      });
      // Während die Sätze laden, kann ein zweites Gerät tauschen (dann wäre
      // der Ersatz gegen ein veraltetes Brett ausgesucht und könnte doppelt
      // dastehen) oder ein `undo` das Brett neu zuweisen. Beides fällt hier auf.
      if (raum.state.board !== brett || brett.categories.map((c) => c.name).join('\n') !== spalten) {
        throw new G.GameError('Das Brett hat sich gerade geändert – bitte noch einmal ansehen.');
      }
      if (!neu) throw new G.GameError('Es ist keine passende Kategorie mehr übrig.');
      // Der Schnappschuss von vor dem Laden kennt womöglich einen Zug nicht,
      // der in der Zwischenzeit durchging (eine Punktkorrektur vom Tablet) –
      // ein „Zurücknehmen" des Tauschs nähme den sonst gleich mit zurück.
      schnappschuss.state = structuredClone(raum.state);
      schnappschuss.am = Date.now();
      // Eingebettete Bilder wie beim Spielstart herauslösen, sonst ginge das
      // Foto aus einem selbstgebauten Satz bei jedem Rundruf an alle Handys.
      const { images } = externalizeImages({ rounds: [{ categories: [neu] }] });
      const { alt } = G.ersetzeKategorie(raum.state, catIdx, neu);
      if (images.size) {
        for (const [id, bild] of images) raum.bilder.set(id, bild);
        // Nicht abwarten: Der Zug ist schon geschehen, und ein Warten hier ließe
        // einen anderen Zug seinen Rückweg-Eintrag vor diesen schieben.
        raum.dienste.sichereBilder().catch((err) => console.error('Bilder nicht gesichert:', err.message));
      }
      // Wer eine Kategorie wegtauscht, kennt sie – der nächste Mix soll sie
      // ebenso meiden wie eine gespielte.
      merkeGespielt(raum, [alt]);
      raum.dienste.hostToast(`„${alt}“ ist raus, neu auf dem Brett: „${neu.name}“.`);
      break;
    }

    /**
     * Eine Frage streichen: Sie zählt nicht, das Feld bleibt offen.
     *
     * Doppeldeutig gestellt, die Lösung war vorhin schon gefallen, im Fragensatz
     * steht ein Fehler – so etwas merkt man erst beim Vorlesen. Bisher blieb nur
     * die Wahl zwischen „irgendwie werten" und „Feld verbrannt": Das Feld war
     * belegt, sobald es aufgerufen war.
     *
     * Gestrichen wird nicht durch Rückrechnen von Punkten, Bilanz und Serie –
     * das wäre eine zweite Buchhaltung neben der ersten und ginge irgendwann
     * auseinander. Stattdessen geht es den Weg zurück bis zu dem Zustand, in dem
     * das Feld noch offen war. Damit stimmt alles wieder, was an dieser Frage
     * hing, ohne dass es einzeln aufgezählt werden muss.
     *
     * Das Verwerfen selbst ist zurücknehmbar: Ein Rückschritt holt die ganze
     * Frage samt Wertung wieder her.
     */
    case 'discard': {
      const q = raum.state.current;
      if (!q) throw new G.GameError('Gerade läuft keine Frage.');
      if (q.stechen) throw new G.GameError('Eine Stechfrage hat kein Feld – lös sie auf und stell die nächste.');

      /*
       * Erst den Ersatz holen, dann den Zustand anfassen.
       *
       * Vorher war „Frage verwerfen" eine Falle: Das Feld ging wieder auf, und
       * wer es erneut anwählte, bekam Wort für Wort dieselbe Frage. Am Tisch
       * ist das die schlechteste aller Antworten – man hat die Frage ja gerade
       * gestrichen, weil sie nichts taugte.
       *
       * Ausgeschlossen wird alles, was heute schon auf dem Brett steht, dazu
       * die Stechfragen: Die Ersatzfrage darf nicht die sein, die in Runde 2
       * ohnehin noch kommt. Das `await` steht bewusst vor jedem Zugriff auf
       * `raum.state` – dieselbe Regel wie beim Stechen weiter unten, denn `undo`
       * und „Neues Spiel" weisen den Modulwert in der Zwischenzeit neu zu.
       */
      const aufDemBrett = [];
      for (const runde of raum.state.questionSet?.rounds || []) {
        for (const cat of runde.categories) for (const f of cat.questions) aufDemBrett.push(f.text);
      }
      const ersatz = await ersatzFrage(q.category,
        [...aufDemBrett, ...(raum.state.stechenTexte || []), ...(raum.state.ersatzTexte || [])]);
      /*
       * Verglichen wird das Objekt, nicht das Feld.
       *
       * Hier standen `catIdx` und `rowIdx`, und genau die überstehen ein
       * `undo`: Der zurückgeholte Zustand steht auf demselben Feld, nur mit
       * einem kürzeren `log`. Die Prüfung winkte durch, und die Rechnung
       * weiter unten nahm `q.log` – das Protokoll des abgehängten Objekts.
       *
       * Gemessen, dreimal von dreimal: Rot hat 500 für ein richtig
       * beantwortetes Feld. Der Host tippt auf dem Screen „Frage
       * austauschen", zwei Millisekunden später die Fernbedienung
       * „Zurücknehmen" (über den Tunnel reicht dafür kein gleichzeitiger
       * Tastendruck). Beide Züge melden ok, und Rot steht danach auf −500 –
       * eine erfundene Korrektur „von Hand" über den vollen Feldwert. Mit
       * 300 ms Abstand passiert nichts dergleichen.
       *
       * `raum.state.current !== q` fängt jede Neuzuweisung: undo, ein zweites
       * discard, „Neues Spiel". Ein `judge` dazwischen ändert dasselbe Objekt
       * und ist damit in `q.log` schon enthalten – das ist richtig so.
       */
      if (raum.state.current !== q) {
        throw new G.GameError('Die Frage ist inzwischen eine andere – bitte noch einmal ansehen.');
      }

      // Der Schnappschuss vor der Feldwahl ist der erste, in dem keine Frage
      // offen steht. Alles darüber gehört zu dieser Frage und fällt mit ihr.
      const bis = raum.rueckWeg.findLastIndex((e) => !e.state.current);
      if (bis < 0) {
        throw new G.GameError('Der Weg zurück reicht nicht mehr bis zum Anfang dieser Frage.');
      }
      /*
       * Was der Host von Hand korrigiert hat, gehört nicht dieser Frage.
       *
       * `discard` springt zum Anker zurück und nimmt damit alles mit, was
       * darüber liegt. Für Punkte, Bilanz und Serie der Frage ist das genau
       * richtig – für eine Punktekorrektur nicht: Sie ist der einzige Zug, den
       * der Host während einer offenen Frage machen darf, der mit der Frage
       * nichts zu tun hat. Beide Knöpfe liegen sogar im selben Menü, und der
       * übliche Ablauf ist ein einziger Besuch darin: erst „ihr habt uns vorhin
       * 100 zu wenig gegeben" richtigstellen, dann die Frage austauschen.
       *
       * Gerechnet wird das aus dem ZUSTAND, nicht aus dem Rückweg-Stapel.
       *
       * Ein erster Anlauf sammelte die Korrekturen als Nutzlast der Einträge
       * über dem Anker ein. Das hielt genau einen Austausch lang: Der erste
       * kappt den Stapel über dem Anker, ein „Zurücknehmen" holt die Frage
       * samt Korrektur zurück – aber der adjustScore-Eintrag ist weg, und der
       * zweite Austausch fand nichts mehr einzusammeln. Nachgestellt: 200
       * Punkte, Austausch, Zurücknehmen, Austausch – und die 200 waren weg.
       *
       * Die Rechnung dagegen hängt an nichts, was verschwinden kann: Zwischen
       * dem Anker und jetzt ändern nur zwei Dinge einen Punktestand – die
       * Wertungen dieser Frage (die stehen alle in `q.log`) und Korrekturen von
       * Hand. Was übrig bleibt, wenn man die Wertungen abzieht, ist von Hand.
       */
      const ankerStand = new Map(raum.rueckWeg[bis].state.teams.map((t) => [t.id, t.score]));
      const ausDerFrage = new Map();
      for (const e of q.log || []) {
        ausDerFrage.set(e.teamId, (ausDerFrage.get(e.teamId) || 0) + (e.delta || 0));
      }
      const korrekturen = [];
      for (const team of raum.state.teams) {
        // Wer erst während der Frage dazukam, steht nicht im Anker – `uebernimm`
        // nimmt ihn mitsamt seinem jetzigen Stand hinüber, da ist nichts zu tun.
        if (!ankerStand.has(team.id)) continue;
        const ausGruenden = ankerStand.get(team.id) + (ausDerFrage.get(team.id) || 0);
        const vonHand = team.score - ausGruenden;
        if (vonHand) korrekturen.push({ teamId: team.id, delta: vonHand });
      }
      const vorher = { state: structuredClone(raum.state), was: 'Frage verworfen', am: Date.now() };
      // Der Ankerpunkt bleibt im Stapel stehen, und übernommen wird eine Kopie.
      //
      // Vorher wurde er verbraucht (`raum.rueckWeg.length = bis`). Nahm der Host das
      // Streichen dann zurück, stand die Frage wieder da – aber ihr Anker war
      // weg. Ein zweites Streichen suchte den nächsten Zustand ohne offene
      // Frage und fand den Anfang der VORHERIGEN Frage: Nachgestellt wurde
      // damit eine längst abgeschlossene, fremde Frage stillschweigend
      // mitgelöscht, samt ihrer Punkte. Bleibt der Anker liegen, findet ihn
      // auch der zweite Versuch. Kopiert werden muss dabei, weil `uebernimm`
      // den übergebenen Zustand verändert – sonst stünde im Stapel danach ein
      // verbogener Schnappschuss.
      const ziel = structuredClone(raum.rueckWeg[bis].state);
      raum.rueckWeg.length = bis + 1;
      raum.state = uebernimm(ziel, raum.state);
      // Teams kommen und gehen nur in der Lobby, hier also nie – geprüft wird
      // trotzdem, damit eine Korrektur für ein fehlendes Team das Streichen
      // nicht mit einem Fehler abbrechen lässt.
      for (const k of korrekturen) {
        if (raum.state.teams.some((t) => t.id === k.teamId)) G.adjustScore(raum.state, k.teamId, k.delta);
      }
      /*
       * Gesagt wird es über den toast-Kanal, nicht über `raum.state.message`.
       *
       * Der Satz stand hier vorher nur in `raum.state.message` – und den liest kein
       * einziges Gerät (siehe die Anmerkung bei `message` in viewFor). Die
       * Rückfrage davor verspricht aber ohne Vorbehalt: „auf dem Feld liegt
       * danach eine andere Frage.“ Blieb der Austausch aus, stand der Host vor
       * demselben Brett und derselben Frage, ohne zu wissen, warum.
       */
      if (ersatz) {
        G.ersetzeFrage(raum.state, q.catIdx, q.rowIdx, ersatz);
        raum.dienste.hostToast('Frage ausgetauscht – auf dem Feld liegt jetzt eine andere.');
      } else {
        // Kann passieren, wenn nur ein einziger Fragensatz installiert ist:
        // Dann steht jede Frage daraus schon auf dem Brett. Lieber ehrlich
        // sagen als so tun, als wäre etwas passiert.
        raum.dienste.hostToast('Es war keine Ersatzfrage übrig – auf dem Feld steht noch dieselbe Frage.', 'error');
      }
      raum.rueckWeg.push(vorher);
      // Auch hier den Deckel halten: Der Anker bleibt liegen, und ohne diese
      // Zeile stünde nach dem Streichen ein Schritt mehr im Stapel als erlaubt.
      if (raum.rueckWeg.length > RUECKWEG_TIEFE) raum.rueckWeg.shift();
      break;
    }
    case 'joinTeam':
      G.joinTeam(raum.state, clientId, body.teamId, body.name);
      break;
    // Ein Handy legt sein eigenes Team an und tritt ihm bei. Bewusst nicht
    // host-only: Genau das ist der Punkt – niemand muss auf den Host warten,
    // der sonst vier Namen abtippt, bevor überhaupt jemand beitreten kann.
    // Die Grenzen dafür stehen ohnehin schon in addTeam: nur in der Lobby,
    // höchstens acht Teams. Entfernen kann sie weiterhin nur der Host.
    case 'eigenesTeam': {
      const wunsch = String(body.name || '').trim();
      // Doppeltipp: Im Netz dauert ein Zug ein paar hundert Millisekunden, und
      // der zweite Tipp legte ein zweites Team gleichen Namens an – das erste
      // blieb leer zurück und kam im Spiel trotzdem an die Reihe. Steht das
      // Gerät schon allein in einem Team dieses Namens, ist nichts zu tun.
      const schon = G.teamOfClient(raum.state, clientId);
      if (schon && schon.members.length === 1 && wunsch && schon.name === wunsch.slice(0, 24)) break;
      G.addTeam(raum.state, wunsch);
      const neu = raum.state.teams[raum.state.teams.length - 1];
      G.joinTeam(raum.state, clientId, neu.id, wunsch);
      break;
    }
    // Wappen wechseln. Ohne `teamId` gilt es fürs eigene Team – so darf jedes
    // Handy sein Wappen aussuchen, aber keins das der anderen umstecken. Der
    // Host darf über die Fernbedienung jedes ändern, so wie er auch jeden
    // Namen ändern darf.
    case 'wappen': {
      const eigenes = G.teamOfClient(raum.state, clientId);
      const ziel = isHost && body.teamId ? body.teamId : eigenes?.id;
      if (!ziel) throw new G.GameError('Such dir erst ein Team aus.');
      G.setTeamWappen(raum.state, ziel, String(body.wappen || ''));
      break;
    }
    case 'leaveTeam':
      G.leaveTeams(raum.state, clientId);
      break;
    case 'addTeam':
      G.addTeam(raum.state, body.name);
      break;
    case 'renameTeam':
      G.renameTeam(raum.state, body.teamId, body.name);
      break;
    case 'removeTeam':
      G.removeTeam(raum.state, body.teamId);
      break;
    case 'removeMember':
      G.removeMember(raum.state, body.teamId, body.clientId);
      break;
    case 'adjustScore':
      G.adjustScore(raum.state, body.teamId, body.delta);
      break;
    case 'setTurn':
      // Während einer Frage ist der Zug bereits vergeben: Wer die Frage hat und
      // wer antworten muss, steht fest. Den Zeiger trotzdem zu verschieben,
      // wirkt für den Host wie ein Fehlgriff – lieber klar absagen.
      if (raum.state.phase === 'question') {
        throw new G.GameError('Der Zug lässt sich erst wieder setzen, wenn die Frage durch ist.');
      }
      G.setTurn(raum.state, body.teamId);
      break;
    case 'settings':
      Object.assign(raum.state.settings, pickSettings(body.settings));
      break;
    case 'startGame': {
      const roh = body.set
        ? normalizeSet(body.set)
        : body.file === MIX
          ? normalizeSet(await mixSet({ zuletzt: raum.gespielt }))
          : await loadSet(body.file);
      const { set, images } = externalizeImages(roh);
      raum.bilder = images;
      // Über einen Spielstart hinweg zurückzunehmen, hieße das alte Spiel
      // wiederauferstehen zu lassen – mitten in einem neuen.
      raum.rueckWeg = [];
      raum.heuteGemerkt = new Set();
      G.startGame(raum.state, set);
      await raum.dienste.sichereBilder();
      break;
    }
    case 'pick': {
      // Auch das Team, das dran ist, darf vom Handy aus wählen.
      const team = G.teamOfClient(raum.state, clientId);
      if (!isHost && !team) throw new G.GameError('Du gehörst zu keinem Team.');
      // Der Einsatz reist als Nutzlast mit, nicht als eigene Aktion – siehe den
      // Kommentar in pickCell. `pick` steht in RUECKNEHMBAR, damit gibt ein
      // Zurücknehmen den Einsatz von selbst wieder her.
      G.pickCell(raum.state, Number(body.catIdx), Number(body.rowIdx),
        isHost ? null : team.id, body.einsatz === true);
      break;
    }
    case 'buzz': {
      G.buzz(raum.state, clientId);
      const team = G.teamOfClient(raum.state, clientId);
      raum.dienste.ereignis('buzz', { teamId: team?.id, teamName: team?.name, by: raum.state.current?.buzzedBy });
      break;
    }
    case 'buzzFor': {
      G.buzzFor(raum.state, body.teamId);
      const team = G.findTeam(raum.state, body.teamId);
      raum.dienste.ereignis('buzz', { teamId: team.id, teamName: team.name, by: team.name });
      break;
    }
    case 'judge':
      G.judge(raum.state, !!body.correct);
      break;
    case 'endQuestion':
      G.endQuestion(raum.state);
      break;
    case 'pass':
      G.passQuestion(raum.state);
      break;
    case 'openBuzz':
      G.openBuzz(raum.state);
      break;
    case 'resetBuzz':
      G.resetBuzz(raum.state);
      break;
    case 'reveal':
      G.revealAnswer(raum.state);
      break;
    case 'close':
      G.closeQuestion(raum.state);
      break;
    case 'nextRound':
      G.nextRound(raum.state);
      break;
    case 'pause':
      G.setPause(raum.state, body.an);
      break;
    case 'stechen': {
      // Alles, was heute schon auf dem Brett stand, fällt raus – sonst kommt
      // als Entscheidungsfrage ausgerechnet die, die vorhin schon jemand
      // gehört hat.
      const gespielt = [];
      for (const runde of raum.state.questionSet?.rounds || []) {
        for (const cat of runde.categories) for (const q of cat.questions) gespielt.push(q.text);
      }
      // Erst warten, dann `raum.state` lesen.
      //
      // Stand das `await` in der Argumentliste, war `raum.state` schon gelesen,
      // bevor gewartet wurde – und `undo`, `discard` und „Neues Spiel" weisen
      // diesen Modulwert neu zu. Trifft einer davon in den Millisekunden ein,
      // die das Einlesen der Fragensätze braucht, arbeitete das Stechen auf
      // einem abgehängten Zustand: Es verpuffte spurlos (mit `ok: true`), und
      // sein Schnappschuss landete trotzdem auf dem Rückweg – auch auf einem,
      // den „Neues Spiel" gerade geleert hatte. Ein `undo` darauf holte das
      // beendete Spiel zurück. Nachgestellt, dreimal von dreimal.
      // `startGame` macht es an derselben Stelle schon richtig.
      const frage = await stechenFrage(
        [...gespielt, ...(raum.state.stechenTexte || []), ...(raum.state.ersatzTexte || [])]);
      G.startStechen(raum.state, frage);
      break;
    }
    /** Das Gedächtnis über die letzten Abende löschen – siehe GESPIELT_FILE. */
    case 'vergessen':
      raum.gespielt = {};
      raum.heuteGemerkt = new Set();
      await raum.dienste.sichereGespielt();
      raum.dienste.hostToast('Vergessen: Der Zufallsmix zieht wieder aus allen Kategorien.');
      break;

    case 'backToLobby':
      raum.state = G.backToLobby(raum.state);
      raum.rueckWeg = [];
      raum.bilder = new Map();
      raum.gezeigteBilder = new Set();
      await raum.dienste.vergissSicherung();
      break;
    default:
      throw new G.GameError(`Unbekannte Aktion: ${type}`);
  }
  // Bis hierher kommt nur, was nicht geworfen hat. `undo` und `backToLobby`
  // räumen den Rückweg selbst ab und stehen nicht in RUECKNEHMBAR – ihr
  // Schnappschuss ist null und überschreibt deshalb nichts.
  if (schnappschuss) {
    raum.rueckWeg.push(schnappschuss);
    if (raum.rueckWeg.length > RUECKWEG_TIEFE) raum.rueckWeg.shift();
  }
  /*
   * Erst jetzt ist der Stand nicht mehr „von letztem Mal", sondern der
   * laufende Abend.
   *
   * Der goldene Balken auf der Leinwand („Spielstand von heute, 21:14 Uhr
   * wiederhergestellt – Rot 500 · Blau 300") ist das Einzige, woran der Host
   * ablesen kann, ob er weiterspielt oder neu anfängt. Diese Zeile stand
   * weiter oben – vor der Lage-Prüfung und vor der Aktion selbst, und ohne
   * Rücksicht darauf, WER da tippt. Gemessen: Ein Gast drückt nach dem
   * Neustart auf den Buzzer, der Server weist ihn ab („Buzzer ist noch
   * gesperrt") – und der Balken war trotzdem weg, bevor der Host ihn gelesen
   * hatte.
   *
   * Jetzt: nur nach einem Zug, der durchgegangen ist, und nur wenn er vom Host
   * kam. Ein Handy, das beitritt oder danebendrückt, ist keine Entscheidung
   * über den Abend.
   */
  if (isHost) raum.wiederhergestelltAm = null;
  merkeBild(raum);
  // Eine Kategorie gilt als gespielt, sobald ein Feld aus ihr aufgerufen ist.
  if (raum.state.board) {
    merkeGespielt(raum, raum.state.board.categories.filter((c) => c.cells.some((z) => z.used)).map((c) => c.name));
  }
  raum.dienste.geaendert();
}

export function pickSettings(s = {}) {
  const out = {};
  if (['rotate', 'keepOnCorrect'].includes(s.turnMode)) out.turnMode = s.turnMode;
  if (['none', 'half', 'full'].includes(s.wrongPenalty)) out.wrongPenalty = s.wrongPenalty;
  if (typeof s.buzzAfterCorrect === 'boolean') out.buzzAfterCorrect = s.buzzAfterCorrect;
  if (['team', 'host'].includes(s.feldwahl)) out.feldwahl = s.feldwahl;
  // Nur die angebotenen Stufen – eine Uhr mit 0,5 Sekunden wäre kein Spiel mehr.
  // Und erst prüfen, ob überhaupt eine Zahl gemeint ist: `Number(null)` ist 0,
  // und 0 heißt „aus". Eine Einstellung mit `buzzUhr: null` hätte die Uhr damit
  // stillschweigend abgeschaltet, statt abgewiesen zu werden – dasselbe für
  // `false`, `''` und `[]`. Vom eigenen Test gefunden.
  const uhr = typeof s.buzzUhr === 'number'
    || (typeof s.buzzUhr === 'string' && s.buzzUhr.trim() !== '')
    ? Number(s.buzzUhr) : NaN;
  if ([0, 10, 15, 20, 30].includes(uhr)) out.buzzUhr = uhr;
  // Die Antwortuhr nach derselben Regel: nur die Werte, die die Lobby anbietet.
  const antwort = typeof s.antwortUhr === 'number'
    || (typeof s.antwortUhr === 'string' && s.antwortUhr.trim() !== '')
    ? Number(s.antwortUhr) : NaN;
  if ([0, 20, 30, 45, 60].includes(antwort)) out.antwortUhr = antwort;
  if (['aus', 'runde'].includes(s.einsatz)) out.einsatz = s.einsatz;
  return out;
}
