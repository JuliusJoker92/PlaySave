/* PlaySave — a disk-usage analyser styled as a console memory card browser.
   Copyright (C) 2026 JuliusJoker92

   This program is free software: you can redistribute it and/or modify it under
   the terms of the GNU General Public License as published by the Free Software
   Foundation, either version 3 of the License, or (at your option) any later
   version. It is distributed WITHOUT ANY WARRANTY; without even the implied
   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
   General Public License, in LICENSE, for more details. */

import { createRenderer, hex, drawGlyphIcon } from "./gl/renderer.js";
import { Sound } from "./audio.js";
import * as P from "./platform.js";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const canvas = document.getElementById("stage");
const osd = document.getElementById("osd");
const toastEl = document.getElementById("toast");
const R = createRenderer(canvas);

/* --------------------------------------------------------------------- state */
const S = {
  screen:"boot",            // boot | menu | devices | contents | options | copyto | details | config
  menuSel:0, cfgSel:0,
  volumes:[], vol:0,
  path:null, stack:[], entries:[], sel:0, scroll:0,
  opt:0, confirm:false, busy:false, err:null,
  help:false,               // the F1 sheet, drawn over whatever screen is up
  stats:null,               // last ScanStats from the backend, null if unavailable
  deleting:false,           // an erase is in flight: the warning at the foot
  /* The Copy flow. src is captured when the picker opens, because a background
     scan can reorder S.entries underneath it and the copy must still mean the
     folder that was chosen. */
  copy:{ src:null, dests:[], di:0, confirm:false, yes:true,
         running:false, copied:0, total:0, files:0, totalFiles:0 },
  settings:{ sound:true, animations:true, confirmDelete:true, iconSource:"mixed",
             labelSize:"normal", sizeUnits:"modern" }
};
/* The void sequence, used for both the startup animation and every scan.
   On the console the camera crept forward for exactly as long as the disc took
   to read, then rushed in. A scan has the same shape: creep while it works,
   rush when it lands. A cache hit has no shape at all — it never gets here. */
const boot = {
  mode:"startup", t:0, towers:[], title:"PlaySave", sub:"",
  bytes:0, seen:0, total:0, done:false, minT:2.0, exitT:null, onDone:null
};
let clock = 0;
let scrollAnim = 0;
/* Redrawing after an arrow key re-fires pointerenter on whatever sits under the
   cursor, which snapped the selection straight back. Hover is ignored until the
   pointer genuinely moves again. */
let kbdMode = false, lastPx = -1, lastPy = -1;

/* Its own capture-phase listener rather than a line inside a navigation
   handler: there are two keydown listeners and the flag has to be set no matter
   which one ends up handling the key. */
const NAV_KEYS = new Set(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
  "Enter"," ","Spacebar","Home","End","PageUp","PageDown","Backspace","Tab"]);
addEventListener("keydown", e => { if(NAV_KEYS.has(e.key)) kbdMode = true; }, true);
let scanEvents = 0;   // raw scan-progress events received, for diagnosis
const anim = { mode:"idle", t:0, spin:0, alpha:1, h:0, last:null, pending:null, shrink:1 };

/* Sizes, in whichever dialect the setting asks for. EVERY size goes through
   here — a setting that changed the header but not the details screen would be
   worse than no setting at all.

   Classic is the console's: KB with thousands separators everywhere. That was
   exactly right for a 512 KB save and is absurd for an 11 TB drive, which is
   why Modern is the default — the console's intent was a size you could read
   at a glance, and at disk scale that means scaling the unit. */
const UNIT_MODES = ["modern","classic"];
const UNIT_LABEL = { modern:"Modern", classic:"Classic" };
const sizeText = b => S.settings.sizeUnits === "classic" ? P.commaKB(b) : P.human(b);

const vol = () => S.volumes[S.vol] || null;
const cur = () => S.entries[Math.min(S.sel, S.entries.length-1)] || null;

/* ------------------------------------------------------------------- helpers */
let toastTimer = 0;
function toast(msg, isErr){
  toastEl.textContent = msg;
  toastEl.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = "toast"; }, 3200);
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* ------------------------------------------------------------------ the keys
   This is a PC, so the footer shows keycaps, not console buttons. Names follow
   the Microsoft style guide exactly — Enter (never Return), Esc (never Escape),
   Spacebar, F5 with no space, combinations joined with "+" and no spaces — and
   the bindings are lifted from File Explorer so muscle memory transfers.

   KEYMAP is the single source of truth: the footer renders the entries marked
   `foot`, the F1 sheet renders all of them, and the keydown handler below
   implements exactly this and nothing else. A key with no hint, or a hint with
   no key, is a bug. */
const KEYCAP = {
  ArrowUp:"↑", ArrowDown:"↓", ArrowLeft:"←", ArrowRight:"→"
};
const KEYNAME = {
  ArrowUp:"Up arrow key", ArrowDown:"Down arrow key",
  ArrowLeft:"Left arrow key", ArrowRight:"Right arrow key"
};
const KEYMAP = {
  global: [
    { keys:["F1"],  label:"Keyboard shortcuts" },
    { keys:["F11"], label:"Full screen" }
  ],
  boot: [
    { keys:["Enter","Spacebar","Esc"], label:"Skip", foot:true }
  ],
  menu: [
    { keys:["ArrowUp","ArrowDown"], label:"Select", sep:"grp", foot:true },
    { keys:["Enter","Spacebar"],    label:"Open",   foot:true }
  ],
  devices: [
    { keys:["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"], label:"Select", sep:"grp", foot:true },
    { keys:["Enter","Spacebar"], label:"Open",    foot:true },
    { keys:["Esc"],              label:"Back",    foot:true },
    { keys:["F5"],               label:"Refresh", foot:true }
  ],
  contents: [
    { keys:["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"], label:"Select", sep:"grp", foot:true },
    { keys:["Enter","Spacebar"],                label:"Options", foot:true },
    { keys:["Esc","Backspace","Alt+ArrowLeft"], label:"Back",    foot:true },
    { keys:["Alt+ArrowUp"],                     label:"Up one level" },
    { keys:["Alt+Enter"],                       label:"Details", foot:true },
    { keys:["F5"],                              label:"Refresh", foot:true }
  ],
  options: [
    { keys:["ArrowUp","ArrowDown"], label:"Select", sep:"grp", foot:true },
    { keys:["Enter","Spacebar"],    label:"Choose", foot:true },
    { keys:["Esc"],                 label:"Cancel", foot:true }
  ],
  copyto: [
    { keys:["ArrowLeft","ArrowRight"], label:"Drive",  sep:"grp", foot:true },
    { keys:["Enter","Spacebar"],       label:"Choose", foot:true },
    { keys:["Esc"],                    label:"Cancel", foot:true }
  ],
  copydir: [
    { keys:["ArrowUp","ArrowDown"], label:"Select",    sep:"grp", foot:true },
    { keys:["Enter"],               label:"Open",      foot:true },
    { keys:["Spacebar"],            label:"Copy here", foot:true },
    { keys:["Esc"],                 label:"Back",      foot:true }
  ],
  copyask: [
    { keys:["ArrowLeft","ArrowRight"], label:"Select",  sep:"grp", foot:true },
    { keys:["Enter"],                  label:"Confirm", foot:true },
    { keys:["Esc"],                    label:"Back",    foot:true }
  ],
  details: [
    { keys:["Esc","Backspace"], label:"Back", foot:true }
  ],
  config: [
    { keys:["ArrowUp","ArrowDown"], label:"Select", sep:"grp", foot:true },
    { keys:["Enter","Spacebar"],    label:"Change", foot:true },
    { keys:["Esc"],                 label:"Back",   foot:true }
  ],
  help: [
    { keys:["Esc","F1"], label:"Close", foot:true }
  ]
};

/* A keycap is descriptive text, not a control: no tab stop, no click target. */
function cap(name, live){
  const face = KEYCAP[name] || name;
  const title = KEYNAME[name];
  return `<kbd class="kbd${KEYCAP[name] ? " kbd-arrow" : ""}"` +
         (title ? ` title="${esc(title)}"` : "") +
         (live === false ? "" : ` data-key="${esc(name)}"`) +
         `>${esc(face)}</kbd>`;
}
/* A hint that shows a key should also BE that key: clicking a cap dispatches
   the keystroke, so everything advertised is reachable with the mouse. For a
   combination the wrapper carries the whole spec — clicking "Alt" alone would
   mean nothing. */
const combo = spec => spec.includes("+")
  ? `<span class="kcombo" data-key="${esc(spec)}">` +
    spec.split("+").map(p => cap(p, false)).join('<span class="kplus">+</span>') + `</span>`
  : cap(spec);
/* The footer shows the first way of doing a thing; the F1 sheet shows them all.
   Alternatives are joined with "/", a set of keys that work together (the four
   arrows) sits side by side. */
function keysHTML(e, compact){
  const ks = (compact && e.sep !== "grp") ? e.keys.slice(0,1) : e.keys;
  return ks.map(combo).join(e.sep === "grp" ? "" : '<span class="kor">/</span>');
}
function hint(e, compact){
  return `<span class="hint"><span class="keys">${keysHTML(e, compact)}</span>` +
         `<span class="hl">${esc(e.label)}</span></span>`;
}
const footHints = screen =>
  (KEYMAP[screen] || []).filter(e => e.foot).map(e => hint(e, true)).join("");
/* aria-keyshortcuts belongs on the control the key actually operates, not on
   the keycap, which is why the caps themselves carry nothing. */
const AK = 'aria-keyshortcuts="Enter"';

/* ------------------------------------------------------------- folder icons
   Three sources, switched in System Configuration:
     Shell     — always the real Windows shell icon when there is one
     Generated — always the device-style glyph
     Mixed     — the shell icon only when it is *distinctive*; a folder that
                 would just come back with the plain manila folder keeps its
                 glyph, because the glyph says more than the generic icon does.
   Distinctiveness is decided by fingerprint: the generic folder icon is, by
   definition, the one Windows hands back for more than one folder, so an 8x8
   fingerprint seen on two different paths is the generic one.

   Nothing here blocks a scan. Requests are raised from the frame loop for the
   folders actually on screen, at most a few in flight, and every result is
   cached by path so returning to a folder costs nothing. */
const texCache  = new Map();   // path -> { tex, entry, shell }
const iconMeta  = new Map();   // path -> { url, img, hash }
const byHash    = new Map();   // fingerprint -> Set(path)
const iconAsked = new Set();
const iconQueue = [];
let iconInflight = 0, applyTimer = 0, listGen = 0;
const ICON_PARALLEL = 4;

const fpCv = document.createElement("canvas");
fpCv.width = fpCv.height = 8;
const fpCtx = fpCv.getContext("2d", { willReadFrequently:true });
function fingerprint(img){
  try{
    fpCtx.clearRect(0,0,8,8);
    fpCtx.drawImage(img,0,0,8,8);
    const d = fpCtx.getImageData(0,0,8,8).data;
    let s = "";
    for(let i=0;i<d.length;i+=4){
      if(d[i+3] < 24){ s += "."; continue; }
      const g = (d[i]*0.30 + d[i+1]*0.59 + d[i+2]*0.11) | 0;
      s += "0123456789abcdef"[Math.min(15, g >> 4)];
    }
    return s;
  }catch{ return null; }
}

const EMPTY = new Set();
function wantShell(hash){
  if(S.settings.iconSource === "generated") return false;
  if(S.settings.iconSource === "shell") return true;
  if(!hash) return true;                   // could not fingerprint it — trust the shell
  const seen = (byHash.get(hash) || EMPTY).size;
  return seen === 1;                       // shared with another folder ⇒ generic
}

function generatedTex(entry){
  return R ? R.texFromCanvas(drawGlyphIcon(glyphFor(entry), P.paletteFor(entry.name).tint)) : null;
}

function decideIcon(path){
  const rec = texCache.get(path), meta = iconMeta.get(path);
  if(!rec || !R) return;
  const want = !!(meta && meta.img) && wantShell(meta.hash);
  // swapping a texture without freeing the old one leaks ~64 KB of GPU memory
  // per folder, and toggling the icon source re-swaps every cached entry
  if(want && !rec.shell){ freeTex(rec.tex); rec.tex = R.texFromCanvas(meta.img); rec.shell = true; }
  else if(!want && rec.shell){ freeTex(rec.tex); rec.tex = generatedTex(rec.entry); rec.shell = false; }
}

function freeTex(t){ if(t && R && R.gl) R.gl.deleteTexture(t); }
function dropTextures(){
  for(const r of texCache.values()) freeTex(r.tex);
  texCache.clear();
  iconMeta.clear(); byHash.clear(); iconAsked.clear();
}

/* Trim between listings, never during one. Called from inside the frame loop it
   deleted textures that had just been created for the icons about to be drawn,
   so once the cache passed its cap every icon rendered as flat dark. */
function pruneTextures(){
  if(texCache.size <= 600) return;
  const keep = new Set(S.entries.map(e => e.path));
  for(const [k, r] of texCache){
    if(keep.has(k)) continue;
    freeTex(r.tex); texCache.delete(k);
    iconMeta.delete(k); iconAsked.delete(k);
    if(texCache.size <= 400) break;
  }
}

/* Decide in batches. A folder whose icon turns out to be the generic one only
   reveals that when a second folder returns the same fingerprint, so settling
   the batch before applying keeps icons from visibly flipping. */
function applyIcons(){
  clearTimeout(applyTimer); applyTimer = 0;
  for(const path of texCache.keys()) decideIcon(path);
}
function scheduleApply(){
  clearTimeout(applyTimer);
  if(!iconQueue.length && iconInflight === 0) applyIcons();
  else applyTimer = setTimeout(applyIcons, 120);
}

function recordIcon(path, url, img, hash){
  // a decoded 128px icon is ~64KB, so this cache is capped like the texture one
  if(iconMeta.size > 400){ iconMeta.clear(); byHash.clear(); iconAsked.clear(); }
  iconMeta.set(path, { url, img, hash });
  if(hash){
    let s = byHash.get(hash);
    if(!s){ s = new Set(); byHash.set(hash, s); }
    s.add(path);
  }
}
function loadIcon(path, url){
  return new Promise(done => {
    const img = new Image();
    img.onload  = () => { recordIcon(path, url, img, fingerprint(img)); done(); };
    img.onerror = () => { recordIcon(path, null, null, null); done(); };
    img.src = url;
  });
}
function pumpIcons(){
  while(iconInflight < ICON_PARALLEL && iconQueue.length){
    const job = iconQueue.shift();
    if(job.gen !== listGen){ iconAsked.delete(job.path); continue; }  // navigated away
    iconInflight++;
    P.iconFor(job.path, 128)
      .then(url => url ? loadIcon(job.path, url) : recordIcon(job.path, null, null, null))
      .catch(() => recordIcon(job.path, null, null, null))
      .finally(() => { iconInflight--; scheduleApply(); pumpIcons(); });
  }
}

function iconTexture(entry){
  const key = entry.path;
  let rec = texCache.get(key);
  if(!rec){
    rec = { tex: generatedTex(entry), entry, shell:false };
    texCache.set(key, rec);
    if(iconMeta.has(key)) decideIcon(key);
  }
  if(P.IS_APP && S.settings.iconSource !== "generated" &&
     !iconMeta.has(key) && !iconAsked.has(key)){
    iconAsked.add(key);
    iconQueue.push({ path:key, gen:listGen });
    pumpIcons();
  }
  return rec;
}
/* meshFor() sends most game folders to the same device, so a shelf of Steam
   titles all inherited one reaction. Spread the personality by name instead:
   stable per folder, but neighbours differ. */
const ANIM_FAMILIES = ["hdd","ssd","m2","floppy","disc","usb"];
/* Six families is only six reactions. Movement and colour are runtime
   transforms rather than baked morphs, so they can vary per FOLDER — two hard
   drives side by side now flinch differently. */
const MOVES = ["spindown","stutter","buzz","swoon","capsize","freeze",
               "tremble","sob","droop","flip","recoil"];
const COPY_MOVES = ["none","tremble","buzz","droop","stutter"];
const TINTS = ["dim","chill","amber","ghost","drain","redshift","bleach","none"];
function hashOf(n){ let h = 2166136261;
  for(let i=0;i<n.length;i++){ h ^= n.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0; }
const moveFor = e => MOVES[hashOf(e.name) % MOVES.length];
const copyFor = e => COPY_MOVES[(hashOf(e.name) >>> 11) % COPY_MOVES.length];
const tintFor = e => TINTS[(hashOf(e.name) >>> 7) % TINTS.length];
function animFamily(e){
  let h = 0;
  const n = e.name;
  for(let i = 0; i < n.length; i++) h = (h * 33 + n.charCodeAt(i)) >>> 0;
  return ANIM_FAMILIES[h % ANIM_FAMILIES.length];
}

function glyphFor(e){
  const n = e.name.toLowerCase();
  if(/^(node_modules|vendor|packages|target)$/.test(n)) return "pkg";
  if(/^windows|winsxs|system32/.test(n)) return "win";
  if(/appdata|roaming|program|library/.test(n)) return "gear";
  if(/document|desktop/.test(n)) return "doc";
  if(/download|temp|cache/.test(n)) return "down";
  if(/video|movie|music|photo|picture|recording|media|obs/.test(n)) return "play";
  if(/steam|epic|game|emulation|iso/.test(n)) return "disc";
  if(/backup|archive/.test(n)) return "clock";
  return "app";
}

/* ------------------------------------------------------------------- layout */
/* Columns follow the window width so the cell stays a constant size; rows per
   page are fixed. More entries means more pages, never smaller icons. */
function gridDims(){
  const asp = R ? R.aspect() : 1.6;
  return { cols: Math.max(3, Math.min(8, Math.round(asp * 3.2))), rows: 3 };
}
function pageCount(){
  const { cols, rows } = gridDims();
  return Math.max(1, Math.ceil(Math.ceil(S.entries.length / cols) / rows));
}
function maxScroll(){
  const { cols, rows } = gridDims();
  return Math.max(0, Math.ceil(S.entries.length / cols) - rows);
}
/* Keep the cursor on screen, and keep the view inside the list as it grows. */
function ensureVisible(){
  const { cols, rows } = gridDims();
  const row = Math.floor(S.sel / cols);
  if(row < S.scroll) S.scroll = row;
  else if(row >= S.scroll + rows) S.scroll = row - rows + 1;
  S.scroll = Math.max(0, Math.min(S.scroll || 0, maxScroll()));
}

function layout(){
  if(S.screen === "devices"){
    const n = Math.max(1, S.volumes.length);
    return S.volumes.map((_,i) => {
      const x = n === 1 ? 0 : ((i+0.5)/n*2-1)*0.78;
      // five drives at 0.50 overlapped into one mass; scale with the count and
      // leave real space between them
      return { ndc:[x,0.02], cell:[Math.min(0.30,1.5/n), 0.40],
               scale: Math.min(0.34, 1.35/Math.max(3,n)) };
    });
  }
  const n = S.entries.length;
  if(!n) return [];
  /* The console kept every save the same size and let you scroll. Sizing the
     grid to fit the count instead shrinks 60 files into unreadable specks, so
     the cell is fixed and anything off-page simply is not laid out. */
  const { cols, rows } = gridDims();
  const first = Math.round(scrollAnim) * cols;
  const out = new Array(n).fill(null);
  for(let i = first; i < Math.min(n, first + cols*rows); i++){
    const r = Math.floor((i - first) / cols), c = i % cols;
    out[i] = {
      // the fractional part of the eased scroll slides the whole page
      ndc:[ ((c+0.5)/cols*2-1)*0.80,
            -(((r + (Math.round(scrollAnim)-scrollAnim) + 0.5)/rows*2-1))*0.46 - 0.03 ],
      /* cell is a FRACTION OF THE CONTAINER, as the devices branch above shows.
         The column pitch is (2/cols)*0.80 in NDC, so its fraction of the width
         is 0.80/cols — this read 1.6/cols*0.80, which is 1.6x too wide, and
         neighbouring cells overlapped by well over half a column. Long captions
         ran under the next icon and, worse, the hit boxes overlapped: the cell
         drawn later won the hover, so pointing just right of an icon selected
         its neighbour. 0.92 leaves the same gutter the row height already uses. */
      cell:[ 0.80/cols*0.92, 0.46/rows*0.92 ],
      scale: Math.min(1.7/cols, 1.0/rows)*0.55*iconTrim()
    };
  }
  return out;
}


/* -------------------------------------------------------------------- screens */
let cellEls = [];

function draw(){
  cellEls = [];
  setWindowLabel();
  // surf under the main menu, silence everywhere else
  Sound.ambience(S.screen === "menu");
  if(S.screen === "details" && !cur()) S.screen = "contents";
  if(S.screen === "boot")           drawBoot();
  else if(S.screen === "menu")      drawMenu();
  else if(S.screen === "config")    drawConfig();
  else if(S.screen === "details")   drawDetails();
  else                              drawBrowser();
  if(S.help) mountHelp();
}

function drawBoot(){
  osd.innerHTML =
    `<div class="boot" id="bootText">
       <div class="boot-name">${esc(boot.title)}</div>
       <div class="boot-sub" id="bootSub">${boot.sub}</div>
       <div class="boot-count" id="bootCount">${sizeText(0)}</div>
       <div class="boot-empty" id="bootEmpty" hidden>No Data</div>
     </div>
     <div class="foot"><div class="foot-keys">${footHints("boot")}</div></div>`;
}

function drawMenu(){
  const items = ["Browser","System Configuration"];
  osd.innerHTML =
    `<div class="menu-items" id="mi">${items.map((t,i) =>
       `<button data-mi="${i}" ${AK} aria-current="${i===S.menuSel}">${t}</button>`).join("")}</div>
     <div class="foot"><div class="foot-keys">${footHints("menu")}</div></div>`;
  osd.querySelectorAll("[data-mi]").forEach(b => {
    const i = +b.dataset.mi;
    b.onpointerenter = () => { if(S.menuSel!==i){ S.menuSel=i; syncSel(); Sound.move(); } };
    b.onclick = () => { S.menuSel=i; pickMenu(); };
  });
}

/* ------------------------------------------------------- system configuration
   Settings first, then what the machine is actually doing: which scanner is
   live, how much is cached, and the two actions that change it. */
const ICON_MODES = ["mixed","shell","generated"];
const ICON_LABEL = { mixed:"Mixed", shell:"Shell", generated:"Generated" };

/* Label size. Bigger captions need somewhere to go, and the only spare room is
   the icon above them — so each step trades a little icon for a lot of text
   rather than letting the two collide. LABEL_SCALE drives the CSS, ICON_TRIM
   the 3D scale, and they move together. */
const LABEL_MODES = ["normal","large","largest"];
const LABEL_LABEL = { normal:"Normal", large:"Large", largest:"Largest" };
const LABEL_SCALE = { normal:1, large:1.22, largest:1.45 };
const ICON_TRIM   = { normal:1, large:0.93, largest:0.86 };
function labelScale(){ return LABEL_SCALE[S.settings.labelSize] || 1; }
function iconTrim(){ return ICON_TRIM[S.settings.labelSize] || 1; }
function applyLabelSize(){
  document.documentElement.style.setProperty("--capScale", String(labelScale()));
}

function configRows(){
  const st = S.stats;
  const backend = st
    ? (st.backend === "mft" ? "MFT" : "Walk") +
      (st.backend !== "mft" && st.mftAvailable ? " · MFT available" : "") +
      (st.elevated ? " · elevated" : "")
    : "—";
  const cached = st
    ? `${(st.cachedPaths||0).toLocaleString("en-US")} · ${sizeText(st.cachedBytes||0)}`
    : "—";
  return [
    { k:"Sound", d:"Startup chime and interface tones",
      v:S.settings.sound ? "On" : "Off", act:() => toggleSetting("sound") },
    { k:"Icon animations", d:"Idle motion, copy and delete reactions",
      v:S.settings.animations ? "On" : "Off", act:() => toggleSetting("animations") },
    { k:"Confirm before delete", d:"Ask before moving anything to the Recycle Bin",
      v:S.settings.confirmDelete ? "On" : "Off", act:() => toggleSetting("confirmDelete") },
    { k:"Folder icons", d:"Mixed keeps the shell icon only where it is distinctive",
      v:ICON_LABEL[S.settings.iconSource], act:() => toggleSetting("iconSource") },
    { k:"Label size", d:"The name and size under each icon. Larger text trims the icons "
        + "a little to make room for it",
      v:LABEL_LABEL[S.settings.labelSize], act:() => toggleSetting("labelSize") },
    { k:"Size units", d:"Classic is the console's KB everywhere; Modern scales to MB, "
        + "GB and TB as the number needs",
      v:UNIT_LABEL[S.settings.sizeUnits], act:() => toggleSetting("sizeUnits") },
    { k:"Replay startup", d:"Run the opening sequence again from the beginning",
      v:"Play", go:true, act:replayStartup },
    { k:"Scan backend", d:"How the scanner reads the disk", v:backend },
    ...(P.IS_APP && st && st.backend !== "mft" && !st.elevated ? [{
      k:"Restart for fast scanning",
      d:"Reading the Master File Table needs Administrator. Windows will ask once, " +
        "then a whole drive indexes in seconds instead of walking every folder",
      v:"Restart", go:true, act:goElevated }] : []),
    { k:"Cached scans", d:"Folders held in memory, which is what makes going back instant",
      v:cached },
    { k:"Clear cache", d:"Drop them; the next visit reads the disk again",
      v:"Clear", go:true, act:clearScanCache },
    { k:"Mode", d:"How this build is running",
      v:P.IS_APP ? "Application" : "Preview (sample data)" }
  ];
}

/* Settings survive a restart. Each value is checked against the list it is
   allowed to take rather than trusted: a file from an older build, or one
   edited by hand, must not be able to put the app into a state its own menus
   cannot express or undo. Anything unrecognised keeps the default. */
const SETTING_VALUES = {
  sound:         [true, false],
  animations:    [true, false],
  confirmDelete: [true, false],
  iconSource:    ICON_MODES,
  labelSize:     LABEL_MODES,
  sizeUnits:     UNIT_MODES
};

async function loadSettings(){
  let stored = null;
  try{ stored = await P.loadSettings(); }catch{}
  if(!stored || typeof stored !== "object") return;
  for(const [k, allowed] of Object.entries(SETTING_VALUES))
    if(allowed.includes(stored[k])) S.settings[k] = stored[k];
}

/* Debounced: holding Enter on a row cycles it several times a second, and each
   of those would otherwise be a file write. */
let settingsTimer = 0;
function saveSettings(){
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => P.saveSettings({ ...S.settings }), 250);
}

/* The build, named quietly in the corner of the one screen that is about the
   program rather than about your disks. Read from the backend rather than typed
   here, so it is the version that was actually compiled. */
let appVersion = null;
const versionLine = () => "PlaySave " + (appVersion ? appVersion : "— preview build");

function drawConfig(){
  const rows = configRows();
  if(S.cfgSel >= rows.length) S.cfgSel = 0;
  const r = rows[S.cfgSel];
  const now = new Date(), p = n => String(n).padStart(2,"0");
  /* The console showed one setting at a time: gold heading, the setting in
     cyan, its value beneath, and a chevron telling you there is more. The
     cubes behind it carry the position. */
  osd.innerHTML =
    `<div class="cfg-clock">
       <span>${now.getFullYear()}/${p(now.getMonth()+1)}/${p(now.getDate())}</span>
       <span>${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}</span>
     </div>
     <div class="cfg">
       <h2>System Configuration</h2>
       <div class="cfg-row-live">
         <div class="cfg-text">
           <div class="cfg-name">${esc(r.k)}</div>
           <div class="cfg-val">${esc(r.v)}</div>
           <div class="cfg-desc">${esc(r.d)}</div>
         </div>
         <div class="cfg-updown" aria-hidden="true">
           <span class="${S.cfgSel > 0 ? "" : "off"}">&#9650;</span>
           <span class="${S.cfgSel < rows.length-1 ? "" : "off"}">&#9660;</span>
         </div>
       </div>
       <div class="cfg-dots">${rows.map((_,i) =>
         `<i class="${i===S.cfgSel?"on":""}"></i>`).join("")}</div>
     </div>
     <div class="foot"><div class="foot-keys">${footHints("config")}</div></div>
     <div class="cfg-version">${esc(versionLine())}</div>`;

  // the whole live row is the control, and each dot jumps to its setting
  const live = osd.querySelector(".cfg-row-live");
  if(live){
    live.style.cursor = "pointer";
    live.onclick = () => { const x = configRows()[S.cfgSel]; if(x && x.act) x.act(); else Sound.back(); };
  }
  const up = osd.querySelector(".cfg-updown span:first-child");
  const dn = osd.querySelector(".cfg-updown span:last-child");
  if(up){ up.style.cursor = "pointer"; up.onclick = e => { e.stopPropagation(); moveCfg(-1); }; }
  if(dn){ dn.style.cursor = "pointer"; dn.onclick = e => { e.stopPropagation(); moveCfg(1); }; }
  osd.querySelectorAll(".cfg-dots i").forEach((d,i) => {
    d.style.cursor = "pointer";
    d.onclick = () => { if(S.cfgSel !== i){ S.cfgSel = i; draw(); Sound.move(); } };
  });
}


function runCfg(i){
  const r = configRows()[i];
  if(r && r.act) r.act();
}
function moveCfg(d){
  const n = configRows().length;
  if(!n) return;
  S.cfgSel = (S.cfgSel + d + n) % n;
  draw();                 // the whole panel is one live row now, so redraw it
  Sound.move();
}

function toggleSetting(key){
  if(!key) return;
  if(key === "iconSource")
    S.settings.iconSource = ICON_MODES[(ICON_MODES.indexOf(S.settings.iconSource)+1) % ICON_MODES.length];
  else if(key === "sizeUnits")
    S.settings.sizeUnits = UNIT_MODES[(UNIT_MODES.indexOf(S.settings.sizeUnits)+1) % UNIT_MODES.length];
  else if(key === "labelSize"){
    S.settings.labelSize = LABEL_MODES[(LABEL_MODES.indexOf(S.settings.labelSize)+1) % LABEL_MODES.length];
    applyLabelSize();     // the 3D scale follows on the next frame, via layout()
  }
  else S.settings[key] = !S.settings[key];
  if(key === "sound"){ Sound.enable(S.settings.sound); if(S.settings.sound) Sound.enter(); }
  else Sound.enter();
  // switching source re-decides what is already cached; nothing is re-fetched
  if(key === "iconSource") applyIcons();
  saveSettings();
  draw();
}

async function refreshStats(){
  try{ S.stats = await P.scanStats(); }
  catch{ S.stats = null; }
  if(S.screen === "config") draw();
}

async function clearScanCache(){
  Sound.enter();
  await P.clearCache();
  selMemory.clear();
  await refreshStats();
  toast("Scan cache cleared");
}

function drawDetails(){
  const s = cur(), v = vol();
  // the same rule the grid uses, so Details and the icon never disagree.
  // The URL goes into a style attribute, so it is checked, not trusted.
  const meta = iconMeta.get(s.path);
  const ok = meta && typeof meta.url === "string" &&
             /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(meta.url);
  const thumb = ok && wantShell(meta.hash)
    ? `<div class="thumb icon" style="background-image:url('${meta.url}')"></div>`
    : `<div class="thumb"></div>`;
  osd.innerHTML =
    `<div class="info">
       <div class="info-title">${thumb}<h4>${esc(s.name)}</h4></div>
       <dl>
         <dt>Location</dt><dd>${esc(s.path)}</dd>
         <dt>File Type</dt><dd>${s.isDir ? "Folder" : "File"}</dd>
         <dt>File Size</dt><dd>${sizeText(s.sizeBytes)}</dd>
         <dt>Contains</dt><dd>${s.itemCount ? s.itemCount.toLocaleString("en-US")+" items" : "—"}</dd>
         <dt>Last Updated</dt><dd>${P.stamp(s.modifiedMs)}</dd>
         <dt>Volume</dt><dd>${esc(v ? v.name + " (" + v.mount + ")" : "—")}</dd>
       </dl>
     </div>
     <div class="foot"><div class="foot-keys">${footHints("details")}</div></div>`;
}

function drawBrowser(){
  const v = vol();
  const opts = S.screen === "options";
  const cpy  = S.screen === "copyto";
  if(S.screen === "devices"){
    osd.innerHTML =
      `<div class="head"><div><div class="head-card">This PC</div></div>
         <div class="head-r"><span class="ttl"></span></div></div>
       <div class="cells" id="cells"></div>
       <div class="foot"><div class="foot-keys">${footHints("devices")}</div></div>`;
  } else {
    const free = v ? v.freeBytes : 0;
    osd.innerHTML =
      `<div class="head">
         <div><div class="head-card">${esc(v?v.name:"—")} <small>(${esc(v?v.mount.replace(/\\$/,""):"")})</small></div>
           <div class="head-free">${sizeText(free)} Free</div>
           <div class="head-free">${esc(S.path||"")}</div>
           ${S.scanning ? `<div class="head-free scanning">Scanning · ${
             S.scanSeen}${S.scanTotal ? " / " + S.scanTotal : ""} measured · ${scanEvents} events</div>` : ""}</div>
         <div class="head-r"><span class="ttl"></span>${opts && cur()
            ? `<span class="sub">${P.stamp(cur().modifiedMs)}<br>${sizeText(cur().sizeBytes)}</span>` : ""}</div>
       </div>
       ${S.scanning ? `<div class="scanbar"><i style="width:${
          S.scanTotal ? Math.round(S.scanSeen/S.scanTotal*100) : 4}%"></i></div>` : ""}
       <div class="cells" id="cells"></div>
       ${opts ? menuHTML() : cpy ? copyHTML() : ""}
       ${cpy && copyMsg() ? `<div class="ct-msg">${esc(copyMsg())}</div>` : ""}
       ${S.deleting ? `<div class="deleting">${DELETING_MSG}</div>` : ""}
       ${S.copy.running ? `<div class="copying">${copyNoteHTML()}</div>` : ""}
       <div class="foot">${S.busy ? `<div class="scanning-note">Scanning…</div>` : ""}
         <div class="foot-keys">${footHints(
             opts ? "options"
           : cpy  ? (S.copy.stage === "folder" ? "copydir"
                   : S.copy.stage === "confirm" ? "copyask" : "copyto")
           : "contents")}</div></div>`;
  }
  buildCells();
  wireMenu();
  wireCopy();
  syncSel();
}

function menuHTML(){
  const items = S.confirm ? ["Yes","No"] : ["Open","Copy","Delete"];
  return `<div class="menu">${S.confirm ? `<div class="ask">Delete this data?</div>` : ""}` +
    items.map((t,i) => `<button data-opt="${i}" ${AK} aria-current="${i===S.opt}">${t}</button>`).join("") +
    `</div>`;
}

function buildCells(){
  const host = osd.querySelector("#cells");
  if(!host) return;
  const L = layout();
  const items = S.screen === "devices" ? S.volumes : S.entries;
  items.forEach((it,i) => {
    const g = L[i]; if(!g) return;
    const b = document.createElement("button");
    b.className = "cell" +
      ((S.screen === "options" || S.screen === "copyto") && i !== S.sel ? " dim" : "");
    b.style.left = ((g.ndc[0]+1)/2*100) + "%";
    b.style.top  = ((1-g.ndc[1])/2*100) + "%";
    b.style.width  = (g.cell[0]*100) + "%";
    b.style.height = (g.cell[1]*100) + "%";
    const sel = S.screen === "devices" ? S.vol : S.sel;
    b.dataset.idx = String(i);
    b.setAttribute("aria-current", String(i === sel));
    b.setAttribute("aria-keyshortcuts", "Enter");
    const name = S.screen === "devices" ? it.name : it.name;
    const meta = S.screen === "devices"
      ? sizeText(it.totalBytes - it.freeBytes) + " used"
      : (it.pending ? "measuring…" : sizeText(it.sizeBytes));
    b.innerHTML = `<span class="cap"><b></b><i>${esc(meta)}</i></span>`;
    b.querySelector("b").textContent = name;
    b.onpointerenter = () => {
      if(kbdMode) return;                     // the keyboard is driving
      if(S.screen === "devices" && S.vol !== i){ S.vol = i; syncSel(); Sound.move(); }
      else if(S.screen === "contents" && S.sel !== i){ S.sel = i; syncSel(); Sound.move(); }
    };
    b.onclick = () => {
      if(S.screen === "devices"){ S.vol = i; enterVolume(); }
      else if(S.screen === "contents"){ S.sel = i; S.screen = "options"; S.opt = 0; S.confirm = false; Sound.enter(); draw(); }
    };
    host.appendChild(b);
    cellEls.push(b);
  });
}

/* The console's picker was one control — the other memory card — because that
   was the only place a save could go. A disk has somewhere to put things, so
   this is two stages: which drive, then which folder on it. The confirm step
   spells out the full path that will be created, because "Copy" and an arrow
   is no longer enough to say where something is about to land. */

const SEP = "\\";
/* Rows the destination list shows at once. The panel is sized to exactly this
   many whole rows and scrolls; it also sets what PageUp and PageDown mean. */
const DEST_ROWS = 7;

/** The parent of a path, or null if it is already a drive root. */
function parentOf(p){
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  if(i < 0) return null;
  const head = t.slice(0, i);
  if(!head || /^[A-Za-z]:$/.test(head)) return /^[A-Za-z]:$/.test(head) ? head + SEP : null;
  return head;
}
const isRoot = p => /^[A-Za-z]:[\\/]?$/.test(p || "");
const tidy   = p => (p || "").replace(/[\\/]+$/, "") || p;
/* A drive root reads as "D:" once its separator is trimmed, which looks like a
   typo at the head of the screen. Roots keep theirs; nothing else does. */
const shown  = p => isRoot(p) ? tidy(p) + SEP : tidy(p);
/** Where the copy will actually land, spelled out in full. */
const copyTarget = () => {
  const c = S.copy;
  if(!c.dir || !c.src) return "";
  // the backend has already decided the name, clash and all; only fall back to
  // guessing while its answer is still in flight
  return c.plan ? c.plan.target : tidy(c.dir) + SEP + c.src.name;
};

function copyHTML(){
  const c = S.copy, d = c.dests[c.di];
  if(!d) return "";

  if(c.stage === "confirm"){
    return `<div class="menu copyto">
      <div class="ct-act">Copy <span class="ct-to">&#8594;</span></div>
      <div class="ct-path">${esc(copyTarget())}</div>
      ${c.plan && c.plan.renamed
        ? `<div class="ct-renamed">${esc(c.src.name)} is already there — this copy takes a new name</div>`
        : ""}
      <div class="ask">Are you sure?</div>
      <div class="yesno">
        <button data-yn="1" ${AK} aria-current="${c.yes}">Yes</button>
        <button data-yn="0" ${AK} aria-current="${!c.yes}">No</button>
      </div></div>`;
  }

  if(c.stage === "folder"){
    /* A plain scrolling list, which is what it was and what it should be. The
       jumping was never the scrollbar: it was hover-to-select. Every draw()
       rebuilds this panel, so moving the mouse towards the scrollbar dragged
       the selection down the rows it crossed and redrew — and each redraw threw
       the scroll position away. Mouse selection is gone here; a click opens a
       folder, the keyboard selects, and the bar is free to be used as a bar. */
    const n = c.kids.length;
    const rows = c.kbusy
      ? `<li class="ct-note">Reading&#8230;</li>`
      : n
        ? c.kids.map((k,i) =>
            `<li><button data-kid="${i}" ${AK} aria-current="${i===c.ksel}">${
              esc(k.name)}</button></li>`).join("")
        : `<li class="ct-note">No folders here</li>`;
    return `<div class="menu copyto">
      <div class="ct-act">Copy to</div>
      <div class="ct-path">${esc(shown(c.dir))}</div>
      <ul class="ct-list">${rows}</ul>
      <div class="ct-free">${n ? `${c.ksel+1} of ${n}  ·  ` : ""}${
        sizeText(d.freeBytes)} Free on ${esc(d.name)}</div>
    </div>`;
  }

  // stage: drive
  const fits = c.src && d.freeBytes > (c.src.sizeBytes || 0);
  return `<div class="menu copyto">
    <div class="ct-act">Copy</div>
    <div class="ct-arrow" aria-hidden="true">&#9660;</div>
    <div class="ct-pick">
      <button class="ct-chev" data-dest="-1" aria-label="Previous drive"
        ${c.dests.length > 1 ? "" : "disabled"}>&#9664;</button>
      <div class="ct-dest">${esc(d.name)} <small>(${esc(tidy(d.mount))})</small></div>
      <button class="ct-chev" data-dest="1" aria-label="Next drive"
        ${c.dests.length > 1 ? "" : "disabled"}>&#9654;</button>
    </div>
    <div class="ct-free${fits ? "" : " tight"}">${sizeText(d.freeBytes)} Free</div>
  </div>`;
}

/** The line under the panel: what this stage wants from you. */
function copyMsg(){
  const c = S.copy;
  if(c.stage === "drive")  return "Select destination for copying to.";
  if(c.stage === "folder") return "Copies to  " + tidy(copyTarget());
  return "";
}

function wireCopy(){
  osd.querySelectorAll("[data-dest]").forEach(b => {
    b.onclick = () => cycleDest(+b.dataset.dest);
  });
  /* No onpointerenter here, deliberately. Everywhere else in this app hovering
     moves the cursor, but this list has a scrollbar, and reaching for it means
     crossing rows — which would drag the selection along and redraw the list
     out from under the pointer. Click opens; the keyboard selects. */
  osd.querySelectorAll("[data-kid]").forEach(b => {
    const i = +b.dataset.kid;
    b.onclick = () => { S.copy.ksel = i; descendDest(); };
  });
  const row = osd.querySelector('.ct-list [aria-current="true"]');
  if(row && row.scrollIntoView) row.scrollIntoView({ block:"nearest" });
  osd.querySelectorAll("[data-yn]").forEach(b => {
    b.onpointerenter = () => { const y = b.dataset.yn === "1";
      if(S.copy.yes !== y){ S.copy.yes = y; draw(); Sound.move(); } };
    b.onclick = () => { S.copy.yes = b.dataset.yn === "1"; confirmCopy(); };
  });
}

function cycleDest(d){
  const c = S.copy, n = c.dests.length;
  if(n < 2) return;
  c.di = (c.di + d + n) % n;
  draw(); Sound.move();
}

/* Copy needs somewhere to go. On the console that was the other memory card;
   here it is any folder on any drive — including this one, because moving
   something to a different folder on the same disk is a perfectly ordinary
   thing to want and the console simply had no way to express it. */
function openCopy(){
  const s = cur(); if(!s) return;
  if(S.copy.running){ toast("A copy is already running", true); return; }
  const dests = S.volumes.filter(v => v.kind !== "cdrom");
  if(!dests.length){ toast("No drive to copy to", true); return; }
  // start on a drive that is not the source's, the way the console started on
  // the other card, but fall back rather than refusing
  const here = (S.path || "").slice(0,2).toUpperCase();
  let di = dests.findIndex(v => v.mount.slice(0,2).toUpperCase() !== here);
  if(di < 0) di = 0;
  S.copy = { src:{ path:s.path, name:s.name, sizeBytes:s.sizeBytes, isDir:s.isDir !== false },
             dests, di, stage:"drive",
             dir:null, kids:[], ksel:0, kbusy:false, kgen:0,
             yes:true, running:false, copied:0, total:0, files:0, totalFiles:0, ticked:false };
  S.screen = "copyto"; draw(); Sound.enter();
}

/* Read one folder's subfolders. Generation-stamped: arrow-keying quickly
   through a slow network drive can leave several of these in flight, and the
   last one to ANSWER is not necessarily the one you are looking at. */
let destGen = 0;
async function loadDest(path){
  const c = S.copy, g = ++destGen;
  c.kgen = g; c.dir = path; c.kids = []; c.ksel = 0; c.kbusy = true; c.plan = null;
  draw();
  let kids = [], plan = null;
  try{ kids = await P.listDirs(path); }
  catch(e){ if(c.kgen === g) toast(String(e && e.message ? e.message : e), true); }
  // what this folder would actually produce, name clash and all
  try{ plan = await P.copyPlan(c.src.path, path); }catch{}
  if(c.kgen !== g || S.screen !== "copyto") return;
  c.kids = kids || []; c.plan = plan; c.kbusy = false;
  draw();
}

function enterDest(){
  const c = S.copy, d = c.dests[c.di];
  if(!d) return;
  c.stage = "folder";
  Sound.enter();
  loadDest(d.mount);
}

function descendDest(){
  const c = S.copy;
  if(c.kbusy || !c.kids.length) return;
  const k = c.kids[Math.min(c.ksel, c.kids.length-1)];
  if(!k) return;
  Sound.enter();
  loadDest(k.path);
}

/** Up one level, and out of the folder stage entirely at the drive root. */
function ascendDest(){
  const c = S.copy;
  if(c.kbusy) return;
  if(isRoot(c.dir)){ c.stage = "drive"; draw(); Sound.back(); return; }
  const up = parentOf(c.dir);
  if(!up){ c.stage = "drive"; draw(); Sound.back(); return; }
  Sound.back();
  loadDest(up);
}

function askCopy(){
  const c = S.copy;
  if(c.kbusy || !c.dir) return;
  c.stage = "confirm"; c.yes = true; draw(); Sound.enter();
}

function confirmCopy(){
  if(!S.copy.yes){ S.copy.stage = "folder"; draw(); Sound.back(); return; }
  startCopy();
}

function wireMenu(){
  osd.querySelectorAll("[data-opt]").forEach(b => {
    const i = +b.dataset.opt;
    b.onpointerenter = () => { if(S.opt!==i){ S.opt=i; syncSel(); Sound.move(); } };
    b.onclick = () => { S.opt=i; chooseOption(); };
  });
}

/* Update selection in place. The mouse moves constantly, so hovering must not
   rebuild the DOM under the cursor — flip attributes and retarget text only. */
function syncSel(){
  const selIdx = S.screen === "devices" ? S.vol : S.sel;
  cellEls.forEach(b => {
    const i = +b.dataset.idx;           // the entry it stands for, not its position
    b.setAttribute("aria-current", String(i === selIdx));
    if(S.screen === "options") b.classList.toggle("dim", i !== selIdx);
  });
  const t = osd.querySelector(".ttl");
  if(t){
    if(S.screen === "devices"){ const v = vol();
      t.innerHTML = v ? esc(v.name) + ' <small>(' + esc(v.mount.replace(/\\$/,"")) + ')</small>' : "No Data"; }
    else { const s = cur(); t.textContent = s ? s.name : (S.busy ? "Scanning…" : "No Data"); }
  }
  const sub = osd.querySelector(".head-r .sub"), s = cur();
  if(sub && s) sub.innerHTML = P.stamp(s.modifiedMs) + "<br>" + sizeText(s.sizeBytes);
  osd.querySelectorAll("[data-opt]").forEach(b =>
    b.setAttribute("aria-current", String(+b.dataset.opt === S.opt)));
  osd.querySelectorAll("[data-mi]").forEach(b =>
    b.setAttribute("aria-current", String(+b.dataset.mi === S.menuSel)));
  osd.querySelectorAll("[data-cfg]").forEach(b => {
    const on = +b.dataset.cfg === S.cfgSel;
    b.setAttribute("aria-current", String(on));
    // the panel scrolls now, so keep the highlighted row on screen
    if(on && b.scrollIntoView) b.scrollIntoView({ block:"nearest" });
  });
}

/* ------------------------------------------------------------- keyboard sheet
   The footer is contextual and short; this is the full list, so that every
   binding is written down somewhere. Built from KEYMAP, never by hand. */
const SCREEN_NAME = {
  boot:"Startup", menu:"Main menu", devices:"Drives", contents:"Folder",
  options:"Options menu", details:"Details", config:"System Configuration"
};
function helpHTML(){
  const sec = (title, list) => !list.length ? "" :
    `<section><h4>${esc(title)}</h4>` + list.map(e =>
      `<div class="krow"><span class="keys">${keysHTML(e)}</span>` +
      `<span class="hl">${esc(e.label)}</span></div>`).join("") + `</section>`;
  // outside the app there is no window to make full screen, so don't claim one
  const global = KEYMAP.global.filter(e => e.keys[0] !== "F11" || !!appWin);
  return `<div class="help" id="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <div class="help-panel">
      <h3>Keyboard shortcuts</h3>
      ${sec(SCREEN_NAME[S.screen] || "This screen", KEYMAP[S.screen] || [])}
      ${sec("Anywhere", global)}
      <div class="foot foot-in">${footHints("help")}</div>
    </div>
  </div>`;
}
function mountHelp(){
  osd.insertAdjacentHTML("beforeend", helpHTML());
  const el = osd.querySelector("#help");
  if(el) el.onclick = ev => { if(!ev.target.closest(".help-panel")) toggleHelp(false); };
}
function toggleHelp(v){
  S.help = v === undefined ? !S.help : !!v;
  if(S.help) Sound.enter(); else Sound.back();
  draw();
}

/* ---------------------------------------------------------------- navigation */
function startVoid(mode, title, sub, onDone){
  boot.mode = mode; boot.t = 0; boot.towers = []; boot.bytes = 0;
  boot.seen = 0; boot.total = 0; boot.done = false; boot.exitT = null;
  boot.title = title; boot.sub = sub; boot.onDone = onDone;
  boot.minT = mode === "startup" ? 3.4 : 1.4;
  S.screen = "boot"; draw();
}
function finishBoot(){
  const fn = boot.onDone; boot.onDone = null;
  if(fn) fn(); else { S.screen = "menu"; draw(); }
}
function setBootSub(html){
  boot.sub = html;
  const el = document.getElementById("bootSub");
  if(el) el.innerHTML = html;
}

async function enterVolume(){
  const v = vol(); if(!v) return;
  Sound.enter();
  S.stack = []; S.path = v.mount;
  await loadDir(v.mount);
}

/* Where the cursor was in each folder, so coming back up lands on the folder
   you came out of rather than on the first one. */
const selMemory = new Map();
function rememberSel(){ if(S.path) selMemory.set(S.path, S.sel); }

function adoptScan(res, path){
  S.entries = (res.entries||[]).map(e => ({ ...e, mesh: P.meshFor(e) }));
  S.path = res.path || path;
  const want = selMemory.has(S.path) ? selMemory.get(S.path) : 0;
  S.sel = Math.max(0, Math.min(want, S.entries.length - 1));
}

/* A scan runs behind the void sequence. Towers grow as each top-level folder
   reports in, so the animation is a readout of the work rather than a timer.

   A folder the backend still holds never gets there: it is adopted and drawn in
   the same turn, with no animation at all. That is what makes going back up
   feel instant — it is the same code path as forward navigation, minus the
   wait, because there was nothing to wait for. */
/* The header read whichever drive you last selected, even after navigating to
   another volume. Derive it from the path instead. */
function syncVolumeFor(path){
  if(!path) return;
  const root = (path.slice(0,2) + "\\").toUpperCase();
  const i = S.volumes.findIndex(v => (v.mount||"").toUpperCase() === root);
  if(i >= 0 && i !== S.vol) S.vol = i;
}

async function loadDir(path, opts){
  const force = !!(opts && opts.force);
  rememberSel();
  listGen++;
  if(!force){
    const hit = await P.scanCached(path);
    if(hit){
      adoptScan(hit, path); S.scroll = 0; syncVolumeFor(path);
      S.busy = false; S.screen = "contents"; draw();
      return;
    }
  }
  /* Explore while it loads. The old flow parked you on the void until the
     whole walk finished; now the folder opens straight away and rows land as
     the scanner reports them, so you can select, drill in and delete while the
     rest is still being measured. The void is for startup only. */
  S.sel = 0; S.entries = []; S.busy = true;
  S.path = path; S.scanning = path; S.scanSeen = 0; S.scanTotal = 0;
  S.scroll = 0; syncVolumeFor(path);
  S.screen = "contents"; draw();
  const t0 = performance.now();
  try{
    const res = await P.scanChildren(path);
    const measured = (performance.now() - t0) / 1000;
    const secs = typeof res.elapsedMs === "number" ? res.elapsedMs / 1000 : measured;
    S.scanning = null;
    adoptScan(res, path);
    pruneTextures();
    if(!boot.towers.length)
      boot.towers = S.entries.slice(0,40).map(e => ({ value: Math.max(1,e.sizeBytes), grow:0 }));
    boot.bytes = res.totalBytes || 0;
    const bits = [`${S.entries.length} items`,
                  `${(res.fileCount||0).toLocaleString("en-US")} files`,
                  `${secs < 1 ? Math.round(secs*1000)+" ms" : secs.toFixed(1)+" s"}`];
    if(res.errors) bits.push(`${res.errors.toLocaleString("en-US")} unreadable`);
    toast(bits.join("  ·  "));
  }catch(e){
    S.entries = []; S.busy = false; toast("Could not read " + path + " — " + e, true);
  }
  boot.done = true;
}

function goUp(){
  rememberSel();
  if(S.stack.length){ const p = S.stack.pop(); loadDir(p); }
  else { listGen++; S.screen = "devices"; draw(); }
  Sound.back();
}

/* F5, as in Explorer: read this folder again and ignore what is cached. */
function refresh(){
  if(S.screen === "devices"){ refreshVolumes(); return; }
  if(S.screen === "contents" && S.path){ Sound.enter(); loadDir(S.path, { force:true }); }
}
async function refreshVolumes(){
  Sound.enter();
  try{
    S.volumes = await P.listVolumes();
    if(S.vol >= S.volumes.length) S.vol = Math.max(0, S.volumes.length - 1);
    draw();
    toast(`${S.volumes.length} drive${S.volumes.length===1?"":"s"}`);
  }catch(e){ toast("Could not list drives: " + e, true); }
}

function pickMenu(){
  Sound.enter();
  if(S.menuSel === 0){ listGen++; S.screen = "devices"; draw(); }
  else { S.cfgSel = 0; S.screen = "config"; draw(); refreshStats(); }
}

function openDetails(){
  if(S.screen !== "contents" || !cur()) return;
  S.screen = "details"; draw(); Sound.enter();
}

function chooseOption(){
  if(S.confirm){
    if(S.opt === 0){ startDelete(); } else { S.confirm=false; S.opt=2; draw(); Sound.back(); }
    return;
  }
  const s = cur(); if(!s) return;
  if(S.opt === 0){                                    // Open
    Sound.enter();
    rememberSel();
    S.stack.push(S.path);
    loadDir(s.path);
  } else if(S.opt === 1){                             // Copy
    if(anim.mode!=="idle") return;
    openCopy();
  } else {                                            // Delete
    if(S.settings.confirmDelete){ S.confirm=true; S.opt=1; draw(); Sound.enter(); }
    else startDelete();
  }
}

/* The console held "Deleting… Do not remove memory card." at the foot of the
   screen for the whole erase, pulsing. Ours says the same thing about the drive
   and, more usefully, is honest: it stays up until the recycle actually returns.
   Adding the node by hand rather than redrawing keeps the CSS pulse from
   restarting and leaves the cells under the cursor alone. */
const DELETING_MSG = "Deleting…  Do not remove the drive.";
const COPYING_MSG  = "Copying…  Do not remove the drive.";

/* The console said only "do not remove the card". A copy here can be hundreds
   of gigabytes, so the same warning carries a real denominator underneath it —
   measured by the backend before the first byte moves, not guessed. */
function copyNoteHTML(){
  const c = S.copy;
  // An empty folder really does total zero bytes, so the ratio cannot be the
  // only source of the percentage or it would sit on "measuring" to the end.
  const pct = c.total ? Math.min(100, Math.round(c.copied / c.total * 100))
            : (c.ticked ? 100 : 0);
  const detail = c.ticked
    ? `${pct}%  ·  ${sizeText(c.copied)} of ${sizeText(c.total)}`
    : "measuring…";
  return `<b>${COPYING_MSG}</b><i>${esc(detail)}</i>`;
}
function showCopying(on){
  S.copy.running = on;
  let el = osd.querySelector(".copying");
  if(on){
    if(!el){ el = document.createElement("div"); el.className = "copying"; osd.appendChild(el); }
    el.innerHTML = copyNoteHTML();
  } else if(el) el.remove();
}
function showDeleting(on){
  S.deleting = on;
  const have = osd.querySelector(".deleting");
  if(on && !have){
    const d = document.createElement("div");
    d.className = "deleting";
    d.textContent = DELETING_MSG;
    osd.appendChild(d);
  } else if(!on && have) have.remove();
}

/* Remove the deleted row — but only once the delete has actually SUCCEEDED,
   and only if the listing on screen is still the one the row came from.
   Splicing a captured index on a wall-clock timer removed an innocent sibling
   if the user navigated during the animation, and claimed success even when
   the recycle later failed. Match on path and folder, not position. */
function commitPending(){
  const p = anim.pending;
  anim.pending = null;
  if(!p || !p.ok) return;
  if(p.dir !== S.path) return;
  const i = S.entries.findIndex(e => e.path === p.path);
  if(i < 0) return;
  S.entries.splice(i, 1);
  if(S.sel >= S.entries.length) S.sel = Math.max(0, S.entries.length - 1);
  draw();
}

async function startCopy(){
  const c = S.copy;
  if(!c.src || !c.dir || c.running) return;
  const dest = c.dir;
  c.copied = 0; c.total = 0; c.files = 0; c.totalFiles = 0; c.ticked = false;
  c.running = true;
  anim.mode = "copy"; anim.t = 0;
  S.screen = "contents"; draw(); Sound.enter();
  // as with the erase: long enough to be read even if the copy is instant
  const held = new Promise(r => setTimeout(r, 1200));
  try{
    const made = await P.copyInto(c.src.path, dest);
    /* The last progress event lands in the same tick the promise resolves, so
       tearing the band down here would leave it reading whatever it happened to
       show. Snap it to full and let it be seen finishing. */
    c.copied = c.total; c.ticked = true;
    const band = osd.querySelector(".copying");
    if(band) band.innerHTML = copyNoteHTML();
    await held;
    await new Promise(r => setTimeout(r, 350));
    // the backend returns the path it created, which is not always the name
    // that was asked for
    const madeName = typeof made === "string" && made
      ? made.replace(/[\\/]+$/,"").split(/[\\/]/).pop() : c.src.name;
    toast(madeName === c.src.name
      ? `${c.src.name} copied to ${tidy(dest)}`
      : `${c.src.name} copied to ${tidy(dest)} as ${madeName}`);
    /* The destination has less room than it did and every cached total that
       counted it is now wrong, so drop the lot and re-read the drives. Matching
       by mount rather than trusting the index: a drive appearing or vanishing
       mid-copy would otherwise silently move the cursor to a different one. */
    await P.clearCache();
    try{
      const was = vol(), vs = await P.listVolumes();
      if(vs && vs.length){
        S.volumes = vs;
        if(was){ const i = vs.findIndex(v => v.mount === was.mount); if(i >= 0) S.vol = i; }
      }
    }catch{}
    if(S.screen === "config") refreshStats();
  }catch(e){
    toast(String(e && e.message ? e.message : e), true);
  }
  showCopying(false);
  anim.mode = "idle"; anim.t = 0; anim.last = null;
  draw();
}

async function startDelete(){
  const s = cur(); if(!s || anim.mode!=="idle") return;
  // deleting the source out from under a running copy is a guaranteed failure
  if(S.copy.running){ toast("Wait for the copy to finish", true); return; }
  /* Deleting anything while a copy is reading the disk is asking for a
     half-copied folder with a missing source. */
  if(S.copy.running){ toast("Wait for the copy to finish", true); return; }
  anim.mode="delete"; anim.t=0; anim.shrink=1;
  anim.pending={ path:s.path, dir:S.path, ok:false };
  S.confirm=false; S.screen="contents"; S.deleting=true; draw(); Sound.erase();
  // a fast recycle must not flash the warning past before it can be read
  const held = new Promise(r => setTimeout(r, 2200));
  try{
    await P.recycle(s.path);
    if(anim.pending) anim.pending.ok = true;
    else {           // the animation already finished; remove it now
      const i = S.entries.findIndex(e => e.path === s.path);
      if(i >= 0){ S.entries.splice(i,1);
        if(S.sel >= S.entries.length) S.sel = Math.max(0,S.entries.length-1);
        draw(); }
    }
    /* Every cached scan that contained this folder is now wrong — its own
       listing, and every ancestor's total. The contract has no per-path
       invalidation, so the honest move is to drop the lot and pay for one
       re-scan rather than show a size that no longer exists. */
    await P.clearCache();
    if(S.screen === "config") refreshStats();
    toast(`${s.name} moved to the Recycle Bin`);
  }catch(e){
    // it failed, so stop warning about an erase that is not happening — holding
    // the message for the rest of its minimum would contradict the error toast
    anim.mode="idle"; anim.pending=null; anim.alpha=1; anim.shrink=1;
    S.deleting=false;
    toast(String(e && e.message ? e.message : e), true);
    draw();
    return;
  }
  await held;
  showDeleting(false);
}

function back(){
  /* A copy can run for minutes. Esc has to reach it before it unwinds any
     screen, or the only way out would be to kill the app mid-write. */
  if(S.copy.running){ P.cancelCopy(); toast("Cancelling the copy…"); return; }
  if(S.screen === "copyto"){
    const c = S.copy;
    if(c.stage === "confirm"){ c.stage = "folder"; draw(); Sound.back(); }
    else if(c.stage === "folder"){ c.stage = "drive"; draw(); Sound.back(); }
    else { S.screen = "options"; S.opt = 1; draw(); Sound.back(); }
    return;
  }
  if(S.screen === "options"){ if(S.confirm){ S.confirm=false; S.opt=2; } else S.screen="contents"; draw(); Sound.back(); }
  else if(S.screen === "details"){ S.screen="contents"; draw(); Sound.back(); }
  else if(S.screen === "contents") goUp();
  else if(S.screen === "devices"){ S.screen="menu"; draw(); Sound.back(); }
  else if(S.screen === "config"){ S.screen="menu"; draw(); Sound.back(); }
}

/* Skipping cuts to the rush rather than teleporting — and a scan can't be
   skipped past its own data, so it only shortens the wait. */
/* Skip cuts to the rush. A scan cannot skip past data that has not arrived, so
   there it collapses the animation to its minimum and gets out of the way the
   instant the walk lands — the key always does something, which is the point,
   since the footer advertises it. */
function skipBoot(){
  if(S.screen !== "boot") return false;
  if(boot.exitT !== null) return true;             // already rushing
  if(boot.done || boot.mode === "startup"){
    boot.done = true; boot.exitT = boot.t;
  } else {
    boot.minT = 0;                                 // leave the moment it can
    boot.skipped = true;
  }
  Sound.enter();
  return true;
}

/* ------------------------------------------------------- application shell
   WebView2 draws the interface, so anything that would give away a browser has
   to be switched off: the page context menu, reload and find, pinch zoom, and
   dropping a file onto the window navigating away from the app. */
const appWin = window.__TAURI__?.window?.getCurrentWindow?.() ?? null;

addEventListener("contextmenu", e => e.preventDefault());
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", e => e.preventDefault());
addEventListener("wheel", e => { if(e.ctrlKey) e.preventDefault(); }, { passive:false });

/* The wheel is how people expect to move through a list on a PC. */
addEventListener("wheel", e => {
  if(e.ctrlKey) return;
  if(S.screen === "config"){ moveCfg(e.deltaY > 0 ? 1 : -1); return; }
  if(S.screen !== "contents") return;
  const before = S.scroll || 0;
  S.scroll = Math.max(0, Math.min(before + (e.deltaY > 0 ? 1 : -1), maxScroll()));
  if(S.scroll !== before) draw();
}, { passive:true });
addEventListener("keydown", e => {
  const k = e.key.toLowerCase();
  if(e.ctrlKey && ["r","f","p","g","j","u","s","+","-","0","="].includes(k)){
    e.preventDefault(); e.stopPropagation(); return;
  }
  /* F5, Backspace and Alt+Arrow are reload and history in a browser. Here they
     are Refresh and Back, so the browser behaviour is cancelled but the event
     is left to reach the application handler below. */
  if(e.key === "F5" || e.key === "Backspace" || e.key === "F1" ||
     (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"))) e.preventDefault();
  if(e.key === "F11" && appWin){
    e.preventDefault();
    appWin.isFullscreen().then(v => appWin.setFullscreen(!v)).catch(() => {});
  }
}, true);

const tb = id => document.getElementById(id);
tb("tbMin").onclick   = () => appWin?.minimize();
tb("tbMax").onclick   = () => appWin?.toggleMaximize();
tb("tbClose").onclick = () => appWin?.close();
function setWindowLabel(){
  const bits = ["PlaySave"];
  if(S.screen === "config") bits.push("System Configuration");
  else if(S.path) bits.push(S.path);
  else if(S.screen === "devices") bits.push("This PC");
  tb("tbName").textContent = bits.join("  —  ");
}

/* -------------------------------------------------------------------- input
   Every branch here corresponds to an entry in KEYMAP above, and every entry in
   KEYMAP has a branch here. */
osd.addEventListener("click", e => {
  const t = e.target.closest && e.target.closest("[data-key]");
  if(!t) return;
  const parts = String(t.dataset.key).split("+");
  // display name -> the value the DOM actually reports
  const REAL = { Esc:"Escape", Spacebar:" ", Space:" ", Del:"Delete", Ins:"Insert" };
  const shown = parts[parts.length - 1];
  const k = REAL[shown] || shown;
  dispatchEvent(new KeyboardEvent("keydown", {
    key: k,
    altKey:  parts.includes("Alt"),
    ctrlKey: parts.includes("Ctrl"),
    shiftKey:parts.includes("Shift"),
    bubbles: true, cancelable: true
  }));
});

addEventListener("pointermove", e => {
  if(e.clientX === lastPx && e.clientY === lastPy) return;   // redraw jitter, not a move
  lastPx = e.clientX; lastPy = e.clientY;
  kbdMode = false;
}, true);

canvas.addEventListener("pointerdown", e => { if(skipBoot()) e.preventDefault(); });

addEventListener("keydown", e => {
  const k = e.key;
  const space = k === " " || k === "Spacebar";
  const go = k === "Enter" || space;

  if(k === "F1"){ e.preventDefault(); toggleHelp(); return; }
  if(S.help){                                   // the sheet swallows everything else
    if(k === "Escape"){ e.preventDefault(); toggleHelp(false); }
    return;
  }
  if(S.screen === "boot"){
    if(go || k === "Escape"){ e.preventDefault(); skipBoot(); }
    return;
  }
  if(k === "Escape"){ back(); e.preventDefault(); return; }

  if(S.screen === "menu"){
    if(k === "ArrowUp" || k === "ArrowDown"){
      S.menuSel = (S.menuSel + (k === "ArrowUp" ? -1 : 1) + 2) % 2; syncSel(); Sound.move(); e.preventDefault(); }
    else if(go){ pickMenu(); e.preventDefault(); }
    return;
  }
  if(S.screen === "config"){
    if(k === "ArrowUp" || k === "ArrowDown"){ moveCfg(k === "ArrowUp" ? -1 : 1); e.preventDefault(); }
    else if(go){ runCfg(S.cfgSel); e.preventDefault(); }
    return;
  }
  if(S.screen === "details"){
    if(k === "Backspace"){ back(); e.preventDefault(); }
    return;
  }

  if(S.screen === "copyto"){
    const c = S.copy;
    e.preventDefault();
    if(c.stage === "confirm"){
      if(k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown"){
        c.yes = !c.yes; draw(); Sound.move(); }
      else if(go) confirmCopy();
      return;
    }
    if(c.stage === "folder"){
      /* Enter and Space part company here, and only here: Enter goes DOWN a
         level, Space takes the folder you are looking at. One key cannot mean
         both, and the footer says which is which. */
      const n = c.kids.length;
      const to = i => { if(!n) return; const j = Math.max(0, Math.min(n-1, i));
        if(j !== c.ksel){ c.ksel = j; draw(); Sound.move(); } };
      if(k === "ArrowUp" || k === "ArrowDown"){
        if(n){ c.ksel = (c.ksel + (k === "ArrowUp" ? -1 : 1) + n) % n; draw(); Sound.move(); } }
      else if(k === "PageUp")   to(c.ksel - DEST_ROWS);
      else if(k === "PageDown") to(c.ksel + DEST_ROWS);
      else if(k === "Home")     to(0);
      else if(k === "End")      to(n - 1);
      else if(space) askCopy();
      else if(k === "Enter" || k === "ArrowRight") descendDest();
      else if(k === "Backspace" || k === "ArrowLeft") ascendDest();
      return;
    }
    if(k === "ArrowLeft") cycleDest(-1);
    else if(k === "ArrowRight") cycleDest(1);
    else if(go) enterDest();
    return;
  }

  if(S.screen === "options"){
    const n = S.confirm ? 2 : 3;
    if(k === "ArrowUp"){ S.opt=(S.opt-1+n)%n; syncSel(); Sound.move(); e.preventDefault(); }
    else if(k === "ArrowDown"){ S.opt=(S.opt+1)%n; syncSel(); Sound.move(); e.preventDefault(); }
    else if(go){ chooseOption(); e.preventDefault(); }
    return;
  }

  // devices | contents
  if(k === "F5"){ e.preventDefault(); refresh(); return; }
  if(S.screen === "contents"){
    if(e.altKey && k === "Enter"){ e.preventDefault(); openDetails(); return; }
    if(e.altKey && (k === "ArrowLeft" || k === "ArrowUp")){ e.preventDefault(); goUp(); return; }
    if(k === "Backspace"){ e.preventDefault(); goUp(); return; }
  }
  const items = S.screen === "devices" ? S.volumes : S.entries;
  const n = items.length;
  if(go && !e.altKey){
    if(S.screen === "devices") enterVolume();
    else if(cur()){ S.screen="options"; S.opt=0; S.confirm=false; draw(); Sound.enter(); }
    e.preventDefault(); return;
  }
  /* The icons sit in a grid, so Up and Down must move a ROW, not one item.
     Mapping all four arrows to +/-1 made the footer's four-arrow "Select" hint
     a half-truth. Devices are a single row, so there they stay horizontal. */
  if(S.screen === "contents" && (k === "PageDown" || k === "PageUp" || k === "Home" || k === "End")){
    const { cols, rows } = gridDims();
    if(k === "Home") S.sel = 0;
    else if(k === "End") S.sel = Math.max(0, S.entries.length - 1);
    else S.sel = Math.max(0, Math.min(S.entries.length - 1,
      S.sel + (k === "PageDown" ? 1 : -1) * cols * rows));
    ensureVisible(); draw(); Sound.move(); e.preventDefault(); return;
  }
  const horiz = { ArrowLeft:-1, ArrowRight:1 }[k];
  const vert  = { ArrowUp:-1, ArrowDown:1 }[k];
  if(horiz === undefined && vert === undefined) return;
  if(!n) return;
  e.preventDefault();
  if(S.screen === "devices"){
    const d = horiz !== undefined ? horiz : vert;
    S.vol = (S.vol + d + n) % n; syncSel();
  } else {
    const { cols } = gridDims();
    let i = S.sel;
    if(horiz !== undefined) i = (i + horiz + n) % n;
    else {
      i += vert * cols;
      // stepping off the end wraps by column, so the cursor never gets stuck
      if(i >= n) i = (i % cols) % n;
      else if(i < 0){
        const col = ((S.sel % cols) + cols) % cols;
        const last = n - 1;
        i = Math.floor((last - col) / cols) * cols + col;
        if(i > last || i < 0) i = last;
      }
    }
    S.sel = i; ensureVisible(); draw();
  }
  Sound.move();
});

/* ------------------------------------------------------------- palette state */
const SILVER = ["#b9b9b7","#9d9d9b","#6f6f6d","#8a8a88"];
const VOID   = ["#0a1224","#070d1c","#01030a","#040914"];   // the dark navy of the first pass
const BLACK  = ["#05070c","#03050a","#000000","#010204"];
const VIOLET = ["#4a3670","#3a2a5e","#140b28","#241541"];   // the console's own field
const bgCur=[[0,0,0],[0,0,0],[0,0,0],[0,0,0]], bgTgt=[[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
const glowCur=[0,0], glowTgt=[0,0];
let glowA=0, glowT=0, rippleC=0, rippleT=0, sparkC=0, sparkT=0, ringC=0, ringT=0, swirlC=0, swirlT=0;

function palette(){
  // the per-save gradient only appears once you drill INTO a save; the grid
  // itself stays on the neutral silver ground
  let cols = SILVER;
  if(S.screen === "boot") cols = VOID;
  else if(S.screen === "menu") cols = BLACK;
  else if(S.screen === "config") cols = VIOLET;
  else if((S.screen === "options" || S.screen === "details") && cur())
    cols = P.paletteFor(cur().name).bg;
  cols.forEach((h,i) => { bgTgt[i] = hex(h); });
  rippleT = S.screen === "devices" ? 1 : (S.screen==="contents"||S.screen==="options") ? 0.25 : 0;
  sparkT  = S.screen === "boot" ? 1 : 0;
  ringT   = S.screen === "menu" ? 1 : 0;
  swirlT  = S.screen === "config" ? 1 : 0;
  glowT   = (S.screen === "devices" || S.screen === "contents" || S.screen === "options") ? 1 : 0;
  const L = layout();
  const g = L[S.screen === "devices" ? S.vol : Math.min(S.sel, L.length-1)];
  if(g){ const asp = R ? R.aspect() : 1.6;
    glowTgt[0] = g.ndc[0]*0.5*asp; glowTgt[1] = g.ndc[1]*0.5; }
}

/* --------------------------------------------------------------- frame loop */
let last = performance.now();
function frame(now){
  const dt = Math.min((now-last)/1000, 0.05); last = now;
  if(!REDUCED) clock += dt;
  if(!R){ requestAnimationFrame(frame); return; }
  R.resize(); palette();

  const k = Math.min(1, dt*5);
  const target = S.scroll || 0;
  if(Math.abs(scrollAnim - target) > 0.001){
    scrollAnim += (target - scrollAnim) * Math.min(1, dt*11);
    if(S.screen === "contents") scheduleLiveDraw();
  } else scrollAnim = target;
  for(let i=0;i<4;i++) for(let c=0;c<3;c++) bgCur[i][c] += (bgTgt[i][c]-bgCur[i][c])*k;
  glowCur[0]+=(glowTgt[0]-glowCur[0])*k; glowCur[1]+=(glowTgt[1]-glowCur[1])*k;
  glowA+=(glowT-glowA)*k; rippleC+=(rippleT-rippleC)*k;
  sparkC+=(sparkT-sparkC)*k; ringC+=(ringT-ringC)*k; swirlC+=(swirlT-swirlC)*k;

  R.background({ time: REDUCED?9:clock, bg:bgCur, glowPos:glowCur,
    glow: glowA*0.55, ripple: rippleC, spark: sparkC*0.9, ring: ringC, swirl: swirlC });

  if(S.screen === "boot"){
    boot.t += dt;
    for(const tw of boot.towers) tw.grow = Math.min(1, (tw.grow||0) + dt*1.9);

    let camZ, tilt, fade, roll = 0, camY = -0.10;
    if(boot.exitT === null){
      // the creep. Slow, tilting, and open-ended — it lasts as long as the work.
      const k = Math.min(1, boot.t/9);
      // Flying OVER the towers looking down them, not across them at 50 degrees.
      // At ~80 degrees the columns foreshorten to their tops, which is the view.
      camZ = 4.2 - 0.5*k;
      camY = -3.684 - 0.10*k;   // solved, projection scale included
      tilt = 1.38 + 0.06*k;
      roll = -0.06*k;            // barely any: the roll was the "weird angle"
      roll = -0.28*k;            // clockwise on screen
      fade = Math.min(1, boot.t/1.1);
      if(boot.done && boot.t > boot.minT) boot.exitT = boot.t;
    } else {
      // the rush: sudden acceleration into the mist, text fading out with it
      const e = Math.min(1, (boot.t - boot.exitT)/0.75), ee = e*e;
      camZ = 3.7 - 2.9*ee;
      camY = -3.784 - 0.9*ee;
      tilt = 1.44 + 0.10*ee;
      roll = -0.06 - 0.45*ee;    // the spin arrives with the dive
      roll = -0.28 - 1.15*ee;    // the roll accelerates with the rush
      fade = Math.max(0, 1 - e*1.5);
      if(e >= 1){ finishBoot(); }
    }

    R.voidScene(boot.towers, boot.t, { camZ, tilt, roll, camY });

    const bt = document.getElementById("bootText");
    if(bt) bt.style.opacity = fade.toFixed(3);
    const bc = document.getElementById("bootCount");
    if(bc) bc.textContent = sizeText(boot.bytes) +
      (boot.total ? `   ·   ${boot.seen} / ${boot.total}` : "");
    const be = document.getElementById("bootEmpty");
    if(be) be.hidden = boot.towers.length > 0 || boot.t < 1.2;
  } else if(S.screen === "config"){
    R.configCubes(configRows().length, S.cfgSel, REDUCED ? 6 : clock);
  } else if(S.screen === "menu" || S.screen === "details"){
    /* nothing 3D on these screens */
  } else {
    const sel = advanceAnim(dt);
    const halfH = R.halfH(), asp = R.aspect();
    const L = layout();
    const items = (S.screen === "devices" ? S.volumes : S.entries).map((it,i) => {
      const g = L[i]; if(!g) return null;
      const isVol = S.screen === "devices";
      const pal = isVol ? null : P.paletteFor(it.name);
      const rec = isVol ? null : iconTexture(it);
      return {
        move:      isVol ? undefined : moveFor(it),
        copyMove:  isVol ? undefined : copyFor(it),
        tintStyle: isVol ? undefined : tintFor(it),
        srcIndex: i,                    // position in the FULL listing; the
                                        // array below is compacted by paging
        // once the genuine shell icon has resolved, drop the chassis: the logo
        // stands on its own, which is what it is
        mesh: isVol ? (it.kind === "removable" ? "usb" : "hdd")
                    : (rec && rec.shell ? "card_" + animFamily(it) : it.mesh),
        x: g.ndc[0]*halfH*asp,
        y: g.ndc[1]*halfH + g.cell[1]*halfH*0.42,
        scale: g.scale,
        rgb: isVol ? (i===S.vol ? [0.62,0.72,0.86] : [0.26,0.27,0.30]) : hex(pal.tint),
        tex: rec ? rec.tex : null,
        phase: i*1.37
      };
    }).filter(Boolean);
    // `items` is compacted, so the selection has to be found by identity, not
    // by the index into the full listing
    const wanted = S.screen === "devices" ? S.vol : S.sel;
    const selIdx = items.findIndex(x => x.srcIndex === wanted);
    // "Icon animations: Off" must also stop the idle motion, not just reactions
    const t = (REDUCED || !S.settings.animations) ? 9 : clock;
    R.icons(items, selIdx, sel, t, S.screen === "options" || S.screen === "copyto");
  }
  requestAnimationFrame(frame);
}

/* The selected icon's state. Hover states come straight off the menu, because
   on the console the delete icon is what you saw when you were ABOUT to delete
   — Xiaoyu crying instead of jumping — not only once it was underway. */
function advanceAnim(dt){
  /* With animations off there is nothing to draw, but the state machine still
     has to run: it is the only thing that clears anim.mode and commits the
     pending removal. Short-circuiting here used to strand mode at "delete"
     forever, silently killing every later Delete and Copy. */
  if(!S.settings.animations){
    if(anim.mode !== "idle"){
      commitPending();
      anim.mode = "idle"; anim.t = 0; anim.alpha = 1; anim.last = null; anim.shrink = 1;
    }
    return { mode:"idle", tween:0.3, spin:0, alpha:1, intensity:0, shrink:1 };
  }
  let mode = anim.mode;
  if(mode === "idle" && S.screen === "options")
    mode = S.confirm ? "hoverDelete" : (S.opt === 2 ? "hoverDelete" : S.opt === 1 ? "hoverCopy" : "idle");
  if(mode === "idle" && S.screen === "copyto") mode = "hoverCopy";
  if(mode !== anim.last){ anim.h = 0; anim.last = mode; }
  if(mode !== "delete") anim.shrink = 1;

  let target="idle", from="pos", tween=0, intensity=0;
  if(mode === "idle"){
    tween = 0.30+0.30*Math.sin(clock*1.7);
    anim.spin += dt*0.55;
    anim.alpha += (1-anim.alpha)*Math.min(1,dt*5);
  } else if(mode === "hoverCopy"){
    target="dup"; anim.h += (0.42-anim.h)*Math.min(1,dt*6);
    tween=anim.h; anim.spin += dt*1.5; anim.alpha=1;
  } else if(mode === "hoverDelete"){
    target="cower"; anim.h += (1-anim.h)*Math.min(1,dt*7);
    tween=anim.h; intensity=anim.h; anim.spin += dt*0.10; anim.alpha=1;
  } else if(mode === "copy"){
    anim.t+=dt; target="dup"; const T=anim.t;
    tween = T<0.28 ? 0.42+0.58*(T/0.28) : T<0.92 ? 1 : Math.max(0,1-(T-0.92)/0.36);
    anim.spin += dt*(1.2+7.0*Math.min(1,tween));
    /* One pass and then stillness would read as finished while a real copy is
       still running, so the gesture repeats until the backend comes back. */
    if(T>1.30){ if(S.copy.running) anim.t = 0; else { anim.mode="idle"; anim.last=null; } }
  } else {                                        // delete
    anim.t+=dt; const T=anim.t; from="cower";
    /* The console's erase: the icon flinches, then spins up and shrinks away
       to nothing. The spin ACCELERATES as it collapses — a constant turn while
       the alpha faded read as the icon simply going out, not being taken. */
    if(T<0.40){ target="cower"; tween=1; intensity=1.9; anim.spin += dt*0.08; }
    else {
      target="del"; tween=Math.min(1,(T-0.40)/0.52); intensity=1;
      const u = Math.min(1,(T-0.40)/0.85);          // 0..1 across the vanish
      anim.spin  += dt*(2.2 + 20.0*u*u);
      anim.shrink = Math.max(0, 1 - u*u);
    }
    anim.alpha = T<0.95 ? 1 : Math.max(0,1-(T-0.95)/0.30);
    if(T>1.25) commitPending();
    if(T>1.40){ anim.mode="idle"; anim.t=0; anim.alpha=0; anim.shrink=1; anim.last=null; }
  }
  return { mode, target, from, tween, spin:anim.spin, alpha:anim.alpha, intensity,
           shrink:anim.shrink };
}

/* --------------------------------------------------------------------- boot */
/* Live scan progress: one tower per folder as it finishes measuring. */
if(P.IS_APP && window.__TAURI__?.event?.listen){
  /* Copy progress. The backend throttles these to roughly ten a second, so the
     band can be rewritten on every one without redrawing the screen — a full
     draw() here would rebuild the icon grid under the cursor ten times a
     second for the length of the copy. */
  window.__TAURI__.event.listen("copy-progress", ev => {
    const p = ev.payload; if(!p || !S.copy.running) return;
    S.copy.ticked = true;
    S.copy.copied = p.copiedBytes || 0;
    S.copy.total  = p.totalBytes  || 0;
    S.copy.files  = p.files       || 0;
    S.copy.totalFiles = p.totalFiles || 0;
    const el = osd.querySelector(".copying");
    if(el) el.innerHTML = copyNoteHTML();
    else showCopying(true);
  });

  window.__TAURI__.event.listen("scan-progress", ev => {
    const p = ev.payload; if(!p) return;
    scanEvents++;
    // the startup void still grows a tower per drive
    if(S.screen === "boot"){
      boot.towers.push({ value: Math.max(1, p.sizeBytes||0), grow: 0 });
      boot.bytes += p.sizeBytes || 0;
      boot.seen = p.done || boot.seen + 1;
      boot.total = p.total || 0;
      return;
    }
    // a live scan: append the row and keep the grid sorted largest-first
    if(!S.scanning || !p.path) return;
    // A previous scan keeps emitting after you navigate away. Without this the
    // rows from an abandoned folder land in whatever listing is on screen.
    const norm = x => { let i = x.length;                  // no regex here:
      // an escaped separator inside a character class kept collapsing to a
      // different pattern, so every scan event was silently rejected
      while(i > 0 && (x.charCodeAt(i-1) === 92 || x.charCodeAt(i-1) === 47)) i--;
      return x.slice(0, i).toLowerCase(); };
    const parent = p.path.slice(0, Math.max(0, p.path.lastIndexOf("\\")));
    if(norm(parent) !== norm(S.scanning)) return;
    S.scanSeen = p.done || S.scanSeen + 1;
    S.scanTotal = p.total || 0;
    const at = S.entries.findIndex(x => x.path === p.path);
    if(at >= 0){
      // the measured figure for a row already on screen
      const e = S.entries[at];
      e.sizeBytes = p.sizeBytes || 0;
      e.itemCount = p.itemCount || 0;
      e.pending = false;
    } else {
      const e = { name:p.name, path:p.path, isDir:!!p.isDir, sizeBytes:p.sizeBytes||0,
                  modifiedMs:p.modifiedMs||0, ext:"", itemCount:p.itemCount||0,
                  pending:!!p.pending };
      e.mesh = P.meshFor(e);
      S.entries.push(e);
    }
    S.entries.sort((a,b) => b.sizeBytes - a.sizeBytes);
    ensureVisible();
    scheduleLiveDraw();
  }).catch(() => {});
}

let liveTimer = 0;
function scheduleLiveDraw(){
  if(liveTimer) return;
  liveTimer = setTimeout(() => { liveTimer = 0; if(S.screen === "contents") draw(); }, 120);
}

async function goElevated(){
  try{ await P.relaunchElevated(); }
  catch(e){ toast(String(e && e.message ? e.message : e), true); }
}

/* The opening sequence, factored out so System Configuration can play it again
   from the very beginning — drives are re-read, towers regrow, chime and all. */
async function runStartup(){
  startVoid("startup", "PlaySave", "Reading drives", () => {
    S.screen = "menu"; draw();
  });
  Sound.boot();
  try{
    S.volumes = await P.listVolumes();
    if(!S.volumes.length) toast("No drives found", true);
    if(S.vol >= S.volumes.length) S.vol = 0;
    boot.towers = S.volumes.map(v => ({ value: Math.max(1, v.totalBytes - v.freeBytes), grow: 0 }));
    boot.bytes = S.volumes.reduce((a,v) => a + (v.totalBytes - v.freeBytes), 0);
    setBootSub(`${S.volumes.length} drive${S.volumes.length===1?"":"s"}` +
      (P.IS_APP ? "" : " — <b>preview, sample data</b>"));
  }catch(e){ toast("Could not list drives: " + e, true); }
  boot.done = true;
}

function replayStartup(){
  Sound.enter();
  S.help = false;
  S.stack = []; S.entries = []; S.path = null; S.sel = 0; S.busy = false;
  anim.mode = "idle"; anim.t = 0; anim.alpha = 1; anim.pending = null; anim.last = null;
  listGen++;
  runStartup();
}

/* Arm audio from the saved setting. Without this Sound.on stayed false no
   matter what the setting said — the only thing that ever enabled it was
   toggling the row by hand, so "on by default" was on in the UI and off in
   fact. The context may still come back suspended; Sound.boot resumes it. */
/* Read the stored settings BEFORE the first frame or the first sound. Loading
   them afterwards would show the boot screen at the default label size and arm
   audio the app had been told to keep quiet, then correct itself a moment
   later — visible, audible, and avoidable. */
await loadSettings();
try{ appVersion = await P.appVersion(); }catch{}

Sound.enable(S.settings.sound);
applyLabelSize();

requestAnimationFrame(frame);
runStartup();
