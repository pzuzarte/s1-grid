"use strict";

const PPQ = Music.PPQ;
const BAR = PPQ * 4;
const SLOTS = 16;
const SCHEDULE_AHEAD_MS = 150;
const CHUNK_PULSES = 10; // Must divide CLOCK_PULSES.
const CLOCK_PULSES = PPQ / 24;
const VELOCITY_STEPS = [1.0, 0.7, 0.4];
const DRAG_THRESHOLD_PX = 4; // A press that moves less than this counts as a click.
const FINE_DIVISIONS = 8; // Resizing moves in eighths of a step, or quarters when steps are narrow.
const NARROW_STEP_PX = 32;
const MIN_CELL_PX = 14; // Below this, steps are too small to click reliably.
const DENSE_CELL_PX = 22;
const DEFAULT_CHANNEL = 2; // Channel 3, the S-1's default.
const CC_ALL_SOUND_OFF = 120;
const CC_ALL_NOTES_OFF = 123;
const STORE_KEY = "s1-grid";

const $ = (id) => document.getElementById(id);

const state = {
  root: 0,
  scale: "minor",
  moveNotes: true,
  slots: Array.from({ length: SLOTS }, () => ({ bars: 4, notes: [] })),
  current: 0,
  queued: null,
  bpm: 120,
  channel: DEFAULT_CHANNEL,
  chord: "note",
  newLength: "step",
  lowOctave: 3,
  span: 2,
  showAll: false,
  baseResolution: 240,
  triplets: false,
  resolution: 240,
  tab: "osc",
  sounds: [],
  values: {},
  delay: {},
  sources: Array.from({ length: SLOTS }, () => null),
  page: 0,
  pageBars: 1,
  windowStart: 0,
  windowSpan: 0,
  undo: [],
  chain: "",
  chainOn: false,
  chainPos: 0,
  showLane: false,
  laneCc: 74,
  laneDraw: null,
  selection: null,
  selecting: null,
  clipboard: null,
  recording: false,
  recStep: 0,
  recLast: 0,
  recOpen: new Map(),
  recent: [],
  preview: null,
  varyOriginal: null,
  varyLatest: null,
  editor: null,
  paint: null,
  lengthDrag: null,
  barsQueued: false,
  midi: null,
  output: null,
  input: null,
  playing: false,
  sendOnce: false,
  nextPulse: 0,
  nextTime: 0,
  saveTimer: null,
};

const slot = () => state.slots[state.current];
const lengthPulses = (item = slot()) => item.bars * BAR;
const notes = () => slot().notes;
const lowNote = () => (state.lowOctave + 1) * 12;

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").title = message;
  $("status").classList.toggle("error", isError);
}

/* ---------- Saving in this browser ---------- */

function saveSoon() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    const saved = {};
    for (const key of ["root", "scale", "moveNotes", "slots", "current", "bpm", "channel", "chord",
      "newLength", "lowOctave", "span", "showAll", "baseResolution", "triplets", "tab", "sounds", "sources",
      "chain", "chainOn", "showLane", "laneCc", "delay"]) {
      saved[key] = state[key];
    }
    // Motions are read back from the patch's text, so they aren't stored twice.
    saved.sources = state.sources.map((source) => source && { name: source.name, text: source.text });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (error) {
      setStatus("Couldn't save in this browser. Export your patterns to keep them.", true);
    }
  }, 300);
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && Array.isArray(saved.slots) && saved.slots.length === SLOTS) {
      Object.assign(state, saved);
      if (!Array.isArray(state.sources)) state.sources = Array.from({ length: SLOTS }, () => null);
      state.resolution = state.triplets ? (state.baseResolution * 2) / 3 : state.baseResolution;
    }
  } catch (error) {
    // A missing or unreadable save just means starting fresh.
  }
}

/* ---------- Key ---------- */

function setKey(root, scale) {
  if (root === state.root && scale === state.scale) return;
  closeNoteEditor({ restoreFocus: false });
  remember();
  if (state.moveNotes) {
    for (const item of state.slots) {
      item.notes = Music.mapNotes(item.notes, state.root, state.scale, root, scale);
    }
  }
  state.root = root;
  state.scale = scale;
  renderAll();
  saveSoon();
  const name = `${Music.NOTE_NAMES[root]} ${Music.SCALES[scale].name.toLowerCase()}`;
  setStatus(state.moveNotes ? `Key: ${name}. Patterns moved to the new key.` : `Key: ${name}. Notes weren't moved.`);
}

function renderKey() {
  $("roots").replaceChildren(...Music.NOTE_NAMES.map((name, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.setAttribute("aria-pressed", String(index === state.root));
    button.addEventListener("click", () => setKey(index, state.scale));
    return button;
  }));
  $("scale").value = state.scale;
  $("move-notes").checked = state.moveNotes;
}

// Rows from high to low. Notes already in the pattern are never hidden.
function rowNotes() {
  const low = lowNote();
  const high = low + state.span * 12;
  const rows = new Set(state.showAll
    ? Array.from({ length: high - low + 1 }, (_, i) => low + i)
    : Music.notesInKey(state.root, state.scale, low, high));
  for (const item of notes()) rows.add(item.note);
  return [...rows].sort((a, b) => b - a);
}

/* ---------- Patterns ---------- */

function renderSlots() {
  const nodes = [];
  for (let index = 0; index < SLOTS; index += 1) {
    const count = state.slots[index].notes.length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slot";
    button.textContent = String(index + 1);
    button.classList.toggle("has-pattern", count > 0);
    button.classList.toggle("queued", index === state.queued);
    button.setAttribute("aria-current", String(index === state.current));
    button.setAttribute("aria-label", `Pattern ${index + 1}, ${count ? `${count} notes` : "empty"}`);
    button.addEventListener("click", () => selectSlot(index));
    nodes.push(button);
  }
  $("slots").replaceChildren(...nodes);
}

function selectSlot(index) {
  if (index === state.current) {
    state.queued = null;
    renderSlots();
  } else if (state.playing) {
    state.queued = index;
    renderSlots();
    setStatus(`Pattern ${index + 1} starts at the end of this loop.`);
  } else {
    switchTo(index);
  }
}

// The sound stays as it is, so only loading a patch or a saved sound changes it.
function switchTo(index) {
  restoreAfterMotions();
  state.current = index;
  state.queued = null;
  state.page = 0;
  renderAll();
  saveSoon();
}

function duplicatePattern() {
  const target = state.slots.findIndex((item) => !item.notes.length);
  if (target < 0) {
    setStatus("All 16 patterns are in use. Clear one first.", true);
    return;
  }
  stop();
  remember();
  state.slots[target] = JSON.parse(JSON.stringify(slot()));
  state.sources[target] = state.sources[state.current];
  switchTo(target);
  setStatus(`Copied to pattern ${target + 1}.`);
}

function generatePattern() {
  remember();
  const kind = $("generator").value;
  const low = kind === "bassline" ? lowNote() : lowNote() + 12;
  slot().notes = Music.generate(kind, {
    root: state.root, scale: state.scale, low, lengthTicks: lengthPulses(),
  });
  renderGrid();
  renderChrome();
  saveSoon();
  const hint = kind === "chords" ? " Set Polyphony to Poly on the VOICE tab to hear full chords." : "";
  setStatus(`New ${Music.GENERATORS[kind].toLowerCase()} in the key. Generate again for another, or Undo.${hint}`);
}

function shiftOctave(octaves) {
  if (!notes().length) {
    setStatus("This pattern has no notes to move.", true);
    return;
  }
  const moved = Music.shiftOctaves(notes(), octaves);
  if (!moved) {
    setStatus(`Can't move ${octaves > 0 ? "up" : "down"} an octave, as the notes would go past the MIDI range.`, true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  slot().notes = moved;
  // The view only follows once the notes leave it.
  const pitches = moved.map((n) => n.note);
  if (Math.min(...pitches) < lowNote() || Math.max(...pitches) > lowNote() + state.span * 12) {
    state.lowOctave = Math.max(1, Math.min(6, state.lowOctave + octaves));
    $("octave").value = String(state.lowOctave);
  }
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Moved pattern ${state.current + 1} ${octaves > 0 ? "up" : "down"} an octave.`);
}

function shiftInScale(steps) {
  if (!notes().length) {
    setStatus("This pattern has no notes to move.", true);
    return;
  }
  const moved = Music.shiftInScale(notes(), steps, state.root, state.scale);
  if (!moved) {
    setStatus("Can't move further, as the notes would go past the MIDI range.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  slot().notes = moved;
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Moved pattern ${state.current + 1} ${steps > 0 ? "up" : "down"} a step in the scale.`);
}

// Moves the whole pattern a step in time, wrapping around, along with its knob movements.
function shiftInTime(direction) {
  const lanes = lanesFor();
  if (!notes().length && !(lanes && Object.keys(lanes).length)) {
    setStatus("This pattern is empty.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  const by = direction * state.resolution;
  const length = lengthPulses();
  slot().notes = Music.rotateNotes(notes(), by, length);
  if (lanes && Object.keys(lanes).length) {
    for (const [cc, points] of Object.entries(editableLanes())) {
      slot().lanes[cc] = points.map((point) => ({
        ...point,
        time: (Math.round((((point.time + by) % length + length) % length) / MOTION_TICKS) * MOTION_TICKS) % length,
      })).sort((a, b) => a.time - b.time);
    }
  }
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Moved pattern ${state.current + 1} ${direction > 0 ? "later" : "earlier"} by one step.`);
}

/* ---------- Selecting steps, copy and paste ---------- */

function updateSelectionMarks() {
  const range = state.selection;
  document.querySelectorAll(".cell, .step-number[data-time]").forEach((node) => {
    const time = Number(node.dataset.time);
    node.classList.toggle("selected", Boolean(range) && time >= range.start && time < range.end);
  });
}

function selectSteps(from, to) {
  const start = Math.min(from, to);
  state.selection = { start, end: Math.max(from, to) + state.resolution };
  updateSelectionMarks();
}

function clearSelection() {
  state.selection = null;
  updateSelectionMarks();
}

function copySelection() {
  const range = state.selection;
  if (!range) {
    setStatus("Click or drag along the step numbers above the grid to choose steps first.", true);
    return;
  }
  const copied = notes().filter((n) => n.time >= range.start && n.time < range.end);
  state.clipboard = { span: range.end - range.start, notes: copied.map((n) => ({ ...n, time: n.time - range.start })) };
  $("paste").disabled = false;
  setStatus(`Copied ${copied.length} ${copied.length === 1 ? "note" : "notes"}. Choose where it goes with the step numbers, then click Paste.`);
}

// Replaces what's in the steps it lands on, in this pattern or another.
function pasteClipboard() {
  if (!state.clipboard) return;
  if (!state.selection) {
    setStatus("Click a step number to choose where to paste.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  const { start } = state.selection;
  const length = lengthPulses();
  const end = Math.min(start + state.clipboard.span, length);
  const pasted = state.clipboard.notes
    .map((n) => ({ ...n, time: n.time + start }))
    .filter((n) => n.time < length)
    .map((n) => ({ ...n, length: Math.min(n.length, length - n.time) }));
  slot().notes = [...notes().filter((n) => n.time < start || n.time >= end), ...pasted]
    .sort((a, b) => a.time - b.time || a.note - b.note);
  state.selection = { start, end };
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Pasted ${pasted.length} ${pasted.length === 1 ? "note" : "notes"}. Undo takes it back.`);
}

// Sets velocity on the chosen steps, or the whole pattern if none are chosen.
function setBulkVelocity() {
  const value = Number($("bulk-velocity").value);
  if (!Number.isInteger(value) || value < 1 || value > 127) {
    setStatus("Velocity goes from 1 to 127.", true);
    return;
  }
  const range = state.selection;
  const targets = range ? notes().filter((n) => n.time >= range.start && n.time < range.end) : notes();
  if (!targets.length) {
    setStatus(range ? "There are no notes in the chosen steps." : "This pattern has no notes.", true);
    return;
  }
  remember();
  targets.forEach((n) => { n.velocity = value / 127; });
  document.querySelectorAll(".cell").forEach(paintCell);
  renderChrome();
  saveSoon();
  setStatus(`Set ${targets.length} ${targets.length === 1 ? "note" : "notes"} to velocity ${value}.`);
}

/* ---------- Undo ---------- */

function remember() {
  // Patch sources are large and never edited in place, so they're shared, not copied.
  state.undo.push({
    json: JSON.stringify({ root: state.root, scale: state.scale, slots: state.slots, current: state.current, bpm: state.bpm }),
    sources: [...state.sources],
  });
  if (state.undo.length > 100) state.undo.shift();
  $("undo").disabled = false;
}

function undo() {
  const last = state.undo.pop();
  if (!last) return;
  closeNoteEditor({ restoreFocus: false });
  Object.assign(state, JSON.parse(last.json), { sources: last.sources });
  library.loaded = state.sources[state.current] ? state.sources[state.current].name : null;
  renderLibrary();
  renderAll();
  if (state.playing) announceTempo();
  saveSoon();
}

/* ---------- Rendering the grid ---------- */

function gridWidthForSteps() {
  const wrap = $("grid-wrap");
  const style = getComputedStyle(wrap);
  const label = document.querySelector(".note-label");
  return wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    - (label ? label.offsetWidth : 76);
}

// Everything fits on one page, until steps would be too small to click.
function updatePaging() {
  const totalBars = Math.ceil(slot().bars);
  const stepsPerBar = BAR / state.resolution;
  const available = gridWidthForSteps();
  let pageBars = totalBars;
  while (pageBars > 1 && available / (pageBars * stepsPerBar) < MIN_CELL_PX) {
    pageBars = Math.ceil(pageBars / 2);
  }
  state.pageBars = pageBars;
  const pages = Math.ceil(totalBars / pageBars);
  state.page = Math.min(state.page, pages - 1);
  $("pager").hidden = pages <= 1;
  const first = state.page * pageBars + 1;
  const last = Math.min(first + pageBars - 1, totalBars);
  $("page-label").textContent = first === last
    ? `Bar ${first} of ${totalBars}` : `Bars ${first}-${last} of ${totalBars}`;
  $("page-prev").disabled = state.page === 0;
  $("page-next").disabled = state.page >= pages - 1;
}

function goToPage(page) {
  state.page = page;
  renderGrid();
}

function renderGrid() {
  closeNoteEditor({ restoreFocus: false });
  const grid = $("grid");
  updatePaging();
  const windowStart = state.page * state.pageBars * BAR;
  const windowEnd = Math.min(windowStart + state.pageBars * BAR, lengthPulses());
  const stepCount = Math.ceil((windowEnd - windowStart) / state.resolution);
  state.windowStart = windowStart;
  state.windowSpan = stepCount * state.resolution;
  const rows = rowNotes();
  grid.style.gridTemplateColumns = `var(--label-width) repeat(${stepCount}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `20px repeat(${rows.length}, minmax(14px, 1fr))`;
  const dense = gridWidthForSteps() / stepCount < DENSE_CELL_PX;
  grid.classList.toggle("dense", dense);
  grid.style.setProperty("--grid-gap", dense ? "1px" : "2px");

  const nodes = [];
  const corner = document.createElement("div");
  corner.className = "corner";
  nodes.push(corner);
  for (let step = 0; step < stepCount; step += 1) {
    const time = windowStart + step * state.resolution;
    const label = document.createElement("div");
    label.className = "step-number";
    label.dataset.time = String(time);
    label.title = "Click or drag to choose steps for Copy, Paste and Velocity";
    if (time % BAR === 0) {
      label.classList.add("bar-start");
      label.textContent = String(time / BAR + 1);
    } else if (time % PPQ === 0) {
      label.textContent = String((time % BAR) / PPQ + 1);
    }
    nodes.push(label);
  }

  for (const note of rows) {
    const isRoot = (note - state.root) % 12 === 0;
    const label = document.createElement("button");
    label.type = "button";
    label.className = "note-label";
    label.textContent = Music.noteName(note);
    label.classList.toggle("root", isRoot);
    const fits = Music.inKey(note, state.root, state.scale);
    label.classList.toggle("out-of-key", !fits);
    label.title = fits ? `Note ${note}. Click to hear it.` : `Note ${note}, outside the key. Click to hear it.`;
    label.addEventListener("pointerdown", () => audition([note]));
    nodes.push(label);
    for (let step = 0; step < stepCount; step += 1) {
      const time = windowStart + step * state.resolution;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.note = String(note);
      cell.dataset.time = String(time);
      if (Math.floor(time / PPQ) % 2 === 0) cell.classList.add("beat");
      if (time % BAR === 0) cell.classList.add("bar-start");
      if (isRoot) cell.classList.add("root-row");
      nodes.push(cell);
    }
  }
  grid.replaceChildren(...nodes);
  document.querySelectorAll(".cell").forEach(paintCell);
  renderNoteBars();
  updateSelectionMarks();
  renderLane();
}

function notesInCell(note, time) {
  return notes().filter((n) => n.note === note && n.time >= time && n.time < time + state.resolution);
}

const cellElement = (note, time) =>
  document.querySelector(`.cell[data-note="${note}"][data-time="${time}"]`);

function paintCell(cell) {
  const time = Number(cell.dataset.time);
  const note = Number(cell.dataset.note);
  const found = notesInCell(note, time);
  const on = found.length > 0;
  queueNoteBars();
  cell.classList.toggle("on", on);
  cell.classList.toggle("chance", found.some((n) => (n.probability ?? 100) < 100));
  cell.setAttribute("aria-pressed", String(on));
  cell.setAttribute("aria-label", `${Music.noteName(note)}, pulse ${time}${on ? ", on" : ""}`);
  if (on) {
    const loudest = Math.max(...found.map((n) => n.velocity));
    cell.style.setProperty("--velocity", String(0.3 + 0.7 * loudest));
  } else {
    cell.style.removeProperty("--velocity");
  }
}

function queueNoteBars() {
  if (state.barsQueued) return;
  state.barsQueued = true;
  requestAnimationFrame(() => {
    state.barsQueued = false;
    renderNoteBars();
  });
}

function renderNoteBars() {
  document.querySelectorAll(".note-bar").forEach((bar) => bar.remove());
  document.querySelectorAll(".cell.has-bar").forEach((cell) => cell.classList.remove("has-bar"));
  const start = state.windowStart;
  const end = start + state.windowSpan;
  for (const note of notes()) {
    const noteEnd = note.time + note.length;
    if (noteEnd <= start || note.time >= end) continue;
    const cellTime = Math.floor(note.time / state.resolution) * state.resolution;
    const anchorTime = Math.max(cellTime, start);
    const cell = cellElement(note.note, anchorTime);
    if (!cell) continue;
    const barStart = Math.max(note.time, start);
    const barEnd = Math.min(noteEnd, end);
    const steps = (barEnd - barStart) / state.resolution;
    const bar = document.createElement("span");
    bar.className = "note-bar";
    bar.style.setProperty("--steps", String(steps));
    bar.style.setProperty("--gaps", String(Math.max(0, Math.ceil(steps) - 1)));
    bar.style.left = `${((barStart - anchorTime) / state.resolution) * 100}%`;
    bar.style.setProperty("--velocity", String(0.3 + 0.7 * note.velocity));
    if (note.substep && note.time === barStart) {
      const mark = document.createElement("span");
      mark.className = "note-sub";
      mark.textContent = Music.SUB_STEPS[note.substep];
      bar.classList.add("sub");
      bar.append(mark);
    }
    // A note running past this page can't be resized from here.
    if (noteEnd <= end) {
      const handle = document.createElement("span");
      handle.className = "note-handle";
      handle.title = "Drag to change where this note ends. Hold Alt for finer control.";
      bar.append(handle);
    }
    cell.append(bar);
    if (note.time === barStart) cell.classList.add("has-bar");
  }
}

function renderStepControls() {
  for (const button of $("steps").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.value) === state.baseResolution));
  }
  $("triplets").setAttribute("aria-pressed", String(state.triplets));
  for (const button of $("chords").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.value === state.chord));
  }
}

function renderChrome() {
  $("undo").disabled = state.undo.length === 0;
  renderSlots();
}

// Patterns from the S-1 can be any number of steps, such as 6 or 12.
function renderBarsOptions() {
  const select = $("bars");
  const value = String(slot().bars);
  select.querySelector("[data-custom]")?.remove();
  if (![...select.options].some((option) => option.value === value)) {
    const option = new Option(`${slot().bars * 16} steps`, value);
    option.dataset.custom = "true";
    select.append(option);
  }
  select.value = value;
}

function renderAll() {
  renderKey();
  renderPatchName();
  renderStepControls();
  renderBarsOptions();
  $("bpm").value = state.bpm;
  $("new-length").value = state.newLength;
  $("octave").value = String(state.lowOctave);
  $("span").value = String(state.span);
  $("show-all").checked = state.showAll;
  $("channel").value = String(state.channel + 1);
  renderGrid();
  renderChrome();
}

/* ---------- Editing ---------- */

function setSteps(baseResolution, triplets) {
  state.baseResolution = baseResolution;
  state.triplets = triplets;
  state.resolution = triplets ? (baseResolution * 2) / 3 : baseResolution;
  renderStepControls();
  renderGrid();
  saveSoon();
}

function setBars(bars) {
  remember();
  slot().bars = bars;
  const length = lengthPulses();
  slot().notes = notes()
    .filter((n) => n.time < length)
    .map((n) => ({ ...n, length: Math.min(n.length, length - n.time) }));
  if (slot().lanes) {
    for (const [cc, points] of Object.entries(slot().lanes)) slot().lanes[cc] = points.filter((point) => point.time < length);
  }
  if (state.nextPulse >= length) state.nextPulse = 0;
  renderGrid();
  renderChrome();
  saveSoon();
}

function newNoteLength(time) {
  const lengths = { step: state.resolution, beat: PPQ, bar: BAR };
  return Math.min(lengths[state.newLength], lengthPulses() - time);
}

// Adds the note, or the chord built on it, and returns what was added.
function addNotes(note, time) {
  const added = [];
  for (const value of Music.chordNotes(note, state.chord, state.root, state.scale)) {
    if (notesInCell(value, time).length) continue;
    const item = { time, note: value, velocity: 1, length: newNoteLength(time), probability: 100 };
    notes().push(item);
    added.push(item);
  }
  notes().sort((a, b) => a.time - b.time || a.note - b.note);
  return added;
}

function repaintFor(items) {
  for (const item of items) {
    const time = Math.floor(item.time / state.resolution) * state.resolution;
    const cell = cellElement(item.note, time);
    if (cell) paintCell(cell);
  }
}

function needsRowsFor(items) {
  return items.some((item) => !cellElement(item.note, state.windowStart));
}

function describeLength(length) {
  const steps = length / state.resolution;
  const shown = Number.isInteger(steps) ? String(steps) : steps.toFixed(2);
  return `${shown} ${steps === 1 ? "step" : "steps"}`;
}

function cycleVelocity(cell) {
  const found = notesInCell(Number(cell.dataset.note), Number(cell.dataset.time));
  if (!found.length) return;
  remember();
  const current = VELOCITY_STEPS.findIndex((v) => found[0].velocity >= v - 0.001);
  const next = VELOCITY_STEPS[(Math.max(current, 0) + 1) % VELOCITY_STEPS.length];
  found.forEach((n) => { n.velocity = next; });
  paintCell(cell);
  renderChrome();
  saveSoon();
  setStatus(`Velocity ${Math.round(next * 127)} of 127.`);
}

function startLengthDrag(event, handle) {
  const cell = handle.closest(".cell");
  const note = Number(cell.dataset.note);
  const anchorTime = Number(cell.dataset.time);
  const found = notes().find((n) => n.note === note
    && n.time < anchorTime + state.resolution && n.time + n.length > anchorTime);
  if (!found) return;
  remember();
  state.lengthDrag = { items: [found], anchorTime, cell, pressed: true, startX: event.clientX };
  event.preventDefault();
}

// Where a resize ends. Drawing a new note uses whole steps, while resizing is finer so
// a note can end inside a step. Alt gives single ticks.
function dragEnd(event, drag, start, currentLength, box) {
  const gap = parseFloat(getComputedStyle($("grid")).getPropertyValue("--grid-gap")) || 0;
  const ticksAt = (x) => drag.anchorTime + ((x - box.left) / (box.width + gap)) * state.resolution;
  // Follows the mouse from where the note was grabbed, so it doesn't jump at the start.
  if (!drag.drawing && drag.grabOffset === undefined) {
    drag.grabOffset = start + currentLength - ticksAt(drag.startX);
  }
  const pointer = ticksAt(event.clientX) + (drag.grabOffset || 0);
  if (event.altKey) return { end: Math.round(pointer), shortest: start + 1 };
  const divisions = box.width < NARROW_STEP_PX ? FINE_DIVISIONS / 2 : FINE_DIVISIONS;
  const unit = drag.drawing ? state.resolution : state.resolution / divisions;
  return {
    end: Math.round(pointer / unit) * unit,
    shortest: Math.floor(start / unit) * unit + unit,
  };
}

function moveLengthDrag(event) {
  const drag = state.lengthDrag;
  const box = drag.cell.getBoundingClientRect();
  // A click that stays on its step keeps the Length setting.
  if (drag.drawing && !drag.moved) {
    if (event.clientX <= box.right) return;
    drag.moved = true;
  }
  if (drag.pressed && !drag.moved) {
    if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
  }
  const start = drag.items[0].time;
  const target = dragEnd(event, drag, start, drag.items[0].length, box);
  const end = Math.max(target.shortest, Math.min(target.end, state.windowStart + state.windowSpan, lengthPulses()));
  const length = end - start;
  if (length !== drag.items[0].length) {
    drag.items.forEach((item) => { item.length = length; });
    renderNoteBars();
  }
  setStatus(`Length: ${describeLength(length)} (${length} ticks).`);
}

function bindGridEvents() {
  const grid = $("grid");
  grid.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const cell = event.target.closest(".cell");
    if (cell) openNoteEditor(cell);
  });
  window.addEventListener("pointermove", (event) => {
    if (state.lengthDrag) moveLengthDrag(event);
  });
  grid.addEventListener("pointerdown", (event) => {
    const number = event.target.closest(".step-number");
    if (number && event.button === 0) {
      const time = Number(number.dataset.time);
      const range = state.selection;
      // A click on the only chosen step clears it.
      if (range && range.start === time && range.end === time + state.resolution) {
        clearSelection();
      } else {
        state.selecting = time;
        selectSteps(time, time);
      }
      event.preventDefault();
      return;
    }
    const handle = event.target.closest(".note-handle");
    if (handle && event.button === 0 && !event.ctrlKey) {
      if (state.editor) closeNoteEditor({ restoreFocus: false });
      startLengthDrag(event, handle);
      return;
    }
    const cell = event.target.closest(".cell");
    // Control-click is a right-click on a Mac and opens the editor instead.
    if (!cell || event.button !== 0 || event.ctrlKey) return;
    event.preventDefault();
    if (state.editor) {
      closeNoteEditor({ restoreFocus: false });
      return;
    }
    if (event.shiftKey) {
      cycleVelocity(cell);
      return;
    }
    remember();
    const note = Number(cell.dataset.note);
    const time = Number(cell.dataset.time);
    const on = !cell.classList.contains("on");
    if (on) {
      const added = addNotes(note, time);
      if (needsRowsFor(added)) {
        // A chord can reach above the rows shown, which adds rows to the grid.
        renderGrid();
      } else {
        repaintFor(added);
      }
      audition(added.map((item) => item.note));
      // Dragging draws one note at the dragged length. Cmd-drag fills separate steps.
      if (!event.metaKey && added.length) {
        state.lengthDrag = { items: added, anchorTime: time, cell: cellElement(note, time), drawing: true };
      } else {
        state.paint = { on: true };
      }
    } else if (event.metaKey) {
      slot().notes = notes().filter((n) => !notesInCell(note, time).includes(n));
      paintCell(cell);
      state.paint = { on: false };
    } else {
      // Dragging a note resizes it, so it's only removed by a click that doesn't move.
      state.lengthDrag = {
        items: notesInCell(note, time), anchorTime: time, cell, pressed: true, startX: event.clientX,
      };
    }
    renderChrome();
    saveSoon();
  });
  grid.addEventListener("pointerover", (event) => {
    if (state.selecting !== null) {
      const over = event.target.closest(".step-number, .cell");
      if (over) selectSteps(state.selecting, Number(over.dataset.time));
      return;
    }
    const cell = event.target.closest(".cell");
    if (!cell || !state.paint) return;
    const note = Number(cell.dataset.note);
    const time = Number(cell.dataset.time);
    if (state.paint.on && !notesInCell(note, time).length) {
      repaintFor(addNotes(note, time));
    } else if (!state.paint.on && notesInCell(note, time).length) {
      slot().notes = notes().filter((n) => !notesInCell(note, time).includes(n));
    }
    paintCell(cell);
    renderChrome();
  });
  window.addEventListener("pointerup", () => {
    state.selecting = null;
    const drag = state.lengthDrag;
    if (drag && drag.pressed && !drag.moved) {
      slot().notes = notes().filter((n) => !drag.items.includes(n));
      paintCell(drag.cell);
      renderChrome();
    }
    if (state.lengthDrag || state.paint) saveSoon();
    state.lengthDrag = null;
    state.paint = null;
  });
  // Keyboard activation: pointer clicks are already handled on pointerdown.
  grid.addEventListener("click", (event) => {
    const cell = event.target.closest(".cell");
    if (!cell || event.detail !== 0) return;
    remember();
    const note = Number(cell.dataset.note);
    const time = Number(cell.dataset.time);
    if (cell.classList.contains("on")) {
      slot().notes = notes().filter((n) => !notesInCell(note, time).includes(n));
      paintCell(cell);
    } else {
      repaintFor(addNotes(note, time));
    }
    renderChrome();
    saveSoon();
  });
}

/* ---------- Step editor ---------- */

const editorNotes = () => notesInCell(state.editor.note, state.editor.time);

function openNoteEditor(cell) {
  closeNoteEditor({ restoreFocus: false });
  const note = Number(cell.dataset.note);
  const time = Number(cell.dataset.time);
  let remembered = false;
  if (!notesInCell(note, time).length) {
    remember();
    remembered = true;
    const wasChord = state.chord;
    state.chord = "note";
    addNotes(note, time);
    state.chord = wasChord;
    renderChrome();
  }
  state.editor = { note, time, remembered };
  cell.classList.add("editing");
  paintCell(cell);
  const bar = Math.floor(time / BAR) + 1;
  const beat = ((time % BAR) / PPQ + 1).toFixed(2).replace(/\.?0+$/, "");
  $("editor-title").textContent = `${Music.noteName(note)}, bar ${bar}, beat ${beat}`;
  fillNoteEditor();
  const panel = $("note-editor");
  panel.hidden = false;
  const box = cell.getBoundingClientRect();
  const margin = 8;
  const fitsRight = box.right + margin + panel.offsetWidth < innerWidth;
  const left = fitsRight ? box.right + margin : box.left - panel.offsetWidth - margin;
  const top = Math.min(box.top, innerHeight - panel.offsetHeight - margin);
  panel.style.left = `${Math.max(margin, left)}px`;
  panel.style.top = `${Math.max(margin, top)}px`;
  $("edit-velocity").focus();
  $("edit-velocity").select();
}

function maxEditorOffset(found) {
  const times = found.map((n) => n.time);
  return state.resolution - 1 - (Math.max(...times) - Math.min(...times));
}

function fillNoteEditor() {
  const found = editorNotes();
  const [first] = found;
  const velocity = Math.max(1, Math.min(127, Math.round(first.velocity * 127)));
  const count = $("editor-count");
  count.hidden = found.length < 2;
  count.textContent = `Changes apply to all ${found.length} notes in this step.`;
  $("edit-velocity").value = velocity;
  $("edit-velocity-range").value = velocity;
  $("edit-length").value = first.length;
  $("edit-length").max = lengthPulses();
  $("edit-length-steps").textContent = `ticks, ${describeLength(first.length)}`;
  const maxOffset = maxEditorOffset(found);
  $("edit-offset").value = Math.min(...found.map((n) => n.time)) - state.editor.time;
  $("edit-offset").max = maxOffset;
  $("edit-offset-range").textContent = `ticks, 0-${maxOffset}`;
  $("edit-probability").value = first.probability ?? 100;
  $("edit-substep").value = String(first.substep || 0);
  for (const id of ["edit-velocity", "edit-length", "edit-offset", "edit-probability"]) {
    $(id).setAttribute("aria-invalid", "false");
  }
}

function changeEditorNotes(change) {
  if (!state.editor.remembered) {
    remember();
    state.editor.remembered = true;
  }
  change(editorNotes());
  notes().sort((a, b) => a.time - b.time || a.note - b.note);
  const cell = cellElement(state.editor.note, state.editor.time);
  if (cell) paintCell(cell);
  renderChrome();
  saveSoon();
}

// Applies a typed value if it's valid, and otherwise leaves the notes alone.
function editorNumber(id, low, high, apply) {
  const input = $(id);
  const value = Number(input.value);
  const valid = input.value !== "" && Number.isInteger(value) && value >= low && value <= high;
  input.setAttribute("aria-invalid", String(!valid));
  if (valid) apply(value);
}

function setEditorVelocity(value) {
  changeEditorNotes((found) => found.forEach((n) => { n.velocity = value / 127; }));
}

function bindNoteEditor() {
  $("edit-velocity").addEventListener("input", () => {
    editorNumber("edit-velocity", 1, 127, (value) => {
      $("edit-velocity-range").value = value;
      setEditorVelocity(value);
    });
  });
  $("edit-velocity-range").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    $("edit-velocity").value = value;
    $("edit-velocity").setAttribute("aria-invalid", "false");
    setEditorVelocity(value);
  });
  $("edit-length").addEventListener("input", () => {
    editorNumber("edit-length", 1, lengthPulses(), (value) => {
      changeEditorNotes((found) => found.forEach((n) => {
        n.length = Math.min(value, lengthPulses() - n.time);
      }));
      $("edit-length-steps").textContent = `ticks, ${describeLength(value)}`;
    });
  });
  $("edit-offset").addEventListener("input", () => {
    editorNumber("edit-offset", 0, maxEditorOffset(editorNotes()), (value) => {
      changeEditorNotes((found) => {
        const start = Math.min(...found.map((n) => n.time));
        const delta = state.editor.time + value - start;
        found.forEach((n) => { n.time += delta; });
      });
    });
  });
  $("edit-probability").addEventListener("input", () => {
    editorNumber("edit-probability", 0, 100, (value) => {
      changeEditorNotes((found) => found.forEach((n) => { n.probability = value; }));
    });
  });
  $("edit-substep").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    changeEditorNotes((found) => found.forEach((n) => {
      if (value) n.substep = value;
      else delete n.substep;
    }));
    renderNoteBars();
  });
  // Leaving a field with a bad value puts back the value actually in use.
  $("note-editor").addEventListener("focusout", (event) => {
    if (state.editor && event.target.getAttribute("aria-invalid") === "true") fillNoteEditor();
  });
  $("note-editor").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") closeNoteEditor();
  });
  $("edit-hear").addEventListener("click", () => {
    audition(editorNotes().map((n) => n.note), editorNotes()[0].velocity);
  });
  $("edit-delete").addEventListener("click", () => {
    changeEditorNotes((found) => {
      slot().notes = notes().filter((n) => !found.includes(n));
    });
    closeNoteEditor();
  });
  $("edit-done").addEventListener("click", () => closeNoteEditor());
  window.addEventListener("pointerdown", (event) => {
    if (!state.editor || $("note-editor").contains(event.target)) return;
    if (!event.target.closest("#grid")) closeNoteEditor({ restoreFocus: false });
  });
}

function closeNoteEditor({ restoreFocus = true } = {}) {
  if (!state.editor) return;
  const cell = cellElement(state.editor.note, state.editor.time);
  state.editor = null;
  $("note-editor").hidden = true;
  if (cell) {
    cell.classList.remove("editing");
    if (restoreFocus) cell.focus();
  }
}

/* ---------- Sound panel ---------- */

const paramControls = new Map();

function renderTabs() {
  const sections = [{ id: "library", name: "LIBRARY" }, ...S1Params.SECTIONS];
  $("tabs").replaceChildren(...sections.map((section) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = section.name;
    button.setAttribute("aria-current", String(section.id === state.tab));
    button.addEventListener("click", () => {
      state.tab = section.id;
      renderTabs();
      renderParams();
      saveSoon();
    });
    return button;
  }));
}

function renderParams() {
  paramControls.clear();
  const section = S1Params.SECTIONS.find((item) => item.id === state.tab) || S1Params.SECTIONS[0];
  const inLibrary = state.tab === "library";
  $("library").hidden = !inLibrary;
  $("params").hidden = inLibrary;
  if (inLibrary) return;
  $("params").replaceChildren(...section.params.map((param) => {
    const row = document.createElement("label");
    row.className = "param";
    row.dataset.cc = String(param.cc);
    row.title = `${param.help} MIDI controller ${param.cc}.`;
    const name = document.createElement("span");
    name.textContent = param.name;
    row.append(name);
    if (param.type === "select") {
      const select = document.createElement("select");
      select.setAttribute("aria-label", param.name);
      select.append(new Option("?", ""));
      param.options.forEach((option, index) => select.append(new Option(option, String(index))));
      select.addEventListener("change", () => {
        if (select.value !== "") setParam(param.cc, Number(select.value));
      });
      row.append(select);
      paramControls.set(param.cc, { param, select });
    } else if (param.type === "toggle") {
      const box = document.createElement("span");
      box.className = "switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("aria-label", param.name);
      const output = document.createElement("output");
      input.addEventListener("change", () => setParam(param.cc, input.checked ? 127 : 0));
      box.append(input, output);
      row.append(box);
      paramControls.set(param.cc, { param, input, output });
    } else {
      const input = document.createElement("input");
      input.type = "range";
      input.setAttribute("aria-label", param.name);
      input.min = param.type === "bipolar" ? 64 - param.span : 0;
      input.max = param.type === "bipolar" ? 64 + param.span : 127;
      input.step = 1;
      const output = document.createElement("output");
      input.addEventListener("input", () => setParam(param.cc, Number(input.value)));
      row.append(input, output);
      paramControls.set(param.cc, { param, input, output });
    }
    return row;
  }));
  if (section.id === "fx") {
    const afterTime = [...$("params").children].findIndex((row) => row.dataset.cc === "90") + 1;
    $("params").children[afterTime].before(...delayRows());
  }
  for (const cc of paramControls.keys()) updateParamControl(cc);
}

// Settings with no MIDI control, so they reach the S-1 when a pattern is saved to it.
function delayRows() {
  const row = (name, help, options, value, apply) => {
    const label = document.createElement("label");
    label.className = "param";
    label.title = `${help} Takes effect once the pattern is saved to the S-1.`;
    const text = document.createElement("span");
    text.textContent = name;
    const select = document.createElement("select");
    select.setAttribute("aria-label", name);
    select.classList.toggle("unknown", value === undefined);
    if (value === undefined) select.append(new Option("?", ""));
    options.forEach((option, index) => select.append(new Option(option, String(index))));
    select.value = value === undefined ? "" : String(value);
    select.addEventListener("change", () => {
      if (select.value === "") return;
      apply(Number(select.value));
      renderParams();
      saveSoon();
      setStatus(`${name} takes effect once this pattern is saved to the S-1.`);
    });
    label.append(text, select);
    return label;
  };
  return [row("Delay sync", "Whether the delay time follows the tempo as a note value, or is set in ms.",
    ["Off (ms)", "On (note value)"], state.delay.sync, setDelaySync)];
}

const DELAY_CC = 90;
const DELAY_LAST_NOTE = Prm.DELAY_NOTES.length - 1;
const DELAY_DEFAULT_NOTE = 12; // 1/8
const DELAY_DEFAULT_TIME = 64;

// Delay time is a note value with sync on and a time with it off, so a value doesn't carry over.
function setDelaySync(sync) {
  const current = state.values[DELAY_CC];
  if (sync === 1) state.values[DELAY_CC] = current <= DELAY_LAST_NOTE ? current : DELAY_DEFAULT_NOTE;
  else if (state.delay.sync === 1) state.values[DELAY_CC] = DELAY_DEFAULT_TIME;
  state.delay.sync = sync;
}

function delayText(value) {
  if (state.delay.sync === 1) return Prm.DELAY_NOTES[Math.min(value, DELAY_LAST_NOTE)];
  return state.delay.sync === 0 ? `${S1Params.delayMs(value)} ms` : String(value);
}

function updateParamControl(cc) {
  const control = paramControls.get(cc);
  if (!control) return;
  const value = state.values[cc];
  const known = value !== undefined;
  const { param, select, input, output } = control;
  if (select) {
    // ? only means something until the value is known, so it isn't an option after that.
    const unknownOption = select.querySelector('option[value=""]');
    if (known && unknownOption) unknownOption.remove();
    if (!known && !unknownOption) select.prepend(new Option("?", ""));
    select.value = known ? String(Math.min(value, param.options.length - 1)) : "";
    select.classList.toggle("unknown", !known);
    return;
  }
  if (param.type === "toggle") input.checked = known && value >= 64;
  else {
    if (cc === DELAY_CC) input.max = state.delay.sync === 1 ? DELAY_LAST_NOTE : 127;
    input.value = known ? value : 64;
  }
  output.textContent = cc === DELAY_CC && known ? delayText(value) : S1Params.display(param, value);
  output.classList.toggle("unknown", !known);
  // The S-1 can't report its settings, so an untouched slider's position means nothing.
  input.classList.toggle("unknown", !known);
}

function sendController(cc, value, atTime) {
  if (!state.output) return false;
  const message = [0xB0 | state.channel, cc, Math.max(0, Math.min(127, Math.round(value)))];
  if (atTime === undefined) state.output.send(message);
  else state.output.send(message, atTime);
  return true;
}

function setParam(cc, value) {
  state.values[cc] = value;
  if (!sendController(cc, value)) setStatus("Not sent: no MIDI output connected.", true);
  updateParamControl(cc);
}

function renderSounds() {
  $("sound-bar").hidden = !state.sounds.length;
  $("sound").replaceChildren(new Option("Saved sounds", ""), ...state.sounds.map(
    (sound, index) => new Option(sound.name, String(index))));
}

function loadSound() {
  const sound = state.sounds[Number($("sound").value)];
  if ($("sound").value === "" || !sound) {
    setStatus("Choose a saved sound first.", true);
    return;
  }
  if (!state.output) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  applySound(sound.values);
  setStatus(`Sent "${sound.name}" to the S-1.`);
}

function deleteSound() {
  const index = Number($("sound").value);
  if ($("sound").value === "" || !state.sounds[index]) return;
  const [removed] = state.sounds.splice(index, 1);
  renderSounds();
  saveSoon();
  setStatus(`Deleted "${removed.name}".`);
}

/* ---------- MIDI ---------- */

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setMidiPill("MIDI needs Chrome or Edge", "warn");
    return;
  }
  $("midi-retry").hidden = true;
  try {
    state.midi = await navigator.requestMIDIAccess({ sysex: false });
  } catch (error) {
    setMidiPill("MIDI blocked", "warn");
    $("midi-retry").hidden = false;
    setStatus(`Chrome blocked MIDI (${error.name}). Click the icon left of the address, set MIDI devices to Allow, then click Allow MIDI.`, true);
    return;
  }
  setStatus("MIDI is allowed. Choose a key, then click or drag on the grid to add notes.");
  state.midi.onstatechange = refreshPorts;
  refreshPorts();
}

function setMidiPill(text, kind) {
  $("midi-state").textContent = text;
  $("midi-state").className = `pill ${kind || ""}`;
}

const isS1 = (port) => /\bS-1\b/i.test(port.name);

function refreshPorts() {
  if (!state.midi) return;
  const outputs = [...state.midi.outputs.values()];
  const previous = state.output && state.output.id;
  $("output").replaceChildren(...outputs.map((port) => new Option(port.name, port.id)));
  state.output = outputs.find((port) => port.id === previous) || outputs.find(isS1) || null;
  if (state.output) $("output").value = state.output.id;
  if (state.output && isS1(state.output)) setMidiPill("MIDI: S-1", "ok");
  else if (state.output) setMidiPill(`MIDI: ${state.output.name}`);
  else setMidiPill("S-1 not found. Connect it and turn it on.", "warn");

  const input = [...state.midi.inputs.values()].find(isS1) || null;
  if (input !== state.input) {
    if (state.input) state.input.onmidimessage = null;
    state.input = input;
    if (input) input.onmidimessage = handleMidiInput;
  }
}

// Knobs moved on the S-1 update the matching controls here, and keys can be recorded.
function handleMidiInput(event) {
  const [status, first, second] = event.data;
  // The S-1 sends its pattern changes on channel 16, whatever its note channel.
  if ((status & 0xF0) === 0xC0) {
    followProgram(first);
    return;
  }
  if ((status & 0x0F) !== state.channel) return;
  const kind = status & 0xF0;
  const at = event.timeStamp || performance.now();
  if (kind === 0x90 && second > 0) {
    recordNoteOn(first, second, at);
  } else if (kind === 0x80 || kind === 0x90) {
    recordNoteOff(first, at);
  } else if (kind === 0xB0 && S1Params.BY_CC.has(first)) {
    // Past the last note value, the S-1 can only be sending a time, so its sync is off.
    const syncIsOff = first === DELAY_CC && second > DELAY_LAST_NOTE && state.delay.sync === 1;
    if (syncIsOff) state.delay.sync = 0;
    state.values[first] = second;
    if (syncIsOff) renderParams();
    else updateParamControl(first);
  }
}

/* ---------- Following the S-1's pattern changes ---------- */

/* The S-1 can't report its sound, but it sends a program change when its pattern changes.
   A copy of its 64 saved patterns, from its BACKUP folder, fills in the controls. The copy
   is kept in this browser, and updated whenever the page reads or writes the S-1 drive. */
const FOLLOW_KEY = "follow-sounds";
const FOLLOW_ON_KEY = "s1-grid-follow";
const follow = { on: false, slots: null, from: "", when: 0, slot: null };

// The pattern files' texts by slot, or null for any that are missing or unreadable.
function slotTexts(bytesOf) {
  const decode = new TextDecoder("ascii");
  return Array.from({ length: S1_DRIVE_FILES }, (_, slot) => {
    const bytes = bytesOf(slot);
    if (!bytes) return null;
    const text = decode.decode(bytes);
    return Prm.validate(text).length ? null : text;
  });
}

async function loadFollowSounds() {
  try {
    follow.on = localStorage.getItem(FOLLOW_ON_KEY) === "on";
  } catch {
    // Private windows can refuse storage, so following starts off.
  }
  try {
    const saved = await storeHandle((store) => store.get(FOLLOW_KEY), "readonly");
    if (saved && saved.slots && saved.slots.length === S1_DRIVE_FILES) Object.assign(follow, saved);
  } catch {
    // Without a saved copy, Follow S-1 asks for a backup.
  }
  renderFollow();
}

async function keepFollowSounds(slots, from) {
  if (!slots.some(Boolean)) return;
  Object.assign(follow, { slots, from, when: Date.now() });
  try {
    await storeHandle((store) => store.put({ slots, from, when: follow.when }, FOLLOW_KEY), "readwrite");
  } catch {
    // It still works until the page is reloaded.
  }
  renderFollow();
}

function renderFollow() {
  $("follow-s1").setAttribute("aria-pressed", String(follow.on));
  const pill = $("follow-state");
  pill.hidden = !follow.on;
  if (!follow.slots) pill.textContent = "No S-1 backup yet";
  else pill.textContent = follow.slot === null ? "Waiting for the S-1" : `S-1 pattern ${Prm.slotLabel(follow.slot)}`;
  pill.title = follow.slots ? `Sounds from ${follow.from}, ${new Date(follow.when).toLocaleString()}` : "";
}

function setFollow(on) {
  follow.on = on;
  try {
    localStorage.setItem(FOLLOW_ON_KEY, on ? "on" : "off");
  } catch {
    // It's just not remembered.
  }
  renderFollow();
}

async function toggleFollow() {
  if (follow.on) {
    setFollow(false);
    setStatus("No longer following the S-1's pattern changes.");
    return;
  }
  if (!follow.slots) {
    await chooseFollowBackup();
    return;
  }
  setFollow(true);
  setStatus(`Following the S-1. Change pattern on it to see its sound here. Its sounds are from ${follow.from}.`);
}

// A copy of the BACKUP folder, or the S-1 drive itself.
async function chooseFollowBackup() {
  let folder;
  try {
    folder = await window.showDirectoryPicker({ id: "s1-import", mode: "read" });
  } catch (error) {
    if (error.name !== "AbortError") setStatus(`Couldn't open that folder: ${error.message}`, true);
    return;
  }
  try {
    let source = folder;
    try {
      source = await folder.getDirectoryHandle("BACKUP");
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
    const files = [];
    for (let slot = 0; slot < S1_DRIVE_FILES; slot += 1) {
      try {
        files.push(new Uint8Array(await (await (await source.getFileHandle(Prm.fileName(slot))).getFile()).arrayBuffer()));
      } catch (error) {
        if (error.name !== "NotFoundError") throw error;
        files.push(null);
      }
    }
    const slots = slotTexts((slot) => files[slot]);
    const count = slots.filter(Boolean).length;
    if (!count) {
      setStatus("That doesn't look like an S-1 backup. Choose the S-1 drive, or a BACKUP folder with its pattern files.", true);
      return;
    }
    await keepFollowSounds(slots, `the folder "${folder.name}"`);
    setFollow(true);
    setStatus(`Read ${count} of the S-1's 64 patterns. Change pattern on the S-1 to see its sound here.`);
  } catch (error) {
    setStatus(`Couldn't read that backup: ${error.message}`, true);
  }
}

// Shows the sound saved in the S-1's new pattern. It's already playing on the S-1, so
// nothing is sent back.
function followProgram(program) {
  if (!follow.on || program >= S1_DRIVE_FILES) return;
  follow.slot = program;
  renderFollow();
  const label = Prm.slotLabel(program);
  const text = follow.slots && follow.slots[program];
  if (!text) {
    setStatus(follow.slots
      ? `The S-1 is on pattern ${label}, but the copy of its sounds doesn't have it. Choose a newer backup.`
      : "Follow S-1 needs a copy of the S-1's sounds. Click S-1 backup and choose its BACKUP folder.", true);
    return;
  }
  resetVary();
  const values = Prm.readValues(text);
  state.delay = Prm.readDelay(text);
  if (state.preview) {
    // The sound comes back when the preview ends, so that's where it goes.
    state.preview.before = values;
  } else {
    state.values = { ...values };
    renderParams();
  }
  saveSoon();
  const match = library.items.find((item) => item.text === text);
  const name = match ? `, the same as "${match.name}" in the library` : "";
  setStatus(`S-1 pattern ${label}: showing its saved sound${name}. Changes made on the S-1 since the backup show once you move those knobs.`);
}

/* ---------- Recording from the S-1's keys ---------- */

const ECHO_WINDOW_MS = 40; // A note this close to one we sent is the S-1 echoing it.
const CHORD_WINDOW_MS = 80; // Keys this close together count as one chord in step entry.

function toggleRecording() {
  if (state.recording) {
    state.recording = false;
    state.recOpen.clear();
    $("record").setAttribute("aria-pressed", "false");
    setStatus("Stopped recording.");
    return;
  }
  if (!state.input) {
    setStatus("No S-1 found to record from. Connect it and turn it on.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  renderChrome();
  state.recording = true;
  state.recLast = 0;
  state.recStep = state.selection ? state.selection.start : 0;
  $("record").setAttribute("aria-pressed", "true");
  if (state.playing) {
    setStatus("Recording. Play the S-1's keys, and notes land on the nearest step. Undo takes it all back.");
  } else {
    moveRecordCursor(state.recStep);
    setStatus("Step recording. Each key adds a note and moves on a step. Press Play to record in time instead.");
  }
}

function moveRecordCursor(time) {
  state.recStep = time;
  if (time < state.windowStart || time >= state.windowStart + state.windowSpan) {
    goToPage(Math.floor(time / (state.pageBars * BAR)));
  }
  selectSteps(time, time);
}

function nearestStep(pulse) {
  return (Math.round(pulse / state.resolution) * state.resolution) % lengthPulses();
}

function recordNoteOn(note, velocity, at) {
  if (!state.recording || state.preview) return;
  if (state.recent.some((sent) => sent.note === note && Math.abs(sent.at - at) < ECHO_WINDOW_MS)) return;
  let time;
  if (state.playing) {
    time = nearestStep(pulseAt(at));
  } else {
    const chord = at - state.recLast < CHORD_WINDOW_MS;
    if (!chord && state.recLast) {
      moveRecordCursor((state.recStep + state.resolution) % lengthPulses());
    }
    time = state.recStep;
    state.recLast = at;
  }
  const existing = notes().find((n) => n.note === note && n.time === time);
  const item = existing || { time, note, velocity: velocity / 127, length: state.resolution, probability: 100 };
  if (!existing) {
    notes().push(item);
    notes().sort((a, b) => a.time - b.time || a.note - b.note);
  }
  state.recOpen.set(note, { item, pulse: state.playing ? pulseAt(at) : null });
  if (needsRowsFor([item])) renderGrid();
  else repaintFor([item]);
  renderChrome();
  saveSoon();
}

// How long a key was held sets the note's length, when recording in time.
function recordNoteOff(note, at) {
  const open = state.recOpen.get(note);
  if (!open) return;
  state.recOpen.delete(note);
  if (!state.playing || open.pulse === null) return;
  const length = lengthPulses();
  const held = ((pulseAt(at) - open.pulse) % length + length) % length;
  const steps = Math.max(1, Math.round(held / state.resolution));
  open.item.length = Math.min(steps * state.resolution, length - open.item.time);
  renderNoteBars();
  saveSoon();
}

function sendNote(note, velocity, atTime, lengthMs) {
  if (!state.output) return;
  const value = Math.max(1, Math.min(127, Math.round(velocity * 127)));
  if (state.recording) {
    state.recent.push({ note, at: atTime });
    if (state.recent.length > 64) state.recent.shift();
  }
  try {
    state.output.send([0x90 | state.channel, note, value], atTime);
    state.output.send([0x80 | state.channel, note, 0], atTime + lengthMs);
  } catch (error) {
    setStatus(`MIDI send failed: ${error.message}`, true);
    stop();
  }
}

function audition(noteList, velocity = 1) {
  if (!noteList.length) return;
  if (!state.output) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  const now = performance.now();
  noteList.forEach((note) => sendNote(note, velocity, now, 220));
}

/* ---------- Playback ---------- */

const ticker = new Worker(URL.createObjectURL(new Blob(
  ["setInterval(() => postMessage(0), 25);"], { type: "text/javascript" })));
ticker.onmessage = () => { if (state.playing) schedule(); };

const msPerPulse = () => 60000 / (currentBpm() * PPQ);
const sendingClock = () => $("clock").checked || state.sendOnce;

function currentBpm() {
  if (state.preview) return state.preview.bpm;
  const value = Number($("bpm").value);
  return value >= 20 && value <= 300 ? value : 120;
}

function schedule() {
  const horizon = performance.now() + SCHEDULE_AHEAD_MS;
  const ms = msPerPulse();
  while (state.nextTime < horizon) {
    const playing = state.preview || slot();
    const from = state.nextPulse;
    const to = from + CHUNK_PULSES;
    if (sendingClock() && from % CLOCK_PULSES === 0 && state.output) {
      state.output.send([0xF8], state.nextTime);
    }
    if (!state.sendOnce) scheduleMotions(from, to, ms);
    for (const note of playing.notes) {
      if (note.time >= from && note.time < to && Math.random() * 100 < (note.probability ?? 100)) {
        for (const part of Music.noteParts(note)) {
          sendNote(note.note, note.velocity, state.nextTime + (part.time - from) * ms, part.length * ms);
        }
      }
    }
    state.nextTime += CHUNK_PULSES * ms;
    state.nextPulse = to >= lengthPulses(playing) ? 0 : to;
    if (state.nextPulse === 0 && state.sendOnce) {
      finishSendOnce();
      return;
    }
    if (state.nextPulse === 0 && !state.preview) {
      if (state.queued !== null) switchTo(state.queued);
      else advanceChain();
    }
  }
}

const chainList = () => (state.chainOn ? Music.parseChain(state.chain) || [] : []);

function advanceChain() {
  const chain = chainList();
  if (!chain.length) return;
  state.chainPos = (state.chainPos + 1) % chain.length;
  if (chain[state.chainPos] !== state.current) switchTo(chain[state.chainPos]);
  setStatus(`Chain: pattern ${chain[state.chainPos] + 1}, ${state.chainPos + 1} of ${chain.length}.`);
}

function setChain(text) {
  state.chain = text;
  const valid = Music.parseChain(text) !== null;
  $("chain").setAttribute("aria-invalid", String(!valid));
  if (!valid) setStatus("A chain is pattern numbers from 1 to 16, such as 1 1 2 3.", true);
  saveSoon();
}

// Plays a loaded patch's recorded knob movements. Each pass starts from the current
// sound's values, as the movements only cover part of the pattern.
function scheduleMotions(from, to, ms) {
  const lanes = state.preview ? state.preview.lanes : lanesFor();
  if (!lanes) return;
  const length = lengthPulses(state.preview || slot());
  for (const [cc, points] of Object.entries(lanes)) {
    if (from === 0) {
      const value = baseValue(cc);
      if (value !== undefined) sendController(Number(cc), value, state.nextTime);
    }
    for (const point of points) {
      if (point.time >= from && point.time < to && point.time < length) {
        sendController(Number(cc), point.value, state.nextTime + (point.time - from) * ms);
      }
    }
  }
}

// What a knob returns to, as the movements only cover part of the pattern.
function baseValue(cc) {
  const source = state.sources[state.current];
  if (state.values[cc] !== undefined || !source) return state.values[cc];
  source.base ??= Prm.readValues(source.text);
  return source.base[cc];
}

function restoreAfterMotions() {
  const lanes = lanesFor();
  if (!lanes) return;
  // Controls edited since loading keep their new value.
  for (const cc of Object.keys(lanes)) {
    const value = baseValue(cc);
    if (value !== undefined) sendController(Number(cc), value, performance.now() + SCHEDULE_AHEAD_MS + 25);
  }
}

/* ---------- Drawing knob movements ---------- */

const MOTION_TICKS = 30; // The S-1 stores 8 points per step.
const MAX_LANES = 8;

// Movements this pattern has been given, or else the ones in its loaded patch.
function lanesFor(index = state.current) {
  const own = state.slots[index].lanes;
  if (own) return own;
  const source = state.sources[index];
  if (!source) return null;
  source.lanes ??= Prm.readLanes(source.text);
  return source.lanes;
}

function editableLanes() {
  slot().lanes ??= JSON.parse(JSON.stringify(lanesFor() || {}));
  return slot().lanes;
}

// Only movements changed here need writing, as a patch's own are kept exactly otherwise.
function drawnMotions() {
  if (!slot().lanes) return null;
  return Object.entries(slot().lanes).flatMap(([cc, points]) =>
    points.map((point) => ({ time: point.time, cc: Number(cc), value: point.value })));
}

function fillLaneOptions() {
  const lanes = lanesFor() || {};
  const select = $("lane-cc");
  select.replaceChildren(...S1Params.ALL
    .filter((param) => param.type === "range" || param.type === "bipolar")
    .map((param) => new Option(`${lanes[param.cc]?.length ? "* " : ""}${param.name}`, String(param.cc))));
  select.value = String(state.laneCc);
  // Keeps the choice when redrawing, and otherwise suggests the next pattern.
  const target = $("lane-copy-target");
  const chosen = Number(target.value);
  const others = state.slots.map((_, index) => index).filter((index) => index !== state.current);
  target.replaceChildren(...others.map((index) => new Option(`Pattern ${index + 1}`, String(index))));
  target.value = String(target.value !== "" && others.includes(chosen) ? chosen : (state.current + 1) % SLOTS);
}

// Copies every knob's movements, replacing whatever the other pattern has.
function copyLanesToPattern() {
  const lanes = lanesFor() || {};
  if (!Object.values(lanes).some((points) => points.length)) {
    setStatus("This pattern has no knob movements to copy.", true);
    return;
  }
  const index = Number($("lane-copy-target").value);
  const target = state.slots[index];
  const { lanes: copied, cut } = Music.copyLanes(lanes, lengthPulses(target));
  remember();
  target.lanes = copied;
  renderChrome();
  saveSoon();
  const count = Object.keys(copied).length;
  const past = cut ? " Pattern " + (index + 1) + " is shorter, so movements past its end were left out." : "";
  setStatus(`Copied ${count} ${count === 1 ? "knob's" : "knobs'"} movements to pattern ${index + 1}, replacing any it had. Undo takes it back.${past}`);
}

function setLaneVisible(visible) {
  state.showLane = visible;
  $("lane").hidden = !visible;
  $("lane-toggle").setAttribute("aria-pressed", String(visible));
  renderGrid();
  saveSoon();
}

function renderLane() {
  if (!state.showLane) return;
  fillLaneOptions();
  const first = document.querySelector(".cell");
  const last = document.querySelector(".grid > :last-child");
  if (!first || !last) return;
  const left = first.getBoundingClientRect().left;
  const width = last.getBoundingClientRect().right - left;
  const canvas = $("lane-canvas");
  const laneLeft = $("lane").getBoundingClientRect().left + parseFloat(getComputedStyle($("lane")).paddingLeft);
  canvas.style.marginLeft = `${left - laneLeft}px`;
  canvas.style.width = `${width}px`;
  const scale = window.devicePixelRatio || 1;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  const style = getComputedStyle(document.documentElement);
  ctx.fillStyle = style.getPropertyValue("--cell");
  ctx.fillRect(0, 0, width, height);
  const span = state.windowSpan || 1;
  const xAt = (time) => ((time - state.windowStart) / span) * width;
  ctx.fillStyle = style.getPropertyValue("--line");
  for (let time = state.windowStart; time < state.windowStart + span; time += state.resolution) {
    ctx.fillRect(xAt(time), 0, 1, height);
  }
  ctx.fillStyle = style.getPropertyValue("--accent");
  const points = (lanesFor() || {})[state.laneCc] || [];
  for (const point of points) {
    if (point.time < state.windowStart || point.time >= state.windowStart + span) continue;
    const bar = (point.value / 127) * height;
    ctx.fillRect(xAt(point.time), height - bar, Math.max(1, xAt(point.time + MOTION_TICKS) - xAt(point.time)), bar);
  }
  // Where the knob sits outside the drawn movements.
  const resting = baseValue(state.laneCc);
  if (resting !== undefined) {
    ctx.fillStyle = style.getPropertyValue("--strong");
    ctx.fillRect(0, height - (resting / 127) * height, width, 1);
  }
}

function setLanePoint(points, time, value, erase) {
  const index = points.findIndex((point) => point.time === time);
  if (erase) {
    if (index >= 0) points.splice(index, 1);
  } else if (index >= 0) {
    points[index].value = value;
  } else {
    points.push({ time, value });
  }
}

function laneStroke(event) {
  const drag = state.laneDraw;
  const box = $("lane-canvas").getBoundingClientRect();
  const x = Math.max(0, Math.min(box.width - 1, event.clientX - box.left));
  const y = Math.max(0, Math.min(box.height, event.clientY - box.top));
  const end = Math.min(state.windowStart + state.windowSpan, lengthPulses());
  const raw = state.windowStart + (x / box.width) * state.windowSpan;
  const time = Math.min(end - MOTION_TICKS, Math.floor(raw / MOTION_TICKS) * MOTION_TICKS);
  const value = Math.round((1 - y / box.height) * 127);
  const points = slot().lanes[state.laneCc];
  // Fills the gap since the last event, as a fast drag skips over points.
  const from = drag.last ? drag.last.time : time;
  const startValue = drag.last ? drag.last.value : value;
  const direction = time >= from ? MOTION_TICKS : -MOTION_TICKS;
  const count = Math.abs(time - from) / MOTION_TICKS;
  for (let index = 0; index <= count; index += 1) {
    const share = count ? index / count : 1;
    setLanePoint(points, from + index * direction, Math.round(startValue + (value - startValue) * share), drag.erase);
  }
  drag.last = { time, value };
  renderLane();
}

function bindLane() {
  const canvas = $("lane-canvas");
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const lanes = lanesFor() || {};
    const used = Object.keys(lanes).filter((cc) => lanes[cc].length).length;
    if (!lanes[state.laneCc]?.length && used >= MAX_LANES) {
      setStatus(`The S-1 records ${MAX_LANES} knobs per pattern. Clear one first.`, true);
      return;
    }
    remember();
    editableLanes()[state.laneCc] ??= [];
    state.laneDraw = { erase: event.altKey, last: null };
    canvas.setPointerCapture(event.pointerId);
    laneStroke(event);
    renderChrome();
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (state.laneDraw) laneStroke(event);
  });
  const finish = () => {
    if (!state.laneDraw) return;
    state.laneDraw = null;
    const lanes = slot().lanes;
    lanes[state.laneCc].sort((a, b) => a.time - b.time);
    if (!lanes[state.laneCc].length) delete lanes[state.laneCc];
    renderLane();
    saveSoon();
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  $("lane-cc").addEventListener("change", (event) => {
    state.laneCc = Number(event.target.value);
    renderLane();
    saveSoon();
  });
  $("lane-clear").addEventListener("click", () => {
    if (!(lanesFor() || {})[state.laneCc]?.length) return;
    remember();
    delete editableLanes()[state.laneCc];
    const value = baseValue(state.laneCc);
    if (value !== undefined) sendController(state.laneCc, value);
    renderLane();
    renderChrome();
    saveSoon();
  });
  $("lane-toggle").addEventListener("click", () => setLaneVisible(!state.showLane));
  $("lane-copy").addEventListener("click", copyLanesToPattern);
}

function renderPeers(names) {
  const pill = $("sync-peers");
  pill.hidden = !$("sync").checked;
  pill.textContent = names.length ? `Linked: ${names.join(", ")}` : "Not linked";
  pill.className = `pill ${names.length ? "ok" : ""}`;
  pill.title = names.length ? "Play, stop and tempo are shared with this page." : "The other grid isn't open in this browser, or has Sync off.";
}

// Plays together with the other grid when both are open. See sync.js.
const link = Sync.connect({
  name: "S-1 Grid",
  checkbox: $("sync"),
  storageKey: "s1-grid-sync",
  start({ bpm, at }) {
    if (state.sendOnce) return false;
    if (state.playing) stop({ fromLink: true });
    state.bpm = bpm;
    $("bpm").value = bpm;
    play({ startAt: at, fromLink: true });
    return state.playing;
  },
  stop: () => stop({ fromLink: true }),
  tempo({ bpm, at, pulse }) {
    state.bpm = bpm;
    $("bpm").value = bpm;
    if (!state.playing || !Number.isFinite(pulse)) return;
    state.nextTime = Sync.aligned({
      nextTime: state.nextTime, nextPulse: state.nextPulse, at, pulse, msPerPulse: msPerPulse(), pulsesPerBeat: PPQ,
    });
  },
  status: (message, isError) => setStatus(message, isError),
  peers: renderPeers,
});
renderPeers([]);

const announceTempo = () => link.announceTempo({
  bpm: currentBpm(), nextTime: state.nextTime, nextPulse: state.playing ? state.nextPulse : 0,
});

function play({ startAt = null, fromLink = false } = {}) {
  if (!state.output) {
    setStatus("No MIDI output connected. Connect the S-1 and turn it on.", true);
    return;
  }
  state.playing = true;
  state.nextPulse = 0;
  const chain = state.sendOnce || state.preview ? [] : chainList();
  if (chain.length) {
    state.chainPos = 0;
    if (state.current !== chain[0]) switchTo(chain[0]);
  }
  const shared = fromLink || state.sendOnce || state.preview ? null : link.announcePlay(currentBpm());
  state.nextTime = startAt ?? shared ?? performance.now() + 60;
  if (sendingClock()) state.output.send([0xFA], state.nextTime);
  $("play").textContent = "Stop";
  $("playhead").hidden = Boolean(state.preview);
  schedule();
  requestAnimationFrame(drawPlayhead);
}

function allNotesOff(at) {
  sendController(CC_ALL_NOTES_OFF, 0, at);
}

function stop({ fromLink = false } = {}) {
  state.queued = null;
  if (!state.playing) {
    // A preview waits a moment for its sound to arrive before it starts playing.
    if (state.preview) endPreview();
    return;
  }
  if (!fromLink && !state.sendOnce && !state.preview) link.announceStop();
  if (sendingClock() && state.output) state.output.send([0xFC]);
  state.playing = false;
  state.sendOnce = false;
  // Notes already scheduled can still start, so this repeats just after them.
  allNotesOff(performance.now());
  allNotesOff(performance.now() + SCHEDULE_AHEAD_MS + 20);
  restoreAfterMotions();
  $("play").textContent = "Play";
  $("playhead").hidden = true;
  renderSlots();
  if (state.preview) endPreview();
}

// Hears a patch without touching the grid, and puts the sound back afterwards.
function previewPatch(item) {
  const same = state.preview && state.preview.name === item.name;
  stop();
  if (same) return;
  if (!state.output) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  state.preview = {
    name: item.name,
    notes: Prm.readNotes(item.text),
    bars: Prm.readBars(item.text),
    bpm: Prm.readBpm(item.text),
    lanes: Prm.readLanes(item.text),
    before: { ...state.values },
  };
  const finished = applySound(Prm.readValues(item.text));
  renderLibrary();
  setStatus(`Hearing "${item.name}". Your grid and sound come back when it stops.`);
  window.setTimeout(() => { if (state.preview && !state.playing) play(); }, Math.max(0, finished - performance.now()) + 40);
}

function endPreview() {
  const { before } = state.preview;
  state.preview = null;
  state.values = {};
  applySound(before);
  renderLibrary();
  setStatus("Back to your sound.");
}

function panic() {
  stop();
  if (!sendController(CC_ALL_SOUND_OFF, 0)) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  allNotesOff();
  setStatus("All notes off.");
}

// Plays the pattern once with MIDI start, clock and stop, for the S-1 to record.
function sendToS1() {
  stop();
  if (!notes().length) {
    setStatus("This pattern has no notes to send.", true);
    return;
  }
  state.sendOnce = true;
  play();
  if (state.playing) setStatus("Sending one pass to the S-1...");
  else state.sendOnce = false;
}

function finishSendOnce() {
  state.output.send([0xFC], state.nextTime);
  state.sendOnce = false;
  state.playing = false;
  $("play").textContent = "Play";
  $("playhead").hidden = true;
  setStatus("Sent one pass. If the S-1 was recording, play it back to check the result.");
}

// Where playback is at a given moment.
function pulseAt(time) {
  const length = lengthPulses();
  const behind = (state.nextTime - time) / msPerPulse();
  return ((state.nextPulse - behind) % length + length) % length;
}

function drawPlayhead() {
  if (!state.playing || state.preview) return;
  const pulse = pulseAt(performance.now());
  const playingPage = Math.floor(pulse / (state.pageBars * BAR));
  // Page turns redraw the grid, so they wait while a step is being edited.
  if (playingPage !== state.page && !state.editor && !state.lengthDrag && !state.paint) goToPage(playingPage);
  const firstCell = document.querySelector(".cell");
  const lastCell = document.querySelector(".grid > :last-child");
  if (firstCell && lastCell) {
    const origin = firstCell.offsetLeft;
    const width = lastCell.offsetLeft + lastCell.offsetWidth - origin;
    const head = $("playhead");
    head.style.left = `${origin + ((pulse - state.windowStart) / state.windowSpan) * width}px`;
    head.style.height = `${$("grid").offsetHeight}px`;
    head.hidden = playingPage !== state.page;
  }
  requestAnimationFrame(drawPlayhead);
}

function exportMidi() {
  if (!notes().length) {
    setStatus("This pattern has no notes to export.", true);
    return;
  }
  const bytes = Music.midiFile(notes(), { bpm: currentBpm(), channel: state.channel });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
  const key = `${Music.NOTE_NAMES[state.root].replace("#", "sharp")}-${state.scale}`;
  link.download = `s1-grid-pattern-${state.current + 1}-${key}.mid`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus(`Exported pattern ${state.current + 1}.`);
}

function downloadBackup() {
  const file = new Blob([JSON.stringify(Backup.pack(state))], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `s1-grid-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus("Saved all 16 patterns and the sound to a file.");
}

async function restoreBackup(file) {
  let data;
  try {
    data = Backup.unpack(JSON.parse(await file.text()), { scales: Music.SCALES, validatePatch: Prm.validate });
  } catch (error) {
    setStatus(`Couldn't restore ${file.name}: ${error.message}`, true);
    return;
  }
  if (state.slots.some((item) => item.notes.length)
    && !window.confirm(`Replace all 16 patterns with the ones in ${file.name}?`)) return;
  stop();
  closeNoteEditor({ restoreFocus: false });
  remember();
  const { values, ...rest } = data;
  Object.assign(state, rest);
  state.page = 0;
  library.loaded = state.sources[state.current] ? state.sources[state.current].name : null;
  resetVary();
  applySound(values);
  $("chain").value = state.chain;
  $("chain-on").checked = state.chainOn;
  renderAll();
  renderLibrary();
  saveSoon();
  setStatus(`Restored ${file.name}. Undo brings back the patterns you had.`);
}

const IMPORT_BARS = [1, 2, 4, 8];

// Replaces the current pattern, which Undo brings back. The sound doesn't change.
async function importMidi(file) {
  let parsed;
  try {
    parsed = Music.parseMidi(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    setStatus(`Couldn't read ${file.name}: ${error.message}`, true);
    return;
  }
  if (!parsed.notes.length) {
    setStatus(`${file.name} has no notes to import.`, true);
    return;
  }
  stop();
  closeNoteEditor({ restoreFocus: false });
  remember();
  const end = Math.max(...parsed.notes.map((n) => n.time + n.length));
  const bars = IMPORT_BARS.find((count) => end <= count * BAR) ?? IMPORT_BARS.at(-1);
  const limit = bars * BAR;
  const kept = parsed.notes
    .filter((n) => n.time < limit)
    .map((n) => ({ ...n, length: Math.min(n.length, limit - n.time) }));
  slot().bars = bars;
  slot().notes = kept;
  delete slot().lanes;
  // It's a new pattern, so a patch loaded here earlier no longer applies.
  state.sources[state.current] = null;
  library.loaded = null;
  if (parsed.bpm) state.bpm = Math.max(20, Math.min(300, Math.round(parsed.bpm * 10) / 10));
  const key = Music.detectKey(kept);
  if (key) Object.assign(state, key);
  const lowest = Math.min(...kept.map((n) => n.note));
  state.lowOctave = Math.max(1, Math.min(6, Math.floor(lowest / 12) - 1));
  state.page = 0;
  renderAll();
  renderLibrary();
  saveSoon();
  const cut = end > limit ? ` It's longer than ${bars} bars, so the rest was cut.` : "";
  const count = `${kept.length} ${kept.length === 1 ? "note" : "notes"}`;
  setStatus(`Imported ${count} from ${file.name} into pattern ${state.current + 1}. Undo brings the old one back.${cut}`);
}

/* ---------- Saving onto the S-1 ---------- */

const S1_DRIVE_FILES = 64;
const SAFETY_COPIES_KEPT = 3;
const GRID_SOURCE = "grid";
const saveState = {
  backup: null, restore: null, files: new Map(), counts: [], names: [], rows: [], active: 0, assignments: new Map(), preset: GRID_SOURCE, batch: [],
};

function showSaveStep(step) {
  $("save-connect").hidden = step !== "connect";
  $("save-pick").hidden = step !== "pick";
  $("save-done").hidden = step !== "done";
}

function showSaveError(message) {
  $("save-error").textContent = message;
  $("save-error").hidden = !message;
}

function openSaveDialog(preset = GRID_SOURCE, batch = []) {
  stop();
  closeNoteEditor({ restoreFocus: false });
  showSaveError("");
  if (!window.showDirectoryPicker) {
    setStatus("Saving to the S-1 needs Chrome or Edge on a computer.", true);
    return;
  }
  if (preset === GRID_SOURCE && !notes().length && !library.items.length) {
    setStatus("This pattern has no notes to save.", true);
    return;
  }
  saveState.preset = preset;
  saveState.batch = batch;
  showSaveStep("connect");
  $("save-dialog").showModal();
}

async function chooseS1Drive() {
  showSaveError("");
  let folder;
  try {
    folder = await window.showDirectoryPicker({ id: "s1-drive", mode: "readwrite" });
  } catch (error) {
    if (error.name !== "AbortError") showSaveError(`Couldn't open that folder: ${error.message}`);
    return;
  }
  await useS1Drive(folder);
}

// Reads the S-1's current saved patterns, which become the starting point.
async function useS1Drive(folder) {
  try {
    const backup = await folder.getDirectoryHandle("BACKUP");
    const restore = await folder.getDirectoryHandle("RESTORE");
    const files = new Map();
    for (let slot = 0; slot < S1_DRIVE_FILES; slot += 1) {
      const name = Prm.fileName(slot);
      const file = await (await backup.getFileHandle(name)).getFile();
      files.set(name, new Uint8Array(await file.arrayBuffer()));
    }
    Object.assign(saveState, { backup, restore, files });
    await keepFollowSounds(slotTexts((slot) => files.get(Prm.fileName(slot))), "the S-1 drive");
  } catch (error) {
    if (error.name === "NotFoundError") {
      showSaveError("That doesn't look like the S-1 drive. It should contain BACKUP and RESTORE folders, with all 64 pattern files.");
    } else {
      showSaveError(`Couldn't read the S-1 drive: ${error.message}`);
    }
    return;
  }
  const decode = new TextDecoder("ascii");
  saveState.counts = [];
  saveState.names = [];
  const byContents = new Map(library.items.map((item) => [item.text, item.name]));
  for (let slot = 0; slot < S1_DRIVE_FILES; slot += 1) {
    const text = decode.decode(saveState.files.get(Prm.fileName(slot)));
    const count = Prm.noteCount(text);
    saveState.counts.push(count);
    // The S-1 doesn't store names, so a slot only has one if a library patch matches exactly.
    saveState.names.push(count ? byContents.get(text) || null : null);
  }
  const chosen = saveState.batch.length ? saveState.batch : [saveState.preset];
  const usable = (source) => (source === GRID_SOURCE ? notes().length > 0 : library.items.some((item) => item.name === source));
  saveState.rows = chosen.filter(usable).map((source) => ({ source, slot: null }));
  saveState.active = 0;
  fillEmptySlots();
  renderSaveSources();
  showSaveStep("pick");
  renderSaveSlots();
}

function gridSourceLabel() {
  return `Current grid (pattern ${state.current + 1})`;
}

function sourceLabel(source) {
  return source === GRID_SOURCE ? gridSourceLabel() : source;
}

function renderSaveSources() {
  const options = [];
  if (notes().length) options.push(new Option(gridSourceLabel(), GRID_SOURCE));
  for (const item of library.items) options.push(new Option(item.name, item.name));
  $("save-source").replaceChildren(...options);
}

function slotDescription(slotIndex) {
  const holds = saveState.names[slotIndex];
  if (holds) return `holds ${holds}`;
  return saveState.counts[slotIndex] ? "has notes" : "empty";
}

/* Gives a row a slot. A slot holds one patch, so a row already in that slot loses
   it. It's left without a slot to choose again, as nothing should be dropped quietly. */
function placeRow(index, slotIndex) {
  if (slotIndex !== null) {
    saveState.rows.forEach((row, other) => {
      if (other !== index && row.slot === slotIndex) row.slot = null;
    });
  }
  saveState.rows[index].slot = slotIndex;
}

// Gives each row without a slot the next free slot, keeping away from existing notes.
function fillEmptySlots() {
  const taken = new Set(saveState.rows.map((row) => row.slot));
  let next = 0;
  for (const row of saveState.rows) {
    if (row.slot !== null) continue;
    while (next < S1_DRIVE_FILES && (saveState.counts[next] > 0 || taken.has(next))) next += 1;
    if (next >= S1_DRIVE_FILES) break;
    row.slot = next;
    taken.add(next);
  }
}

// After placing a patch, moves on to the next one still needing a slot.
function selectNextUnplaced() {
  const next = saveState.rows.findIndex((row) => row.slot === null);
  if (next >= 0) saveState.active = next;
}

function renderSaveRows() {
  $("save-rows").replaceChildren(...saveState.rows.map((row, index) => {
    const item = document.createElement("li");
    item.className = "save-row";
    item.classList.toggle("active", index === saveState.active);
    item.addEventListener("click", () => {
      saveState.active = index;
      renderSaveSlots();
    });
    const name = document.createElement("span");
    name.className = "save-row-name";
    name.textContent = sourceLabel(row.source);
    name.title = sourceLabel(row.source);
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Slot for ${sourceLabel(row.source)}`);
    select.append(new Option("Choose a slot", ""));
    for (let slotIndex = 0; slotIndex < S1_DRIVE_FILES; slotIndex += 1) {
      select.append(new Option(`${Prm.slotLabel(slotIndex)}: ${slotDescription(slotIndex)}`, String(slotIndex)));
    }
    select.value = row.slot === null ? "" : String(row.slot);
    select.classList.toggle("unplaced", row.slot === null);
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", () => {
      saveState.active = index;
      placeRow(index, select.value === "" ? null : Number(select.value));
      renderSaveSlots();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "\u00d7";
    remove.title = "Remove from the list";
    remove.setAttribute("aria-label", `Remove ${sourceLabel(row.source)} from the list`);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      saveState.rows.splice(index, 1);
      saveState.active = Math.max(0, Math.min(saveState.active, saveState.rows.length - 1));
      renderSaveSlots();
    });
    item.append(name);
    if (row.slot !== null && saveState.counts[row.slot] > 0) {
      const replaces = document.createElement("span");
      replaces.className = "save-row-replace";
      replaces.textContent = "replaces notes";
      item.append(replaces);
    }
    item.append(select, remove);
    return item;
  }));
}

function renderSaveSlots() {
  // Saving works from slots, so this is rebuilt from the list each time.
  saveState.assignments = new Map();
  for (const row of saveState.rows) {
    if (row.slot !== null) saveState.assignments.set(row.slot, row.source);
  }
  const activeRow = saveState.rows[saveState.active];
  const nodes = [];
  for (let slotIndex = 0; slotIndex < S1_DRIVE_FILES; slotIndex += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = Prm.slotLabel(slotIndex);
    const assigned = saveState.assignments.get(slotIndex);
    button.classList.toggle("has-notes", saveState.counts[slotIndex] > 0);
    button.classList.toggle("assigned", assigned !== undefined);
    button.classList.toggle("for-active", Boolean(activeRow) && activeRow.slot === slotIndex);
    button.setAttribute("aria-pressed", String(assigned !== undefined));
    const planned = assigned !== undefined ? `, will get ${sourceLabel(assigned)}` : "";
    button.title = `${Prm.slotLabel(slotIndex)}: ${slotDescription(slotIndex)}${planned}`;
    button.setAttribute("aria-label", `Pattern ${button.title}`);
    button.addEventListener("click", () => {
      if (!saveState.rows[saveState.active]) {
        showSaveError("Add a patch to the list first.");
        return;
      }
      const current = saveState.rows[saveState.active].slot === slotIndex;
      placeRow(saveState.active, current ? null : slotIndex);
      if (!current) selectNextUnplaced();
      renderSaveSlots();
    });
    nodes.push(button);
  }
  $("save-slots").replaceChildren(...nodes);
  renderSaveRows();
  renderSavePreview();
}

// Returns a slot's new file, and anything that couldn't transfer exactly.
function buildAssignment(slotIndex, source) {
  if (source !== GRID_SOURCE) {
    const item = library.items.find((entry) => entry.name === source);
    if (!item) throw new Error(`"${source}" is no longer in the library.`);
    const problems = Prm.validate(item.text);
    if (problems.length) throw new Error(`"${source}" isn't a valid pattern file.`);
    return { text: item.text, warnings: [], label: source };
  }
  const existing = state.sources[state.current];
  const template = existing
    ? existing.text
    : new TextDecoder("ascii").decode(saveState.files.get(Prm.fileName(slotIndex)));
  const result = Prm.render(template, {
    notes: notes(), bars: slot().bars, bpm: currentBpm(), values: state.values, keepMotions: Boolean(existing), motions: drawnMotions(), delay: state.delay,
  });
  return { ...result, label: gridSourceLabel() };
}

function renderSavePreview() {
  const write = $("save-write");
  showSaveError("");
  const count = saveState.assignments.size;
  const warnings = [];
  let failed = false;
  const ordered = [...saveState.assignments.entries()].sort((a, b) => a[0] - b[0]);
  for (const [slotIndex, source] of ordered) {
    const label = Prm.slotLabel(slotIndex);
    try {
      buildAssignment(slotIndex, source).warnings.forEach((text) => warnings.push(`${label}: ${text}`));
    } catch (error) {
      failed = true;
      showSaveError(`Pattern ${label} can't be saved: ${error.message} No changes were made.`);
    }
  }
  const waiting = saveState.rows.filter((row) => row.slot === null).length;
  if (waiting) warnings.unshift(`${waiting} patch(es) in the list have no slot yet, so they won't be saved.`);
  const item = (text) => {
    const node = document.createElement("li");
    node.textContent = text;
    return node;
  };
  $("save-warnings").replaceChildren(...warnings.map(item));
  write.disabled = !count || failed;
  write.textContent = count === 1 ? "Save 1 pattern" : `Save ${count} patterns`;
}

// Keeps the S-1's files in this browser before anything is written.
async function keepSafetyCopy() {
  const root = await navigator.storage.getDirectory();
  const copies = await root.getDirectoryHandle("s1-backups", { create: true });
  const copy = await copies.getDirectoryHandle(String(Date.now()), { create: true });
  for (const [name, bytes] of saveState.files) await writeBytes(copy, name, bytes);
  const names = [];
  for await (const name of copies.keys()) names.push(name);
  names.sort((a, b) => Number(b) - Number(a));
  for (const old of names.slice(SAFETY_COPIES_KEPT)) await copies.removeEntry(old, { recursive: true });
}

async function writeBytes(folder, name, bytes) {
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  const written = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  if (written.length !== bytes.length || !written.every((value, i) => value === bytes[i])) {
    throw new Error(`${name} didn't read back correctly.`);
  }
}

async function writeToS1() {
  const write = $("save-write");
  write.disabled = true;
  write.textContent = "Saving...";
  showSaveError("");
  try {
    const encoder = new TextEncoder();
    const replaced = new Map();
    for (const [slotIndex, source] of saveState.assignments) {
      replaced.set(Prm.fileName(slotIndex), encoder.encode(buildAssignment(slotIndex, source).text));
    }
    await keepSafetyCopy();
    for (const [name, bytes] of saveState.files) {
      await writeBytes(saveState.restore, name, replaced.get(name) || bytes);
    }
    // macOS adds hidden ._ files beside new files on this kind of drive.
    for await (const name of saveState.restore.keys()) {
      if (name.startsWith("._")) await saveState.restore.removeEntry(name);
    }
    // What the S-1 will hold once it restores, for Follow S-1.
    await keepFollowSounds(slotTexts((slot) => {
      const name = Prm.fileName(slot);
      return replaced.get(name) || saveState.files.get(name);
    }), "the last Save to S-1");
    const labels = [...saveState.assignments.keys()].sort((a, b) => a - b).map(Prm.slotLabel).join(", ");
    $("save-done-title").textContent = `Ready for ${labels}. Finish on the S-1:`;
    showSaveStep("done");
    library.selected.clear();
    renderLibrary();
    setStatus(`Pattern ${labels} ready on the S-1 drive. Eject it, then press HOLD on the S-1.`);
  } catch (error) {
    renderSavePreview();
    showSaveError(`Saving failed: ${error.message} Nothing changes on the S-1 until you press HOLD, so don't press it. Empty the RESTORE folder on the drive before trying again.`);
  }
}

/* ---------- Patch library ---------- */

const LIBRARY_DB = "s1-grid";
const LIBRARY_KEY = "library-folder";
const PATCH_EXTENSION = ".PRM";
const LIBRARY_INFO = "library-info.json";

const library = {
  info: {},
  favouritesOnly: false,
  folder: null, status: "none", items: [], search: "", loaded: null, selected: new Set(),
};

function openHandleStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeHandle(action, mode) {
  const db = await openHandleStore();
  return new Promise((resolve, reject) => {
    const request = action(db.transaction("kv", mode).objectStore("kv"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function setLibraryState(text) {
  $("library-state").textContent = text;
}

// Reconnects to the folder chosen last time. Chrome may ask to allow it again.
async function restoreLibrary() {
  try {
    library.folder = (await storeHandle((store) => store.get(LIBRARY_KEY), "readonly")) || null;
  } catch (error) {
    library.folder = null;
  }
  if (!library.folder) {
    library.status = "none";
    renderLibrary();
    return;
  }
  const permission = await library.folder.queryPermission({ mode: "readwrite" });
  if (permission === "granted") await readLibrary();
  else {
    library.status = "permission";
    renderLibrary();
  }
}

async function chooseLibraryFolder() {
  try {
    if (library.status === "permission") {
      const answer = await library.folder.requestPermission({ mode: "readwrite" });
      if (answer !== "granted") return;
    } else {
      library.folder = await window.showDirectoryPicker({ id: "s1-library", mode: "readwrite" });
      await storeHandle((store) => store.put(library.folder, LIBRARY_KEY), "readwrite");
    }
    await readLibrary();
  } catch (error) {
    if (error.name !== "AbortError") setStatus(`Couldn't open that folder: ${error.message}`, true);
  }
}

const naturalOrder = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

async function readPatchFolder(folder) {
  const items = [];
  let skipped = 0;
  for await (const [fileName, handle] of folder.entries()) {
    if (handle.kind !== "file" || fileName.startsWith(".")) continue;
    if (!fileName.toUpperCase().endsWith(PATCH_EXTENSION)) continue;
    const text = await (await handle.getFile()).text();
    if (Prm.validate(text).length) {
      skipped += 1;
    } else {
      items.push({ name: fileName.slice(0, -PATCH_EXTENSION.length), text, info: Prm.describe(text), bpm: Prm.readBpm(text) });
    }
  }
  return { items: items.sort(naturalOrder), skipped };
}

// Favourites and tags, kept beside the patches so they stay with the folder.
async function readLibraryInfo() {
  try {
    const file = await (await library.folder.getFileHandle(LIBRARY_INFO)).getFile();
    const info = JSON.parse(await file.text());
    return info && typeof info === "object" ? info : {};
  } catch {
    return {};
  }
}

async function changeLibraryInfo(name, change) {
  const entry = { favourite: false, tags: "", ...library.info[name] };
  change(entry);
  if (entry.favourite || entry.tags) library.info[name] = entry;
  else delete library.info[name];
  try {
    await writeBytes(library.folder, LIBRARY_INFO, new TextEncoder().encode(JSON.stringify(library.info, null, 2)));
  } catch (error) {
    setStatus(`Couldn't save that to the library folder: ${error.message}`, true);
  }
  renderLibrary();
}

function editTags(item) {
  const answer = window.prompt("Tags for this patch, separated by commas:", library.info[item.name]?.tags || "");
  if (answer !== null) changeLibraryInfo(item.name, (entry) => { entry.tags = answer.trim().slice(0, 200); });
}

async function readLibrary() {
  try {
    const { items, skipped } = await readPatchFolder(library.folder);
    library.items = items;
    library.info = await readLibraryInfo();
    library.status = "ready";
    library.skipped = skipped;
  } catch (error) {
    library.status = "missing";
    library.items = [];
  }
  renderLibrary();
}

function renderLibrary() {
  const button = $("library-folder");
  const views = {
    none: ["Choose library folder", "Choose or create a folder on this computer to keep patches in."],
    permission: ["Allow library folder", `Allow access to "${library.folder && library.folder.name}" to use your library.`],
    missing: ["Choose library folder", `Couldn't read "${library.folder && library.folder.name}". Choose it again.`],
    ready: ["Change folder", ""],
  };
  const [label, message] = views[library.status];
  button.textContent = label;
  const ready = library.status === "ready";
  $("library-import").disabled = !ready;
  $("library-from-s1").disabled = !ready;
  $("library-search").disabled = !ready;
  if (ready) {
    const skipped = library.skipped ? ` ${library.skipped} file(s) couldn't be read.` : "";
    const hint = library.items.length ? "" : " Use Import from S-1 to add your S-1's patches.";
    setLibraryState(`"${library.folder.name}": ${library.items.length} patch(es).${skipped}${hint}`);
  } else {
    setLibraryState(message);
  }
  $("library-list").replaceChildren(...visiblePatches().map(libraryRow));
  renderLibraryBatch();
}

function selectedPatches() {
  return library.items.filter((item) => library.selected.has(item.name)).map((item) => item.name);
}

function renderLibraryBatch() {
  const count = selectedPatches().length;
  const send = $("library-send");
  send.disabled = !count;
  send.textContent = count ? `Send ${count} to S-1` : "Send to S-1";
  $("library-select-all").disabled = !library.items.length;
  $("library-select-none").disabled = !count;
}

// Select all follows the search, so a filtered list can be sent together.
function visiblePatches() {
  const term = library.search.trim().toLowerCase();
  return library.items.filter((item) => {
    const info = library.info[item.name];
    if (library.favouritesOnly && !info?.favourite) return false;
    return item.name.toLowerCase().includes(term) || (info?.tags || "").toLowerCase().includes(term);
  });
}

function libraryRow(item) {
  const row = document.createElement("li");
  row.className = "library-item";
  row.classList.toggle("loaded", item.name === library.loaded);
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "library-check";
  check.checked = library.selected.has(item.name);
  check.setAttribute("aria-label", `Select ${item.name}`);
  check.addEventListener("change", () => {
    if (check.checked) library.selected.add(item.name);
    else library.selected.delete(item.name);
    renderLibraryBatch();
  });
  const load = document.createElement("button");
  load.type = "button";
  load.className = "library-load";
  load.title = "Load into the grid and send its sound to the S-1";
  const name = document.createElement("b");
  name.textContent = item.name;
  const detail = document.createElement("small");
  const motions = item.info.motions ? ", motions" : "";
  const info = library.info[item.name];
  const tags = info?.tags ? `. ${info.tags}` : "";
  detail.textContent = `${item.info.notes} steps with notes, ${item.bpm} BPM${motions}${tags}`;
  load.append(name, detail);
  load.addEventListener("click", () => loadPatch(item));
  const action = (text, title, handler) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.title = title;
    button.setAttribute("aria-label", `${title}: ${item.name}`);
    button.addEventListener("click", handler);
    return button;
  };
  const hearing = state.preview?.name === item.name;
  const star = action(info?.favourite ? "★" : "☆", "Favourite", () => {
    changeLibraryInfo(item.name, (entry) => { entry.favourite = !entry.favourite; });
  });
  star.setAttribute("aria-pressed", String(Boolean(info?.favourite)));
  row.append(
    check,
    load,
    star,
    action(hearing ? "Stop" : "Hear", "Hear it without changing the grid", () => previewPatch(item)),
    action("Play", "Load and play", () => loadPatch(item, { play: true })),
    action("To S-1", "Save to the S-1", () => openSaveDialog(item.name)),
    action("Name", "Rename", () => renamePatch(item)),
    action("Tags", "Edit tags", () => editTags(item)),
    action("Del", "Delete from the library", () => deletePatch(item)),
  );
  return row;
}

function cleanPatchName(raw) {
  const name = String(raw ?? "").trim().replace(/\.prm$/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.()#+-]{0,59}$/.test(name)) {
    throw new Error("Patch names can use letters, numbers, spaces, and _ . ( ) # + -");
  }
  return name;
}

async function fileExists(folder, name) {
  try {
    await folder.getFileHandle(name);
    return true;
  } catch (error) {
    if (error.name === "NotFoundError") return false;
    throw error;
  }
}

// Saving needs the library folder, so this connects it first if it can.
async function ensureLibraryReady() {
  if (library.status === "ready") return true;
  state.tab = "library";
  renderTabs();
  renderParams();
  if (library.status !== "permission") {
    setStatus("Choose a library folder first, then click Save to library again.", true);
    return false;
  }
  await chooseLibraryFolder();
  renderLibrary();
  return library.status === "ready";
}

async function addPatchToLibrary() {
  try {
    if (!(await ensureLibraryReady())) return;
    if (!$("library-name").value.trim()) {
      $("library-name").focus();
      throw new Error("Type a name for this patch first.");
    }
    const name = cleanPatchName($("library-name").value);
    const source = state.sources[state.current];
    const blank = library.items.find((item) => !item.info.notes && !item.info.motions) || library.items[0];
    const template = source ? source.text : blank && blank.text;
    if (!template) throw new Error("Use Import backup first, as new patches start from one of your S-1's files.");
    const file = `${name}${PATCH_EXTENSION}`;
    if (await fileExists(library.folder, file)
        && !window.confirm(`Replace "${name}" in the library?`)) return;
    const { text, warnings } = Prm.render(template, {
      notes: notes(), bars: slot().bars, bpm: currentBpm(), values: state.values, keepMotions: Boolean(source), motions: drawnMotions(), delay: state.delay,
    });
    await writeBytes(library.folder, file, new TextEncoder().encode(text));
    state.sources[state.current] = { name, text };
    library.loaded = name;
    await readLibrary();
    saveSoon();
    renderPatchName();
    const contents = notes().length ? "pattern and sound" : "sound, with no notes,";
    setStatus(`Saved the ${contents} as "${name}" in the library.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function renamePatch(item) {
  const answer = window.prompt("New name for this patch:", item.name);
  if (answer === null) return;
  try {
    const name = cleanPatchName(answer);
    if (name === item.name) return;
    const file = `${name}${PATCH_EXTENSION}`;
    if (await fileExists(library.folder, file)) throw new Error(`"${name}" already exists.`);
    await writeBytes(library.folder, file, new TextEncoder().encode(item.text));
    await library.folder.removeEntry(`${item.name}${PATCH_EXTENSION}`);
    if (library.loaded === item.name) library.loaded = name;
    if (library.selected.delete(item.name)) library.selected.add(name);
    if (library.info[item.name]) {
      const kept = library.info[item.name];
      delete library.info[item.name];
      await changeLibraryInfo(name, (entry) => Object.assign(entry, kept));
    }
    const current = state.sources[state.current];
    if (current && current.name === item.name) {
      current.name = name;
      renderPatchName();
      saveSoon();
    }
    await readLibrary();
    setStatus(`Renamed to "${name}".`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function deletePatch(item) {
  if (!window.confirm(`Delete "${item.name}" from the library? This removes the file from your computer.`)) return;
  try {
    await library.folder.removeEntry(`${item.name}${PATCH_EXTENSION}`);
    if (library.loaded === item.name) library.loaded = null;
    library.selected.delete(item.name);
    if (library.info[item.name]) await changeLibraryInfo(item.name, (entry) => Object.assign(entry, { favourite: false, tags: "" }));
    await readLibrary();
    setStatus(`Deleted "${item.name}".`);
  } catch (error) {
    setStatus(`Couldn't delete it: ${error.message}`, true);
  }
}

/* Copies an S-1 BACKUP folder's patterns into the library, without replacing anything.
   Patterns with no notes are all alike, so one is kept as a blank starting point. */
async function importBackup() {
  let folder;
  try {
    folder = await window.showDirectoryPicker({ id: "s1-import", mode: "read" });
  } catch (error) {
    if (error.name !== "AbortError") setStatus(`Couldn't open that folder: ${error.message}`, true);
    return;
  }
  await importFromFolder(folder);
}

async function importFromFolder(folder) {
  try {
    let source = folder;
    try {
      source = await folder.getDirectoryHandle("BACKUP");
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
    let added = 0;
    let existing = 0;
    let blankDone = library.items.some((item) => item.name === "Blank patch");
    const { items } = await readPatchFolder(source);
    const encoder = new TextEncoder();
    for (const item of items) {
      const match = /^S1_PTN(\d)-(\d\d)$/i.exec(item.name);
      const empty = !item.info.notes && !item.info.motions;
      if (empty && blankDone) continue;
      const name = empty ? "Blank patch" : `S-1 ${match ? `${match[1]}-${match[2]}` : item.name}`;
      if (empty) blankDone = true;
      const file = `${name}${PATCH_EXTENSION}`;
      if (await fileExists(library.folder, file)) {
        existing += 1;
      } else {
        await writeBytes(library.folder, file, encoder.encode(item.text));
        added += 1;
      }
    }
    if (!items.length) {
      setStatus("No S-1 pattern files were found in that folder.", true);
      return;
    }
    await readLibrary();
    const kept = existing ? ` ${existing} already in the library were left as they were.` : "";
    setStatus(`Imported ${added} patch(es).${kept}`);
  } catch (error) {
    setStatus(`Import failed: ${error.message}`, true);
  }
}

/* ---------- Importing chosen patches from the S-1 ---------- */

// Slots read from the drive, and the name each chosen slot will be saved under.
const importState = { slots: [], names: new Map() };

function showImportSection(id) {
  for (const section of ["import-connect", "import-pick", "import-done"]) {
    $(section).hidden = section !== id;
  }
  showImportError("");
}

function showImportError(message) {
  $("import-error").textContent = message;
  $("import-error").hidden = !message;
}

function openImportDialog() {
  closeNoteEditor({ restoreFocus: false });
  Object.assign(importState, { slots: [], names: new Map() });
  showImportSection("import-connect");
  $("import-dialog").showModal();
}

async function chooseImportDrive() {
  showImportError("");
  let folder;
  try {
    folder = await window.showDirectoryPicker({ id: "s1-import", mode: "read" });
  } catch (error) {
    if (error.name !== "AbortError") showImportError(`Couldn't open that folder: ${error.message}`);
    return;
  }
  await readImportSlots(folder);
}

// Works with the S-1 drive, or a BACKUP folder saved earlier.
async function readImportSlots(folder) {
  try {
    let source = folder;
    try {
      source = await folder.getDirectoryHandle("BACKUP");
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
    const byContents = new Map(library.items.map((item) => [item.text, item.name]));
    const decode = new TextDecoder("ascii");
    const slots = [];
    for (let slotIndex = 0; slotIndex < S1_DRIVE_FILES; slotIndex += 1) {
      let entry = null;
      try {
        const file = await (await source.getFileHandle(Prm.fileName(slotIndex))).getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const text = decode.decode(bytes);
        if (!Prm.validate(text).length) {
          entry = { bytes, info: Prm.describe(text), bpm: Prm.readBpm(text), match: byContents.get(text) || null };
        }
      } catch (error) {
        if (error.name !== "NotFoundError") throw error;
      }
      slots.push(entry);
    }
    if (!slots.some(Boolean)) {
      showImportError("That doesn't look like the S-1 drive. It should contain a BACKUP folder with the S-1's pattern files.");
      return;
    }
    await keepFollowSounds(slotTexts((slot) => slots[slot] && slots[slot].bytes), `the folder "${folder.name}"`);
    importState.slots = slots;
    importState.names = new Map();
    showImportSection("import-pick");
    renderImportPicker();
  } catch (error) {
    showImportError(`Couldn't read the S-1 drive: ${error.message}`);
  }
}

function describeImportSlot(slotIndex) {
  const entry = importState.slots[slotIndex];
  if (!entry) return "couldn't be read";
  const contents = entry.info.notes ? `${entry.info.notes} steps with notes, ${entry.bpm} BPM` : "no notes";
  return entry.match ? `${contents}, same as "${entry.match}" in the library` : contents;
}

function toggleImportSlot(slotIndex) {
  if (importState.names.has(slotIndex)) {
    importState.names.delete(slotIndex);
  } else {
    const taken = [...library.items.map((item) => item.name), ...importState.names.values()];
    importState.names.set(slotIndex, Prm.uniqueName(`S-1 ${Prm.slotLabel(slotIndex)}`, taken));
  }
  renderImportPicker();
}

function renderImportPicker() {
  $("import-slots").replaceChildren(...importState.slots.map((entry, slotIndex) => {
    const button = document.createElement("button");
    const chosen = importState.names.has(slotIndex);
    button.type = "button";
    button.textContent = Prm.slotLabel(slotIndex);
    button.disabled = !entry;
    button.classList.toggle("has-notes", Boolean(entry) && entry.info.notes > 0);
    button.classList.toggle("assigned", chosen);
    button.setAttribute("aria-pressed", String(chosen));
    button.title = `${Prm.slotLabel(slotIndex)}: ${describeImportSlot(slotIndex)}`;
    button.setAttribute("aria-label", `Pattern ${button.title}`);
    button.addEventListener("click", () => toggleImportSlot(slotIndex));
    return button;
  }));
  const chosen = [...importState.names.keys()].sort((a, b) => a - b);
  $("import-rows").replaceChildren(...chosen.map(importRow));
  $("import-none").hidden = chosen.length > 0;
  checkImportNames();
}

function importRow(slotIndex) {
  const row = document.createElement("li");
  row.className = "save-row import-row";
  row.dataset.slot = String(slotIndex);
  const label = document.createElement("span");
  label.className = "import-row-slot";
  label.textContent = Prm.slotLabel(slotIndex);
  label.title = describeImportSlot(slotIndex);
  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 60;
  name.spellcheck = false;
  name.value = importState.names.get(slotIndex);
  name.setAttribute("aria-label", `Name for pattern ${Prm.slotLabel(slotIndex)}`);
  name.addEventListener("input", () => {
    importState.names.set(slotIndex, name.value);
    checkImportNames();
  });
  const note = document.createElement("span");
  note.className = "save-row-replace";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Remove ${Prm.slotLabel(slotIndex)}`);
  remove.addEventListener("click", () => toggleImportSlot(slotIndex));
  row.append(label, name, note, remove);
  return row;
}

// Why a name can't be used, if it can't. Nothing in the library is ever replaced.
function importNameProblem(slotIndex) {
  const raw = importState.names.get(slotIndex);
  let name;
  try {
    name = cleanPatchName(raw);
  } catch {
    return raw.trim() ? "Letters, numbers, spaces and _ . ( ) # + - only" : "Needs a name";
  }
  const lower = name.toLowerCase();
  if (library.items.some((item) => item.name.toLowerCase() === lower)) return "Already in the library";
  const repeated = [...importState.names].some(([other, value]) => other !== slotIndex
    && value.trim().replace(/\.prm$/i, "").toLowerCase() === lower);
  return repeated ? "Used twice" : "";
}

function checkImportNames() {
  let problems = 0;
  for (const row of $("import-rows").children) {
    const slotIndex = Number(row.dataset.slot);
    const problem = importNameProblem(slotIndex);
    if (problem) problems += 1;
    const { match } = importState.slots[slotIndex];
    const note = row.querySelector(".save-row-replace");
    note.textContent = problem || (match ? `Same as "${match}"` : "");
    note.title = note.textContent;
  }
  const count = importState.names.size;
  $("import-write").disabled = !count || problems > 0;
  $("import-write").textContent = count ? `Import ${count} ${count === 1 ? "patch" : "patches"}` : "Import";
}

function selectNewImportSlots() {
  importState.slots.forEach((entry, slotIndex) => {
    if (entry && entry.info.notes && !entry.match && !importState.names.has(slotIndex)) {
      toggleImportSlot(slotIndex);
    }
  });
}

async function writeImportedPatches() {
  const chosen = [...importState.names.keys()].sort((a, b) => a - b);
  let written = 0;
  try {
    const files = chosen.map((slotIndex) => [slotIndex, `${cleanPatchName(importState.names.get(slotIndex))}${PATCH_EXTENSION}`]);
    for (const [, file] of files) {
      if (await fileExists(library.folder, file)) throw new Error(`"${file}" is already in the library.`);
    }
    for (const [slotIndex, file] of files) {
      await writeBytes(library.folder, file, importState.slots[slotIndex].bytes);
      written += 1;
    }
  } catch (error) {
    await readLibrary();
    renderLibrary();
    showImportError(`Imported ${written} of ${chosen.length}, then stopped: ${error.message}`);
    return;
  }
  await readLibrary();
  renderLibrary();
  $("import-done-title").textContent = `Imported ${written} ${written === 1 ? "patch" : "patches"} into your library.`;
  showImportSection("import-done");
  setStatus(`Imported ${written} ${written === 1 ? "patch" : "patches"} from the S-1.`);
}

/* ---------- Loading a patch ---------- */

function renderPatchName() {
  const source = state.sources[state.current];
  $("patch-name").hidden = !source;
  if (source) $("patch-name").textContent = `Patch: ${source.name}`;
  $("revert-sound").disabled = !source;
}

// Every setting back to what the pattern's patch has saved. The sound before it stays a click away.
function revertSound() {
  const source = state.sources[state.current];
  if (!source) {
    setStatus("This pattern has no saved sound yet. Load a patch, or save it to the library first.", true);
    return;
  }
  if (state.preview) stop();
  state.varyOriginal = { ...state.values };
  state.values = {};
  state.delay = Prm.readDelay(source.text);
  applySound(Prm.readValues(source.text));
  state.varyLatest = { ...state.values };
  renderVary(false);
  renderLane();
  saveSoon();
  const sent = state.output ? "Hear original brings back the sound you had." : "No MIDI output, so it wasn't sent to the S-1.";
  setStatus(`Back to the sound saved in "${source.name}". ${sent}`, !state.output);
}

const THEME_KEY = "s1-grid-theme";

function setTheme(theme) {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  $("theme-toggle").textContent = theme === "light" ? "Dark mode" : "Light mode";
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private windows can refuse storage, so the theme just isn't remembered.
  }
  renderLane();
}

// Sends a sound to the S-1 and shows it on the page. A short gap keeps a burst of
// messages from overrunning the S-1.
function applySound(values) {
  let at = performance.now();
  for (const [cc, value] of Object.entries(values)) {
    state.values[cc] = value;
    sendController(Number(cc), value, at);
    at += 2;
  }
  renderParams();
  return at;
}

/* ---------- Sound variations ---------- */

function resetVary() {
  state.varyOriginal = null;
  state.varyLatest = null;
  renderVary(false);
}

function renderVary(showingOriginal) {
  $("vary-compare").disabled = !state.varyOriginal;
  $("vary-compare").textContent = showingOriginal ? "Hear new" : "Hear original";
  $("vary-compare").setAttribute("aria-pressed", String(showingOriginal));
}

// Sets every control. The sound before it stays a click away.
function applyInitSound(values, message) {
  if (state.preview) stop();
  state.varyOriginal = { ...state.values };
  state.varyLatest = null;
  state.delay.sync = 0;
  applySound(values);
  state.varyLatest = { ...state.values };
  renderVary(false);
  saveSoon();
  const sent = state.output ? "Hear original brings back the sound you had." : "No MIDI output, so it wasn't sent to the S-1.";
  setStatus(`${message} ${sent}`, !state.output);
}

function initSound() {
  const kind = $("generator").value;
  applyInitSound(S1Params.startingSound(kind), `${Music.GENERATORS[kind]} starting sound. Every control is set.`);
}

function initSine() {
  applyInitSound(S1Params.sineSound(), "Close to a sine wave, using a filtered square. Move Cutoff to fine-tune it.");
}

function varySound(amount) {
  const { changes, unknown } = S1Params.vary(state.values, amount);
  // Its range is much smaller as a note value, so a nudge would jump to another note.
  if (state.delay.sync === 1) delete changes[DELAY_CC];
  if (!Object.keys(changes).length) {
    setStatus("Vary needs known values. Load a patch, or move the controls first.", true);
    return;
  }
  state.varyOriginal ??= { ...state.values };
  applySound(changes);
  state.varyLatest = { ...state.values };
  renderVary(false);
  const skipped = unknown ? ` ${unknown} controls showing ? were left alone.` : "";
  setStatus(`Changed ${Object.keys(changes).length} controls. Hear original compares them.${skipped}`);
}

function compareVary() {
  const showingOriginal = $("vary-compare").getAttribute("aria-pressed") === "true";
  if (!showingOriginal) state.varyLatest = { ...state.values };
  applySound(showingOriginal ? state.varyLatest : state.varyOriginal);
  renderVary(!showingOriginal);
  setStatus(showingOriginal ? "Hearing the new version." : "Hearing the original.");
}

function loadPatch(item, { play: startPlaying = false } = {}) {
  stop();
  closeNoteEditor({ restoreFocus: false });
  remember();
  resetVary();
  const loadedNotes = Prm.readNotes(item.text);
  slot().notes = loadedNotes;
  delete slot().lanes;
  slot().bars = Prm.readBars(item.text);
  state.sources[state.current] = { name: item.name, text: item.text };
  library.loaded = item.name;
  $("library-name").value = item.name;
  state.bpm = Prm.readBpm(item.text);
  const key = Music.detectKey(loadedNotes);
  if (key) Object.assign(state, key);
  if (loadedNotes.length) {
    const lowest = Math.min(...loadedNotes.map((n) => n.note));
    state.lowOctave = Math.max(1, Math.min(6, Math.floor(lowest / 12) - 1));
  }
  state.page = 0;
  state.delay = Prm.readDelay(item.text);
  const finished = applySound(Prm.readValues(item.text));
  renderAll();
  renderLibrary();
  saveSoon();
  const extra = item.info.motions ? " Its motions play along." : "";
  const sent = state.output ? "Sound sent to the S-1." : "No MIDI output, so the sound wasn't sent.";
  setStatus(`Loaded "${item.name}". ${sent}${extra} Some settings, like delay feedback, only apply once it's saved to the S-1.`);
  if (startPlaying && state.output) {
    window.setTimeout(() => { if (!state.playing) play(); }, Math.max(0, finished - performance.now()) + 40);
  }
}

/* ---------- Controls ---------- */

function openHelp() {
  closeNoteEditor({ restoreFocus: false });
  $("help").showModal();
  document.querySelector(".help-body").scrollTop = 0;
}

function fillSelects() {
  $("scale").replaceChildren(...Object.entries(Music.SCALES).map(
    ([id, scale]) => new Option(scale.name, id)));
  $("generator").replaceChildren(...Object.entries(Music.GENERATORS).map(
    ([id, name]) => new Option(name, id)));
  const octaves = [];
  for (let octave = 1; octave <= 6; octave += 1) octaves.push(new Option(`C${octave}`, String(octave)));
  $("octave").replaceChildren(...octaves);
  const channels = [];
  for (let channel = 1; channel <= 16; channel += 1) channels.push(new Option(String(channel), String(channel)));
  $("channel").replaceChildren(...channels);
  $("chords").replaceChildren(...Object.entries(Music.CHORDS).map(([id, chord]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.value = id;
    button.textContent = chord.name;
    button.addEventListener("click", () => {
      state.chord = id;
      renderStepControls();
      saveSoon();
      if (id !== "note") setStatus(`Drawing ${chord.name.toLowerCase()} chords in the key. Set Polyphony to Poly on the VOICE tab to hear every note.`);
    });
    return button;
  }));
}

function bindControls() {
  const number = (id, apply) => $(id).addEventListener("change", (event) => {
    apply(Number(event.target.value));
    saveSoon();
  });
  $("scale").addEventListener("change", (event) => setKey(state.root, event.target.value));
  $("move-notes").addEventListener("change", (event) => {
    state.moveNotes = event.target.checked;
    saveSoon();
  });
  $("steps").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) setSteps(Number(button.dataset.value), state.triplets);
  });
  $("triplets").addEventListener("click", () => setSteps(state.baseResolution, !state.triplets));
  number("bars", setBars);
  number("bpm", (value) => { state.bpm = currentBpm(); $("bpm").value = state.bpm; announceTempo(); void value; });
  number("octave", (value) => { state.lowOctave = value; renderGrid(); });
  number("span", (value) => { state.span = value; renderGrid(); });
  number("channel", (value) => { state.channel = value - 1; });
  $("new-length").addEventListener("change", (event) => { state.newLength = event.target.value; saveSoon(); });
  $("show-all").addEventListener("change", (event) => {
    state.showAll = event.target.checked;
    renderGrid();
    saveSoon();
  });
  $("output").addEventListener("change", (event) => {
    state.output = state.midi.outputs.get(event.target.value) || null;
    if (state.output) setMidiPill(`MIDI: ${state.output.name}`, isS1(state.output) ? "ok" : "");
  });
  $("page-prev").addEventListener("click", () => goToPage(state.page - 1));
  $("page-next").addEventListener("click", () => goToPage(state.page + 1));
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderGrid, 100);
  });
  $("midi-retry").addEventListener("click", initMidi);
  $("play").addEventListener("click", () => (state.playing ? stop() : play()));
  $("stop-all").addEventListener("click", panic);
  $("send").addEventListener("click", sendToS1);
  $("save-open").addEventListener("click", () => openSaveDialog());
  $("save-add").addEventListener("click", () => {
    const source = $("save-source").value;
    if (!source) return;
    saveState.rows.push({ source, slot: null });
    saveState.active = saveState.rows.length - 1;
    renderSaveSlots();
  });
  $("save-fill").addEventListener("click", () => {
    fillEmptySlots();
    renderSaveSlots();
  });
  $("save-clear").addEventListener("click", () => {
    saveState.rows.forEach((row) => { row.slot = null; });
    saveState.active = 0;
    renderSaveSlots();
  });
  $("follow-s1").addEventListener("click", toggleFollow);
  $("follow-backup").addEventListener("click", chooseFollowBackup);
  $("library-folder").addEventListener("click", () => {
    if (library.status === "ready") library.status = "none";
    chooseLibraryFolder().finally(renderLibrary);
  });
  $("library-import").addEventListener("click", importBackup);
  $("library-from-s1").addEventListener("click", openImportDialog);
  $("import-close").addEventListener("click", () => $("import-dialog").close());
  $("import-done-close").addEventListener("click", () => $("import-dialog").close());
  $("import-choose").addEventListener("click", chooseImportDrive);
  $("import-select-new").addEventListener("click", selectNewImportSlots);
  $("import-clear").addEventListener("click", () => {
    importState.names.clear();
    renderImportPicker();
  });
  $("import-write").addEventListener("click", writeImportedPatches);
  $("library-select-all").addEventListener("click", () => {
    visiblePatches().forEach((item) => library.selected.add(item.name));
    renderLibrary();
  });
  $("library-select-none").addEventListener("click", () => {
    library.selected.clear();
    renderLibrary();
  });
  $("library-send").addEventListener("click", () => {
    const batch = selectedPatches();
    openSaveDialog(batch[0], batch);
  });
  $("library-save").addEventListener("click", addPatchToLibrary);
  $("library-search").addEventListener("input", (event) => {
    library.search = event.target.value;
    renderLibrary();
  });
  $("save-close").addEventListener("click", () => $("save-dialog").close());
  $("save-choose").addEventListener("click", chooseS1Drive);
  $("save-write").addEventListener("click", writeToS1);
  $("export").addEventListener("click", exportMidi);
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    // Cleared so that choosing the same file again still counts as a change.
    event.target.value = "";
    if (file) importMidi(file);
  });
  $("shift-left").addEventListener("click", () => shiftInTime(-1));
  $("shift-right").addEventListener("click", () => shiftInTime(1));
  $("scale-down").addEventListener("click", () => shiftInScale(-1));
  $("scale-up").addEventListener("click", () => shiftInScale(1));
  $("copy").addEventListener("click", copySelection);
  $("paste").addEventListener("click", pasteClipboard);
  $("velocity-set").addEventListener("click", setBulkVelocity);
  $("record").addEventListener("click", toggleRecording);
  $("chain").addEventListener("change", (event) => setChain(event.target.value));
  $("chain-on").addEventListener("change", (event) => {
    state.chainOn = event.target.checked;
    saveSoon();
  });
  $("backup").addEventListener("click", downloadBackup);
  $("restore").addEventListener("click", () => $("restore-file").click());
  $("restore-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (file) restoreBackup(file);
  });
  $("vary-small").addEventListener("click", () => varySound(0.06));
  $("revert-sound").addEventListener("click", revertSound);
  $("theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
  $("theme-toggle").textContent = document.documentElement.dataset.theme === "light" ? "Dark mode" : "Light mode";
  $("vary-big").addEventListener("click", () => varySound(0.25));
  $("vary-compare").addEventListener("click", compareVary);
  $("library-favourites").addEventListener("change", (event) => {
    library.favouritesOnly = event.target.checked;
    renderLibrary();
  });
  $("octave-down").addEventListener("click", () => shiftOctave(-1));
  $("octave-up").addEventListener("click", () => shiftOctave(1));
  $("generate").addEventListener("click", generatePattern);
  $("generator").addEventListener("change", initSound);
  $("init-sound").addEventListener("click", initSound);
  $("init-sine").addEventListener("click", initSine);
  $("undo").addEventListener("click", undo);
  $("duplicate").addEventListener("click", duplicatePattern);
  $("clear").addEventListener("click", () => {
    if (!notes().length) return;
    remember();
    slot().notes = [];
    renderGrid();
    renderChrome();
    saveSoon();
  });
  $("sound-send").addEventListener("click", loadSound);
  $("sound-delete").addEventListener("click", deleteSound);
  $("help-open").addEventListener("click", openHelp);
  $("help-close").addEventListener("click", () => $("help").close());
  $("help").addEventListener("click", (event) => {
    if (event.target === $("help")) $("help").close();
  });

  const typing = (target) => /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
  window.addEventListener("keydown", (event) => {
    if ($("help").open || $("save-dialog").open || $("import-dialog").open) return;
    if (event.key === "?" && !typing(event.target)) {
      openHelp();
      return;
    }
    if (event.key === "Escape" && state.editor) {
      closeNoteEditor();
      return;
    }
    // Space is the transport wherever you've last clicked, unless you're writing text.
    const writing = event.target.tagName === "TEXTAREA" || /^(text|search)$/.test(event.target.type);
    if (event.code === "Space" && !writing && !event.metaKey && !event.ctrlKey && !event.altKey
      && !event.target.closest?.("#note-editor") && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      if (!event.repeat) {
        if (state.playing) stop(); else play();
      }
      return;
    }
    if (typing(event.target) || event.target.closest?.("#note-editor")) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "c") {
      event.preventDefault();
      copySelection();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "v") {
      event.preventDefault();
      pasteClipboard();
    } else if (event.key === "Escape") {
      clearSelection();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "z") {
      event.preventDefault();
      undo();
    } else if (event.key === "t" && !event.metaKey && !event.ctrlKey) {
      setSteps(state.baseResolution, !state.triplets);
    }
  });
}

async function start() {
  restore();
  fillSelects();
  bindControls();
  bindGridEvents();
  bindNoteEditor();
  bindLane();
  $("edit-substep").replaceChildren(...Music.SUB_STEPS.map((pattern, index) => new Option(index ? pattern.replaceAll("_", "-") : "Off", String(index))));
  $("chain").value = state.chain;
  $("chain-on").checked = state.chainOn;
  $("lane").hidden = !state.showLane;
  $("lane-toggle").setAttribute("aria-pressed", String(state.showLane));
  renderTabs();
  renderParams();
  renderSounds();
  renderAll();
  renderLibrary();
  setStatus("Choose a key, then click or drag on the grid to add notes.");
  await initMidi();
  await loadFollowSounds();
  if (window.showDirectoryPicker) await restoreLibrary();
}

start().catch((error) => setStatus(error.message, true));
