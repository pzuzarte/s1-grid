"use strict";
/* Saving a pattern or patch as a file anywhere on this computer, with the Mac's own Save
   and Open dialogs. The file each one came from, or was last saved to, is remembered, so
   Save writes to it again under the same name. Chrome remembers the last folder used for
   each kind of file. The same file is used by every grid. */
const NamedFile = (() => {
  const STORE = "handles";

  function store(db, action, mode) {
    return new Promise((resolve, reject) => {
      const opening = indexedDB.open(db, 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const request = action(opening.result.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      };
    });
  }

  // A key for a new pattern's file, so a copied pattern doesn't save over the original.
  const newKey = () => `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /* db is where the files are remembered, id the name Chrome keeps the last folder under,
     and extension and description describe the files, such as ".json" and "Patterns". */
  function create({ db, id, extension, description, mime = "application/octet-stream" }) {
    const types = [{ description, accept: { [mime]: [extension] } }];
    const withoutExtension = (name) => (name.toLowerCase().endsWith(extension.toLowerCase()) ? name.slice(0, -extension.length) : name);

    const supported = () => typeof window !== "undefined" && "showSaveFilePicker" in window;

    const remember = (key, handle) => store(db, (place) => place.put(handle, key), "readwrite");
    const forget = (key) => store(db, (place) => place.delete(key), "readwrite");
    const recall = async (key) => {
      if (!key) return null;
      try {
        return (await store(db, (place) => place.get(key), "readonly")) || null;
      } catch {
        return null;
      }
    };

    // bytes can be a function giving them, so a dialog opens straight after the click,
    // which Chrome needs, and the file is made after it closes.
    async function write(handle, bytes) {
      // Asking again for permission also needs the click, so it comes first.
      if (await handle.queryPermission({ mode: "readwrite" }) !== "granted"
          && await handle.requestPermission({ mode: "readwrite" }) !== "granted") {
        throw new Error("Chrome wasn't allowed to save to that file.");
      }
      const contents = typeof bytes === "function" ? await bytes() : bytes;
      const writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
    }

    // Asks where to save, with the Mac's Save dialog. Returns null if it's cancelled.
    async function saveAs(key, suggestedName, bytes, { startIn } = {}) {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          id, types, suggestedName: `${suggestedName || "Untitled"}${extension}`, ...(startIn ? { startIn } : {}),
        });
      } catch (error) {
        if (error.name === "AbortError") return null;
        throw error;
      }
      await write(handle, bytes);
      await remember(key, handle);
      return { handle, name: withoutExtension(handle.name) };
    }

    // Saves again to the file remembered for this key. Returns null if there isn't one.
    async function save(key, bytes) {
      const handle = await recall(key);
      if (!handle) return null;
      await write(handle, bytes);
      return { handle, name: withoutExtension(handle.name) };
    }

    // Opens a file with the Mac's Open dialog. Returns null if it's cancelled.
    async function open(key, { startIn } = {}) {
      let handle;
      try {
        [handle] = await window.showOpenFilePicker({ id, types, multiple: false, ...(startIn ? { startIn } : {}) });
      } catch (error) {
        if (error.name === "AbortError") return null;
        throw error;
      }
      const file = await handle.getFile();
      await remember(key, handle);
      return { handle, name: withoutExtension(file.name), bytes: new Uint8Array(await file.arrayBuffer()) };
    }

    return { supported, saveAs, save, open, remember, forget, recall, write, withoutExtension };
  }

  return { create, newKey };
})();

if (typeof module !== "undefined") module.exports = NamedFile;
