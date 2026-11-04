"use strict";
/* Musical logic for the grid: keys, chords, pattern ideas and MIDI files.
   Nothing here touches the page or MIDI hardware, so it can be tested directly.
   Times are in ticks at 960 per quarter note, and one 1/16 step is 240 ticks. */
const Music = (() => {
  const PPQ = 960;
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  const SCALES = {
    major: { name: "Major", intervals: [0, 2, 4, 5, 7, 9, 11] },
    minor: { name: "Minor", intervals: [0, 2, 3, 5, 7, 8, 10] },
    harmonicMinor: { name: "Harmonic minor", intervals: [0, 2, 3, 5, 7, 8, 11] },
    melodicMinor: { name: "Melodic minor", intervals: [0, 2, 3, 5, 7, 9, 11] },
    dorian: { name: "Dorian", intervals: [0, 2, 3, 5, 7, 9, 10] },
    phrygian: { name: "Phrygian", intervals: [0, 1, 3, 5, 7, 8, 10] },
    lydian: { name: "Lydian", intervals: [0, 2, 4, 6, 7, 9, 11] },
    mixolydian: { name: "Mixolydian", intervals: [0, 2, 4, 5, 7, 9, 10] },
    locrian: { name: "Locrian", intervals: [0, 1, 3, 5, 6, 8, 10] },
    majorPentatonic: { name: "Major pentatonic", intervals: [0, 2, 4, 7, 9] },
    minorPentatonic: { name: "Minor pentatonic", intervals: [0, 3, 5, 7, 10] },
    blues: { name: "Blues", intervals: [0, 3, 5, 6, 7, 10] },
    chromatic: { name: "Chromatic", intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  };

  const noteName = (note) => `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
  const clampNote = (note) => Math.min(127, Math.max(0, note));
  const pitchClass = (note, root) => ((note - root) % 12 + 12) % 12;
  const intervalsOf = (scale) => (SCALES[scale] || SCALES.major).intervals;

  function inKey(note, root, scale) {
    return intervalsOf(scale).includes(pitchClass(note, root));
  }

  // Every note in the key from low to high, inclusive.
  function notesInKey(root, scale, low, high) {
    const notes = [];
    for (let note = low; note <= high; note += 1) {
      if (inKey(note, root, scale)) notes.push(note);
    }
    return notes;
  }

  // The smallest root movement, so a key change doesn't jump the pattern an octave.
  function rootShift(from, to) {
    const shift = pitchClass(to, from);
    return shift > 6 ? shift - 12 : shift;
  }

  /* Where a note goes when the key changes. Notes keep their place in the scale,
     so the melody's shape survives: E in C major is the same degree as C# in A major.
     Scales of different sizes use the nearest note, and notes outside the old key
     simply move with the root. */
  function mapNote(note, fromRoot, fromScale, toRoot, toScale) {
    const from = intervalsOf(fromScale);
    const to = intervalsOf(toScale);
    const offset = pitchClass(note, fromRoot);
    const octaveBase = note - offset;
    const degree = from.indexOf(offset);
    let target = offset;
    if (degree >= 0) {
      target = from.length === to.length
        ? to[degree]
        : to.reduce((best, interval) =>
          (Math.abs(interval - offset) < Math.abs(best - offset) ? interval : best), to[0]);
    }
    return clampNote(octaveBase + rootShift(fromRoot, toRoot) + target);
  }

  function mapNotes(notes, fromRoot, fromScale, toRoot, toScale) {
    return notes.map((item) => ({
      ...item, note: mapNote(item.note, fromRoot, fromScale, toRoot, toScale),
    }));
  }

  // The note a number of scale steps above another, which needn't be in the key.
  function stepsAbove(note, steps, root, scale) {
    const intervals = intervalsOf(scale);
    const offset = pitchClass(note, root);
    let degree = intervals.indexOf(offset);
    let base = note - offset;
    if (degree < 0) {
      degree = intervals.findIndex((interval) => interval > offset);
      if (degree < 0) {
        degree = 0;
        base += 12;
      }
    }
    const total = degree + steps;
    const octaves = Math.floor(total / intervals.length);
    const index = total - octaves * intervals.length;
    return base + octaves * 12 + intervals[index];
  }

  const CHORDS = {
    note: { name: "Note", steps: [0] },
    fifth: { name: "Power", steps: [0, 4] },
    triad: { name: "Triad", steps: [0, 2, 4] },
    seventh: { name: "7th", steps: [0, 2, 4, 6] },
  };

  // Stacks the key's own notes, so every chord fits the chosen key.
  function chordNotes(note, chord, root, scale) {
    const { steps } = CHORDS[chord] || CHORDS.note;
    const size = intervalsOf(scale).length;
    // Thirds only mean anything in seven-note scales. Others take evenly spaced notes.
    const spaced = size === 7 ? steps : steps.map((step) => Math.round((step * size) / 7));
    return [...new Set(spaced.map((step) => stepsAbove(note, step, root, scale)))]
      .filter((value) => value <= 127);
  }

  const GENERATORS = {
    bassline: "Bassline",
    melody: "Melody",
    arpUp: "Arp up",
    arpUpDown: "Arp up and down",
    chords: "Chords",
  };

  // Common progressions, as scale degrees counted from zero.
  const PROGRESSIONS = [[0, 5, 3, 4], [0, 3, 4, 3], [0, 4, 5, 3], [0, 3, 5, 4]];

  /* Writes a new pattern in the key. random is any function returning 0 to 1, passed
     in so results can be repeated in tests. */
  function generate(kind, {
    root, scale, low, lengthTicks, stepTicks = PPQ / 4, random = Math.random,
  }) {
    const pick = (items) => items[Math.floor(random() * items.length) % items.length];
    const barTicks = PPQ * 4;
    const tonic = notesInKey(root, scale, low, low + 11).find((note) => pitchClass(note, root) === 0);
    const progression = pick(PROGRESSIONS);
    const chordRoot = (bar) => stepsAbove(tonic, progression[bar % progression.length], root, scale);
    const notes = [];
    const add = (time, note, length, velocity = 0.8) => {
      if (time >= lengthTicks || note > 127) return;
      notes.push({
        time, note, length: Math.max(1, Math.min(length, lengthTicks - time)), velocity, probability: 100,
      });
    };
    const bars = Math.ceil(lengthTicks / barTicks);

    if (kind === "chords") {
      for (let bar = 0; bar < bars; bar += 1) {
        for (const note of chordNotes(chordRoot(bar), "triad", root, scale)) {
          add(bar * barTicks, note, barTicks - stepTicks / 2, 0.75);
        }
      }
    } else if (kind === "arpUp" || kind === "arpUpDown") {
      for (let time = 0; time < lengthTicks; time += stepTicks) {
        const bar = Math.floor(time / barTicks);
        const tones = chordNotes(chordRoot(bar), "seventh", root, scale);
        const up = [...tones, tones[0] + 12];
        const sequence = kind === "arpUp" ? up : [...up, ...up.slice(1, -1).reverse()];
        const position = Math.round((time - bar * barTicks) / stepTicks);
        add(time, sequence[position % sequence.length], stepTicks * 0.8, position % 4 === 0 ? 0.95 : 0.7);
      }
    } else if (kind === "bassline") {
      for (let time = 0; time < lengthTicks; time += stepTicks) {
        const bar = Math.floor(time / barTicks);
        const onBeat = Math.round(time / stepTicks) % 4 === 0;
        if (!onBeat && random() > 0.45) continue;
        const base = chordRoot(bar);
        const note = onBeat || random() < 0.55 ? base : pick([stepsAbove(base, 4, root, scale), base + 12, stepsAbove(base, 6, root, scale) - 12]);
        add(time, note, stepTicks * (random() < 0.25 ? 2 : 0.8), onBeat ? 0.95 : 0.7);
      }
    } else {
      const pool = notesInKey(root, scale, low, low + 24);
      let index = Math.max(0, pool.indexOf(tonic + 12));
      for (let time = 0; time < lengthTicks; time += stepTicks) {
        const onBeat = Math.round(time / stepTicks) % 4 === 0;
        if (random() > (onBeat ? 0.85 : 0.45)) continue;
        index = Math.min(pool.length - 1, Math.max(0, index + pick([-2, -1, -1, 1, 1, 2])));
        const steps = random() < 0.3 ? 2 : 1;
        add(time, pool[index], stepTicks * steps * 0.9, onBeat ? 0.9 : 0.72);
      }
    }
    return notes;
  }

  /* Finds the key a set of notes most likely belongs to. Longer notes and notes at
     the start of a bar count for more, as does landing on the root. */
  function detectKey(notes) {
    if (!notes.length) return null;
    const weights = new Array(12).fill(0);
    for (const item of notes) {
      weights[item.note % 12] += item.length * (item.time % (PPQ * 4) === 0 ? 2 : 1);
    }
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let best = null;
    for (let root = 0; root < 12; root += 1) {
      for (const scale of ["minor", "major"]) {
        const fit = intervalsOf(scale).reduce((sum, interval) => sum + weights[(root + interval) % 12], 0);
        const score = fit / total + 0.25 * (weights[root] / total) + 0.1 * (weights[(root + 7) % 12] / total);
        if (!best || score > best.score + 1e-9) best = { root, scale, score };
      }
    }
    return { root: best.root, scale: best.scale };
  }

  function variableLength(value) {
    const bytes = [value & 0x7f];
    let rest = value >> 7;
    while (rest > 0) {
      bytes.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    return bytes;
  }

  // A standard one-track MIDI file, which any DAW can open.
  function midiFile(notes, { bpm = 120, channel = 0 } = {}) {
    const events = [];
    for (const item of notes) {
      const velocity = Math.max(1, Math.min(127, Math.round(item.velocity * 127)));
      events.push({ time: item.time, order: 1, bytes: [0x90 | channel, item.note, velocity] });
      events.push({ time: item.time + item.length, order: 0, bytes: [0x80 | channel, item.note, 0] });
    }
    // At equal times, note-offs go first so repeated notes aren't cut short.
    events.sort((a, b) => a.time - b.time || a.order - b.order);
    const tempo = Math.round(60000000 / bpm);
    const track = [0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255];
    let now = 0;
    for (const event of events) {
      track.push(...variableLength(event.time - now), ...event.bytes);
      now = event.time;
    }
    track.push(0, 0xff, 0x2f, 0);
    const uint32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    return new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, ...uint32(6), 0, 0, 0, 1, (PPQ >> 8) & 255, PPQ & 255,
      0x4d, 0x54, 0x72, 0x6b, ...uint32(track.length), ...track,
    ]);
  }

  return {
    CHORDS,
    GENERATORS,
    NOTE_NAMES,
    PPQ,
    SCALES,
    chordNotes,
    detectKey,
    generate,
    inKey,
    mapNote,
    mapNotes,
    midiFile,
    noteName,
    notesInKey,
    stepsAbove,
  };
})();

if (typeof module !== "undefined") module.exports = Music;
