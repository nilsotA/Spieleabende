import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../server/game.js';

/**
 * Zufällige Zugfolgen gegen die Regel-Engine.
 *
 * Am Spieleabend sitzen acht Leute an einem Spiel, das der Host nebenbei
 * bedient, während getrunken und dazwischengerufen wird. Da wird gedrückt, was
 * gerade da ist – auch in der falschen Reihenfolge, auch doppelt, auch von zwei
 * Geräten gleichzeitig. Ein einzelner durchgespielter Abend als Test findet
 * genau die Wege, an die man beim Schreiben gedacht hat.
 *
 * Dieser Test würfelt stattdessen: Er wirft alles, was die Engine kennt, in
 * beliebiger Folge dagegen. Erlaubte Züge müssen wirken, unerlaubte müssen mit
 * einer lesbaren Meldung abprallen – und nach jedem einzelnen Schritt muss der
 * Zustand in sich stimmen. Ein `TypeError` oder ein Spiel, das in einer Phase
 * ohne Ausweg feststeckt, wäre ein Fehler mitten im Abend.
 */

/* Eigener Zufall mit Saat: Ein Fehlschlag muss sich mit derselben Zahl wieder
   herstellen lassen, sonst sucht man ihn nie wieder. */
function wuerfel(saat) {
  let x = saat >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

const SATZ = {
  name: 'Fuzz',
  rounds: Array.from({ length: 2 }, (_, r) => ({
    categories: Array.from({ length: 3 }, (_, c) => ({
      name: `R${r}K${c}`,
      questions: Array.from({ length: 4 }, (_, i) => ({
        text: `Frage ${r}-${c}-${i}`,
        answer: `Antwort ${r}-${c}-${i}`,
        note: i === 3 ? 'Ein Zusatz.' : null,
      })),
    })),
  })),
};

/** Alles, was nach jedem Schritt gelten muss. */
function pruefeZustand(state, spur) {
  const wo = () => `nach: ${spur.slice(-6).join(' → ')}`;
  const ids = new Set(state.teams.map((t) => t.id));

  assert.ok(['lobby', 'board', 'question', 'roundEnd', 'gameOver'].includes(state.phase),
    `unbekannte Phase „${state.phase}" ${wo()}`);
  assert.equal(ids.size, state.teams.length, `doppelte Team-Kennung ${wo()}`);

  for (const t of state.teams) {
    assert.ok(Number.isInteger(t.score), `Punktestand ist keine ganze Zahl: ${t.score} ${wo()}`);
    assert.ok(Number.isFinite(t.score), `Punktestand ist keine Zahl ${wo()}`);
    assert.ok(t.serie >= 0 && Number.isFinite(t.serie), `Serie kaputt ${wo()}`);
    assert.ok(t.serieBest >= t.serie, `Bestserie kleiner als laufende Serie ${wo()}`);
    for (const [feld, wert] of Object.entries(t.bilanz || {})) {
      assert.ok(Number.isFinite(wert), `Bilanz „${feld}" ist ${wert} ${wo()}`);
      assert.ok(wert >= 0, `Bilanz „${feld}" ist negativ: ${wert} ${wo()}`);
    }
    // Ein Gerät steht in höchstens einem Team.
    for (const m of t.members) {
      const woanders = state.teams.filter((a) => a !== t && a.members.some((x) => x.clientId === m.clientId));
      assert.equal(woanders.length, 0, `Gerät ${m.clientId} steht in zwei Teams ${wo()}`);
    }
    const clients = t.members.map((m) => m.clientId);
    assert.equal(new Set(clients).size, clients.length, `Gerät doppelt im selben Team ${wo()}`);
  }

  if (state.teams.length) {
    assert.ok(state.turnIndex >= 0 && state.turnIndex < state.teams.length,
      `turnIndex ${state.turnIndex} bei ${state.teams.length} Teams ${wo()}`);
  }

  assert.equal(state.phase === 'question', !!state.current,
    `Phase „${state.phase}" und current passen nicht zusammen ${wo()}`);

  const q = state.current;
  if (q) {
    assert.ok(['primary', 'buzz', 'result'].includes(q.step), `unbekannter Schritt „${q.step}" ${wo()}`);
    assert.ok(ids.has(q.teamId), `Zugteam der Frage gibt es nicht mehr ${wo()}`);
    assert.equal(q.halfValue ?? G.halfPoints(q.value), G.halfPoints(q.value), `halbe Punkte falsch ${wo()}`);
    for (const id of q.lockedOut) assert.ok(ids.has(id), `gesperrtes Team gibt es nicht ${wo()}`);
    if (q.buzzedTeamId) {
      assert.ok(ids.has(q.buzzedTeamId), `Buzzer-Team gibt es nicht ${wo()}`);
      assert.notEqual(q.buzzedTeamId, q.teamId, `das Zugteam hat sich selbst gebuzzert ${wo()}`);
    }
    for (const e of q.log) {
      assert.ok(Number.isInteger(e.delta), `Log-Delta ist keine ganze Zahl ${wo()}`);
      assert.ok(['correct', 'wrong', 'pass'].includes(e.result), `Log-Ergebnis „${e.result}" ${wo()}`);
    }
    // Ein Team antwortet höchstens einmal je Frage (Zugteam plus ein Buzz).
    const proTeam = new Map();
    for (const e of q.log) proTeam.set(e.teamId, (proTeam.get(e.teamId) || 0) + 1);
    for (const [id, n] of proTeam) {
      assert.ok(n <= 2, `Team ${id} steht ${n}× im Log derselben Frage ${wo()}`);
    }
  }

  if (state.board) {
    for (const cat of state.board.categories) {
      for (const c of cat.cells) {
        assert.ok(Number.isInteger(c.value) && c.value > 0, `Feldwert kaputt ${wo()}`);
      }
    }
  }
}

/** Alle Züge, die es gibt – erlaubte wirken, unerlaubte prallen ab. */
function zuege(state, r) {
  const zufall = (liste) => liste[Math.floor(r() * liste.length)];
  const team = state.teams.length ? zufall(state.teams) : null;
  const catIdx = Math.floor(r() * 4);      // absichtlich auch daneben
  const rowIdx = Math.floor(r() * 5);
  const client = `c${Math.floor(r() * 6)}`;
  return [
    ['addTeam', () => G.addTeam(state, zufall(['', 'Rot', 'Blau', 'Ein sehr langer Teamname zum Kürzen']))],
    ['removeTeam', () => team && G.removeTeam(state, team.id)],
    ['renameTeam', () => team && G.renameTeam(state, team.id, zufall(['', 'Neu', 'Team X']))],
    ['joinTeam', () => team && G.joinTeam(state, client, team.id, zufall(['Mira', '', 'Nils']))],
    ['leaveTeams', () => G.leaveTeams(state, client)],
    ['removeMember', () => team && G.removeMember(state, team.id, client)],
    ['setMemberOnline', () => G.setMemberOnline(state, client, r() < 0.5)],
    ['adjustScore', () => team && G.adjustScore(state, team.id, zufall([-100, 100, 0]))],
    ['startGame', () => G.startGame(state, SATZ)],
    ['pickCell', () => G.pickCell(state, catIdx, rowIdx)],
    ['pickCellByTeam', () => team && G.pickCell(state, catIdx, rowIdx, team.id)],
    ['passQuestion', () => G.passQuestion(state)],
    ['openBuzz', () => G.openBuzz(state)],
    ['buzz', () => G.buzz(state, client)],
    ['buzzFor', () => team && G.buzzFor(state, team.id)],
    ['resetBuzz', () => G.resetBuzz(state)],
    ['judge', () => G.judge(state, r() < 0.5)],
    ['revealAnswer', () => G.revealAnswer(state)],
    ['endQuestion', () => G.endQuestion(state)],
    ['closeQuestion', () => G.closeQuestion(state)],
    ['nextRound', () => G.nextRound(state)],
    ['setTurn', () => team && G.setTurn(state, team.id)],
    ['backToLobby', () => Object.assign(state, G.backToLobby(state))],
  ];
}

test('zufällige Zugfolgen bringen die Regeln nicht durcheinander', () => {
  for (let saat = 1; saat <= 250; saat++) {
    const r = wuerfel(saat * 2654435761);
    const state = G.createState();
    const spur = [];
    for (let schritt = 0; schritt < 600; schritt++) {
      const liste = zuege(state, r);
      const [name, tun] = liste[Math.floor(r() * liste.length)];
      spur.push(name);
      try {
        tun();
      } catch (err) {
        // Erlaubt ist nur die eigene, erklärende Ablehnung.
        assert.ok(err instanceof G.GameError,
          `Saat ${saat}, Schritt ${schritt}: ${err.name}: ${err.message}\n  Spur: ${spur.slice(-10).join(' → ')}`);
        assert.ok(err.message.length > 8 && /[.!]$/.test(err.message),
          `Saat ${saat}: unfertige Meldung „${err.message}"`);
      }
      try {
        pruefeZustand(state, spur);
      } catch (err) {
        err.message = `Saat ${saat}, Schritt ${schritt}: ${err.message}`;
        throw err;
      }
    }
  }
});

test('die Punktestände sind genau die Summe der Wertungen', () => {
  // Die stärkste Aussage über das Punktesystem: Am Ende darf kein Team einen
  // Punkt mehr oder weniger haben, als in den Frageprotokollen steht. Damit
  // fiele jede Doppelzählung auf – etwa wenn eine Wertung zweimal durchginge
  // oder ein Abzug zusätzlich zum Buzzer-Malus gebucht würde.
  //
  // Gespielt wird zufällig, aber vollständig: jedes Feld, beide Runden, alle
  // Regelkombinationen durch.
  const kombis = [];
  for (const wrongPenalty of ['none', 'half', 'full']) {
    for (const turnMode of ['rotate', 'keepOnCorrect']) {
      for (const buzzAfterCorrect of [false, true]) {
        kombis.push({ wrongPenalty, turnMode, buzzAfterCorrect });
      }
    }
  }

  for (const [nr, settings] of kombis.entries()) {
    let x = (nr + 1) * 2654435761;
    const r = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
    const state = G.createState();
    for (const name of ['Rot', 'Blau', 'Grün', 'Gelb']) G.addTeam(state, name);
    Object.assign(state.settings, settings);
    G.startGame(state, SATZ);

    const gebucht = new Map(state.teams.map((t) => [t.id, 0]));
    for (let runde = 1; runde <= 2; runde++) {
      let schutz = 0;
      while (state.phase === 'board' && schutz++ < 100) {
        let feld = null;
        state.board.categories.forEach((c, ci) => c.cells.forEach((z, ri) => {
          if (!z.used && !feld) feld = { ci, ri };
        }));
        if (!feld) break;
        G.pickCell(state, feld.ci, feld.ri);

        let runden = 0;
        while (state.phase === 'question' && runden++ < 20) {
          const q = state.current;
          if (q.step === 'primary') {
            if (r() < 0.55) G.judge(state, r() < 0.5);
            else G.passQuestion(state);
          } else if (q.step === 'buzz' && !q.buzzedTeamId) {
            const dran = state.teams.filter((t) => t.id !== q.teamId && !q.lockedOut.includes(t.id));
            if (dran.length && r() < 0.7) {
              G.buzzFor(state, dran[Math.floor(r() * dran.length)].id);
            } else {
              G.endQuestion(state);
            }
          } else if (q.step === 'buzz') {
            G.judge(state, r() < 0.5);
          } else {
            break;
          }
        }
        assert.equal(state.current?.step, 'result',
          `Frage hängt in Schritt „${state.current?.step}" (Kombination ${nr})`);
        // Vor dem Schließen mitschreiben – danach ist das Protokoll weg.
        for (const e of state.current.log) {
          gebucht.set(e.teamId, (gebucht.get(e.teamId) || 0) + e.delta);
        }
        G.closeQuestion(state);
      }
      if (runde === 1) {
        assert.equal(state.phase, 'roundEnd', `Runde 1 endet nicht (Kombination ${nr})`);
        G.nextRound(state);
      }
    }
    assert.equal(state.phase, 'gameOver', `Spiel endet nicht (Kombination ${nr})`);
    for (const t of state.teams) {
      assert.equal(t.score, gebucht.get(t.id),
        `${t.name} hat ${t.score}, gebucht wurden ${gebucht.get(t.id)} `
        + `(Abzug ${settings.wrongPenalty}, ${settings.turnMode}, `
        + `Buzz nach richtig: ${settings.buzzAfterCorrect})`);
    }
    // Und die Bilanz muss dieselbe Geschichte erzählen wie der Punktestand.
    for (const t of state.teams) {
      assert.equal(t.bilanz.geholt - t.bilanz.verloren, t.score,
        `${t.name}: Bilanz ${t.bilanz.geholt}−${t.bilanz.verloren} passt nicht zu ${t.score}`);
    }
  }
});
