// PlaySave — a disk-usage analyser styled as a console memory card browser.
// Copyright (C) 2026 JuliusJoker92
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; without even the implied
// warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// General Public License, in LICENSE, for more details.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod copy;
mod scan;
mod tree;

#[cfg(windows)]
mod mft;
#[cfg(windows)]
mod shellicon;

#[cfg(test)]
mod tests;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub id: String,
    pub name: String,
    pub mount: String,
    pub kind: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    /// Directories that can be answered without touching the disk.
    pub cached_paths: u64,
    /// Bytes of disk those cached trees account for.
    pub cached_bytes: u64,
    pub mft_available: bool,
    pub elevated: bool,
    /// `"mft"` or `"walk"` — whichever produced the most recent answer.
    pub backend: String,
}

/* -------------------------------------------------------------- state */

const B_WALK: u8 = 0;
const B_MFT: u8 = 1;

pub struct AppState {
    cache: cache::Cache,
    /// Whether the process token is elevated. Reported, never acted on: the
    /// only test that matters is whether the volume actually opens.
    elevated: bool,
    /// Volumes the MFT backend could serve at startup, one bit per drive
    /// letter. Availability is re-checked per scan, so this is only ever used
    /// to answer "is the fast path a thing on this machine".
    mft_mask: u32,
    backend: AtomicU8,
    /// Raised by `cancel_copy` and read by the copy loop. A copy can be a very
    /// long operation on a real drive, so it has to be stoppable.
    copy_cancel: Arc<AtomicBool>,
}

impl AppState {
    fn new() -> AppState {
        #[cfg(windows)]
        let (elevated, mft_mask) = (mft::elevated(), mft::probe_mask());
        #[cfg(not(windows))]
        let (elevated, mft_mask) = (false, 0u32);

        AppState {
            cache: cache::Cache::new(),
            elevated,
            mft_mask,
            backend: AtomicU8::new(if mft_mask != 0 { B_MFT } else { B_WALK }),
            copy_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    fn set_backend(&self, name: &str) {
        self.backend.store(
            if name == "mft" { B_MFT } else { B_WALK },
            Ordering::Relaxed,
        );
    }

    fn backend_name(&self) -> &'static str {
        if self.backend.load(Ordering::Relaxed) == B_MFT {
            "mft"
        } else {
            "walk"
        }
    }

    /// The drive letter to enumerate via the MFT for this path, if that path is
    /// on a fixed NTFS volume this process can open raw. `None` means walk —
    /// silently, with no prompt of any kind.
    #[cfg(windows)]
    fn mft_letter(&self, path: &str) -> Option<char> {
        let b = path.as_bytes();
        if b.len() < 2 || b[1] != b':' || !b[0].is_ascii_alphabetic() {
            return None;
        }
        let letter = b[0].to_ascii_uppercase() as char;
        if !mft::available(letter) {
            return None;
        }
        // Sizing the job up first is free for an ordinary user, and a volume
        // with only a handful of records is walked faster than its $MFT can be
        // parsed. Below the threshold the fast path is not a fast path.
        if mft::record_count(letter)? < 8_192 {
            return None;
        }
        Some(letter)
    }
}

/* ------------------------------------------------------------------ volumes */
#[cfg(windows)]
fn volumes() -> Vec<Volume> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    };
    // GetDriveTypeW returns a plain u32 and these values are fixed Win32 ABI
    // constants; naming them here avoids chasing where the crate files them.
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;

    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let mount = format!("{}:\\", letter);
        let w: Vec<u16> = mount.encode_utf16().chain(std::iter::once(0)).collect();

        let kind = match unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) } {
            DRIVE_FIXED => "fixed",
            DRIVE_REMOVABLE => "removable",
            DRIVE_REMOTE => "network",
            DRIVE_CDROM => "cdrom",
            DRIVE_RAMDISK => "ram",
            _ => "unknown",
        };
        if kind == "unknown" || kind == "cdrom" {
            continue;
        }

        let (mut total, mut free) = (0u64, 0u64);
        let ok = unsafe {
            GetDiskFreeSpaceExW(PCWSTR(w.as_ptr()), None, Some(&mut total), Some(&mut free))
        }
        .is_ok();
        if !ok || total == 0 {
            continue;
        }

        let mut label = [0u16; 261];
        let named = unsafe {
            GetVolumeInformationW(
                PCWSTR(w.as_ptr()),
                Some(&mut label),
                None,
                None,
                None,
                None,
            )
        }
        .is_ok();
        let mut name = if named {
            String::from_utf16_lossy(&label)
                .trim_end_matches('\0')
                .trim()
                .to_string()
        } else {
            String::new()
        };
        if name.is_empty() {
            name = match kind {
                "removable" => "Removable Disk".into(),
                "network" => "Network Drive".into(),
                _ => "Local Disk".into(),
            };
        }

        out.push(Volume {
            id: mount.clone(),
            name,
            mount,
            kind: kind.to_string(),
            total_bytes: total,
            free_bytes: free,
        });
    }
    out
}

#[cfg(not(windows))]
fn volumes() -> Vec<Volume> {
    vec![Volume {
        id: "/".into(),
        name: "Root".into(),
        mount: "/".into(),
        kind: "fixed".into(),
        total_bytes: 0,
        free_bytes: 0,
    }]
}

/* ------------------------------------------------- what may not be touched */
/// The system-owned subtrees, whatever the operation. Writing INTO C:\Windows
/// is as bad as deleting out of it, so both guards share this. What they do NOT
/// share is the drive root: copying to `D:\` is exactly what the console did,
/// while deleting `D:\` is the whole disk.
fn guarded_system(path: &str) -> Option<String> {
    let p = path.trim_end_matches(['\\', '/']);
    let mut parts = p.split(['\\', '/']).filter(|s| !s.is_empty());
    let root = parts.next().unwrap_or("").to_ascii_lowercase();
    let rest: Vec<String> = parts.map(|s| s.to_ascii_lowercase()).collect();
    if rest.is_empty() {
        return None;
    }
    // Guard the whole subtree, not just its first two levels: matching on the
    // first component below the root means C:\Windows\System32\drivers is as
    // protected as C:\Windows, and a user folder called "Windows" further down
    // is not caught by mistake.
    const GUARDED_TOP: [&str; 7] = [
        "windows",
        "program files",
        "program files (x86)",
        "programdata",
        "system volume information",
        "users",
        "$recycle.bin",
    ];
    let looks_like_drive = root.len() == 2 && root.ends_with(':');
    if looks_like_drive && GUARDED_TOP.contains(&rest[0].as_str()) {
        // A user's own folder inside their profile is fair game; the profile
        // root and everything else system-owned is not.
        let is_own_stuff = rest[0] == "users" && rest.len() >= 3;
        if !is_own_stuff {
            return Some(format!("{} is a protected system location — refusing", path));
        }
    }
    None
}

/// Somewhere a copy is allowed to write. Drive roots pass; system subtrees do
/// not.
fn refuse_dest(path: &str) -> Option<String> {
    guarded_system(path)
}

/// What a delete, or the SOURCE of a copy, may touch. Anything shallower than
/// two path components, or a well-known system tree, is refused outright: a
/// charming interface must not become a footgun.
fn refuse(path: &str) -> Option<String> {
    // The drive letter is a component, so "C:\Users" split to 2 and slipped
    // through the old check. Count only the parts BELOW the root.
    let below = path
        .trim_end_matches(['\\', '/'])
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .count();
    if below <= 1 {
        return Some(format!("{} is a drive root — refusing", path));
    }
    guarded_system(path)
}

#[cfg(windows)]
fn recycle_impl(path: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FO_DELETE, SHFILEOPSTRUCTW,
    };

    // pFrom is a double-NUL-terminated list, not a plain string
    let mut from: Vec<u16> = path.encode_utf16().collect();
    from.push(0);
    from.push(0);

    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE as u32,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        ..Default::default()
    };
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 {
        return Err(format!("the shell refused the delete (code {})", rc));
    }
    if op.fAnyOperationsAborted.as_bool() {
        return Err("delete was aborted".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn recycle_impl(_path: &str) -> Result<(), String> {
    Err("recycle is only implemented on Windows".into())
}

/* ---------------------------------------------------------------- progress */

/// A cached answer arrives whole, with none of the events a live walk emits.
/// The interface is driven by those events, so replay them rather than leave it
/// waiting on ticks that will never come. Small folders get a tick per child so
/// the fill-in looks identical to a real scan; anything larger jumps straight to
/// the end instead of firing thousands of events at the webview.
fn fast_forward(app: &tauri::AppHandle, r: &scan::ScanResult) {
    let total = r.entries.len() as u64;
    if total == 0 {
        let _ = app.emit(
            "scan-progress",
            tree::Progress::tick(String::new(), 0, 0, 0),
        );
        return;
    }
    if total <= 256 {
        for (i, e) in r.entries.iter().enumerate() {
            let _ = app.emit(
                "scan-progress",
                tree::Progress {
                    name: e.name.clone(),
                    path: e.path.clone(),
                    is_dir: e.is_dir,
                    modified_ms: e.modified_ms,
                    item_count: e.item_count,
                    size_bytes: e.size_bytes,
                    done: i as u64 + 1,
                    total,
                    pending: false,
                },
            );
        }
    } else {
        let last = &r.entries[r.entries.len() - 1];
        let _ = app.emit(
            "scan-progress",
            tree::Progress::tick(last.name.clone(), last.size_bytes, total, total),
        );
    }
}

/// The executable that best represents a folder, so Claude's folder wears
/// Claude's logo. Scored so the main binary beats `unins000.exe`, and only one
/// directory level is ever read, keeping it cheap enough to run per folder.
#[cfg(windows)]
fn representative_exe(dir: &str) -> Option<String> {
    let md = std::fs::metadata(dir).ok()?;
    if !md.is_dir() {
        return None;
    }
    let base = std::path::Path::new(dir)
        .file_name()?
        .to_string_lossy()
        .to_ascii_lowercase();

    const NOISE: [&str; 8] = [
        "unins", "uninstall", "setup", "install", "update", "crashpad", "helper", "vcredist",
    ];

    let mut best: Option<(i32, String)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten().take(400) {
        let low = e.file_name().to_string_lossy().to_ascii_lowercase();
        if !low.ends_with(".exe") {
            continue;
        }
        let stem = &low[..low.len() - 4];
        if NOISE.iter().any(|n| stem.contains(n)) {
            continue;
        }
        let mut score = 0i32;
        if stem == base {
            score += 100;
        } else if base.starts_with(stem) || stem.starts_with(&base) {
            score += 60;
        }
        if let Ok(m) = e.metadata() {
            score += (m.len() / (4 * 1024 * 1024)).min(20) as i32;
        }
        if best.as_ref().map_or(true, |(b, _)| score > *b) {
            best = Some((score, e.path().to_string_lossy().to_string()));
        }
    }
    best.filter(|(s, _)| *s > 0).map(|(_, p)| p)
}


/// One shallow `read_dir`, emitted as `pending` rows. Costs milliseconds and
/// guarantees the grid is populated the instant a folder opens, whichever
/// backend then does the real measuring — the MFT sweep reports nothing at all
/// until it has indexed the entire volume.
fn announce_children(app: &tauri::AppHandle, path: &str) {
    let rd = match std::fs::read_dir(path) {
        Ok(r) => r,
        Err(_) => return,
    };
    let kids: Vec<_> = rd.filter_map(|e| e.ok()).take(4096).collect();
    let total = kids.len() as u64;
    for e in kids {
        let md = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let _ = app.emit(
            "scan-progress",
            tree::Progress {
                name: e.file_name().to_string_lossy().to_string(),
                path: e.path().to_string_lossy().replace("\\?\\", ""),
                is_dir: md.is_dir(),
                modified_ms: 0,
                item_count: 0,
                size_bytes: if md.is_dir() { 0 } else { md.len() },
                done: 0,
                total,
                pending: true,
            },
        );
    }
}

/// Restart with a UAC prompt. The MFT fast path has to open the raw volume,
/// which an ordinary token cannot do, so the whole difference between a
/// minutes-long walk and a seconds-long index is this one prompt — raised only
/// when the user explicitly asks for it, never at launch.
#[tauri::command]
fn relaunch_elevated(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let w: Vec<u16> = exe.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
        let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();
        let h = unsafe {
            ShellExecuteW(None, PCWSTR(verb.as_ptr()), PCWSTR(w.as_ptr()),
                          PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL)
        };
        if h.0 as isize <= 32 {
            return Err("elevation was declined".into());
        }
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("elevation is only implemented on Windows".into())
    }
}

/* ----------------------------------------------------------------- commands */
#[tauri::command]
fn list_volumes() -> Vec<Volume> {
    volumes()
}

// `async` matters: the default command context is Blocking, which runs the body
// on the event-loop thread. A multi-minute walk there deafens the window to
// input AND queues every scan-progress event until the end — so the animation
// that is meant to be a readout of the work shows nothing, then dumps the lot.
#[tauri::command(async)]
fn scan_children(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    force: Option<bool>,
) -> Result<scan::ScanResult, String> {
    let started = Instant::now();

    // A forced refresh must actually re-read the disk. Evicting first also
    // stops the stale covering tree from shadowing the narrower one we build.
    if force.unwrap_or(false) {
        state.cache.evict(&path);
    }

    // 1. Already known. Descending into a folder of a scanned root lands here.
    if let Some(mut r) = state.cache.lookup(&path).filter(|_| !force.unwrap_or(false)) {
        if let Some(b) = state.cache.backend_for(&path) {
            state.set_backend(b);
        }
        r.from_cache = true;
        r.elapsed_ms = started.elapsed().as_millis() as u64;
        fast_forward(&app, &r);
        return Ok(r);
    }

    announce_children(&app, &path);

    // 2. The fast path, when the volume and the process permit it. One sweep
    //    indexes the entire volume, so this is the last disk access for any
    //    path on it until the cache is cleared.
    #[cfg(windows)]
    {
        if let Some(letter) = state.mft_letter(&path) {
            if let Some(t) = mft::build_tree(letter) {
                let t = Arc::new(t);
                state.cache.insert(t.clone());
                if let Some(mut r) = t.result_for(&path) {
                    state.set_backend(mft::BACKEND);
                    r.from_cache = false;
                    r.elapsed_ms = started.elapsed().as_millis() as u64;
                    fast_forward(&app, &r);
                    return Ok(r);
                }
            }
        }
    }

    // 3. The walk. Emits progress as it goes, and caches every subtotal it
    //    computed on the way rather than throwing them away.
    let t = Arc::new(scan::walk_root(&path, Some(&app))?);
    state.set_backend(scan::BACKEND);
    state.cache.insert(t.clone());
    let mut r = t
        .result_for(&path)
        .ok_or_else(|| format!("{} could not be indexed", path))?;
    r.from_cache = false;
    r.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(r)
}

/// Pure lookup: no disk, no events, no scan. `None` is a miss.
#[tauri::command]
fn scan_cached(state: tauri::State<'_, AppState>, path: String) -> Option<scan::ScanResult> {
    state.cache.lookup(&path).map(|mut r| {
        r.from_cache = true;
        r.elapsed_ms = 0;
        r
    })
}

#[tauri::command]
fn clear_cache(state: tauri::State<'_, AppState>) {
    state.cache.clear();
}

#[tauri::command]
fn scan_stats(state: tauri::State<'_, AppState>) -> ScanStats {
    let (cached_paths, cached_bytes) = state.cache.stats();
    ScanStats {
        cached_paths,
        cached_bytes,
        mft_available: state.mft_mask != 0,
        elevated: state.elevated,
        backend: state.backend_name().to_string(),
    }
}

#[tauri::command(async)]
fn icon_for(path: String, size: u32) -> Option<String> {
    #[cfg(windows)]
    {
        // A folder full of an application's files should wear that
        // application's icon, not the generic manila folder.
        if let Some(exe) = representative_exe(&path) {
            if let Some(url) = shellicon::icon_data_url(&exe, size) {
                return Some(url);
            }
        }
        shellicon::icon_data_url(&path, size)
    }
    #[cfg(not(windows))]
    {
        let _ = (path, size);
        None
    }
}

#[tauri::command(async)]
fn recycle(path: String) -> Result<(), String> {
    if let Some(why) = refuse(&path) {
        return Err(why);
    }
    if !std::path::Path::new(&path).exists() {
        return Err(format!("{} no longer exists", path));
    }
    recycle_impl(&path)
}

/// Bytes as the interface would say them, for error messages the user reads.
fn human(b: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", b, U[0])
    } else if v < 10.0 {
        format!("{:.1} {}", v, U[i])
    } else {
        format!("{:.0} {}", v, U[i])
    }
}

/// Split a file name on the last dot, so `archive.tar.gz` gives `archive.tar`
/// and `.gz`. A leading dot is not an extension: `.gitignore` is all name.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// A name that is free inside `dir`, following Explorer's convention:
/// `notes.txt` becomes `notes - Copy.txt`, then `notes - Copy (2).txt`.
///
/// Folders keep their whole name — Explorer names a copy of `My.Folder`
/// `My.Folder - Copy`, not `My - Copy.Folder`, and it is right to: the part
/// after the dot only means "extension" for a file.
///
/// This is what makes copying something into its own folder work at all, which
/// is the one case where the clash is certain rather than incidental.
fn free_name(dir: &std::path::Path, name: &str, is_dir: bool) -> Result<String, String> {
    if !dir.join(name).exists() {
        return Ok(name.to_string());
    }
    let (stem, ext) = if is_dir { (name, "") } else { split_ext(name) };
    for i in 1..1000 {
        let cand = if i == 1 {
            format!("{} - Copy{}", stem, ext)
        } else {
            format!("{} - Copy ({}){}", stem, i, ext)
        };
        if !dir.join(&cand).exists() {
            return Ok(cand);
        }
    }
    Err(format!(
        "{} already has a thousand copies of {} — pick somewhere else",
        dir.display(),
        name
    ))
}

/// What a copy WOULD create, without creating it. The confirm screen has to be
/// able to say "this will be copied as notes - Copy.txt" rather than announce a
/// path and then quietly produce a different one.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPlan {
    pub name: String,
    pub target: String,
    /// True when the chosen name was taken and this one had to be invented.
    pub renamed: bool,
}

#[tauri::command(async)]
fn copy_plan(src: String, dest_dir: String) -> Result<CopyPlan, String> {
    let sp = std::path::Path::new(&src);
    let md = std::fs::symlink_metadata(sp).map_err(|_| format!("{} no longer exists", src))?;
    let name = sp
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("that has no name to copy under")?
        .to_string();
    let dp = std::path::Path::new(&dest_dir);
    let final_name = free_name(dp, &name, md.is_dir())?;
    Ok(CopyPlan {
        renamed: final_name != name,
        target: dp.join(&final_name).to_string_lossy().to_string(),
        name: final_name,
    })
}

/// Case- and separator-insensitive path key, for asking whether one path sits
/// inside another. Deliberately textual: the answer is needed before anything
/// is created, so it cannot lean on canonicalising a target that does not exist
/// yet.
fn path_key(p: &str) -> String {
    p.trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_lowercase()
}

/// Is `inner` the same as, or underneath, `outer`?
fn within(inner: &str, outer: &str) -> bool {
    let (i, o) = (path_key(inner), path_key(outer));
    i == o || i.starts_with(&format!("{}\\", o))
}

/// Copy a file or folder into a destination folder, under its own name.
///
/// The console could only send a save to the other memory card. A disk has
/// somewhere to put things, so the destination is any folder the browser can
/// reach — which means the guards have to do more work, not less. Every refusal
/// happens here, before anything is written:
///   * the source passes the same guard as a delete — no drive roots, no
///     system locations;
///   * the destination is not a system location either. Writing INTO
///     C:\Windows is as bad as deleting out of it;
///   * the destination is not inside the thing being copied, which would
///     otherwise recurse until the disk filled;
///   * the target must not already exist, because merging into someone's
///     existing folder is not what "copy" means here and could overwrite;
///   * it has to fit, with room left over.
///
/// A copy that fails or is cancelled leaves a partial tree that LOOKS finished,
/// which is worse than nothing, so it goes to the Recycle Bin — recoverable,
/// never hard-deleted.
#[tauri::command(async)]
fn copy_into(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    src: String,
    dest_dir: String,
) -> Result<String, String> {
    if let Some(why) = refuse(&src) {
        return Err(why);
    }
    if let Some(why) = refuse_dest(&dest_dir) {
        return Err(why);
    }
    let sp = std::path::Path::new(&src);
    let src_md = std::fs::symlink_metadata(sp).map_err(|_| format!("{} no longer exists", src))?;
    let name = sp
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("that has no name to copy under")?
        .to_string();

    let dp = std::path::Path::new(&dest_dir);
    if !dp.is_dir() {
        return Err(format!("{} is not a folder", dest_dir));
    }
    // A folder copied inside itself would walk into the copy it is making.
    if src_md.is_dir() && within(&dest_dir, &src) {
        return Err(format!("{} cannot be copied into itself", name));
    }

    // Refusing on a name clash was wrong: copying something into the folder it
    // is already in is a perfectly ordinary thing to do, and it is the one case
    // where a clash is GUARANTEED. Keep both, as Explorer does.
    let final_name = free_name(dp, &name, src_md.is_dir())?;
    let target = dp.join(&final_name);

    let (bytes, files) = copy::measure(&scan::long(&src));
    // Room is a property of the destination's VOLUME, not of the folder chosen
    // on it, so the free-space figure comes from the drive that folder is on.
    let vols = volumes();
    let dletter = dest_dir.get(..2).unwrap_or("").to_ascii_uppercase();
    if let Some(v) = vols
        .iter()
        .find(|v| v.mount.get(..2).unwrap_or("").to_ascii_uppercase() == dletter)
    {
        const MARGIN: u64 = 64 * 1024 * 1024;
        if bytes.saturating_add(MARGIN) > v.free_bytes {
            return Err(format!(
                "{} needs {} and {} has {} free",
                name,
                human(bytes),
                v.name,
                human(v.free_bytes)
            ));
        }
    }

    state.copy_cancel.store(false, Ordering::Relaxed);
    let target_s = target.to_string_lossy().to_string();
    let r = copy::run(
        Some(&app),
        &scan::long(&src),
        &scan::long(&target_s),
        bytes,
        files,
        &state.copy_cancel,
    );
    match r {
        Ok(()) => Ok(target_s),
        Err(e) => {
            let cleaned = recycle_impl(&target_s).is_ok();
            Err(if cleaned {
                format!("{} — the partial copy went to the Recycle Bin", e)
            } else {
                format!("{} — a partial copy may remain at {}", e, target_s)
            })
        }
    }
}

/// The version of the binary that is actually running.
///
/// `env!` bakes this in from Cargo.toml at compile time, so what the interface
/// shows is what was built — it cannot drift the way a number typed into the
/// frontend by hand would.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn cancel_copy(state: tauri::State<'_, AppState>) {
    state.copy_cancel.store(true, Ordering::Relaxed);
}

/* ----------------------------------------------------------------- settings
   A file rather than the webview's localStorage. Settings that vanish when a
   cache is cleared are not settings, and this app is relaunched under
   elevation by its own "Restart for fast scanning" — a plain file in the app's
   config directory survives both, and can be read by a human. */

fn settings_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

/// The stored settings, or None if there are none yet or the file is unusable.
/// Every failure is a None: a corrupt file must start the app on defaults, not
/// fail to start it.
#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let p = settings_file(&app)?;
    let txt = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&txt).ok()
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let p = settings_file(&app).ok_or("no config directory for this app")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {}", dir.display(), e))?;
    }
    let txt = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    /* Written straight to the file.
       This used to write a .tmp beside it and rename, for atomicity. The write
       landed and the rename did not, so the settings were never saved at all —
       a .json.tmp sat there holding them. The guard cost more than the thing it
       guarded against: a torn write of a 142-byte file loses the settings, and
       `load_settings` already treats an unreadable file as "no settings" and
       starts on defaults. Trading a real, observed failure for a theoretical
       one is not a trade worth making. */
    std::fs::write(&p, txt).map_err(|e| format!("could not write {}: {}", p.display(), e))?;
    // clear the stale temp file the old scheme left behind
    let _ = std::fs::remove_file(p.with_extension("json.tmp"));
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubDir {
    pub name: String,
    pub path: String,
}

/// The immediate subfolders of one directory — one `read_dir`, no recursion, no
/// sizes.
///
/// The browser's own listing comes from a full recursive scan, which is the
/// right answer when the point is how big things are and completely the wrong
/// one for "which folder am I copying into". This returns in milliseconds on
/// any directory.
#[tauri::command(async)]
fn list_dirs(path: String) -> Result<Vec<SubDir>, String> {
    let base = path.trim_end_matches(['\\', '/']).to_string();
    let rd = std::fs::read_dir(scan::long(&path))
        .map_err(|e| format!("could not read {}: {}", path, e))?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let md = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !md.is_dir() || scan::skippable(&md) {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        // A destination list is for choosing, so the machine's own bookkeeping
        // is noise: $Recycle.Bin, $WinREAgent, System Volume Information.
        if name.starts_with('$') || name.eq_ignore_ascii_case("System Volume Information") {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const HIDDEN: u32 = 0x2;
            const SYSTEM: u32 = 0x4;
            if md.file_attributes() & (HIDDEN | SYSTEM) != 0 {
                continue;
            }
        }
        // Built from the plain path, not the \\?\ form the read used, so what
        // the interface shows and later copies to is an ordinary path.
        out.push(SubDir {
            path: format!("{}\\{}", base, name),
            name,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command(async)]
fn reveal(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("reveal is only implemented on Windows".into())
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            list_volumes,
            scan_children,
            scan_cached,
            clear_cache,
            scan_stats,
            icon_for,
            relaunch_elevated,
            recycle,
            copy_into,
            copy_plan,
            cancel_copy,
            list_dirs,
            app_version,
            load_settings,
            save_settings,
            reveal
        ])
        .run(tauri::generate_context!())
        .expect("error while running PlaySave");
}
