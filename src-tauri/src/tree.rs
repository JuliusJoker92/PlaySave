//! The shape every backend produces.
//!
//! Both the directory walk and the MFT reader end up with the same thing: a
//! flat arena of nodes, parent/first-child/next-sibling links, and a recursive
//! byte total already summed on every directory. That last part is the whole
//! trick — a scan of `C:\` necessarily computes the size of every folder on the
//! volume on its way to the top-level numbers, and the old code threw all of it
//! away. Keeping it turns "descend into a folder" from a fresh walk into a
//! hashmap lookup.
//!
//! One node is 56 bytes plus its name, so a two-million-file volume costs
//! roughly 150 MB resident. That is the going rate for this class of tool and
//! it is reclaimable with `clear_cache`.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, MAIN_SEPARATOR};

/// Null link. `u32::MAX` rather than `Option<u32>` so a node stays 56 bytes.
pub const NIL: u32 = u32::MAX;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub modified_ms: i64,
    pub ext: String,
    pub item_count: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub path: String,
    pub total_bytes: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub errors: u64,
    pub entries: Vec<Entry>,
    pub from_cache: bool,
    pub elapsed_ms: u64,
}

/// Emitted as each top-level child finishes measuring, so the interface can grow
/// a tower per folder while the walk is still running. On the console the camera
/// kept creeping the whole time the disc was being read; this is the same idea.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub name: String,
    /// Full path, so the interface can build a real row from the event alone
    /// and let the user explore a folder while the rest of it is still walking.
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub is_dir: bool,
    pub size_bytes: u64,
    #[serde(default)]
    pub modified_ms: i64,
    #[serde(default)]
    pub item_count: u64,
    pub done: u64,
    pub total: u64,
    /// True when the row has been *discovered* but not yet measured. The
    /// interface shows it immediately with an unknown size, so a drive with a
    /// few enormous folders stops looking frozen for minutes.
    #[serde(default)]
    pub pending: bool,
}

impl Progress {
    /// Everything except the identity, for the catch-up emits that only exist
    /// to keep a cached result's event count honest.
    pub fn tick(name: String, size_bytes: u64, done: u64, total: u64) -> Progress {
        Progress { name, path: String::new(), is_dir: true, size_bytes,
                   modified_ms: 0, item_count: 0, done, total, pending: false }
    }
}

/// `size`, `files`, `dirs` and `errors` are recursive: they describe everything
/// at or below this node. For a file, `size` is its own length and the counts
/// are zero.
#[derive(Clone)]
pub struct Node {
    pub name: Box<str>,
    pub parent: u32,
    pub first_child: u32,
    pub next_sibling: u32,
    pub size: u64,
    pub mtime: i64,
    pub files: u32,
    pub dirs: u32,
    pub errors: u32,
    pub is_dir: bool,
}

impl Node {
    pub fn dir(name: Box<str>, mtime: i64) -> Node {
        Node {
            name,
            parent: NIL,
            first_child: NIL,
            next_sibling: NIL,
            size: 0,
            mtime,
            files: 0,
            dirs: 0,
            errors: 0,
            is_dir: true,
        }
    }

    pub fn file(name: Box<str>, size: u64, mtime: i64) -> Node {
        Node {
            name,
            parent: NIL,
            first_child: NIL,
            next_sibling: NIL,
            size,
            mtime,
            files: 0,
            dirs: 0,
            errors: 0,
            is_dir: false,
        }
    }
}

/// One scanned root and everything under it.
pub struct Tree {
    /// The scanned root run through [`norm`]; the cache matches on this, and
    /// every directory key beneath it is built by appending to it.
    pub key: String,
    /// `"mft"` or `"walk"` — which backend produced it.
    pub backend: &'static str,
    /// Node 0 is always the root.
    pub nodes: Vec<Node>,
    /// Normalised absolute path -> node index, directories only. Files are
    /// reachable through their parent, and indexing them would triple the cost
    /// of the map for no gain.
    pub dirs: HashMap<String, u32>,
}

impl Tree {
    pub fn new(root: &str, backend: &'static str, nodes: Vec<Node>) -> Tree {
        let mut t = Tree {
            key: norm(root),
            backend,
            nodes,
            dirs: HashMap::new(),
        };
        t.build_index();
        t
    }

    pub fn total_bytes(&self) -> u64 {
        self.nodes.first().map(|n| n.size).unwrap_or(0)
    }

    /// Paths this tree can answer instantly.
    pub fn dir_count(&self) -> u64 {
        self.dirs.len() as u64
    }

    fn build_index(&mut self) {
        if self.nodes.is_empty() {
            return;
        }
        // A rough guess at the directory count keeps the map from rehashing
        // twenty times on a whole-volume tree.
        let mut map: HashMap<String, u32> =
            HashMap::with_capacity((self.nodes.len() / 8).max(16));
        map.insert(self.key.clone(), 0);

        let mut stack: Vec<(u32, String)> = vec![(0, self.key.clone())];
        while let Some((idx, base)) = stack.pop() {
            let mut c = self.nodes[idx as usize].first_child;
            while c != NIL {
                let n = &self.nodes[c as usize];
                if n.is_dir {
                    let lower = n.name.to_lowercase();
                    let mut k = String::with_capacity(base.len() + 1 + lower.len());
                    k.push_str(&base);
                    k.push(MAIN_SEPARATOR);
                    k.push_str(&lower);
                    map.insert(k.clone(), c);
                    stack.push((c, k));
                }
                c = n.next_sibling;
            }
        }
        map.shrink_to_fit();
        self.dirs = map;
    }

    pub fn result_for(&self, path: &str) -> Option<ScanResult> {
        self.result_for_key(&norm(path), path)
    }

    /// `display` is echoed back verbatim in `ScanResult::path` and used as the
    /// stem for child paths, so the frontend gets the spelling it asked with.
    pub fn result_for_key(&self, key: &str, display: &str) -> Option<ScanResult> {
        let idx = *self.dirs.get(key)? as usize;
        let n = self.nodes.get(idx)?;
        let base = stem(display);

        let mut entries = Vec::new();
        let mut c = n.first_child;
        while c != NIL {
            let k = &self.nodes[c as usize];
            entries.push(Entry {
                name: k.name.to_string(),
                path: format!("{}{}{}", base, MAIN_SEPARATOR, k.name),
                is_dir: k.is_dir,
                size_bytes: k.size,
                modified_ms: k.mtime,
                ext: ext_of(&k.name),
                item_count: if k.is_dir {
                    k.files as u64 + k.dirs as u64
                } else {
                    0
                },
            });
            c = k.next_sibling;
        }
        entries.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));

        Some(ScanResult {
            path: display.to_string(),
            total_bytes: n.size,
            file_count: n.files as u64,
            dir_count: n.dirs as u64,
            errors: n.errors as u64,
            entries,
            from_cache: true,
            elapsed_ms: 0,
        })
    }
}

/// Case-folded, separator-normalised, no `\\?\`, no trailing separator, so
/// `C:\`, `c:/`, and `\\?\C:` all land on the same key.
pub fn norm(path: &str) -> String {
    let p = path.strip_prefix("\\\\?\\").unwrap_or(path);
    let mut s: String = p
        .to_lowercase()
        .chars()
        .map(|c| if c == '/' || c == '\\' { MAIN_SEPARATOR } else { c })
        .collect();
    while s.len() > 1 && s.ends_with(MAIN_SEPARATOR) {
        s.pop();
    }
    s
}

/// The part of a display path you concatenate a child name onto: `C:\` -> `C:`.
fn stem(display: &str) -> &str {
    let d = display.strip_prefix("\\\\?\\").unwrap_or(display);
    let t = d.trim_end_matches(['\\', '/']);
    if t.is_empty() {
        ""
    } else {
        t
    }
}

/// Matches the old behaviour, which ran every child through `Path::extension`
/// regardless of whether it was a directory.
fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Aggregates `size`/`files`/`dirs`/`errors` up the tree.
///
/// The stack-based descent yields every parent before any of its children, so
/// walking that order backwards guarantees a node is complete before it is
/// folded into its parent. Nodes not reachable from the root are left alone —
/// they cost memory and nothing else.
pub fn roll_up(nodes: &mut Vec<Node>) {
    if nodes.is_empty() {
        return;
    }
    let mut order: Vec<u32> = Vec::with_capacity(nodes.len());
    let mut stack: Vec<u32> = vec![0];
    while let Some(i) = stack.pop() {
        order.push(i);
        let mut c = nodes[i as usize].first_child;
        while c != NIL {
            stack.push(c);
            c = nodes[c as usize].next_sibling;
        }
    }
    for &i in order.iter().rev() {
        let (size, files, dirs, errors, is_dir, parent) = {
            let n = &nodes[i as usize];
            (n.size, n.files, n.dirs, n.errors, n.is_dir, n.parent)
        };
        if parent == NIL {
            continue;
        }
        let p = &mut nodes[parent as usize];
        p.size = p.size.saturating_add(size);
        if is_dir {
            p.dirs = p.dirs.saturating_add(1).saturating_add(dirs);
            p.files = p.files.saturating_add(files);
            p.errors = p.errors.saturating_add(errors);
        } else {
            p.files = p.files.saturating_add(1);
        }
    }
}
