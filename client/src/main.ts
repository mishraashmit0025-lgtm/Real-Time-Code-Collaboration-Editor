import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { MonacoBinding } from "y-monaco";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import "./style.css";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

const COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46a0a8", "#f032e6", "#9a6324", "#800000", "#000075"];
const ADJ = ["Swift", "Quiet", "Brave", "Clever", "Lucky", "Sunny", "Nimble", "Witty"];
const ANIMAL = ["Otter", "Falcon", "Panda", "Lynx", "Koala", "Heron", "Fox", "Yak"];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

// room from ?room=, else a fresh random one
const params = new URLSearchParams(location.search);
let room = params.get("room") ?? "";
if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
  room = Math.random().toString(36).slice(2, 10);
  history.replaceState(null, "", `?room=${room}`);
}
document.getElementById("room-name")!.textContent = room;

const doc = new Y.Doc();
const wsBase = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const provider = new WebsocketProvider(wsBase, room, doc);
const ytext = doc.getText("code");
const meta = doc.getMap<string>("meta");

// ---- identity / presence
const stored = (() => {
  try {
    return JSON.parse(localStorage.getItem("collab-user") ?? "null");
  } catch {
    return null;
  }
})();
const me = stored ?? { name: `${pick(ADJ)} ${pick(ANIMAL)}`, color: pick(COLORS) };
provider.awareness.setLocalStateField("user", me);
const nameInput = document.getElementById("user-name") as HTMLInputElement;
nameInput.value = me.name;
nameInput.addEventListener("change", () => {
  me.name = nameInput.value.trim().slice(0, 24) || me.name;
  provider.awareness.setLocalStateField("user", me);
  try {
    localStorage.setItem("collab-user", JSON.stringify(me));
  } catch {
    /* storage may be unavailable */
  }
});

// ---- editor
const editor = monaco.editor.create(document.getElementById("editor")!, {
  value: "",
  language: "typescript",
  automaticLayout: true,
  theme: matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs",
  minimap: { enabled: true },
  fontSize: 14,
  tabSize: 2,
});
new MonacoBinding(ytext, editor.getModel()!, new Set([editor]), provider.awareness);

// ---- language (synced through the shared doc)
const langSelect = document.getElementById("language") as HTMLSelectElement;
const languages = monaco.languages
  .getLanguages()
  .filter((l) => l.aliases?.length)
  .sort((a, b) => a.aliases![0].localeCompare(b.aliases![0]));
for (const l of languages) langSelect.add(new Option(l.aliases![0], l.id));
const applyLanguage = () => {
  const lang = meta.get("language") ?? "typescript";
  monaco.editor.setModelLanguage(editor.getModel()!, lang);
  langSelect.value = lang;
};
langSelect.addEventListener("change", () => meta.set("language", langSelect.value));
meta.observe(applyLanguage);
applyLanguage();

// seed an empty room once, after the first sync so we never clobber existing content
provider.once("sync", (synced: boolean) => {
  if (synced && ytext.length === 0 && !meta.get("language")) {
    doc.transact(() => {
      meta.set("language", "typescript");
      ytext.insert(0, "// Share this page's link to edit together in real time.\n\nfunction greet(name: string) {\n  return `Hello, ${name}!`;\n}\n");
    });
  }
});

// ---- remote cursor colors + presence list
const styleEl = document.head.appendChild(document.createElement("style"));
const usersEl = document.getElementById("users")!;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// CSS string literal: escape every non-alphanumeric char as a hex escape
const cssString = (s: string) =>
  `"${[...s].map((c) => (/[\w ]/.test(c) ? c : "\\" + c.codePointAt(0)!.toString(16) + " ")).join("")}"`;
function renderPresence() {
  let css = "";
  const items: string[] = [];
  provider.awareness.getStates().forEach((state, clientId) => {
    const u = (state as { user?: { name: string; color: string } }).user;
    if (!u) return;
    const color = /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : "#888888";
    css += `.yRemoteSelection-${clientId}{background-color:${color}40}`;
    css += `.yRemoteSelectionHead-${clientId}{border-left:2px solid ${color};border-top:2px solid ${color}}`;
    css += `.yRemoteSelectionHead-${clientId}::after{content:${cssString(u.name)};background:${color}}`;
    items.push(`<li style="--c:${color}" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}${clientId === doc.clientID ? " (you)" : ""}</li>`);
  });
  styleEl.textContent = css;
  usersEl.innerHTML = items.join("");
}
provider.awareness.on("change", renderPresence);
renderPresence();

// ---- connection status + share
const statusEl = document.getElementById("status")!;
provider.on("status", ({ status }: { status: string }) => {
  statusEl.textContent = status;
  statusEl.dataset.state = status;
});
document.getElementById("share")!.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    (document.getElementById("share") as HTMLButtonElement).textContent = "Copied!";
    setTimeout(() => ((document.getElementById("share") as HTMLButtonElement).textContent = "Copy link"), 1500);
  } catch {
    prompt("Copy this link", location.href);
  }
});
