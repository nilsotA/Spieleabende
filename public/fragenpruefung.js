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

function zerlege(text, mindestens) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= mindestens && !STOPPWOERTER.has(w));
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
  return lang.length ? lang : zerlege(text, 2);
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
  fragen.forEach((q, i) => {
    const antwort = String(q?.answer ?? '').trim();
    const frage = String(q?.text ?? '').trim();
    if (!antwort || !frage) return;
    if (FORMATANTWORTEN.test(antwort)) return;
    const loesung = loesungswoerter(antwort);
    if (!loesung.length) return;

    fragen.forEach((andere, j) => {
      if (i === j) return;
      const andererText = String(andere?.text ?? '').trim();
      if (!andererText) return;
      // Auch hier die kurze Latte, sonst steht „SMS" zwar in der Lösung, aber
      // nicht im Vergleichstext, und das Paar bleibt unsichtbar.
      const anderswo = zerlege(`${andererText} ${andere?.answer ?? ''}`, 2);
      // Erst wenn die Lösung vollständig anderswo steht, ist sie verraten.
      if (loesung.every((w) => anderswo.includes(w))) {
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
 */
export function selbstverraeter(fragen) {
  const glatt = (t) => String(t ?? '').toLowerCase().replace(/[^0-9a-zäöüß]/g, '');
  const ohneArtikel = (a) => String(a ?? '').trim()
    .replace(/^(der|die|das|den|dem|ein|eine|einen|einem|mit|aus|zu|zum|zur|in|im|bei|beim|von|auf)\s+/i, '');
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
    if (glatt(frage).includes(kern)) treffer.push({ i, answer: antwort });
  });
  return treffer;
}
