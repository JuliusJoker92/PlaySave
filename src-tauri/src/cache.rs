//! Scan cache.
//!
//! Not an LRU in front of the scanner — that would still re-walk on a miss for
//! a folder whose size was computed thirty seconds ago. The unit of caching is
//! a whole [`Tree`]: one scan of a root publishes an answer for *every*
//! directory beneath it at once, and lookups are a hashmap hit on a normalised
//! path.
//!
//! Trees are immutable once published and handed out as `Arc`, so a lookup
//! holds the read lock only long enough to find the tree.
//!
//! Freshness policy is deliberately blunt: entries never expire on their own,
//! because a disk-usage number that quietly changes under you is worse than one
//! you know is a minute old. `clear_cache` is the refresh button.

use crate::tree::{norm, ScanResult, Tree};
use std::path::MAIN_SEPARATOR;
use std::sync::{Arc, RwLock};

/// Roots kept at once. Eight covers "every drive plus a few deep dives".
const MAX_TREES: usize = 8;
/// Roughly 750 MB of nodes at the far end; whichever limit bites first, the
/// oldest root is dropped.
const MAX_NODES: usize = 12_000_000;

pub struct Cache {
    /// Oldest first. Lookups scan backwards so a freshly scanned subfolder
    /// shadows the stale region of an older whole-volume tree.
    trees: RwLock<Vec<Arc<Tree>>>,
}

impl Default for Cache {
    fn default() -> Self {
        Cache::new()
    }
}

impl Cache {
    pub fn new() -> Cache {
        Cache {
            trees: RwLock::new(Vec::new()),
        }
    }

    /// Pure lookup. Never touches the filesystem.
    pub fn lookup(&self, path: &str) -> Option<ScanResult> {
        let key = norm(path);
        let g = self.trees.read().ok()?;
        for t in g.iter().rev() {
            if let Some(r) = t.result_for_key(&key, path) {
                return Some(r);
            }
        }
        None
    }

    /// Which backend produced the tree that would answer `path`.
    pub fn backend_for(&self, path: &str) -> Option<&'static str> {
        let key = norm(path);
        let g = self.trees.read().ok()?;
        for t in g.iter().rev() {
            if t.dirs.contains_key(&key) {
                return Some(t.backend);
            }
        }
        None
    }

    pub fn insert(&self, tree: Arc<Tree>) {
        let mut g = match self.trees.write() {
            Ok(g) => g,
            Err(_) => return,
        };
        // Anything rooted at or inside the new root is now redundant.
        let prefix = format!("{}{}", tree.key, MAIN_SEPARATOR);
        g.retain(|t| t.key != tree.key && !t.key.starts_with(&prefix));
        g.push(tree);

        while g.len() > MAX_TREES {
            g.remove(0);
        }
        while g.len() > 1 && g.iter().map(|t| t.nodes.len()).sum::<usize>() > MAX_NODES {
            g.remove(0);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut g) = self.trees.write() {
            g.clear();
        }
    }

    /// Drop every tree that could answer for `path`, so a forced refresh really
    /// re-reads the disk. A whole-volume tree answers for everything under it,
    /// so refreshing one folder has to discard the tree covering it — otherwise
    /// the stale root keeps shadowing whatever the fresh walk produces.
    pub fn evict(&self, path: &str) {
        let key = norm(path);
        if let Ok(mut g) = self.trees.write() {
            let prefix = format!("{}{}", key, MAIN_SEPARATOR);
            g.retain(|t| {
                let covers = t.dirs.contains_key(&key);
                let inside = t.key == key || t.key.starts_with(&prefix);
                !covers && !inside
            });
        }
    }

    /// `(directories answerable instantly, bytes of disk those trees account for)`.
    pub fn stats(&self) -> (u64, u64) {
        match self.trees.read() {
            Ok(g) => (
                g.iter().map(|t| t.dir_count()).sum(),
                g.iter().map(|t| t.total_bytes()).sum(),
            ),
            Err(_) => (0, 0),
        }
    }
}
