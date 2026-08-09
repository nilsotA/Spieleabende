# Quizduell für Spieleabende

Ein Quiz-Spielbrett im Stil der Quizduell-Show: **ein großer Screen** (Beamer, TV oder
geteilter Bildschirm) zeigt Kategorien, Punktefelder und Fragen – **alle Mitspieler
buzzern über ihr Handy** im gleichen WLAN.

Keine Datenbank, keine Abhängigkeiten, kein Build. Node installieren, starten, spielen.

---

## Losspielen

```bash
node server/index.js       # oder: npm start
```

Der Server nennt beim Start alle Adressen:

```
Host-Screen (Beamer/TV):  http://localhost:3000/host
Handys der Mitspieler:    http://192.168.x.x:3000
Fernbedienung für dich:   http://192.168.x.x:3000/remote
Fragen-Editor:            http://localhost:3000/editor
```

1. **Host-Screen** öffnen und Teams anlegen – für Einzelspieler einfach ein Team pro Person.
2. Alle anderen scannen den **QR-Code**, der in der Lobby steht (oder tippen die
   WLAN-Adresse ein), geben ihren Namen ein und wählen ihr Team. Für Zweierteams
   wählen beide dasselbe Team.
3. Fragensatz auswählen, Regeln einstellen, **Spiel starten**.

Anderer Port: `PORT=8080 node server/index.js`

### Fernbedienung: `/remote`

Der große Screen ist für alle sichtbar – die Lösung darf da nicht draufstehen. Öffne
deshalb als Host **`/remote` auf deinem eigenen Handy**. Dort stehen Frage, Bild *und
Lösung*, und du bewertest von dort mit großen Knöpfen. Auf der Leinwand bleibt die
Lösung verdeckt, und du musst dich nicht umdrehen.

Auch das nächste Feld rufst du von dort auf: Solange das Board steht, listet die
Fernbedienung alle Kategorien mit ihren noch offenen Werten. Gespielte Felder bleiben
ausgegraut stehen, damit die Reihe ihre Ordnung behält.

Ohne zweites Gerät geht es auch: In der Steuerleiste des Host-Screens ist die Lösung
unscharf und lässt sich mit `👁` oder der Taste `L` kurz aufdecken – dann sehen sie
allerdings alle im Raum.

### Host-Screen: Beamer, MacBook oder iPad

Der Host-Screen muss kein Beamer sein – ein MacBook oder ein iPad tut es genauso.

- **Vollbild** mit `F` oder dem `⛶` in der Steuerleiste: Ohne Tableiste, Adresszeile
  und Dock bleibt spürbar mehr Bühne übrig. Gerade auf einem 13-Zöller lohnt sich das.
- **Der Bildschirm bleibt an.** Während einer Frage fasst den Host-Screen minutenlang
  niemand an – ohne Sperre ginge er mitten im Spiel aus.
- **Mit dem Finger bedienbar:** Auf Touchgeräten wachsen alle Knöpfe auf Fingergröße.
  Am MacBook bleibt die Leiste kompakt, damit sie keine Bühnenhöhe frisst.

### Verklickt?

„Richtig" statt „Falsch" passiert an jedem Spieleabend genau einmal. Ein Knopf
in der Steuerleiste – und auf der Fernbedienung – nimmt den letzten Zug wieder
zurück, samt Punkten, Serie und Bilanz. Er sagt dabei, was er zurücknimmt
(„Wertung für Die Grübelmeister"). Eine Stufe genügt: Wer zwei Züge zurück
will, hat ein anderes Problem.

Wer zwischendurch beigetreten ist, bleibt im Team – zurückgenommen wird der
Spielzug, nicht der Raum.

### Wenn etwas abstürzt

Der Spielstand liegt nicht nur im Speicher: Punkte, Teams, das halb gespielte Board
und sogar eine offen stehende Frage werden laufend gesichert und beim Start wieder
hergestellt. Der Host-Screen sagt dann oben, von wann der Stand ist, und bietet
„Neues Spiel" gleich daneben an – der Hinweis verschwindet beim ersten Zug. Ein versehentlich geschlossenes Terminal oder ein abgestürzter Rechner
kostet euch also höchstens ein paar Sekunden. Nach 12 Stunden verfällt der Stand,
und „Spiel beenden“ im Host-Menü verwirft ihn sofort.

### Auch ohne Handys spielbar

Wenn ihr um einen Bildschirm herumsitzt, braucht ihr keine Handys: Der Host bewertet
alles über die Leiste unten und kann per „Buzz: <Team>“ auch stellvertretend für das
Team buzzern, das als Erstes „hier!“ ruft.

---

## Regeln

Das Board hat 6 Kategorien × 4 Felder. Wer am Zug ist, wählt ein Feld.

| Situation | Punkte |
|---|---|
| Team am Zug antwortet richtig | **+ voller Wert** |
| Team am Zug antwortet falsch oder weiß es nicht | 0 (einstellbar: Abzug) |
| Danach: ein anderes Team buzzert und liegt richtig | **+ halber Wert** |
| Danach: ein anderes Team buzzert und liegt falsch | **− halber Wert** |

**Wichtig:** Der Buzzer bleibt gesperrt, solange das Team am Zug nicht geantwortet hat.
Erst danach wird er für alle anderen frei – der Server entscheidet, wer zuerst gedrückt
hat. Wer falsch buzzert, ist für diese Frage raus; die Übrigen dürfen weiter.

**Runde 2** hat neue Kategorien und **doppelte Punkte** (200/400/600/1000 statt
100/200/300/500). Wer am Ende die meisten Punkte hat, gewinnt.

### Was der Screen nebenbei erzählt

Die Punkteregeln sind das ganze Spiel – alles Folgende ist reine Anzeige und
ändert daran nichts:

- **Wie knapp war der Buzz?** Der Server misst die Zeit zwischen Freigabe und
  Druck und zeigt sie an: „Team Rakete hat gebuzzert · 0,42 s“. Nur bei echten
  Handy-Buzzern – drückt der Host stellvertretend, wäre es seine Reaktionszeit.
- **Serien:** Ab drei richtigen Antworten in Folge trägt das Pult ein Abzeichen.
- **Wer noch darf:** Bei freiem Buzzer stehen die Pulte im Licht, die noch
  drücken dürfen; wer seinen Versuch hatte, tritt zurück.
- **Am Ende** stehen unter dem Siegertreppchen die Auszeichnungen des Abends:
  schnellster Buzz, längste Serie, teuerster Reinfall, bester Dieb (die meisten
  per Buzzer geholten Punkte), sicherste Bank (beste Trefferquote) und
  ehrlichste Haut (die meisten „weiß nicht“). Gezeigt wird nur, was jemand sich
  auch verdient hat; bei vielen Teams rückt die Tafel enger zusammen.
- **Eigene Bilanz:** In den Pausen – am Rundenende und zum Schluss – zeigt jedes Handy
  seinem Team, wie der Punktestand zustande kam: richtig, daneben, „weiß nicht“, dazu
  Geklautes und Verbuzzertes. Das steht bewusst auf dem Handy und nicht auf der
  Leinwand, wo alle auf den Sieger schauen.

### Einstellbar in der Lobby

- **Wer ist als Nächstes dran?** Reihum (Standard) oder „wer richtig liegt, bleibt dran“.
- **Abzug bei falscher Antwort des Zugteams:** keiner (Standard), halbe oder volle Punkte.
- **Buzzern nach richtiger Antwort:** normalerweise aus – die Frage ist dann durch.

### Tastenkürzel auf dem Host-Screen

| Taste | Aktion |
|---|---|
| `1` | Richtig |
| `2` | Falsch |
| `3` | Zugteam weiß es nicht → Buzzer frei |
| `4` | Keiner weiß es → auflösen |
| `L` | Lösung kurz aufdecken (Achtung: alle sehen den Bildschirm) |
| `Leertaste` | Weiter / nächste Runde |
| `F` | Vollbild an/aus (geht auch schon in der Lobby) |
| `Esc` | Menü (Punkte korrigieren, Zug setzen, Ton an/aus) |

### Ton

Alle Klänge entstehen im Browser aus Oszillatoren – keine Datei, kein Download.
Jedes Gerät lässt sich einzeln stummschalten: auf dem Host-Screen im Menü (`Esc`),
auf dem Handy über das Lautsprechersymbol unten. Der Beamer darf also tönen,
während die Handys still bleiben.

---

## Eigene Fragen

Der **Fragen-Editor** unter `/editor` baut Fragensätze im Browser: Kategorien benennen,
Fragen und Antworten eintippen, optional ein Bild pro Frage (wird verkleinert und direkt
in die Datei eingebettet). Speichern geht auf den Server (landet in `data/`) oder als
Download – zwischendurch merkt sich der Browser den Stand automatisch.

Fragensätze sind schlichtes JSON und lassen sich auch von Hand schreiben:

```json
{
  "name": "Unser Fragensatz",
  "rounds": [
    {
      "categories": [
        {
          "name": "Erdkunde",
          "questions": [
            { "text": "Hauptstadt von Australien?", "answer": "Canberra", "note": "Nicht Sydney!" },
            { "text": "…", "answer": "…" },
            { "text": "…", "answer": "…" },
            { "text": "…", "answer": "…" }
          ]
        }
      ]
    },
    { "categories": [] }
  ]
}
```

- Jede Kategorie braucht **genau vier** Fragen: **100 / 200 / 300 / 500** – in Runde 2
  automatisch verdoppelt. Die Reihenfolge im JSON bestimmt also die Schwierigkeit.
  Stimmt die Anzahl nicht, sagt das die Fragensatz-Auswahl im Host-Screen direkt –
  nichts wird stillschweigend abgeschnitten.
- `image` ist optional: eine URL, ein `data:`-URI oder ein Dateiname aus `data/bilder/`
  (dann als `"/bilder/foto.jpg"` eintragen). Bei Bildfragen tritt der Buzzer auf dem
  Handy zurück, damit das Bild vollständig sichtbar bleibt. Fehlt eine Bilddatei,
  sagt das die Fragensatz-Auswahl – sonst wäre die Frage im Spiel stumm verbrannt.
- `note` ist optional und erscheint beim Auflösen als kleiner Zusatz – auf der
  Leinwand und auf den Handys. Genau darüber redet die Runde danach.
- Mehr als zwei Runden gehen auch – jede weitere zählt ebenfalls doppelt.

### Mitgeliefert

Fünf fertige Sätze mit je 48 Fragen – zusammen 240, keine doppelt:

| Satz | Kategorien |
|---|---|
| **Spieleabend Klassiker** | Gemischtes Allgemeinwissen zum Loslegen ohne Vorbereitung |
| **Popkultur & Emoji** | Emoji-Rätsel, Filmzitate, Werbeslogans, Serien, Musik, Gaming |
| **Kopfnuss** | Anagramme, Geheimschrift, Schätzfragen, Logik, Wahr oder falsch |
| **Deutschland-Duell** | KFZ-Kennzeichen, Bundesländer, Dialekt, Marken, Erfindungen |
| **Länder & Flaggen** | Flaggen zum Ansehen, Hauptstädte, Wahrzeichen, Währungen, Nachbarländer |
| **Neunziger & Nuller** | Fernsehen damals, Werbung, Technik-Museum, Pausenhof, Boygroups |
| **Kurios & Wahr** | Tierische Superkräfte, Wahr oder falsch, aus Versehen erfunden, Schätzfragen |

„Kopfnuss“ ist der Satz für gemischte Runden: Anagramme und Logikrätsel kann man
knacken, ohne irgendetwas auswendig zu wissen. „Neunziger & Nuller“ ist der mit
dem meisten Dazwischengerufe, „Kurios & Wahr“ der, bei dem gutes Raten reicht.

Dazu gibt es in der Auswahl **🎲 Zufallsmix aus allen Sätzen** – zwölf Kategorien,
bei jedem Start neu gewürfelt. So ist kein Abend wie der andere.

Emoji auf einer eigenen Zeile werden groß dargestellt – bei Rätseln wie
`Welcher Film?\n🦁 👑` sind die Symbole ja die eigentliche Frage.

Die Flaggen in „Länder & Flaggen“ sind als SVG gezeichnet und liegen in `data/bilder/`.
Keine Downloads, keine externen Bilder – das Quiz läuft auch ohne Internet.

---

## Technik

- **Server:** Node ≥ 18, reine Standardbibliothek.
- **Verbindung:** Server-Sent Events für Updates, `POST /api/action` für Eingaben. Der
  Server vergibt den Buzz nach Eingangszeit; wer die Antwort noch nicht sehen darf,
  bekommt sie auch nicht geschickt.
- **Rollen:** Host ist, wer `/host` oder `/remote` offen hat – die Rechte hängen an der
  offenen Verbindung, nicht an einer Angabe im Request, damit nicht jedes Handy Punkte
  verteilen kann. Ein Passwort gibt es bewusst nicht: Es ist ein Spieleabend im eigenen
  WLAN, kein öffentlicher Dienst. Stell den Server nicht ins offene Internet.
- **QR-Code:** eigener Encoder in `public/qr.js` (Byte-Modus, Version 1–10), damit
  auch dafür keine Abhängigkeit nötig ist. Die Ausgabe ist über 394 Zufallseingaben
  gegen eine unabhängige Implementierung geprüft und bis auf die Maskenwahl in
  3 Fällen bitgenau identisch – die Maske beeinflusst nur die Robustheit.
- **Spielstand:** liegt in `data/.spielstand.json` (eingebettete Bilder daneben) und
  wird beim Start zurückgeholt. Über `QUIZDUELL_STATE_FILE` umlenkbar.
- **Tests:** `npm test` (Node-Testrunner). Neben den Punkte- und Buzzer-Regeln,
  der Fragensatz-Prüfung und dem QR-Encoder laufen Integrationstests gegen einen
  echten Server – inklusive `SIGKILL` mitten im Spiel und anschließendem Neustart.
  Ein Test prüft außerdem, dass innerhalb einer Kategorie keine Frage die Lösung
  einer anderen verrät – so etwas verschenkt sonst ausgerechnet die teuerste Frage.

```
server/   game.js (Spielregeln) · questions.js (Fragensätze) · index.js (HTTP/SSE)
public/   host.* (Board) · player.* (Handy) · remote.* (Fernbedienung)
          editor.* (Fragen) · index.html/start.css · common.js · qr.js · style.css
data/     Fragensätze als JSON, Bilder unter data/bilder/
test/     Regeltests
```
