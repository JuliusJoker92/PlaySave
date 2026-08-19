//! Directory scanning — the portable fallback backend.
//!
//! A rayon-parallel `std::fs` walk. Correct everywhere, and on warm NVMe it
//! saturates around 100k entries/s across 8-16 threads, which is fine for a
//! folder and slow for a volume. When the target is a fixed NTFS volume and the
//! process can open it raw, [`crate::mft`] does the same job roughly 30-60x
//! faster; this runs whenever that is unavailable, which includes every
//! non-elevated session.
//!
//! The important change from v0.1 is what it *keeps*. Measuring one directory
//! necessarily measures every directory beneath it, and the old code returned a
//! single `u64` per top-level child and dropped the rest — so stepping into a
//! subfolder re-walked a subtree that had been fully measured milliseconds
//! earlier. Now the walk writes into a [`Tree`], and everything below the
//! scanned root is answerable from memory.

use crate::tree::{Node, Progress, Tree, NIL};
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

pub use crate::tree::ScanResult;

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

pub const BACKEND: &str = "walk";

#[cfg(windows)]
mod attr {
    pub const REPARSE_POINT: u32 = 0x0000_0400;
    pub const RECALL_ON_OPEN: u32 = 0x0004_0000;
    pub const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
}

/// Directory junctions, symlinks and cloud placeholders are skipped entirely:
/// following them double-counts at best and downloads gigabytes at worst.
#[cfg(windows)]
pub(crate) fn skippable(md: &std::fs::Metadata) -> bool {
    let a = md.file_attributes();
    a & attr::REPARSE_POINT != 0
        || a & attr::RECALL_ON_OPEN != 0
        || a & attr::RECALL_ON_DATA_ACCESS != 0
}

#[cfg(not(windows))]
pub(crate) fn skippable(md: &std::fs::Metadata) -> bool {
    md.file_type().is_symlink()
}

fn ms_of(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Long paths: `\\?\` lifts the 260-char limit. It only accepts absolute,
/// already-canonical paths, so apply it to the drive-letter form only.
pub(crate) fn long(path: &str) -> PathBuf {
    if cfg!(windows)
        && path.len() > 3
        && !path.starts_with("\\\\")
        && path.as_bytes().get(1) == Some(&b':')
    {
        PathBuf::from(format!("\\\\?\\{}", path.trim_end_matches('\\')))
    } else {
        PathBuf::from(path)
    }
}

/// The inverse of `long`: a path as the interface knows it.
///
/// This existed as `.replace("\\?\\", "")`, which is the THREE-character
/// sequence `\?\` — so `\\?\E:\x` lost characters 2..4 and came back as
/// `\E:\x`, with a leading separator. Every measured size the walk emitted
/// therefore carried a path the front end could not match against the row it
/// belonged to, the event was dropped, and the row sat on "measuring…" until
/// the whole scan finished and replaced the listing wholesale.
pub(crate) fn plain(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_string(),
        None => s,
    }
}

/// One subtree as the recursion builds it, before it is flattened into the
/// arena. Names only — no `PathBuf` per node, which is what keeps this from
/// costing several hundred bytes an entry.
struct Raw {
    name: Box<str>,
    is_dir: bool,
    size: u64,
    mtime: i64,
    files: u32,
    dirs: u32,
    errors: u32,
    kids: Vec<Raw>,
}

struct DirSum {
    size: u64,
    files: u32,
    dirs: u32,
    errors: u32,
    kids: Vec<Raw>,
}

/// Recursive measure of one directory, retaining the per-directory subtotals it
/// computes on the way. Errors are counted, never fatal — an unreadable subtree
/// should cost you that subtree, not the whole scan.
fn walk_dir(dir: &Path) -> DirSum {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => {
            return DirSum {
                size: 0,
                files: 0,
                dirs: 0,
                errors: 1,
                kids: Vec::new(),
            }
        }
    };
    let items: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    let failed = AtomicU32::new(0);

    let kids: Vec<Raw> = items
        .par_iter()
        .filter_map(|e| {
            let md = match e.metadata() {
                Ok(m) => m,
                Err(_) => {
                    failed.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
            };
            if skippable(&md) {
                return None;
            }
            let name: Box<str> = e.file_name().to_string_lossy().into_owned().into_boxed_str();
            if md.is_dir() {
                let sub = walk_dir(&e.path());
                Some(Raw {
                    name,
                    is_dir: true,
                    size: sub.size,
                    mtime: ms_of(&md),
                    files: sub.files,
                    dirs: sub.dirs,
                    errors: sub.errors,
                    kids: sub.kids,
                })
            } else {
                // TODO: logical size, not size-on-disk. Cluster rounding and
                // sparse/compressed files need GetCompressedFileSizeW, which is
                // one extra syscall per file and would roughly halve this
                // backend's throughput — the MFT backend gets it for free from
                // the $DATA allocated-size field when that lands.
                // TODO: hardlinks are counted once per link; dedupe by file id.
                // Needs GetFileInformationByHandle (an open per file) here; the
                // MFT backend already resolves this, since one record is one
                // file however many names point at it.
                Some(Raw {
                    name,
                    is_dir: false,
                    size: md.len(),
                    mtime: ms_of(&md),
                    files: 0,
                    dirs: 0,
                    errors: 0,
                    kids: Vec::new(),
                })
            }
        })
        .collect();

    let mut sum = DirSum {
        size: 0,
        files: 0,
        dirs: 0,
        errors: failed.load(Ordering::Relaxed),
        kids: Vec::new(),
    };
    for k in &kids {
        sum.size = sum.size.saturating_add(k.size);
        if k.is_dir {
            sum.dirs = sum.dirs.saturating_add(1).saturating_add(k.dirs);
            sum.files = sum.files.saturating_add(k.files);
            sum.errors = sum.errors.saturating_add(k.errors);
        } else {
            sum.files = sum.files.saturating_add(1);
        }
    }
    sum.kids = kids;
    sum
}

/// Flatten a subtree into the arena, consuming it as it goes so the transient
/// `Raw` allocation is released while the walk is still finishing.
fn push_raw(nodes: &mut Vec<Node>, parent: u32, raw: Raw) -> u32 {
    let idx = nodes.len() as u32;
    nodes.push(Node {
        name: raw.name,
        parent,
        first_child: NIL,
        next_sibling: NIL,
        size: raw.size,
        mtime: raw.mtime,
        files: raw.files,
        dirs: raw.dirs,
        errors: raw.errors,
        is_dir: raw.is_dir,
    });
    let mut prev = NIL;
    for k in raw.kids {
        let c = push_raw(nodes, idx, k);
        if prev == NIL {
            nodes[idx as usize].first_child = c;
        } else {
            nodes[prev as usize].next_sibling = c;
        }
        prev = c;
    }
    idx
}

/// Walk `path` and everything under it, emitting `scan-progress` as each
/// top-level child completes.
pub fn walk_root(path: &str, app: Option<&tauri::AppHandle>) -> Result<Tree, String> {
    use tauri::Emitter;

    let root = long(path);
    let rd = std::fs::read_dir(&root).map_err(|e| format!("{}: {}", path, e))?;
    let root_mtime = std::fs::metadata(&root).map(|m| ms_of(&m)).unwrap_or(0);

    let items: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    let total = items.len() as u64;
    let done = AtomicU64::new(0);
    let failed = AtomicU32::new(0);

    let kids: Vec<Raw> = items
        .par_iter()
        .filter_map(|e| {
            let md = match e.metadata() {
                Ok(m) => m,
                Err(_) => {
                    failed.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
            };
            if skippable(&md) {
                return None;
            }
            let name: Box<str> = e.file_name().to_string_lossy().into_owned().into_boxed_str();
            // Announce it before measuring. walk_dir on a large folder can run
            // for minutes, and emitting only on completion left the grid empty
            // and the app looking hung for exactly that long.
            if let Some(h) = app {
                let _ = h.emit("scan-progress", Progress {
                    name: name.to_string(),
                    path: plain(&e.path()),
                    is_dir: md.is_dir(),
                    modified_ms: ms_of(&md),
                    item_count: 0,
                    size_bytes: 0,
                    done: done.load(Ordering::Relaxed),
                    total,
                    pending: true,
                });
            }
            let raw = if md.is_dir() {
                let sub = walk_dir(&e.path());
                Raw {
                    name,
                    is_dir: true,
                    size: sub.size,
                    mtime: ms_of(&md),
                    files: sub.files,
                    dirs: sub.dirs,
                    errors: sub.errors,
                    kids: sub.kids,
                }
            } else {
                Raw {
                    name,
                    is_dir: false,
                    size: md.len(),
                    mtime: ms_of(&md),
                    files: 0,
                    dirs: 0,
                    errors: 0,
                    kids: Vec::new(),
                }
            };
            if let Some(h) = app {
                let _ = h.emit(
                    "scan-progress",
                    Progress {
                        name: raw.name.to_string(),
                        path: plain(&e.path()),
                        is_dir: raw.is_dir,
                        modified_ms: raw.mtime,
                        item_count: raw.files as u64 + raw.dirs as u64,
                        size_bytes: raw.size,
                        done: done.fetch_add(1, Ordering::Relaxed) + 1,
                        total,
                        pending: false,
                    },
                );
            }
            Some(raw)
        })
        .collect();

    // Skipped reparse points and unreadable entries never emit, so a UI
    // counting up to `total` would otherwise sit one tick short forever.
    if let Some(h) = app {
        if done.load(Ordering::Relaxed) < total {
            let _ = h.emit(
                "scan-progress",
                Progress::tick(String::new(), 0, total, total),
            );
        }
    }

    let mut nodes: Vec<Node> = Vec::with_capacity(items.len() + 1);
    nodes.push(Node::dir(path.to_string().into_boxed_str(), root_mtime));
    nodes[0].errors = failed.load(Ordering::Relaxed);

    let mut prev = NIL;
    for k in kids {
        let (size, files, dirs, errors, is_dir) = (k.size, k.files, k.dirs, k.errors, k.is_dir);
        let c = push_raw(&mut nodes, 0, k);
        if prev == NIL {
            nodes[0].first_child = c;
        } else {
            nodes[prev as usize].next_sibling = c;
        }
        prev = c;

        let root_node = &mut nodes[0];
        root_node.size = root_node.size.saturating_add(size);
        if is_dir {
            root_node.dirs = root_node.dirs.saturating_add(1).saturating_add(dirs);
            root_node.files = root_node.files.saturating_add(files);
            root_node.errors = root_node.errors.saturating_add(errors);
        } else {
            root_node.files = root_node.files.saturating_add(1);
        }
    }
    nodes.shrink_to_fit();

    Ok(Tree::new(path, BACKEND, nodes))
}
