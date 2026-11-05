"use strict";
/* All of the page's patterns and its sound as one file, as patterns otherwise only live
   in this browser. Restoring checks everything first, as the file could be anything. */
const Backup = (() => {
  const APP = "s1-grid";
  const VERSION = 1;
  const SLOTS = 16;

  function pack(state, now = new Date()) {
    return {
      app: APP,
      version: VERSION,
      saved: now.toISOString(),
      root: state.root,
      scale: state.scale,
      bpm: state.bpm,
      chain: state.chain,
      chainOn: state.chainOn,
      values: state.values,
      delay: state.delay,
      slots: state.slots,
      sources: state.sources.map((source) => source && { name: source.name, text: source.text }),
    };
  }

  const finite = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;

  function cleanNote(item) {
    if (!item || !finite(item.time, 0, 1e7) || !finite(item.note, 0, 127) || !finite(item.length, 0.001, 1e7)
      || !finite(item.velocity, 0, 1)) {
      throw new Error("It has a damaged note.");
    }
    const note = {
      time: item.time, note: item.note, velocity: item.velocity, length: item.length, probability: finite(item.probability, 0, 100) ? item.probability : 100,
    };
    if (finite(item.substep, 1, 13)) note.substep = item.substep;
    return note;
  }

  function cleanLanes(lanes) {
    const clean = {};
    for (const [cc, points] of Object.entries(lanes)) {
      if (!finite(Number(cc), 0, 127) || !Array.isArray(points)) throw new Error("It has a damaged knob movement.");
      clean[cc] = points.map((point) => {
        if (!point || !finite(point.time, 0, 1e7) || !finite(point.value, 0, 127)) throw new Error("It has a damaged knob movement.");
        return { time: point.time, value: point.value };
      });
    }
    return clean;
  }

  // Returns just the known fields, or throws if the file can't be used.
  function unpack(data, { scales, validatePatch }) {
    if (!data || data.app !== APP) throw new Error("It isn't an S-1 Grid backup.");
    if (data.version !== VERSION) throw new Error("It's from a different version of S-1 Grid.");
    if (!Array.isArray(data.slots) || data.slots.length !== SLOTS) throw new Error("It doesn't have 16 patterns.");
    if (!finite(data.root, 0, 11) || !scales[data.scale] || !finite(data.bpm, 20, 300)) throw new Error("Its key or tempo isn't valid.");
    const slots = data.slots.map((item) => {
      if (!item || !finite(item.bars, 0.01, 64) || !Array.isArray(item.notes)) throw new Error("It has a damaged pattern.");
      const slot = { bars: item.bars, notes: item.notes.map(cleanNote) };
      if (item.lanes) slot.lanes = cleanLanes(item.lanes);
      return slot;
    });
    const given = Array.isArray(data.sources) ? data.sources : [];
    const sources = Array.from({ length: SLOTS }, (_, index) => {
      const source = given[index];
      if (!source) return null;
      if (typeof source.name !== "string" || typeof source.text !== "string" || validatePatch(source.text).length) {
        throw new Error("It has a damaged patch.");
      }
      return { name: source.name, text: source.text };
    });
    const values = {};
    for (const [cc, value] of Object.entries(data.values || {})) {
      if (finite(Number(cc), 0, 127) && finite(value, 0, 127)) values[cc] = value;
    }
    const delay = {};
    if (data.delay?.sync === 0 || data.delay?.sync === 1) delay.sync = data.delay.sync;
    if (Number.isInteger(data.delay?.note) && finite(data.delay.note, 0, 15)) delay.note = data.delay.note;
    return {
      delay,
      root: data.root,
      scale: data.scale,
      bpm: data.bpm,
      chain: typeof data.chain === "string" ? data.chain : "",
      chainOn: data.chainOn === true,
      values,
      slots,
      sources,
    };
  }

  return { pack, unpack };
})();

if (typeof module !== "undefined") module.exports = Backup;
