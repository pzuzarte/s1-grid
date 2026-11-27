"use strict";
/* Favourites and tags, the same in every grid's library, so sounds and patterns can be
   starred, tagged and filtered the same way everywhere, and in Song Grid's Add list.

   Each grid keeps them beside what they're for, in its library folder's info file, as
   { favourite: true, tags: "dark, bass" }: tags are words or short phrases, separated by
   commas. Matching ignores capitals.

   bar() draws a row with Favourites and a button for each tag in use, which filter a
   list, and matches() says whether an item passes the filter. This file is the same in
   each grid. */

const LibraryTags = (() => {
  const MOST = 12; // Tags on one item.
  const LONGEST = 24; // Characters in a tag.

  // The tags in some text, tidied: trimmed, each once, in the order given.
  function parse(text) {
    const seen = new Set();
    const tags = [];
    for (const raw of String(text ?? "").split(",")) {
      const tag = raw.trim().replace(/\s+/g, " ").slice(0, LONGEST);
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= MOST) break;
    }
    return tags;
  }

  // An item's tags, from its info, whether kept as text or as a list.
  const of = (info) => parse(Array.isArray(info?.tags) ? info.tags.join(",") : info?.tags);
  const format = (tags) => tags.join(", ");

  // An info entry with its favourite and tags tidied, or null if nothing is left in it.
  function tidy(entry) {
    const next = { ...entry };
    if (!next.favourite) delete next.favourite;
    const tags = format(of(next));
    if (tags) next.tags = tags;
    else delete next.tags;
    return Object.keys(next).length ? next : null;
  }

  // Every tag in use, most used first, spelt as it was first seen.
  function counts(infos) {
    const found = new Map();
    for (const info of infos) {
      for (const tag of of(info)) {
        const key = tag.toLowerCase();
        const entry = found.get(key) || { tag, key, count: 0 };
        entry.count += 1;
        found.set(key, entry);
      }
    }
    return [...found.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  // Asks for an item's tags. Gives the new text, or null if it was cancelled.
  function ask(name, info, known = []) {
    const own = new Set(of(info).map((tag) => tag.toLowerCase()));
    const others = known.filter((tag) => !own.has(tag.toLowerCase())).slice(0, 15);
    const hint = others.length ? `\n\nTags you use: ${others.join(", ")}` : "";
    const answer = window.prompt(`Tags for "${name}", separated by commas.${hint}`, format(of(info)));
    return answer === null ? null : format(parse(answer));
  }

  /* A filter: { favourites, tags, words }. tags are the tags picked, in lower case, and an
     item needs them all. words is search text, found in its name, its tags or extra text. */
  const filter = () => ({ favourites: false, tags: [], words: "" });

  function matches(test, name, info, extra = "") {
    if (test.favourites && !info?.favourite) return false;
    const tags = of(info).map((tag) => tag.toLowerCase());
    if (!test.tags.every((tag) => tags.includes(tag))) return false;
    const text = `${name} ${tags.join(" ")} ${extra}`.toLowerCase();
    return String(test.words || "").toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
  }

  function button(text, title, pressed, onClick, className) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = className;
    item.textContent = text;
    item.title = title;
    item.setAttribute("aria-pressed", String(pressed));
    item.onclick = onClick;
    return item;
  }

  // Draws the filter row: Favourites, a button for each tag in use, and Clear.
  function bar(container, test, infos, onChange, { disabled = false } = {}) {
    const tags = counts(infos);
    // A tag no longer in use can't stay picked.
    test.tags = test.tags.filter((key) => tags.some((entry) => entry.key === key));
    const items = [button("★ Favourites", "Shows only the favourites", test.favourites, () => {
      test.favourites = !test.favourites;
      onChange();
    }, "toggle tag-favourites")];
    for (const entry of tags) {
      const on = test.tags.includes(entry.key);
      items.push(button(`${entry.tag} ${entry.count}`, on ? `Showing only those tagged "${entry.tag}". Click to show the rest too.` : `Shows only those tagged "${entry.tag}"`, on, () => {
        test.tags = on ? test.tags.filter((key) => key !== entry.key) : [...test.tags, entry.key];
        onChange();
      }, "tag-chip"));
    }
    if (test.favourites || test.tags.length) {
      items.push(button("Clear", "Shows everything again", false, () => {
        test.favourites = false;
        test.tags = [];
        onChange();
      }, "tag-clear"));
    }
    for (const item of items) item.disabled = disabled;
    container.classList.add("tag-bar");
    container.replaceChildren(...items);
  }

  // The star beside an item.
  function star(favourite, name, onClick) {
    const item = button(favourite ? "★" : "☆", favourite ? "A favourite. Click to unstar it." : "Make it a favourite", favourite, onClick, "favourite tag-star");
    item.setAttribute("aria-label", `${favourite ? "Unstar" : "Star"} ${name}`);
    return item;
  }

  // An item's tags, as small labels to show beside its name.
  function pills(info) {
    const tags = of(info);
    if (!tags.length) return null;
    const box = document.createElement("span");
    box.className = "tag-pills";
    for (const tag of tags) box.append(Object.assign(document.createElement("span"), { className: "tag-pill", textContent: tag }));
    return box;
  }

  if (typeof document !== "undefined") {
    const style = document.createElement("style");
    style.textContent = `
      .tag-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
      .tag-bar:empty { display: none; }
      .tag-chip, .tag-clear { min-height: 0; padding: 2px 9px; border-radius: 999px; font-size: 12px; line-height: 1.5; }
      .tag-chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
      .tag-clear { border-style: dashed; }
      .tag-star { min-width: 28px; padding: 0 6px; }
      .tag-star[aria-pressed="true"] { color: var(--accent); }
      .tag-pills { display: inline-flex; flex-wrap: wrap; gap: 3px; margin-left: 6px; vertical-align: middle; }
      .tag-pill { padding: 0 6px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 10.5px; font-weight: 400; line-height: 1.5; }`;
    document.head.append(style);
  }

  return { ask, bar, counts, filter, format, matches, of, parse, pills, star, tidy };
})();

if (typeof module !== "undefined") module.exports = LibraryTags;
