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
  sources: Array.from({ length: SLOTS }, () => null),
  page: 0,
  pageBars: 1,
  windowStart: 0,
  windowSpan: 0,
  undo: [],
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
  $("status").classList.toggle("error", isError);
}

/* ---------- Saving in this browser ---------- */

function saveSoon() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    const saved = {};
    for (const key of ["root", "scale", "moveNotes", "slots", "current", "bpm", "channel", "chord",
      "newLength", "lowOctave", "span", "showAll", "baseResolution", "triplets", "tab", "sounds", "sources"]) {
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

function switchTo(index) {
  state.current = index;
  state.queued = null;
  state.page = 0;
  // A pattern loaded from the library brings its sound with it.
  const source = state.sources[index];
  if (source) applySound(Prm.readValues(source.text));
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
  for (const cc of paramControls.keys()) updateParamControl(cc);
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
  else input.value = known ? value : 64;
  output.textContent = S1Params.display(param, value);
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

// Knobs moved on the S-1 update the matching controls here.
function handleMidiInput(event) {
  const [status, cc, value] = event.data;
  if ((status & 0xF0) !== 0xB0 || (status & 0x0F) !== state.channel) return;
  if (!S1Params.BY_CC.has(cc)) return;
  state.values[cc] = value;
  updateParamControl(cc);
}

function sendNote(note, velocity, atTime, lengthMs) {
  if (!state.output) return;
  const value = Math.max(1, Math.min(127, Math.round(velocity * 127)));
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
  const value = Number($("bpm").value);
  return value >= 20 && value <= 300 ? value : 120;
}

function schedule() {
  const horizon = performance.now() + SCHEDULE_AHEAD_MS;
  const ms = msPerPulse();
  while (state.nextTime < horizon) {
    const from = state.nextPulse;
    const to = from + CHUNK_PULSES;
    if (sendingClock() && from % CLOCK_PULSES === 0 && state.output) {
      state.output.send([0xF8], state.nextTime);
    }
    if (!state.sendOnce) scheduleMotions(from, to, ms);
    for (const note of notes()) {
      if (note.time >= from && note.time < to && Math.random() * 100 < (note.probability ?? 100)) {
        sendNote(note.note, note.velocity, state.nextTime + (note.time - from) * ms, note.length * ms);
      }
    }
    state.nextTime += CHUNK_PULSES * ms;
    state.nextPulse = to >= lengthPulses() ? 0 : to;
    if (state.nextPulse === 0 && state.sendOnce) {
      finishSendOnce();
      return;
    }
    if (state.nextPulse === 0 && state.queued !== null) switchTo(state.queued);
  }
}

// Plays a loaded patch's recorded knob movements. Each pass starts from the sound's
// own values, as the movements only cover part of the pattern.
function scheduleMotions(from, to, ms) {
  const source = state.sources[state.current];
  if (!source) return;
  source.motions ??= Prm.readMotions(source.text);
  if (!source.motions.length) return;
  if (from === 0) {
    source.base ??= Prm.readValues(source.text);
    for (const cc of new Set(source.motions.map((m) => m.cc))) {
      if (source.base[cc] !== undefined) sendController(cc, source.base[cc], state.nextTime);
    }
  }
  for (const motion of source.motions) {
    if (motion.time >= from && motion.time < to && motion.time < lengthPulses()) {
      sendController(motion.cc, motion.value, state.nextTime + (motion.time - from) * ms);
    }
  }
}

function restoreAfterMotions() {
  const source = state.sources[state.current];
  if (!source || !source.motions || !source.motions.length) return;
  source.base ??= Prm.readValues(source.text);
  // Controls edited since loading keep their new value.
  for (const cc of new Set(source.motions.map((m) => m.cc))) {
    const value = state.values[cc] ?? source.base[cc];
    if (value !== undefined) sendController(cc, value, performance.now() + SCHEDULE_AHEAD_MS + 25);
  }
}

function play() {
  if (!state.output) {
    setStatus("No MIDI output connected. Connect the S-1 and turn it on.", true);
    return;
  }
  state.playing = true;
  state.nextPulse = 0;
  state.nextTime = performance.now() + 60;
  if (sendingClock()) state.output.send([0xFA], state.nextTime);
  $("play").textContent = "Stop";
  $("playhead").hidden = false;
  schedule();
  requestAnimationFrame(drawPlayhead);
}

function allNotesOff(at) {
  sendController(CC_ALL_NOTES_OFF, 0, at);
}

function stop() {
  state.queued = null;
  if (!state.playing) return;
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

function drawPlayhead() {
  if (!state.playing) return;
  const length = lengthPulses();
  const behind = (state.nextTime - performance.now()) / msPerPulse();
  const pulse = ((state.nextPulse - behind) % length + length) % length;
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
    notes: notes(), bars: slot().bars, bpm: currentBpm(), values: state.values, keepMotions: Boolean(existing),
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
const library = {
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

async function readLibrary() {
  try {
    const { items, skipped } = await readPatchFolder(library.folder);
    library.items = items;
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
  $("library-search").disabled = !ready;
  if (ready) {
    const skipped = library.skipped ? ` ${library.skipped} file(s) couldn't be read.` : "";
    const hint = library.items.length ? "" : " Use Import backup to add your S-1's patches.";
    setLibraryState(`"${library.folder.name}": ${library.items.length} patch(es).${skipped}${hint}`);
  } else {
    setLibraryState(message);
  }
  const term = library.search.trim().toLowerCase();
  const items = library.items.filter((item) => item.name.toLowerCase().includes(term));
  $("library-list").replaceChildren(...items.map(libraryRow));
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
  return library.items.filter((item) => item.name.toLowerCase().includes(term));
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
  detail.textContent = `${item.info.notes} steps with notes, ${item.bpm} BPM${motions}`;
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
  row.append(
    check,
    load,
    action("Play", "Load and play", () => loadPatch(item, { play: true })),
    action("To S-1", "Save to the S-1", () => openSaveDialog(item.name)),
    action("Name", "Rename", () => renamePatch(item)),
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
      notes: notes(), bars: slot().bars, bpm: currentBpm(), values: state.values, keepMotions: Boolean(source),
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

/* ---------- Loading a patch ---------- */

function renderPatchName() {
  const source = state.sources[state.current];
  $("patch-name").hidden = !source;
  if (source) $("patch-name").textContent = `Patch: ${source.name}`;
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

function loadPatch(item, { play: startPlaying = false } = {}) {
  stop();
  closeNoteEditor({ restoreFocus: false });
  remember();
  const loadedNotes = Prm.readNotes(item.text);
  slot().notes = loadedNotes;
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
  const finished = applySound(Prm.readValues(item.text));
  renderAll();
  renderLibrary();
  saveSoon();
  const { motions, substeps } = item.info;
  const notes2 = [];
  if (motions) notes2.push("Its motions play along");
  if (substeps) notes2.push("step sub-divisions won't play from this page");
  const extra = notes2.length ? ` ${notes2.join(", and ")}.` : "";
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
  number("bpm", (value) => { state.bpm = currentBpm(); $("bpm").value = state.bpm; void value; });
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
  $("library-folder").addEventListener("click", () => {
    if (library.status === "ready") library.status = "none";
    chooseLibraryFolder().finally(renderLibrary);
  });
  $("library-import").addEventListener("click", importBackup);
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
  $("generate").addEventListener("click", generatePattern);
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
    if ($("help").open || $("save-dialog").open) return;
    if (event.key === "?" && !typing(event.target)) {
      openHelp();
      return;
    }
    if (event.key === "Escape" && state.editor) {
      closeNoteEditor();
      return;
    }
    if (typing(event.target) || event.target.closest?.("#note-editor")) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (state.playing) stop(); else play();
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
  renderTabs();
  renderParams();
  renderSounds();
  renderAll();
  renderLibrary();
  setStatus("Choose a key, then click or drag on the grid to add notes.");
  await initMidi();
  if (window.showDirectoryPicker) await restoreLibrary();
}

start().catch((error) => setStatus(error.message, true));
