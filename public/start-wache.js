/*
 * Die Startwache: Sie sorgt dafür, dass nie wieder eine leere Seite dasteht.
 *
 * Alle drei Ansichten – Buzzer, Fernbedienung, Beamer – schalten ihre Inhalte
 * erst per JavaScript sichtbar. Stirbt das Skript beim Laden, bleibt genau
 * nichts übrig: ein dunkler Bildschirm ohne ein einziges Wort. Auf dem Beamer
 * fällt das noch auf, auf dem Handy eines Gastes ist es ein Rätsel – und der
 * Gast sitzt dann mit einem schwarzen Bildschirm am Tisch, während alle warten.
 * Genau so ist es beim Spiel über den Tunnel passiert.
 *
 * Diese Datei ist deshalb bewusst ein ganz gewöhnliches Skript, kein Modul:
 * Sie läuft, bevor das Modul überhaupt geholt wird, und sie überlebt dessen
 * Absturz. Sie hat keine Importe, kein `await`, keine modernen Sprachmittel –
 * sie muss auch auf einem alten Handy noch laufen, auf dem das eigentliche
 * Skript vielleicht gerade an einer neuen Sprachform gescheitert ist.
 *
 * Zwei Fänger:
 *   1. ein Fehler, bevor die Seite lebt  -> sofort melden
 *   2. nach acht Sekunden immer noch kein Lebenszeichen -> auch melden
 *
 * Sobald die Seite lebt (`window.quizduellLaeuft`), hält die Wache still.
 * Ein späterer Fehler mitten im Spiel darf niemals das Spielfeld zudecken –
 * eine Meldung über einem laufenden Satz wäre schlimmer als der Fehler selbst.
 */
(function () {
  var gemeldet = false;

  function lebt() {
    return window.quizduellLaeuft === true;
  }

  function zeige(technik) {
    if (gemeldet || lebt() || !document.body) return;
    gemeldet = true;

    var kasten = document.createElement('div');
    kasten.className = 'startwache';
    kasten.setAttribute('role', 'alert');

    var titel = document.createElement('h1');
    titel.textContent = 'Die Seite konnte nicht starten.';
    kasten.appendChild(titel);

    var text = document.createElement('p');
    text.textContent = 'Der Zugang steht – das Spiel selbst ist beim Aufbauen '
      + 'gestolpert. Fast immer liegt es am Browser dieses Geräts:';
    kasten.appendChild(text);

    var liste = document.createElement('ul');
    var punkte = [
      'Privates Fenster? Dann bitte einen normalen Tab öffnen und den QR-Code noch einmal scannen.',
      'Website-Daten gesperrt? In den Einstellungen für diese Seite erlauben.',
      'Sonst hilft oft schon: Seite neu laden.',
    ];
    for (var i = 0; i < punkte.length; i++) {
      var li = document.createElement('li');
      li.textContent = punkte[i];
      liste.appendChild(li);
    }
    kasten.appendChild(liste);

    var knopf = document.createElement('button');
    knopf.className = 'btn btn-primary btn-block';
    knopf.type = 'button';
    knopf.textContent = 'Neu laden';
    knopf.addEventListener('click', function () { location.reload(); });
    kasten.appendChild(knopf);

    // Der technische Grund steht mit dazu – nicht für den Gast, sondern für
    // den Gastgeber, dem das Handy hingehalten wird. Ohne ihn ist jede
    // Ferndiagnose ein Ratespiel.
    if (technik) {
      var grund = document.createElement('p');
      grund.className = 'startwache-grund';
      grund.textContent = technik;
      kasten.appendChild(grund);
    }

    document.body.appendChild(kasten);
  }

  window.addEventListener('error', function (ev) {
    // Ein fehlendes Bild ist kein Grund, die Seite für tot zu erklären.
    // Ladefehler einzelner Dateien melden sich mit dem Element als Ziel;
    // nur ein gescheitertes Skript zählt.
    var ziel = ev.target;
    if (ziel && ziel !== window && ziel.tagName !== 'SCRIPT') return;
    zeige(ev.message || (ziel && ziel.src ? 'Skript nicht ladbar: ' + ziel.src : ''));
  }, true); // capture: Ladefehler von <script> steigen nicht auf

  window.addEventListener('unhandledrejection', function (ev) {
    var grund = ev && ev.reason;
    zeige(grund && grund.message ? grund.message : String(grund || ''));
  });

  // Die Notbremse fängt den stillen Tod: kein Fehler, aber auch kein Aufbau –
  // etwa wenn das Modul selbst gar nicht erst ankommt. Acht Sekunden sind
  // reichlich; das Skript liegt im selben Haus wie die Seite.
  setTimeout(function () { zeige(''); }, 8000);
}());
