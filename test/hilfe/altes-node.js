/**
 * Tut so, als liefe alles auf einem älteren Node.
 *
 * Wird dem Server über `--import` vorgeschaltet und setzt `process.versions.node`
 * um. Nur so lässt sich prüfen, dass der Torwächter in server/index.js wirklich
 * verdrahtet ist – und nicht bloß, dass `nodeZuAlt` für sich genommen richtig
 * rechnet. Ein zweites Node zu installieren wäre der einzige andere Weg.
 *
 * Die Eigenschaft ist nicht beschreibbar, aber konfigurierbar – daher
 * defineProperty statt einer Zuweisung.
 */
Object.defineProperty(process.versions, 'node', {
  value: process.env.QUIZDUELL_ALTES_NODE || '16.20.2',
  configurable: true,
  enumerable: true,
});
