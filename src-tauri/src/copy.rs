//! Recursive copy for the browser's Copy action.
//!
//! The console could only send a save from one memory card to the other, so its
//! destination was a card and nothing else. A disk has somewhere to put things,
//! so this takes an arbitrary destination folder and copies either a file or a
//! whole subtree into it, under its own name.
//!
//! Every refusal happens in `main.rs` BEFORE a byte moves — a protected
//! destination, a target that already exists, a destination inside the thing
//! being copied, or a size that does not fit. What is left here is the walk.
//!
//! Nothing in this file deletes. A failed or cancelled copy leaves a partial
//! tree, and the caller decides what happens to it; that decision belongs next
//! to the Recycle Bin call, not in the middle of a loop.

use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Emitter;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopyProgress {
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub files: u64,
    pub total_files: u64,
    pub done: bool,
}

/// Big enough that the syscall overhead disappears, small enough that Esc still
/// lands promptly in the middle of one enormous file.
const CHUNK: usize = 4 * 1024 * 1024;

/// Bytes and file count of a subtree, skipping reparse points exactly as the
/// scanner does. A junction would otherwise be measured — and then copied — as
/// a whole second tree, and a cloud placeholder would be downloaded to be read.
///
/// Iterative, not recursive: `\\?\` paths lift the 260-character limit, so a
/// pathological tree really can be deep enough to matter.
pub fn measure(root: &Path) -> (u64, u64) {
    if let Ok(md) = fs::symlink_metadata(root) {
        if !md.is_dir() {
            return (md.len(), 1);
        }
    }
    let (mut bytes, mut files) = (0u64, 0u64);
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            // DirEntry::metadata does not traverse a reparse point, which is
            // exactly what is wanted here
            let md = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if crate::scan::skippable(&md) {
                continue;
            }
            if md.is_dir() {
                stack.push(e.path());
            } else {
                bytes += md.len();
                files += 1;
            }
        }
    }
    (bytes, files)
}

/// One file, in chunks.
///
/// `fs::copy` is a single blocking call: a 40 GB file would freeze the bar at
/// whatever it last showed and ignore Esc until it finished. Copying by hand
/// costs a little throughput and buys both back.
fn copy_one(
    from: &Path,
    to: &Path,
    cancel: &AtomicBool,
    on: &mut dyn FnMut(u64),
) -> Result<(), String> {
    let mut src = fs::File::open(from).map_err(|e| format!("could not open {}: {}", from.display(), e))?;
    let mut dst = fs::File::create(to).map_err(|e| format!("could not create {}: {}", to.display(), e))?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("copy cancelled".into());
        }
        let n = src
            .read(&mut buf)
            .map_err(|e| format!("could not read {}: {}", from.display(), e))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .map_err(|e| format!("could not write {}: {}", to.display(), e))?;
        on(n as u64);
    }
    Ok(())
}

/// Copy `src` to `target`, emitting `copy-progress` as it goes.
///
/// `total_bytes` and `total_files` come from `measure`, so the interface has a
/// real denominator rather than a bar that fills by guesswork. `app` is optional
/// so the walk itself is testable without a running app — the same shape the
/// scanner uses.
pub fn run(
    app: Option<&tauri::AppHandle>,
    src: &Path,
    target: &Path,
    total_bytes: u64,
    total_files: u64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut copied = 0u64;
    let mut files = 0u64;
    let mut last = Instant::now();
    // A tick per file would be thousands of events at the webview for a big
    // tree, and the bar cannot show more than the screen refreshes anyway.
    let gap = Duration::from_millis(90);

    let tick = |copied, files, done| {
        if let Some(a) = app {
            let _ = a.emit(
                "copy-progress",
                CopyProgress {
                    copied_bytes: copied,
                    total_bytes,
                    files,
                    total_files,
                    done,
                },
            );
        }
    };
    tick(0, 0, false);

    let src_md = fs::symlink_metadata(src)
        .map_err(|e| format!("could not read {}: {}", src.display(), e))?;

    if !src_md.is_dir() {
        // a single file: its parent already exists, since it was chosen there
        let mut on = |n: u64| {
            copied += n;
            if last.elapsed() >= gap {
                last = Instant::now();
                tick(copied, files, false);
            }
        };
        copy_one(src, target, cancel, &mut on)?;
        tick(copied, 1, true);
        return Ok(());
    }

    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(src.to_path_buf(), target.to_path_buf())];
    while let Some((from, to)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Err("copy cancelled".into());
        }
        fs::create_dir_all(&to).map_err(|e| format!("could not create {}: {}", to.display(), e))?;
        let rd =
            fs::read_dir(&from).map_err(|e| format!("could not read {}: {}", from.display(), e))?;
        for entry in rd {
            if cancel.load(Ordering::Relaxed) {
                return Err("copy cancelled".into());
            }
            let e = entry.map_err(|e| format!("could not read {}: {}", from.display(), e))?;
            let md = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue, // unreadable entries are skipped, as in a scan
            };
            if crate::scan::skippable(&md) {
                continue;
            }
            let dst = to.join(e.file_name());
            if md.is_dir() {
                stack.push((e.path(), dst));
            } else {
                let mut on = |n: u64| {
                    copied += n;
                    if last.elapsed() >= gap {
                        last = Instant::now();
                        tick(copied, files, false);
                    }
                };
                copy_one(&e.path(), &dst, cancel, &mut on)?;
                files += 1;
            }
        }
    }
    tick(copied, files, true);
    Ok(())
}
