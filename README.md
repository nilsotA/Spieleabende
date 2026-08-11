# Quizduell für Spieleabende

Ein Quiz-Spielbrett im Stil der Quizduell-Show: **ein großer Screen** (Beamer, TV oder
geteilter Bildschirm) zeigt Kategorien, Punktefelder und Fragen – **alle Mitspieler
buzzern über ihr Handy** im gleichen WLAN.

Keine Datenbank, keine Abhängigkeiten, kein Build. Node installieren, starten, spielen.

---

## Losspielen

**Der kürzeste Weg: doppelklicken.**

| System | Datei |
|---|---|
| macOS | `Start-Quizduell.command` |
| Windows | `Start-Quizduell.bat` |
| Linux | `start-quizduell.sh` |

Das Fenster bleibt offen, solange gespielt wird, und der Host-Screen geht von
selbst im Browser auf. Fehlt Node.js noch, sagt das Fenster, wo es herkommt.
Tut der Doppelklick auf macOS oder Linux nichts, fehlt einmalig das Ausführrecht:

```bash
chmod +x "Start-Quizduell.command"    # bzw. start-quizduell.sh
```

Im Terminal geht es genauso:

```bash
npm start                  # oder: node server/index.js
```

Ist der übliche Port 3000 schon belegt, nimmt der Server von selbst den nächsten
freien und sagt es dazu – ein zweiter Doppelklick läuft also nicht ins Leere.

Der Server nennt beim Start alle Adressen:

```
Host-Screen (Beamer/TV):  http://localhost:3000/host
Handys der Mitspieler:    http://192.168.x.x:3000
Fernbedienung für dich:   http://192.168.x.x:3000/remote
Fragen-Editor:            http://localhost:3000/editor
```

1. **Host-Screen** öffnen – mehr braucht es zum Anfangen nicht.
2. Alle scannen den **QR-Code**, der in der Lobby steht (oder tippen die
   WLAN-Adresse ein), geben ihren Namen ein und tippen auf **„Eigenes Team“**.
   Das Team heißt dann wie sie und erscheint sofort auf der Leinwand. Für
   Zweierteams tippt der Zweite stattdessen auf das Team des Ersten.
3. Wer mag, sucht sich auf dem Handy noch ein **Wappen** aus – Fuchs, Bär,
   Panda … Es steht den Abend über neben dem Teamnamen: an der Punkteleiste,
   im Fragenkasten und in der Rangliste. Ein vergebenes Wappen zeigt der
   Rahmen in der Farbe des Teams, dem es gehört. Zu ändern ist es nur in der
   Lobby – danach ist es das Zeichen, an dem man sein Team wiedererkennt.
4. Fragensatz auswählen, Regeln einstellen, **Spiel starten**.

Teams anlegen, umbenennen und entfernen kann der Host weiterhin selbst – nur
muss er nicht mehr vier Namen abtippen, bevor überhaupt jemand beitreten kann.
Selbst anlegen geht ausschließlich in der Lobby; läuft das Spiel, steigt man in
ein vorhandenes Team ein.

Anderer Port: `PORT=8080 node server/index.js` – eine eigene Angabe gilt dann
genau so und wird nicht verschoben.

### Wann kann ich starten?

Über dem Startknopf steht, wie es um die Handys steht – und zwar das, was die
Teamliste daneben nicht zeigen kann:

```
3 Handys verbunden · ohne Handy: Die Grübelmeister, Solo Sarah · 1 noch ohne Team
5 Handys verbunden – alle 3 Teams sind dabei.
```

- **Die Kopfzahl** zählt alle verbundenen Handys, auch die zweiten Geräte in
  Zweierteams. Ein Team gilt schon mit einem Handy als dabei – ob der Partner
  auch drauf ist, sieht man nur an dieser Zahl.
- **„Ohne Handy“** nennt die Teams beim Namen, damit du sie ansprechen kannst,
  statt „irgendwer fehlt noch“ in den Raum zu rufen.
- **„Noch ohne Team“** sind Handys, die den QR-Code schon gescannt haben und
  gerade den Namen tippen. Die stehen in keinem Team und wären sonst unsichtbar –
  dabei sind sie der Grund, noch zehn Sekunden zu warten.

Sind alle dabei, wird die Zeile grün. Ohne Handys zu spielen bleibt erlaubt: Dann
steht dort nur, dass der Host die Knöpfe drückt, und der Start ist nicht gesperrt.

Dieselbe Zeile steht auch oben auf der **Fernbedienung** – in der Lobby steht der
Host meist mit dem Handy am Tisch und nicht am Laptop.

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

„Richtig“ statt „Falsch“ passiert an jedem Spieleabend genau einmal. Ein Knopf
in der Steuerleiste – und auf der Fernbedienung – nimmt den letzten Zug wieder
zurück, samt Punkten, Serie und Bilanz. Er sagt dabei, was er zurücknimmt
(„Wertung für Die Grübelmeister“). Eine Stufe genügt: Wer zwei Züge zurück
will, hat ein anderes Problem.

Wer zwischendurch beigetreten ist, bleibt im Team – zurückgenommen wird der
Spielzug, nicht der Raum.

Gegen den anderen Verklicker – „Richtig“ drücken, während in derselben Sekunde
jemand buzzert – wirken zwei Sperren. Auf dem Gerät selbst ist jede Wertung
400 ms lang gesperrt, damit ein zitternder Finger nicht zweimal zählt. Und jede
Wertung nennt dem Server die Lage, für die sie gedacht war: Hat sich die
inzwischen geändert, prallt sie ab, statt dem falschen Team Punkte zu geben.
Das greift auch dann, wenn Leinwand und Fernbedienung kurz auseinanderlaufen.

### Wenn etwas abstürzt

Der Spielstand liegt nicht nur im Speicher: Punkte, Teams, das halb gespielte Board
und sogar eine offen stehende Frage werden laufend gesichert und beim Start wieder
hergestellt. Der Host-Screen sagt dann oben, von wann der Stand ist, und bietet
„Neues Spiel“ gleich daneben an – der Hinweis verschwindet beim ersten Zug. Ein versehentlich geschlossenes Terminal oder ein abgestürzter Rechner
kostet euch also höchstens ein paar Sekunden. Nach 12 Stunden verfällt der Stand,
und „Spiel beenden“ im Host-Menü verwirft ihn sofort.

### Noch ein Satz?

Nach dem Endstand führt „Spiel beenden“ im Menü zurück in die Lobby: Punkte auf
null, Board neu, aber **die Teams und ihre Handys bleiben stehen**. Niemand muss
den QR-Code noch einmal scannen – auch nicht, wer sein Handy in der Pause weggelegt
hat. Erst wer über zwei Stunden weg ist, wird beim nächsten Spiel aussortiert.

### Auch ohne Handys spielbar

Wenn ihr um einen Bildschirm herumsitzt, braucht ihr keine Handys: Der Host bewertet
alles über die Leiste unten. Sobald der Buzzer frei ist, steht dort für jedes Team
**ohne verbundenes Handy** ein kleiner Knopf mit Teamfarbe und Kurznamen – damit
buzzert der Host für den, der als Erstes „hier!“ ruft. Teams, die ein Handy in der
Hand haben, drücken selbst und bekommen deshalb keinen Knopf; fällt so ein Handy
mitten in der Frage aus, taucht sein Knopf sofort wieder auf.

---

## Regeln

Das Board hat 6 Kategorien × 4 Felder. Wer am Zug ist, wählt ein Feld.

| Situation | Punkte |
|---|---|
| Team am Zug antwortet richtig | **+ voller Wert** |
| Team am Zug antwortet falsch **oder weiß es nicht** | **− halber Wert** (einstellbar) |
| Danach: ein anderes Team buzzert und liegt richtig | **+ halber Wert** |
| Danach: ein anderes Team buzzert und liegt falsch | **− halber Wert** |

**„Weiß nicht" zählt wie eine falsche Antwort.** Wer die Frage zuerst bekommt und
passt, steht genauso da, als hätte er etwas Falsches gesagt – gleicher Abzug, gleiche
Serie gerissen. Sonst wäre „weiß nicht“ der sichere Ausweg, und geraten hätte nur noch,
wer nichts zu verlieren hat. Auf der
Leinwand steht trotzdem weiter „wusste es nicht“ statt „falsch“: Das ist am Tisch eine
andere Geschichte, auch wenn sie gleich viel kostet.

**Wichtig:** Der Buzzer bleibt gesperrt, solange das Team am Zug nicht geantwortet hat.
Erst danach wird er für alle anderen frei – der Server entscheidet, wer zuerst gedrückt
hat. Wer falsch buzzert, ist für diese Frage raus; die Übrigen dürfen weiter.

**Runde 2** hat neue Kategorien und **doppelte Punkte** (200/400/600/1000 statt
100/200/300/500). Wer am Ende die meisten Punkte hat, gewinnt.

**Stechen bei Gleichstand.** Stehen am Ende zwei oder mehr gleichauf an der Spitze,
steht im Endstand ein Knopf „⚡ Stechen“. Er holt eine Entscheidungsfrage aus einem
der anderen Fragensätze – eine, die an diesem Abend noch nicht dran war. Es gibt
kein Zugteam: Der Buzzer ist sofort frei, aber nur für die Punktgleichen. Wer zuerst
drückt und richtig liegt, gewinnt den Abend; wer danebenliegt, ist aus dem Stechen
raus und die Übrigen dürfen weiter. Weiß es keiner, holt der Host die nächste Frage.

Das Stechen vergibt **keine Punkte** – die Tafel bleibt, wie sie gespielt wurde. Es
beantwortet nur die Frage, die sonst offenbliebe: wer gewonnen hat.

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
- **Abzug, wenn das Zugteam falsch liegt oder nicht weiß:** halbe Punkte (Standard),
  keiner oder volle Punkte. Falsch und „weiß nicht“ kosten gleich viel – siehe oben.
  Ohne Abzug ist ein Feldaufruf risikofrei, dann wird gern das teuerste Feld genommen
  und ins Blaue geraten.
- **Buzzern nach richtiger Antwort:** normalerweise aus – die Frage ist dann durch.
- **Wer ruft das Feld auf?** Standard: das Team am Zug tippt es auf seinem Handy an.
  Auf **„Nur der Host“** verschwindet das Raster von den Handys – dann rufen die Teams
  ihr Feld zu und du klickst es an. Das lohnt sich, wenn ihr sowieso alle auf die
  Leinwand schaut, oder wenn zu oft versehentlich das teuerste Feld angetippt wird.
  Das Zugteam sieht die Kategorien und die offenen Werte weiterhin auf seinem Handy –
  nur eben zum Ansehen, damit es ansagen kann, was es will.

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
| `Esc` | Menü (Punkte korrigieren, Zug setzen, Ton an/aus, Spickzettel) |

### Spickzettel

Im Menü (`Esc`) stehen die Punkteregeln so, **wie sie für diese Runde eingestellt
sind** – samt der Zahlen der gerade laufenden Frage. Wer Abzug oder Zugfolge
umstellt, sieht das dort sofort; ein fest getexteter Zettel wäre für die halben
Runden falsch, und ein falscher Spickzettel ist schlimmer als keiner. Darunter
liegen die Tastenkürzel, damit man sie nicht im README suchen muss.

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
- **Kurz halten.** Passt eine Frage nicht auf die Bühne, rechnet der Host-Screen
  die Schrift herunter, bis sie passt – bei einem ganzen Absatz landet sie dabei
  bei einem Bruchteil ihrer Größe und ist aus vier Metern nicht mehr zu lesen.
  Bis etwa 180 Zeichen bleibt sie in voller Größe; darüber sagt es der Editor.
  Reicht auch die kleinste Stufe nicht, rückt beim Auflösen wenigstens die
  Lösung ins Bild – die Frage hat der Host ohnehin vorgelesen.
- Mehr als zwei Runden gehen auch – jede weitere zählt ebenfalls doppelt.

### Mitgeliefert

Vierzehn fertige Sätze mit je 48 Fragen – zusammen 672, keine doppelt:

| Satz | Kategorien |
|---|---|
| **Spieleabend Klassiker** | Gemischtes Allgemeinwissen zum Loslegen ohne Vorbereitung |
| **Popkultur & Emoji** | Emoji-Rätsel, Filmzitate, Werbeslogans, Serien, Musik, Gaming |
| **Kopfnuss** | Anagramme, Geheimschrift, Schätzfragen, Logik, Wahr oder falsch |
| **Deutschland-Duell** | KFZ-Kennzeichen, Bundesländer, Dialekt, Marken, Erfindungen |
| **Länder & Flaggen** | Flaggen für Fortgeschrittene, Hauptstädte, Wahrzeichen, Währungen, Nachbarländer |
| **Neunziger & Nuller** | Fernsehen damals, Werbung, Technik-Museum, Pausenhof, Boygroups |
| **Kurios & Wahr** | Tierische Superkräfte, Wahr oder falsch, aus Versehen erfunden, Schätzfragen |
| **Küche & Keller** | Herkunft von Gerichten, Zutaten, Kochbegriffe, Gewürze, Bier & Wein, Küchengeräte |
| **Drei Generationen** | Wohnzimmer von früher, Schule von damals, Marken, Jugendwörter, „Heute erklärt“ |
| **Zahlen & Formen** | Berühmte Zahlen, Geometrie, Kopfrechnen, Wahrscheinlichkeit, Mathe-Köpfe |
| **Anpfiff** | Regelkunde, Olympia, Wintersport, Leichtathletik, Vereine, Sport & Körper |
| **Schule & Uni** | Schulfächer, Latein, Notenkunde, Pausenhof, Uni-Latein, Prüfungszeit |
| **Der Klassiker** | Hauptstädte, Zahlen, der Mensch, „Wer war das?“, Abkürzungen, Tiere & Pflanzen |
| **Weltgeschichte** | Ritter & Römer, Kriege & Krisen, Herrscher, Entdecker, Weltreiche, Kalter Krieg |

„Kopfnuss“ ist der Satz für gemischte Runden: Anagramme und Logikrätsel kann man
knacken, ohne irgendetwas auswendig zu wissen. „Neunziger & Nuller“ ist der mit
dem meisten Dazwischengerufe, „Kurios & Wahr“ der, bei dem gutes Raten reicht.
„Küche & Keller“ passt zu dem Abend, an dem sowieso alle am Buffet stehen –
mitraten kann jeder, der schon mal gekocht hat.

Für den **Familienabend** ist „Drei Generationen“ gebaut: In jeder Kategorie weiß
jemand anders Bescheid – die Eltern beim Wohnzimmer von früher und beim Telefon mit
Wählscheibe, die Jüngeren bei „cringe“ und „geghostet“. Niemand sitzt eine ganze
Runde lang nur daneben.

Für die **Uni-Runde** gibt es „Zahlen & Formen“, „Anpfiff“ und „Schule & Uni“.
Sie sind so geschrieben, dass Fachwissen hilft, aber nicht Voraussetzung ist:
Wer Mathe studiert, hat bei den Mathe-Köpfen einen Vorsprung, das Kopfrechnen und
die Wahrscheinlichkeiten schafft aber auch der Rest des Tisches.

Dazu gibt es in der Auswahl **🎲 Zufallsmix aus allen Sätzen** – zwölf Kategorien,
bei jedem Start neu gewürfelt. So ist kein Abend wie der andere. Gezogen wird reihum
über die Sätze: Je Runde kommt höchstens eine Kategorie aus derselben Quelle, damit
sich der Mix auch nach Mischung anfühlt und nicht nach einem Satz mit Beilage.

Emoji auf einer eigenen Zeile werden groß dargestellt – bei Rätseln wie
`Welcher Film?\n🦁 👑` sind die Symbole ja die eigentliche Frage.

Die Flaggen in „Länder & Flaggen“ sind als SVG gezeichnet und liegen in `data/bilder/`.
Keine Downloads, keine externen Bilder – das Quiz läuft auch ohne Internet.

Sie sind bewusst schwer: Jamaika, Tansania, die Bahamas und Katar in Runde 1,
Trinidad und Tobago, Dschibuti, Guyana und die Seychellen in Runde 2. Deutschland,
Italien oder Japan kennt jeder – interessant wird es bei den Flaggen, über die man
danach noch redet. Katar liefert die Pointe gleich mit: Bahrain sieht fast genauso
aus, hat aber fünf Zacken statt neun.

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
Start-Quizduell.command/.bat, start-quizduell.sh   zum Doppelklicken
server/   game.js (Spielregeln) · questions.js (Fragensätze) · index.js (HTTP/SSE)
          browser.js (öffnet den Host-Screen beim Doppelklick-Start)
public/   host.* (Board) · player.* (Handy) · remote.* (Fernbedienung)
          editor.* (Fragen) · index.html/start.css · common.js · qr.js · style.css
data/     Fragensätze als JSON, Bilder unter data/bilder/
test/     Regeltests
```
