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
2. Alle anderen rufen die WLAN-Adresse auf dem Handy auf, geben ihren Namen ein und
   wählen ihr Team. Für Zweierteams wählen beide dasselbe Team.
3. Fragensatz auswählen, Regeln einstellen, **Spiel starten**.

Anderer Port: `PORT=8080 node server/index.js`

### Fernbedienung: `/remote`

Der große Screen ist für alle sichtbar – die Lösung darf da nicht draufstehen. Öffne
deshalb als Host **`/remote` auf deinem eigenen Handy**. Dort stehen Frage *und Lösung*,
und du bewertest von dort mit großen Knöpfen. Auf der Leinwand bleibt die Lösung verdeckt.

Ohne zweites Gerät geht es auch: In der Steuerleiste des Host-Screens ist die Lösung
unscharf und lässt sich mit `👁` oder der Taste `L` kurz aufdecken – dann sehen sie
allerdings alle im Raum.

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
| `Esc` | Menü (Punkte korrigieren, Zug setzen, Offline-Geräte entfernen) |

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
  (dann als `"/bilder/foto.jpg"` eintragen).
- `note` ist optional und erscheint beim Auflösen als kleiner Zusatz.
- Mehr als zwei Runden gehen auch – jede weitere zählt ebenfalls doppelt.

Mitgeliefert: `data/beispiel-spieleabend.json` mit 48 Fragen zum sofort Losspielen.

---

## Technik

- **Server:** Node ≥ 18, reine Standardbibliothek. Der Spielzustand liegt im Speicher –
  Server neu starten heißt neues Spiel.
- **Verbindung:** Server-Sent Events für Updates, `POST /api/action` für Eingaben. Der
  Server vergibt den Buzz nach Eingangszeit; wer die Antwort noch nicht sehen darf,
  bekommt sie auch nicht geschickt.
- **Rollen:** Host ist, wer `/host` oder `/remote` offen hat – die Rechte hängen an der
  offenen Verbindung, nicht an einer Angabe im Request, damit nicht jedes Handy Punkte
  verteilen kann. Ein Passwort gibt es bewusst nicht: Es ist ein Spieleabend im eigenen
  WLAN, kein öffentlicher Dienst. Stell den Server nicht ins offene Internet.
- **Tests:** `npm test` (Node-Testrunner, deckt die Punkte- und Buzzer-Regeln ab).

```
server/   game.js (Spielregeln) · questions.js (Fragensätze) · index.js (HTTP/SSE)
public/   host.* (Board) · player.* (Handy) · remote.* (Fernbedienung)
          editor.* (Fragen) · common.js · style.css
data/     Fragensätze als JSON, Bilder unter data/bilder/
test/     Regeltests
```
