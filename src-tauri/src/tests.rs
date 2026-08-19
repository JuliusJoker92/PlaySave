//! Checks for the parts that are easy to get quietly wrong: path normalisation,
//! the subtotals the walk now retains, and cache subsumption.

#![cfg(test)]

use crate::cache::Cache;
use crate::scan::walk_root;
use crate::tree::norm;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

fn fixture(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("playsave-test-{}", tag));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("sub").join("deep")).unwrap();
    fs::create_dir_all(root.join("empty")).unwrap();
    fs::write(root.join("a.txt"), vec![0u8; 100]).unwrap();
    fs::write(root.join("sub").join("b.bin"), vec![0u8; 2000]).unwrap();
    fs::write(root.join("sub").join("deep").join("c.dat"), vec![0u8; 30]).unwrap();
    root
}

#[test]
fn norm_folds_case_separators_and_trailing_slashes() {
    assert_eq!(norm("C:\\"), norm("c:/"));
    assert_eq!(norm("C:\\"), norm("\\\\?\\C:"));
    assert_eq!(norm("C:\\Users\\Bob\\"), norm("c:/users/BOB"));
    // A drive root must not normalise to the empty string.
    assert_eq!(norm("C:\\"), "c:");
}

#[test]
fn walk_retains_every_subtotal_it_computed() {
    let root = fixture("subtotals");
    let path = root.to_string_lossy().to_string();
    let tree = walk_root(&path, None).unwrap();

    let top = tree.result_for(&path).unwrap();
    assert_eq!(top.total_bytes, 2130);
    assert_eq!(top.file_count, 3);
    assert_eq!(top.dir_count, 3); // sub, sub/deep, empty
    assert_eq!(top.errors, 0);

    // Sorted by size, descending.
    let names: Vec<&str> = top.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["sub", "a.txt", "empty"]);
    assert_eq!(top.entries[0].size_bytes, 2030);
    assert_eq!(top.entries[0].item_count, 3); // b.bin, deep, deep/c.dat
    assert_eq!(top.entries[1].ext, "txt");

    // The point of the exercise: descending needs no second walk.
    let sub = tree.result_for(&format!("{}\\sub", path)).unwrap();
    assert_eq!(sub.total_bytes, 2030);
    assert_eq!(sub.file_count, 2);
    assert_eq!(sub.dir_count, 1);
    let sub_names: Vec<&str> = sub.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(sub_names, vec!["b.bin", "deep"]);

    let deep = tree.result_for(&format!("{}\\SUB\\Deep", path)).unwrap();
    assert_eq!(deep.total_bytes, 30);
    assert_eq!(deep.entries.len(), 1);
    assert_eq!(deep.entries[0].path, format!("{}\\SUB\\Deep\\c.dat", path));

    // Files are not directories; a file path is a miss, not a zero-entry hit.
    assert!(tree.result_for(&format!("{}\\a.txt", path)).is_none());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn cache_serves_descendants_and_forgets_on_clear() {
    let root = fixture("cache");
    let path = root.to_string_lossy().to_string();
    let cache = Cache::new();

    assert!(cache.lookup(&path).is_none());
    cache.insert(Arc::new(walk_root(&path, None).unwrap()));

    let hit = cache.lookup(&format!("{}\\sub\\deep", path)).unwrap();
    assert!(hit.from_cache);
    assert_eq!(hit.total_bytes, 30);
    assert_eq!(cache.backend_for(&path), Some("walk"));

    let (paths, bytes) = cache.stats();
    assert_eq!(paths, 4); // root, sub, sub/deep, empty
    assert_eq!(bytes, 2130);

    cache.clear();
    assert!(cache.lookup(&path).is_none());
    assert_eq!(cache.stats(), (0, 0));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn inserting_a_root_drops_the_subtrees_it_covers() {
    let root = fixture("subsume");
    let path = root.to_string_lossy().to_string();
    let cache = Cache::new();

    let sub = format!("{}\\sub", path);
    cache.insert(Arc::new(walk_root(&sub, None).unwrap()));
    assert_eq!(cache.stats().0, 2); // sub, sub/deep

    cache.insert(Arc::new(walk_root(&path, None).unwrap()));
    // The narrower tree is redundant now, so it is not counted twice.
    assert_eq!(cache.stats(), (4, 2130));

    let _ = fs::remove_dir_all(&root);
}

/// Not an assertion about this machine — it prints what the fast path found so
/// a failure to engage can be told apart from a failure to compile. Run with
/// `cargo test -- --nocapture`.
#[test]
#[cfg(windows)]
fn mft_probe_reports_without_prompting() {
    use crate::mft;
    let mask = mft::probe_mask();
    println!(
        "elevated={} mft_mask={:#x} available(C:)={} records(C:)={:?}",
        mft::elevated(),
        mask,
        mft::available('C'),
        mft::record_count('C'),
    );
    // FSCTL_GET_NTFS_VOLUME_DATA goes through a plain FILE_READ_ATTRIBUTES
    // handle, so sizing works for an ordinary user even when enumeration cannot.
    if let Some(n) = mft::record_count('C') {
        assert!(n > 0, "a live NTFS volume has records");
    }
    // Not elevated must mean not available, never a hang or a prompt.
    if !mft::elevated() {
        assert_eq!(mask, 0, "no non-elevated fast path exists");
    }
}

/// Manual cross-check against a real tree, for confirming the walk agrees with
/// an independent measurement:
///
/// ```text
/// $env:XCHECK = "C:\some\folder"
/// cargo test -- --ignored --nocapture
/// Get-ChildItem -LiteralPath $env:XCHECK -Recurse -File -Force |
///     Measure-Object -Property Length -Sum
/// ```
#[test]
#[ignore]
fn crosscheck_a_real_tree() {
    let Ok(path) = std::env::var("XCHECK") else {
        println!("set XCHECK to a directory to run this");
        return;
    };
    let t = walk_root(&path, None).unwrap();
    let r = t.result_for(&path).unwrap();
    println!(
        "XCHECK total={} files={} dirs={} errors={} entries={}",
        r.total_bytes,
        r.file_count,
        r.dir_count,
        r.errors,
        r.entries.len()
    );
}

/* ------------------------------------------------------------------- copy */

/// Bytes and files must agree with the fixture exactly: the denominator the
/// progress bar divides by comes from here, and a wrong one is invisible until
/// the bar sticks at 60% or races past 100.
#[test]
fn measure_counts_the_whole_tree() {
    let root = fixture("measure");
    let (bytes, files) = crate::copy::measure(&root);
    assert_eq!(bytes, 100 + 2000 + 30);
    assert_eq!(files, 3);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn copy_reproduces_the_tree_including_empty_directories() {
    let root = fixture("copy-src");
    let dest = std::env::temp_dir().join("playsave-test-copy-dst");
    let _ = fs::remove_dir_all(&dest);
    let (bytes, files) = crate::copy::measure(&root);
    let cancel = std::sync::atomic::AtomicBool::new(false);

    crate::copy::run(None, &root, &dest, bytes, files, &cancel).unwrap();

    assert_eq!(fs::read(dest.join("a.txt")).unwrap().len(), 100);
    assert_eq!(fs::read(dest.join("sub").join("b.bin")).unwrap().len(), 2000);
    assert_eq!(
        fs::read(dest.join("sub").join("deep").join("c.dat")).unwrap().len(),
        30
    );
    // an empty folder is still part of the shape being copied
    assert!(dest.join("empty").is_dir());
    // and the copy is the same size as the original, by the same measure
    assert_eq!(crate::copy::measure(&dest), (bytes, files));

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&dest);
}

/// A copy can run for minutes against a real drive, so Esc has to stop it. The
/// flag is checked per entry, so a copy already flagged must not write a file.
#[test]
fn a_cancelled_copy_stops_and_says_so() {
    let root = fixture("copy-cancel");
    let dest = std::env::temp_dir().join("playsave-test-copy-cancel-dst");
    let _ = fs::remove_dir_all(&dest);
    let cancel = std::sync::atomic::AtomicBool::new(true);

    let e = crate::copy::run(None, &root, &dest, 2130, 3, &cancel).unwrap_err();
    assert!(e.contains("cancelled"), "{}", e);
    assert!(!dest.join("a.txt").exists(), "a cancelled copy wrote anyway");

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&dest);
}

#[test]
fn a_single_file_copies_and_measures_as_one_file() {
    let root = fixture("copy-file");
    let src = root.join("a.txt");
    let dest = root.join("copied.txt");
    assert_eq!(crate::copy::measure(&src), (100, 1));
    let cancel = std::sync::atomic::AtomicBool::new(false);
    crate::copy::run(None, &src, &dest, 100, 1, &cancel).unwrap();
    assert_eq!(fs::read(&dest).unwrap().len(), 100);
    let _ = fs::remove_dir_all(&root);
}

/// The destination is chosen by browsing now, so "inside itself" is reachable
/// by hand and has to be caught by text before anything is created.
#[test]
fn a_folder_cannot_be_copied_inside_itself() {
    assert!(crate::within(r"D:\Games\Sub", r"D:\Games"));
    assert!(crate::within(r"D:\Games", r"D:\Games"));
    assert!(crate::within(r"d:/games/sub/", r"D:\Games"));
    // a sibling that merely shares a prefix is not inside it
    assert!(!crate::within(r"D:\GamesOther", r"D:\Games"));
    assert!(!crate::within(r"D:\Other", r"D:\Games"));
}

/// A drive root is a fine place to copy TO and a terrible thing to delete.
#[test]
fn the_destination_guard_allows_roots_but_not_system_trees() {
    assert!(crate::refuse_dest(r"D:\").is_none());
    assert!(crate::refuse_dest(r"D:\Games\Steam").is_none());
    assert!(crate::refuse_dest(r"C:\Windows\System32").is_some());
    assert!(crate::refuse_dest(r"C:\Program Files").is_some());
    // and the delete guard still refuses the root
    assert!(crate::refuse(r"D:\").is_some());
    assert!(crate::refuse(r"C:\Windows").is_some());
    assert!(crate::refuse(r"C:\Users\Bob\Stuff").is_none());
}

/// Copying something into the folder it already lives in is the one case where
/// a name clash is certain, so refusing was the wrong answer. Explorer keeps
/// both, and so does this.
#[test]
fn a_clashing_name_gets_a_copy_suffix_rather_than_a_refusal() {
    let root = fixture("free-name");
    // a.txt exists in the fixture
    assert_eq!(crate::free_name(&root, "a.txt", false).unwrap(), "a - Copy.txt");
    fs::write(root.join("a - Copy.txt"), b"x").unwrap();
    assert_eq!(crate::free_name(&root, "a.txt", false).unwrap(), "a - Copy (2).txt");
    // a name nothing has taken is left alone
    assert_eq!(crate::free_name(&root, "b.txt", false).unwrap(), "b.txt");
    // folders keep their whole name: the part after a dot is not an extension
    assert_eq!(crate::free_name(&root, "sub", true).unwrap(), "sub - Copy");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_extension_split_handles_the_awkward_names() {
    assert_eq!(crate::split_ext("notes.txt"), ("notes", ".txt"));
    assert_eq!(crate::split_ext("archive.tar.gz"), ("archive.tar", ".gz"));
    // a leading dot is a name, not an extension
    assert_eq!(crate::split_ext(".gitignore"), (".gitignore", ""));
    assert_eq!(crate::split_ext("README"), ("README", ""));
}

/// The walk runs on the `\\?\` long-path form; the front end matches rows by
/// the plain path the announcer sent. If the two disagree by so much as a
/// leading separator, every measured size is silently dropped and every row
/// sits on "measuring..." until the scan finishes and replaces the listing.
///
/// That is exactly what `.replace("\\?\\", "")` did: that literal is the THREE
/// characters backslash-question-backslash, one short of the four-character
/// prefix, so it left the path starting with a stray separator.
#[test]
fn the_walk_and_the_announcer_agree_on_a_path() {
    use crate::scan::plain;
    use std::path::Path;

    assert_eq!(plain(Path::new(r"\\?\E:\mono.msi")), r"E:\mono.msi");
    assert_eq!(plain(Path::new(r"\\?\E:\dir\file.txt")), r"E:\dir\file.txt");
    // a path that never had the prefix is returned untouched
    assert_eq!(plain(Path::new(r"E:\mono.msi")), r"E:\mono.msi");
    assert_eq!(plain(Path::new(r"E:\")), r"E:\");

    // the old expression, kept as a guard: it left a leading separator, so the
    // parent derived from it ("\E:") could never equal the folder being
    // scanned ("E:")
    let broken = r"\\?\E:\mono.msi".replace(r"\?\", "");
    assert_eq!(broken, r"\E:\mono.msi");
    assert_ne!(broken, plain(Path::new(r"\\?\E:\mono.msi")));
}
