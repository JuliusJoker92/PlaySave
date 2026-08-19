/* Platform bridge.
   Inside Tauri these calls hit the Rust backend and read real disks. Opened as a
   plain page (or published as a preview) the same calls fall back to sample data,
   so the whole UI can be developed and reviewed without a build step. */

const tauri = typeof window !== "undefined" && window.__TAURI__ ? window.__TAURI__ : null;
export const IS_APP = !!tauri;

async function invoke(cmd, args){
  if(!tauri) throw new Error("not running under Tauri");
  const fn = tauri.core?.invoke || tauri.invoke;
  return fn(cmd, args);
}

/* ---------------------------------------------------------------- sample data
   Shapes match the Rust structs exactly, so the mock path exercises the same
   code the real one does. */
const MB = 1024 * 1024;
const SAMPLE_VOLUMES = [
  { id:"C:\\", name:"Local Disk",  mount:"C:\\", kind:"fixed",     totalBytes: 999_653_638_144, freeBytes: 769_875_968_000 },
  { id:"D:\\", name:"Games Drive", mount:"D:\\", kind:"fixed",     totalBytes: 2_000_398_934_016, freeBytes: 1_040_187_392_000 },
  { id:"E:\\", name:"Archive",     mount:"E:\\", kind:"removable", totalBytes: 500_107_862_016, freeBytes: 61_502_361_600 }
];

const SAMPLE_TREE = {
  "C:\\": [
    ["node_modules",  "C:\\Users\\you\\dev",  65_820_000, "2026-07-22T23:04:38Z", 214_882],
    ["Windows",       "C:\\",                 41_231_685, "2026-08-02T06:12:01Z",  98_441],
    ["AppData",       "C:\\Users\\you",       34_035_538, "2026-08-11T21:47:52Z",  61_205],
    ["Program Files", "C:\\",                 29_957_396, "2026-07-30T15:22:10Z",  40_118],
    ["Videos",        "C:\\Users\\you",       23_729_694, "2026-08-09T01:15:44Z",     418],
    ["Downloads",     "C:\\Users\\you",       19_971_597, "2026-08-12T20:30:19Z",   2_044],
    ["Blender",       "C:\\Users\\you\\3D",   10_522_669, "2026-08-06T22:58:03Z",     906],
    ["Documents",     "C:\\Users\\you",        4_509_715, "2026-08-13T07:41:27Z",   3_310]
  ],
  "D:\\": [
    ["SteamLibrary",  "D:\\",    443_076_313, "2026-08-10T17:09:55Z", 302_884],
    ["Emulation",     "D:\\",    258_637_666, "2026-08-01T02:33:12Z",  44_190],
    ["Recordings",    "D:\\OBS", 143_247_224, "2026-08-12T23:52:40Z",     712],
    ["Epic Games",    "D:\\",     94_817_275, "2026-07-18T18:47:29Z",  71_663],
    ["Backups",       "D:\\",     66_357_244, "2026-08-03T04:05:13Z",   1_188]
  ],
  "E:\\": [
    ["Photo Archive", "E:\\", 288_419_002, "2026-05-19T12:00:00Z", 88_402],
    ["Old Projects",  "E:\\",  96_311_540, "2026-02-04T09:31:00Z", 12_774],
    ["ISO",           "E:\\",  52_004_118, "2026-06-27T16:45:00Z",     31]
  ]
};

function mockChildren(path){
  const rows = SAMPLE_TREE[path];
  if(!rows) return { path, totalBytes:0, fileCount:0, dirCount:0, errors:0, entries:[],
                     fromCache:false, elapsedMs:0 };
  const entries = rows.map(([name, parent, kb, iso, items]) => ({
    name, path: parent.replace(/\\+$/, "\\") + name, isDir: true,
    sizeBytes: kb * 1024, modifiedMs: Date.parse(iso), ext: "", itemCount: items
  }));
  return {
    path,
    totalBytes: entries.reduce((a,e) => a + e.sizeBytes, 0),
    fileCount: entries.reduce((a,e) => a + e.itemCount, 0),
    dirCount: entries.length, errors: 0, entries,
    fromCache:false, elapsedMs:0
  };
}

/* Preview mode keeps its own cache so back-navigation is instant there too —
   the mock path has to exercise the same hit/miss shape the real one does. */
const mockCache = new Map();

/* ------------------------------------------------------------------- the API */
export async function listVolumes(){
  if(!IS_APP) return SAMPLE_VOLUMES;
  try { return await invoke("list_volumes"); }
  catch(e){ console.error("list_volumes failed", e); return []; }
}

export async function scanChildren(path){
  if(!IS_APP){
    const res = mockChildren(path);
    mockCache.set(path, res);
    return res;
  }
  return invoke("scan_children", { path });
}

/* The instant path. Returns a ScanResult only if the backend already holds one
   for this exact path, otherwise null — never a scan, never a wait. Anything
   that goes wrong (including a backend built before the command existed) is a
   miss, so the caller simply falls back to the full scan. */
export async function scanCached(path){
  if(!IS_APP){
    const hit = mockCache.get(path);
    return hit ? { ...hit, fromCache:true, elapsedMs:0 } : null;
  }
  try{
    const res = await invoke("scan_cached", { path });
    return res || null;
  }catch{ return null; }
}

export async function clearCache(){
  if(!IS_APP){ mockCache.clear(); return; }
  try{ await invoke("clear_cache"); }
  catch(e){ console.error("clear_cache failed", e); }
}

/* Backend telemetry for the System Configuration screen: which scanner is live,
   how much is cached. null means the backend could not answer. */
export async function scanStats(){
  if(!IS_APP){
    let bytes = 0;
    for(const r of mockCache.values()) bytes += r.totalBytes || 0;
    return { cachedPaths: mockCache.size, cachedBytes: bytes,
             mftAvailable:false, elevated:false, backend:"walk" };
  }
  try{
    const s = await invoke("scan_stats");
    return s || null;
  }catch{ return null; }
}

export async function iconFor(path, size = 128){
  if(!IS_APP) return null;
  try { return await invoke("icon_for", { path, size }); }
  catch { return null; }
}

export async function recycle(path){
  if(!IS_APP) throw new Error("preview mode: nothing was deleted");
  return invoke("recycle", { path });
}

/* Copy a file or folder into a destination folder. Every refusal — a system
   location, a name already taken there, not enough room — is decided in the
   backend before anything is written, so a rejection here is authoritative
   rather than a guess made from a cached listing. Resolves with the path it
   created.

   destDir, not destRoot: the backend takes any folder now, and Tauri matches
   command arguments by NAME. Renaming the Rust parameter without renaming this
   one failed every copy with "missing required key destDir" — the two sides
   have to agree, and nothing but a real invoke can prove they do. */
export async function copyInto(src, destDir){
  if(!IS_APP) throw new Error("preview mode: nothing was copied");
  return invoke("copy_into", { src, destDir });
}

/* The immediate subfolders of one directory, for the destination browser. The
   browser's own listing is a full recursive scan — the right answer for "how
   big is this" and completely the wrong one for "which folder am I copying
   into", which has to come back instantly on any directory. */
export async function listDirs(path){
  if(!IS_APP){
    const depth = (path.match(/[\\/]/g) || []).length;
    if(depth > 3) return [];
    return ["Program Files","Games","Media","Backups"].map(n => ({
      name:n, path:path.replace(/[\\/]+$/,"") + "\\" + n }));
  }
  return invoke("list_dirs", { path });
}

/* What a copy WOULD create, without creating it. Copying something into the
   folder it already lives in guarantees a name clash, so the confirm screen has
   to be able to say "this lands as notes - Copy.txt" rather than announce one
   path and quietly produce another. */
export async function copyPlan(src, destDir){
  if(!IS_APP){
    const name = src.replace(/[\\/]+$/,"").split(/[\\/]/).pop();
    return { name, target: destDir.replace(/[\\/]+$/,"") + "\\" + name, renamed:false };
  }
  return invoke("copy_plan", { src, destDir });
}

/* The running binary's version, straight from the crate. null when there is no
   backend to ask — a preview has no build to name. */
export async function appVersion(){
  if(!IS_APP) return null;
  try{ return await invoke("app_version"); }catch{ return null; }
}

export async function cancelCopy(){
  if(!IS_APP) return;
  try{ await invoke("cancel_copy"); }catch(e){ console.error("cancel_copy failed", e); }
}

/* Restart with a UAC prompt so the MFT fast path can open the raw volume.
   The difference between a minutes-long directory walk and a seconds-long
   index is exactly this, which is why it is offered rather than forced. */
export async function relaunchElevated(){
  if(!IS_APP) throw new Error("preview mode: nothing to relaunch");
  return invoke("relaunch_elevated");
}

/* Settings persistence. In the app this is a file the backend owns; opened as a
   plain page it falls back to localStorage so the same code path can be driven
   without a build. Neither ever throws: failing to read settings must start the
   app on defaults, not fail to start it. */
const PREVIEW_KEY = "playsave-settings";

export async function loadSettings(){
  if(!IS_APP){
    try{ return JSON.parse(localStorage.getItem(PREVIEW_KEY) || "null"); }
    catch{ return null; }
  }
  try{ return (await invoke("load_settings")) || null; }
  catch(e){ console.error("load_settings failed", e); return null; }
}

export async function saveSettings(settings){
  if(!IS_APP){
    try{ localStorage.setItem(PREVIEW_KEY, JSON.stringify(settings)); }catch{}
    return;
  }
  try{ await invoke("save_settings", { settings }); }
  catch(e){ console.error("save_settings failed", e); }
}

export async function reveal(path){
  if(!IS_APP) return;
  try { await invoke("reveal", { path }); } catch(e){ console.error(e); }
}

/* --------------------------------------------------------------- formatting */
export const KB = b => Math.round(b / 1024);
export const commaKB = b => KB(b).toLocaleString("en-US") + " KB";
export function human(b){
  if(b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(2) + " TB";
  if(b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + " GB";
  if(b >= MB)        return (b / MB).toFixed(1) + " MB";
  if(b >= 1024)      return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}
export function stamp(ms){
  if(!ms) return "—";
  const d = new Date(ms), p = n => String(n).padStart(2, "0");
  let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${p(d.getMonth()+1)}/${p(d.getDate())}/${d.getFullYear()}  ${h}:${p(d.getMinutes())}:${p(d.getSeconds())} ${ap}`;
}

/* Which device model represents a folder. Extension-led, with name hints for the
   handful of directories everyone recognises. */
export function meshFor(entry){
  const n = entry.name.toLowerCase();
  if(/^(node_modules|\.git|vendor|packages|target|build|dist)$/.test(n)) return "m2";
  if(/^(windows|winsxs|system32|program files.*|programdata)$/.test(n))  return "hdd";
  if(/^(documents|desktop|onedrive|dropbox)$/.test(n))                   return "floppy";
  if(/^(downloads|temp|tmp|cache)$/.test(n))                             return "usb";
  if(/(video|movie|music|photo|picture|recording|media|obs)/.test(n))    return "disc";
  if(/(steam|epic|game|emulation|xbox|origin|gog|riot|battle)/.test(n))  return "disc";
  if(/(backup|archive|iso)/.test(n))                                     return "floppy";
  if(/(appdata|roaming|local|library|users)/.test(n))                    return "ssd";
  return "ssd";
}

/* Deterministic palette per folder, so a given name always gets the same colour. */
export function paletteFor(name){
  let h = 0;
  for(let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360, s = 0.42 + (h >> 9 & 31) / 124;
  const hsl = (H,S,L) => {
    const c = (1-Math.abs(2*L-1))*S, x = c*(1-Math.abs((H/60)%2-1)), m = L-c/2;
    const r = [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(H/60)%6];
    return "#" + r.map(v => Math.round((v+m)*255).toString(16).padStart(2,"0")).join("");
  };
  return {
    tint: hsl(hue, Math.min(0.8, s + 0.22), 0.62),
    bg: [ hsl(hue, s*0.5, 0.40), hsl((hue+18)%360, s*0.5, 0.33),
          hsl(hue, s*0.55, 0.13), hsl((hue+18)%360, s*0.5, 0.20) ]
  };
}
