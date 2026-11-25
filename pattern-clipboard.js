"use strict";
/* One clipboard shared by S-1 Grid, TD-3 Grid, Bass Station Grid and Protein Grid, so a
   pattern copied in one can be pasted in another. They're all served from the same site,
   so the clipboard is kept in the browser's storage, where each page can read it.

   What's kept: { version, from, span, triplet, notes }, with times and lengths in ticks at 960 per
   quarter note. Each note is { time, length, note, velocity, probability } (note is the
   MIDI note, velocity 0 to 1), the same as the S-1, Bass Station and Protein grids' own
   notes, which may also carry their own extras (substep). TD-3 Grid turns its steps into
   notes like these, adding accent and slide, and turns notes back into steps. triplet says
   the pattern was written in triplet steps, so a grid pasting it can show triplets too.

   This file is the same in each grid. */

const PatternClipboard = (() => {
  const KEY = "midi-grids-clipboard";
  const VERSION = 1;
  const PPQ = 960;
  const NAMES = { s1: "S-1 Grid", td3: "TD-3 Grid", "bass-station": "Bass Station Grid", protein: "Protein Grid" };

  function clean(note) {
    const time = Math.max(0, Math.round(Number(note.time) || 0));
    const length = Math.max(1, Math.round(Number(note.length) || PPQ / 4));
    const pitch = Math.max(0, Math.min(127, Math.round(Number(note.note) || 0)));
    const velocity = Number.isFinite(Number(note.velocity)) ? Math.max(0, Math.min(1, Number(note.velocity))) : 1;
    return { ...note, time, length, note: pitch, velocity };
  }

  // Keeps a copied pattern for every grid. Returns false if the browser wouldn't store it.
  function write(from, span, notes, { triplet = false } = {}) {
    const clip = {
      version: VERSION, from, span: Math.max(1, Math.round(span)), triplet: Boolean(triplet), notes: notes.map(clean), at: Date.now(),
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(clip));
      return true;
    } catch {
      return false;
    }
  }

  // The last copied pattern, from any grid, or null.
  function read() {
    try {
      const clip = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!clip || clip.version !== VERSION || !Array.isArray(clip.notes)) return null;
      return {
        ...clip, span: Math.max(1, Math.round(Number(clip.span) || PPQ * 4)), triplet: clip.triplet === true, notes: clip.notes.map(clean),
      };
    } catch {
      return null;
    }
  }

  // Calls back when another grid's page copies something.
  function onChange(callback) {
    window.addEventListener("storage", (event) => {
      if (event.key === KEY) callback(read());
    });
  }

  const sourceName = (clip) => NAMES[clip?.from] || "another grid";

  return { KEY, PPQ, write, read, onChange, sourceName };
})();

if (typeof module !== "undefined") module.exports = PatternClipboard;
