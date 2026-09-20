/**
 * Prüfungen für Fragensätze, die Editor und Testlauf sich teilen.
 *
 * Bisher stand die Regel „keine Frage verrät die Lösung einer anderen" nur im
 * Testlauf. Für die mitgelieferten Sätze reicht das – wer aber eigene Fragen
 * schreibt, führt keine Tests aus und merkt es erst am Spielabend, wenn die
 * teuerste Frage einer Kategorie geschenkt ist. Deshalb liegt die Regel hier,
 * und beide Seiten benutzen dieselbe: Der Editor kann nicht anders urteilen als
 * die Prüfung, die über den fertigen Satz läuft.
 *
 * Reines ES-Modul ohne Node- oder Browser-Eigenheiten, damit das geht.
 */

const STOPPWOERTER = new Set([
  'der', 'die', 'das', 'des', 'dem', 'den', 'ein', 'eine', 'einer', 'eines',
  'und', 'oder', 'aus', 'von', 'für', 'mit', 'auf', 'ist', 'sind', 'was',
  'wer', 'wie', 'wo', 'welche', 'welcher', 'welches', 'welchem', 'welchen',
  'in', 'im', 'am', 'an', 'zu', 'zum', 'zur', 'es', 'man', 'sich', 'nicht',
  'heißt', 'nennt', 'gibt', 'hat', 'haben', 'seit', 'auch', 'noch', 'aber',
]);

/** Antwortformate, die in ihrer Kategorie naturgemäß mehrfach vorkommen. */
const FORMATANTWORTEN = /^(wahr|falsch|ja|nein)\b/i;

/**
 * Zahlen fallen nie durch die Latte.
 *
 * Die Latte soll Füllwörter aussortieren – eine Zahl ist nie eines. Gemessen
 * an fünf selbstgetippten Kategorien meldete die Prüfung ohne diese Ausnahme
 * vier heile Fragen: „399 Euro" und „3 Euro" standen in derselben Kategorie,
 * und weil die Ziffern unter der Vier-Zeichen-Latte wegfielen, blieb von
 * beiden Lösungen nur „euro" übrig – das steht in der Nachbarfrage
 * selbstverständlich auch. Dasselbe mit „90 Minuten" und „8 Minuten“.
 * Genau die Zahl ist aber das, was die Frage ausmacht.
 */
const NUR_ZIFFERN = /^\p{N}+$/u;

function zerlege(text, mindestens) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => (w.length >= mindestens || NUR_ZIFFERN.test(w)) && !STOPPWOERTER.has(w));
}

/**
 * Die Wörter, an denen eine Lösung hängt.
 *
 * Kurze Lösungen brauchen eine kürzere Latte: „SMS" hat drei Buchstaben und
 * fiele mit der langen ganz aus der Prüfung – ausgerechnet in einer Kategorie
 * mit einer zweiten Frage „Wofür steht die Abkürzung SMS?". Abkürzungen und
 * Zahlen sind die Lösungen, die sich am leichtesten verraten.
 */
function loesungswoerter(text) {
  const lang = zerlege(text, 4);
  const woerter = lang.length ? lang : zerlege(text, 2);
  // Eine Lösung, die nur aus einer einzelnen Ziffer besteht, kann diese
  // Prüfung nicht beurteilen: Eine 1 oder eine 6 steht irgendwo in jeder
  // Zahlenkategorie. Gemessen an den mitgelieferten Sätzen sind es genau zwei
  // Stellen – „Wie viele Zahlen kreuzt man beim Lotto an?" (6) neben „Wie
  // groß ist die Chance auf eine Sechs?" (1 zu 6), und „Welche Schulnote ist
  // die beste?" (Die 1) neben dem Abiturschnitt 1,0. Beide Male dieselbe
  // Ziffer, beide Male Zufall. In einer mehrteiligen Lösung zählt die Ziffer
  // dagegen mit: Bei „3 Euro" ist genau sie der Unterschied zu „399 Euro".
  if (woerter.length === 1 && /^\p{N}$/u.test(woerter[0])) return [];
  return woerter;
}

/**
 * Endungen, die deutsche Wörter beim Beugen anhängen.
 *
 * Ohne sie vergleicht die Prüfung buchstabengleich – und aus „Neue Deutsche
 * Welle“ wird in der Nachbarfrage „Neuen Deutschen Welle“. Drei andere
 * Wörter, also kein Treffer. Genau so stand es im ausgelieferten „Zugabe“:
 *
 *   „Wofür steht die Abkürzung NDW?“                       → Neue Deutsche Welle
 *   „Welche Band der Neuen Deutschen Welle hatte …“
 *
 * Wer die zweite Frage zuerst spielt, bekommt die erste geschenkt.
 */
const BEUGUNGSENDUNGEN = ['en', 'em', 'er', 'es', 'e', 'n', 's'];

/**
 * Ein Wort auf seinen Stamm bringen.
 *
 * Abgeschnitten wird nur, solange genug übrig bleibt – und wiederholt, bis
 * nichts mehr geht: „wassers“ → „wasser“ → „wass“, sonst läge es neben
 * „wasser“ → „wass“ und die beiden fänden sich nicht.
 *
 * Die vier Zeichen Mindestrest sind der Grund, warum deutsche
 * Zusammensetzungen heil bleiben: „Telefon“ wird zu „telefo“, „Telefonbuch“
 * bleibt „telefonbuch“ – zwei verschiedene Stämme. Gemessen über alle
 * mitgelieferten Sätze meldet die Regel genau den einen echten Fall oben und
 * sonst nichts. Ein einfacher Anfangsvergleich („steckt das eine im anderen?“)
 * meldete an derselben Stelle neun Fälle, von denen acht keine waren:
 * Trainer/Trainerstuhl, Pause/Pausenaufsicht, Winter/Winterschlaf …
 */
function stamm(wort) {
  let w = wort;
  let vorher;
  do {
    vorher = w;
    for (const endung of BEUGUNGSENDUNGEN) {
      if (w.length - endung.length >= 4 && w.endsWith(endung)) {
        w = w.slice(0, -endung.length);
        break;
      }
    }
  } while (w !== vorher);
  return w;
}

/** Zwei Wörter, die dasselbe meinen – auch wenn eines gebeugt ist. */
function gleichesWort(a, b) {
  return a === b || stamm(a) === stamm(b);
}

/**
 * Welche Fragen einer Kategorie verraten die Lösung einer anderen?
 *
 * Erwartet eine Liste `{ text, answer }` und liefert Paare zurück:
 * `{ i, j, answer }` – die Lösung von Frage `i` steht vollständig in Frage `j`.
 * Leere Felder werden übersprungen: Ein halb getippter Satz ist keine Warnung
 * wert, sondern einfach noch nicht fertig.
 */
export function verraeteneLoesungen(fragen) {
  const treffer = [];
  // Jede Frage einmal in Wörter zerlegt – für die Zählung gleich darunter.
  const woerterJeFrage = fragen.map((q) => zerlege(`${q?.text ?? ''} ${q?.answer ?? ''}`, 2));
  const stehtInAnderen = (wort, ausser) => woerterJeFrage.reduce(
    (n, wo, k) => (k !== ausser && wo.some((x) => gleichesWort(wort, x)) ? n + 1 : n), 0,
  );
  // Ab wann ein Wort zur Kategorie gehört und nicht zur Lösung: mindestens
  // zwei der anderen Fragen, und mindestens die Hälfte von ihnen.
  const durchgaengig = Math.max(2, Math.ceil((fragen.length - 1) / 2));

  fragen.forEach((q, i) => {
    const antwort = String(q?.answer ?? '').trim();
    const frage = String(q?.text ?? '').trim();
    if (!antwort || !frage) return;
    if (FORMATANTWORTEN.test(antwort)) return;
    const alle = loesungswoerter(antwort);
    if (!alle.length) return;
    // Ein Wort, das ohnehin durch die halbe Kategorie läuft, verrät nichts:
    // Wer es liest, weiß deshalb noch nicht, welche Frage gemeint ist.
    // Gemessen an einer selbstgetippten Kategorie „Fußball", in der die Lösung
    // einer Frage schlicht „Fußball" war: Ohne diese Zeile meldete die Prüfung
    // zwei der drei Nachbarfragen – beide völlig in Ordnung, sie hatten nur
    // dasselbe Wort im Text. Bleibt von der Lösung danach nichts übrig, ist an
    // ihr auch nichts zu verraten.
    const loesung = alle.filter((w) => stehtInAnderen(w, i) < durchgaengig);
    if (!loesung.length) return;

    fragen.forEach((andere, j) => {
      if (i === j) return;
      const andererText = String(andere?.text ?? '').trim();
      if (!andererText) return;
      // Auch hier die kurze Latte, sonst steht „SMS" zwar in der Lösung, aber
      // nicht im Vergleichstext, und das Paar bleibt unsichtbar.
      const anderswo = zerlege(`${andererText} ${andere?.answer ?? ''}`, 2);
      // Erst wenn die Lösung vollständig anderswo steht, ist sie verraten –
      // gebeugt zählt dabei mit, siehe stamm().
      if (loesung.every((w) => anderswo.some((x) => gleichesWort(w, x)))) {
        treffer.push({ i, j, answer: antwort });
      }
    });
  });
  return treffer;
}

/**
 * Welche Frage verrät ihre eigene Lösung?
 *
 * `verraeteneLoesungen` vergleicht die Fragen einer Kategorie miteinander und
 * überspringt dabei ausdrücklich die Frage selbst. Genau dort schlüpften zwei
 * Fälle durch, die am Tisch geschenkte Punkte bedeuten:
 *
 *   „Wie nennt man den Wurf von der Sieben-Meter-Linie?"  → Der Siebenmeter
 *   „Welche Sendung mit der Maus erklärt sonntags die Welt?" → Die Sendung mit der Maus
 *
 * Das ist keine Frage mehr, sondern Vorlesen.
 *
 * Was diese Prüfung NICHT sieht: kurze Lösungen. „Wie viele Disziplinen
 * umfasst der Zehnkampf?" mit der Lösung „10" oder „Zehn" bleibt unentdeckt –
 * dort steckt die Antwort im Wortsinn, nicht im Buchstabenstand, und jede
 * Regel, die das fassen wollte, meldete reihenweise gesunde Fragen. Gegen
 * dieses Muster hilft nur Lesen; die Prüfung nimmt einem den anderen Teil ab.
 *
 * Verglichen wird bewusst hart: Die Lösung muss – ohne Artikel davor und ohne
 * Leerzeichen und Bindestriche – am Stück im Fragetext stehen. Ein
 * Wortmengen-Vergleich wie oben ging hier nicht: Bei „60 Euro" oder „13 Tage"
 * bleibt nach dem Aussortieren kurzer Wörter nur die Einheit übrig, und die
 * steht in der Frage natürlich auch. Gemessen an allen mitgelieferten Sätzen
 * meldete diese Fassung 20 Fälle, von denen 19 keine waren.
 *
 * Auswahlfragen sind ausgenommen: Wer „Kölsch oder Pils?" fragt, muss die
 * Lösung nennen – das ist die Bauart der Frage, kein Fehler.
 *
 * Die Lösung muss aber an einem Wortanfang beginnen. Ohne diese Bedingung
 * sucht sie in einer Buchstabenkette ohne Fugen, und die hat Nahtstellen, die
 * es im Text gar nicht gibt: „auf eine" wird zu „aufeine" und enthält „feine",
 * „Spanier entwickelte" enthält „nieren", „lässt einen" enthält „steinen".
 * Über die 1008 mitgelieferten Fragen gezählt, gegen die 1002 Lösungswörter ab
 * fünf Zeichen: 1166 Funde stehen innerhalb eines Wortes, 94 nur quer über
 * eine Wortgrenze – und unter diesen 94 ist keiner, der als Lösung zu seiner
 * Frage passte. Der Wortanfang schneidet genau sie weg.
 *
 * Nach hinten bleibt es offen, und das ist der ganze Zweck: „Siebenmeter"
 * steht in „Sieben-Meter-Linie" nur, wenn man über die Bindestriche hinweg
 * liest. An einem Wortanfang fängt es dort aber an.
 */
export function selbstverraeter(fragen) {
  const glatt = (t) => String(t ?? '').toLowerCase().replace(/[^0-9a-zäöüß]/g, '');
  const ohneArtikel = (a) => String(a ?? '').trim()
    .replace(/^(der|die|das|den|dem|ein|eine|einen|einem|mit|aus|zu|zum|zur|in|im|bei|beim|von|auf)\s+/i, '');
  // Dieselbe Buchstabenkette wie oben – und dazu zu jeder Stelle die Frage,
  // ob dort im Originaltext ein Wort anfing.
  const kette = (t) => {
    let buchstaben = '';
    const wortanfang = [];
    let neu = true;
    for (const c of String(t ?? '').toLowerCase()) {
      if (/[0-9a-zäöüß]/.test(c)) { buchstaben += c; wortanfang.push(neu); neu = false; } else neu = true;
    }
    return { buchstaben, wortanfang };
  };
  const stehtDrin = (text, kern) => {
    const { buchstaben, wortanfang } = kette(text);
    for (let p = buchstaben.indexOf(kern); p !== -1; p = buchstaben.indexOf(kern, p + 1)) {
      if (wortanfang[p]) return true;
    }
    return false;
  };
  const treffer = [];
  fragen.forEach((q, i) => {
    const antwort = String(q?.answer ?? '').trim();
    const frage = String(q?.text ?? '').trim();
    if (!antwort || !frage) return;
    if (FORMATANTWORTEN.test(antwort)) return;
    if (/\boder\b/i.test(frage)) return; // Auswahlfrage – siehe oben
    const kern = glatt(ohneArtikel(antwort));
    // Unter fünf Zeichen ist ein Fund kein Beweis: „acht" steckt auch in
    // „beachten".
    if (kern.length < 5) return;
    if (stehtDrin(frage, kern)) treffer.push({ i, answer: antwort });
  });
  return treffer;
}
