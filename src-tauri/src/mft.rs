//! The NTFS Master File Table fast path.
//!
//! A directory walk asks the filesystem one question per file. The MFT *is* the
//! answer sheet: one record per file, name + parent + size, laid out
//! contiguously enough to stream off an NVMe in a couple of seconds. On a
//! multi-million-file volume that is the difference between minutes and
//! seconds — call it 30-60x, not the 1000x the internet likes to claim, since
//! the walk itself saturates around 100k entries/s across 8-16 threads.
//!
//! Why raw `$MFT` and not `FSCTL_ENUM_USN_DATA`: the USN records carry no size
//! field at all. They give you the namespace and nothing else, which is why
//! Everything (a name index) uses them and WizTree (a size analyser) does not.
//! Statting every file to recover the sizes would hand back the entire win.
//!
//! Both routes need Administrator, and there is no non-elevated fast path:
//! opening `\\.\C:` for read fails with ERROR_ACCESS_DENIED (5) for an ordinary
//! user. So this module *detects and degrades*. It never asks for elevation,
//! never shows a UAC prompt, and every failure path returns `None` so the
//! caller silently walks instead.
//!
//! Correctness notes, since this is the part that is easy to get subtly wrong:
//!
//! * **Fragmented files.** A file whose attributes overflow its base record
//!   keeps its `$DATA` in an *extension* record listed in `$ATTRIBUTE_LIST`.
//!   Readers that only look at base records report size 0 for exactly the huge
//!   files a disk-usage tool exists to find. Because this is a full sweep we do
//!   not need to follow attribute lists at all: extension records are
//!   recognised by a non-zero base reference and their `$DATA` is folded back
//!   into the base record's entry.
//! * **Multi-extent `$DATA`.** Only the extent with `StartingVCN == 0` carries
//!   the real size in its header, so that is the only one consulted.
//! * **Hardlinks.** One record is one file, no matter how many `$FILE_NAME`
//!   attributes it carries, so a hardlinked file is counted once and filed
//!   under its first Win32 name. This is the `TODO: dedupe by file id` in
//!   `scan.rs`, resolved — on this backend.
//! * **Alternate data streams** are skipped (unnamed `$DATA` only), so sizes
//!   match what Explorer shows.

#![cfg(windows)]

use crate::tree::{roll_up, Node, Tree, NIL};
use std::ffi::c_void;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, GetDriveTypeW, GetVolumeInformationW, ReadFile, SetFilePointerEx, FILE_BEGIN,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_SEQUENTIAL_SCAN, FILE_READ_ATTRIBUTES, FILE_READ_DATA,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Ioctl::{FSCTL_GET_NTFS_VOLUME_DATA, NTFS_VOLUME_DATA_BUFFER};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::System::IO::DeviceIoControl;

pub const BACKEND: &str = "mft";

const DRIVE_FIXED: u32 = 3;

/// The NTFS root directory is always record 5.
const ROOT_REC: u32 = 5;
/// Guard against a corrupt `MftValidDataLength`; 64M records is ~64 GB of $MFT.
const MAX_RECORDS: u64 = 64 << 20;

/* --------------------------------------------------------------- handles */

struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A handle to the volume's raw byte stream. Administrator only — this is the
/// gate the whole module hangs on, and it fails fast and quietly without it.
fn open_volume(letter: char) -> Option<Owned> {
    let w = wide(&format!("\\\\.\\{}:", letter));
    let h = unsafe {
        CreateFileW(
            PCWSTR(w.as_ptr()),
            FILE_READ_DATA.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_SEQUENTIAL_SCAN,
            None,
        )
    }
    .ok()?;
    Some(Owned(h))
}

/// A handle to `X:\` itself. `FILE_READ_ATTRIBUTES | FILE_FLAG_BACKUP_SEMANTICS`
/// is enough for an ordinary user, which is what makes sizing the job up
/// possible *before* deciding whether the fast path is worth attempting.
fn open_root(letter: char) -> Option<Owned> {
    let w = wide(&format!("{}:\\", letter));
    let h = unsafe {
        CreateFileW(
            PCWSTR(w.as_ptr()),
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .ok()?;
    Some(Owned(h))
}

fn volume_data(h: HANDLE) -> Option<NTFS_VOLUME_DATA_BUFFER> {
    let mut vd = NTFS_VOLUME_DATA_BUFFER::default();
    let mut ret = 0u32;
    unsafe {
        DeviceIoControl(
            h,
            FSCTL_GET_NTFS_VOLUME_DATA,
            None,
            0,
            Some(&mut vd as *mut _ as *mut c_void),
            std::mem::size_of::<NTFS_VOLUME_DATA_BUFFER>() as u32,
            Some(&mut ret),
            None,
        )
    }
    .ok()?;
    Some(vd)
}

/* ------------------------------------------------------------ capability */

/// Does this process hold an elevated token? Purely informational — nothing is
/// gated on it, because the real test is whether the volume opens.
pub fn elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let guard = Owned(token);
        let mut info = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            guard.0,
            TokenElevation,
            Some(&mut info as *mut _ as *mut c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        ok && info.TokenIsElevated != 0
    }
}

fn is_ntfs(letter: char) -> bool {
    let w = wide(&format!("{}:\\", letter));
    let mut fsname = [0u16; 32];
    let ok = unsafe {
        GetVolumeInformationW(
            PCWSTR(w.as_ptr()),
            None,
            None,
            None,
            None,
            Some(&mut fsname),
        )
    }
    .is_ok();
    if !ok {
        return false;
    }
    String::from_utf16_lossy(&fsname)
        .trim_end_matches('\0')
        .eq_ignore_ascii_case("NTFS")
}

/// Fixed volume, NTFS, and the raw handle actually opens. All three, or we walk.
pub fn available(letter: char) -> bool {
    let w = wide(&format!("{}:\\", letter));
    if unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) } != DRIVE_FIXED {
        return false;
    }
    if !is_ntfs(letter) {
        return false;
    }
    open_volume(letter).is_some()
}

/// Bitmask over `A..=Z` of volumes the fast path can serve. Probed once; every
/// call is a `CreateFileW` that fails immediately when not elevated, so this is
/// cheap and, crucially, silent.
pub fn probe_mask() -> u32 {
    let mut mask = 0u32;
    for i in 0..26u32 {
        let letter = (b'A' + i as u8) as char;
        if available(letter) {
            mask |= 1 << i;
        }
    }
    mask
}

/// How many file records the volume holds — i.e. how big the job is.
///
/// This one goes through a handle to `X:\` opened with
/// `FILE_READ_ATTRIBUTES | FILE_FLAG_BACKUP_SEMANTICS`, which an ordinary user
/// can get. `FSCTL_GET_NTFS_VOLUME_DATA` succeeds there even when the raw
/// volume handle does not, so the size of the prize is knowable before anything
/// privileged is attempted.
pub fn record_count(letter: char) -> Option<u64> {
    let h = open_root(letter)?;
    let vd = volume_data(h.0)?;
    let rec = vd.BytesPerFileRecordSegment.max(1) as u64;
    Some(vd.MftValidDataLength.max(0) as u64 / rec)
}

/* -------------------------------------------------------- byte accessors */

#[inline]
fn u16at(b: &[u8], o: usize) -> Option<u16> {
    b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}

#[inline]
fn u32at(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

#[inline]
fn u64at(b: &[u8], o: usize) -> Option<u64> {
    b.get(o..o + 8).map(|s| {
        u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]])
    })
}

/// FILETIME (100ns ticks since 1601) -> Unix milliseconds.
fn filetime_ms(ft: u64) -> i64 {
    if ft == 0 {
        return 0;
    }
    (ft / 10_000) as i64 - 11_644_473_600_000
}

/* ---------------------------------------------------------- run lists */

/// `(lcn, clusters)`; `lcn < 0` marks a sparse hole.
fn parse_runs(data: &[u8]) -> Vec<(i64, u64)> {
    let mut runs = Vec::new();
    let mut pos = 0usize;
    let mut lcn: i64 = 0;
    while pos < data.len() {
        let header = data[pos];
        if header == 0 {
            break;
        }
        let len_sz = (header & 0x0f) as usize;
        let off_sz = (header >> 4) as usize;
        pos += 1;
        if len_sz == 0 || len_sz > 8 || off_sz > 8 || pos + len_sz + off_sz > data.len() {
            break;
        }
        let mut count = 0u64;
        for (i, b) in data[pos..pos + len_sz].iter().enumerate() {
            count |= (*b as u64) << (8 * i);
        }
        pos += len_sz;
        if off_sz == 0 {
            runs.push((-1, count));
            continue;
        }
        // Sign-extended little-endian delta against the previous LCN.
        let bytes = &data[pos..pos + off_sz];
        let mut delta: i64 = 0;
        for (i, b) in bytes.iter().enumerate() {
            delta |= (*b as i64) << (8 * i);
        }
        let sign_bit = 1i64 << (off_sz * 8 - 1);
        if delta & sign_bit != 0 {
            delta -= 1i64 << (off_sz * 8);
        }
        pos += off_sz;
        lcn += delta;
        if lcn < 0 {
            break;
        }
        runs.push((lcn, count));
    }
    runs
}

/* ------------------------------------------------------- record parsing */

/// The update sequence array replaces the last two bytes of every sector with
/// a stamp; the originals live in the array and have to be put back before the
/// record means anything.
///
/// The stride is derived from the record rather than from the volume's reported
/// sector size — `UpdateSequenceCount - 1` is by definition the number of
/// sectors this record spans, so this stays right on 4Kn and 512e alike instead
/// of rejecting every record when the two disagree.
fn apply_fixup(rec: &mut [u8]) -> bool {
    let uoff = match u16at(rec, 0x04) {
        Some(v) => v as usize,
        None => return false,
    };
    let ucnt = match u16at(rec, 0x06) {
        Some(v) => v as usize,
        None => return false,
    };
    if ucnt == 0 || uoff + ucnt * 2 > rec.len() {
        return false;
    }
    if ucnt == 1 {
        return true; // nothing was stamped
    }
    let stride = rec.len() / (ucnt - 1);
    if stride < 4 {
        return false;
    }
    let usn = match u16at(rec, uoff) {
        Some(v) => v,
        None => return false,
    };
    for i in 1..ucnt {
        let pos = match i.checked_mul(stride).and_then(|v| v.checked_sub(2)) {
            Some(p) => p,
            None => return false,
        };
        if pos + 2 > rec.len() {
            return false;
        }
        if u16at(rec, pos) != Some(usn) {
            return false;
        }
        let v = match u16at(rec, uoff + i * 2) {
            Some(v) => v,
            None => return false,
        };
        rec[pos] = (v & 0xff) as u8;
        rec[pos + 1] = (v >> 8) as u8;
    }
    true
}

struct Parsed {
    in_use: bool,
    is_dir: bool,
    /// 0 when this is a base record; otherwise the record it extends.
    base: u32,
    parent: u32,
    name: Option<Box<str>>,
    name_rank: u8,
    size: u64,
    mtime: i64,
}

/// Every read here is bounds-checked: this is on-disk data and a panic inside a
/// Tauri command would take the scan down instead of degrading to a walk.
fn parse_record(rec: &[u8]) -> Option<Parsed> {
    if rec.len() < 48 || &rec[0..4] != b"FILE" {
        return None;
    }
    let attr_off = u16at(rec, 0x14)? as usize;
    let flags = u16at(rec, 0x16)?;
    let used = u32at(rec, 0x18)? as usize;
    let base_ref = u64at(rec, 0x20)?;

    let mut p = Parsed {
        in_use: flags & 0x01 != 0,
        is_dir: flags & 0x02 != 0,
        base: (base_ref & 0x0000_FFFF_FFFF_FFFF) as u32,
        parent: NIL,
        name: None,
        name_rank: u8::MAX,
        size: 0,
        mtime: 0,
    };
    if !p.in_use {
        return Some(p);
    }

    let limit = used.min(rec.len());
    let mut off = attr_off;
    while off + 16 <= limit {
        let atype = u32at(rec, off)?;
        if atype == 0xFFFF_FFFF {
            break;
        }
        let alen = u32at(rec, off + 4)? as usize;
        if alen < 16 || alen % 8 != 0 || off + alen > limit {
            break;
        }
        let non_resident = *rec.get(off + 8)? != 0;
        let name_len = *rec.get(off + 9)? as usize;
        // A header too short for its own kind is corrupt; reading its size
        // fields would return whatever happened to follow it in the record.
        if alen < if non_resident { 0x40 } else { 0x18 } {
            break;
        }

        match atype {
            // $STANDARD_INFORMATION — always resident.
            0x10 if !non_resident => {
                let voff = u16at(rec, off + 0x14)? as usize;
                if let Some(v) = rec.get(off + voff..off + alen) {
                    if let Some(ft) = u64at(v, 0x08) {
                        p.mtime = filetime_ms(ft);
                    }
                }
            }
            // $FILE_NAME — one per hardlink; keep the best namespace only.
            0x30 if !non_resident => {
                let vlen = u32at(rec, off + 0x10)? as usize;
                let voff = u16at(rec, off + 0x14)? as usize;
                if let Some(v) = rec.get(off + voff..off + voff + vlen) {
                    if v.len() >= 0x42 {
                        let namespace = v[0x41];
                        // 1 = Win32, 3 = Win32&DOS, 0 = POSIX, 2 = the 8.3 alias.
                        let rank = match namespace {
                            1 | 3 => 0u8,
                            0 => 1,
                            _ => 2,
                        };
                        if rank < p.name_rank {
                            let nlen = v[0x40] as usize;
                            if let Some(raw) = v.get(0x42..0x42 + nlen * 2) {
                                let units: Vec<u16> = raw
                                    .chunks_exact(2)
                                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                                    .collect();
                                let parent = u64at(v, 0)? & 0x0000_FFFF_FFFF_FFFF;
                                p.name =
                                    Some(String::from_utf16_lossy(&units).into_boxed_str());
                                p.name_rank = rank;
                                p.parent = parent as u32;
                            }
                        }
                    }
                }
            }
            // $DATA — unnamed stream only, so alternate streams don't inflate
            // the number the user sees next to the file in Explorer.
            0x80 if name_len == 0 => {
                let candidate = if non_resident {
                    if u64at(rec, off + 0x10)? != 0 {
                        // Not the first extent; its header carries no real size.
                        0
                    } else {
                        u64at(rec, off + 0x30)?
                    }
                } else {
                    u32at(rec, off + 0x10)? as u64
                };
                if candidate > p.size {
                    p.size = candidate;
                }
            }
            _ => {}
        }
        off += alen;
    }
    Some(p)
}

/* -------------------------------------------------------------- reading */

fn read_at(h: HANDLE, offset: u64, buf: &mut [u8]) -> bool {
    if unsafe { SetFilePointerEx(h, offset as i64, None, FILE_BEGIN) }.is_err() {
        return false;
    }
    let mut done = 0usize;
    while done < buf.len() {
        let mut got = 0u32;
        let ok = unsafe { ReadFile(h, Some(&mut buf[done..]), Some(&mut got), None) }.is_ok();
        if !ok || got == 0 {
            return false;
        }
        done += got as usize;
    }
    true
}

#[derive(Clone)]
struct Rec {
    parent: u32,
    name: Option<Box<str>>,
    size: u64,
    mtime: i64,
    is_dir: bool,
    live: bool,
}

impl Default for Rec {
    fn default() -> Rec {
        Rec {
            parent: NIL,
            name: None,
            size: 0,
            mtime: 0,
            is_dir: false,
            live: false,
        }
    }
}

/// Enumerate one volume and return the whole thing as a tree. `None` means
/// "not available, walk instead" and is never an error the user hears about.
pub fn build_tree(letter: char) -> Option<Tree> {
    if !is_ntfs(letter) {
        return None;
    }
    let vol = open_volume(letter)?;
    let vd = volume_data(vol.0)?;

    let sector = vd.BytesPerSector as usize;
    let cluster = vd.BytesPerCluster as u64;
    let rec_size = vd.BytesPerFileRecordSegment as usize;
    let valid = vd.MftValidDataLength.max(0) as u64;
    if sector < 256 || cluster == 0 || !(256..=65536).contains(&rec_size) || valid < rec_size as u64
    {
        return None;
    }
    let record_count = valid / rec_size as u64;
    if record_count <= ROOT_REC as u64 || record_count > MAX_RECORDS {
        return None;
    }

    // Record 0 is $MFT's own record; its $DATA run list is the map to the rest.
    let mut first = vec![0u8; rec_size];
    let mft_start = (vd.MftStartLcn.max(0) as u64).checked_mul(cluster)?;
    if !read_at(vol.0, mft_start, &mut first) {
        return None;
    }
    if !apply_fixup(&mut first) {
        return None;
    }
    let runs = mft_runs(&first)?;

    let covered: u64 = runs.iter().map(|(_, c)| c).sum::<u64>().saturating_mul(cluster);
    if covered < valid {
        // $MFT is fragmented past what fits in record 0 and the rest lives
        // behind an $ATTRIBUTE_LIST. Rather than half-enumerate the volume and
        // report confident wrong numbers, hand the job back to the walker.
        return None;
    }

    let recs = sweep(vol.0, &runs, cluster, rec_size, valid, record_count)?;
    assemble(letter, recs)
}

/// The unnamed non-resident `$DATA` run list out of record 0.
fn mft_runs(rec: &[u8]) -> Option<Vec<(i64, u64)>> {
    let attr_off = u16at(rec, 0x14)? as usize;
    let used = (u32at(rec, 0x18)? as usize).min(rec.len());
    let mut off = attr_off;
    while off + 16 <= used {
        let atype = u32at(rec, off)?;
        if atype == 0xFFFF_FFFF {
            break;
        }
        let alen = u32at(rec, off + 4)? as usize;
        if alen < 16 || off + alen > used {
            break;
        }
        let non_resident = *rec.get(off + 8)? != 0;
        let name_len = *rec.get(off + 9)? as usize;
        if non_resident && alen < 0x40 {
            break;
        }
        if atype == 0x80 && non_resident && name_len == 0 && u64at(rec, off + 0x10)? == 0 {
            let run_off = u16at(rec, off + 0x20)? as usize;
            let data = rec.get(off + run_off..off + alen)?;
            let runs = parse_runs(data);
            if runs.is_empty() {
                return None;
            }
            return Some(runs);
        }
        off += alen;
    }
    None
}

/// Stream the whole table once, parsing every record as it goes.
fn sweep(
    h: HANDLE,
    runs: &[(i64, u64)],
    cluster: u64,
    rec_size: usize,
    valid: u64,
    record_count: u64,
) -> Option<Vec<Rec>> {
    let mut recs: Vec<Rec> = vec![Rec::default(); record_count as usize];
    // $DATA found in an extension record, to be folded back into its base.
    let mut adopted: Vec<(u32, u64)> = Vec::new();

    // ~8 MB per read, rounded up to whole clusters.
    let chunk = {
        let target = 8u64 << 20;
        let c = ((target + cluster - 1) / cluster) * cluster;
        c.max(cluster) as usize
    };
    let mut buf = vec![0u8; chunk + rec_size];
    let mut carry = 0usize;
    let mut stream_pos: u64 = 0;

    'runs: for &(lcn, clusters) in runs {
        let run_bytes = clusters.saturating_mul(cluster);
        if lcn < 0 {
            // A sparse hole in $MFT would be extraordinary; skip its records.
            // Any partly-read record carried in from the previous run is part
            // of the stream too, so it counts towards the position even though
            // it is being thrown away — otherwise every record number after
            // the hole is off by the size of the carry.
            stream_pos = stream_pos
                .saturating_add(carry as u64)
                .saturating_add(run_bytes);
            carry = 0;
            continue;
        }
        let mut off = 0u64;
        while off < run_bytes {
            if stream_pos >= valid {
                break 'runs;
            }
            let want = ((run_bytes - off) as usize).min(chunk);
            if !read_at(h, (lcn as u64) * cluster + off, &mut buf[carry..carry + want]) {
                return None;
            }
            off += want as u64;

            let filled = carry + want;
            let whole = filled - (filled % rec_size);
            let mut at = 0usize;
            while at + rec_size <= whole {
                if stream_pos >= valid {
                    break 'runs;
                }
                let number = (stream_pos / rec_size as u64) as usize;
                stream_pos += rec_size as u64;
                let slice = &mut buf[at..at + rec_size];
                at += rec_size;
                if number >= recs.len() {
                    continue;
                }
                if !apply_fixup(slice) {
                    continue;
                }
                let Some(p) = parse_record(slice) else {
                    continue;
                };
                if !p.in_use {
                    continue;
                }
                if p.base != 0 {
                    if p.size > 0 {
                        adopted.push((p.base, p.size));
                    }
                    continue;
                }
                let Some(name) = p.name else { continue };
                recs[number] = Rec {
                    parent: p.parent,
                    name: Some(name),
                    size: if p.is_dir { 0 } else { p.size },
                    mtime: p.mtime,
                    is_dir: p.is_dir,
                    live: true,
                };
            }
            // A record straddling a run boundary is only possible when the
            // cluster size is smaller than a record; carry the tail forwards.
            carry = filled - whole;
            if carry > 0 {
                buf.copy_within(whole..filled, 0);
            }
        }
    }

    for (base, size) in adopted {
        if let Some(r) = recs.get_mut(base as usize) {
            if r.live && !r.is_dir && size > r.size {
                r.size = size;
            }
        }
    }
    Some(recs)
}

/// Records -> arena tree. Parent links come straight out of `$FILE_NAME`, so
/// this is a link pass and a roll-up, no I/O.
fn assemble(letter: char, recs: Vec<Rec>) -> Option<Tree> {
    let root_display = format!("{}:\\", letter);
    let n = recs.len();
    if !recs.get(ROOT_REC as usize).map(|r| r.live).unwrap_or(false) {
        return None;
    }

    let mut index: Vec<u32> = vec![NIL; n];
    let mut nodes: Vec<Node> = Vec::with_capacity(n / 2 + 1);

    nodes.push(Node::dir(
        root_display.clone().into_boxed_str(),
        recs[ROOT_REC as usize].mtime,
    ));
    index[ROOT_REC as usize] = 0;

    for (i, r) in recs.iter().enumerate() {
        if i == ROOT_REC as usize || !r.live {
            continue;
        }
        let Some(name) = r.name.as_ref() else { continue };
        index[i] = nodes.len() as u32;
        nodes.push(if r.is_dir {
            Node::dir(name.clone(), r.mtime)
        } else {
            Node::file(name.clone(), r.size, r.mtime)
        });
    }

    let mut orphans = 0u32;
    for (i, r) in recs.iter().enumerate() {
        if i == ROOT_REC as usize {
            continue;
        }
        let child = index[i];
        if child == NIL {
            continue;
        }
        let parent_rec = r.parent as usize;
        let parent = match recs.get(parent_rec) {
            Some(p) if p.live && p.is_dir => index[parent_rec],
            _ => NIL,
        };
        if parent == NIL || parent == child {
            orphans = orphans.saturating_add(1);
            continue;
        }
        nodes[child as usize].parent = parent;
        nodes[child as usize].next_sibling = nodes[parent as usize].first_child;
        nodes[parent as usize].first_child = child;
    }

    drop(recs);
    roll_up(&mut nodes);
    nodes[0].errors = orphans;
    nodes.shrink_to_fit();

    // A volume with no children or no bytes means the parse went wrong
    // somewhere subtle; better to walk than to show a confident zero.
    if nodes.len() < 2 || nodes[0].size == 0 {
        return None;
    }
    Some(Tree::new(&root_display, BACKEND, nodes))
}

/* ---------------------------------------------------------------- tests */

/// The record parser is the half of this module that cannot be exercised
/// without an elevated session, so it is exercised against hand-built records
/// instead. Every offset below is the on-disk NTFS layout; if one of these
/// fails, a real sweep would be returning plausible-looking nonsense.
#[cfg(test)]
mod tests {
    use super::*;

    const REC: usize = 1024;
    const SECTOR: usize = 512;

    struct Rb {
        buf: Vec<u8>,
        end: usize,
    }

    impl Rb {
        /// `flags`: 0x01 in use, 0x02 directory.
        fn new(flags: u16, base: u64) -> Rb {
            let mut buf = vec![0u8; REC];
            buf[0..4].copy_from_slice(b"FILE");
            buf[4..6].copy_from_slice(&0x30u16.to_le_bytes()); // USA offset
            buf[6..8].copy_from_slice(&3u16.to_le_bytes()); // USA count: 2 sectors + 1
            buf[0x14..0x16].copy_from_slice(&0x38u16.to_le_bytes()); // first attribute
            buf[0x16..0x18].copy_from_slice(&flags.to_le_bytes());
            buf[0x20..0x28].copy_from_slice(&base.to_le_bytes());
            Rb { buf, end: 0x38 }
        }

        fn resident(&mut self, atype: u32, name_len: u8, value: &[u8]) -> &mut Rb {
            let len = 0x18 + value.len();
            let len = (len + 7) & !7; // 8-byte aligned
            let o = self.end;
            self.buf[o..o + 4].copy_from_slice(&atype.to_le_bytes());
            self.buf[o + 4..o + 8].copy_from_slice(&(len as u32).to_le_bytes());
            self.buf[o + 8] = 0;
            self.buf[o + 9] = name_len;
            self.buf[o + 0x10..o + 0x14].copy_from_slice(&(value.len() as u32).to_le_bytes());
            self.buf[o + 0x14..o + 0x16].copy_from_slice(&0x18u16.to_le_bytes());
            self.buf[o + 0x18..o + 0x18 + value.len()].copy_from_slice(value);
            self.end = o + len;
            self
        }

        fn non_resident(
            &mut self,
            atype: u32,
            name_len: u8,
            start_vcn: u64,
            real: u64,
            runs: &[u8],
        ) -> &mut Rb {
            let len = ((0x40 + runs.len()) + 7) & !7;
            let o = self.end;
            self.buf[o..o + 4].copy_from_slice(&atype.to_le_bytes());
            self.buf[o + 4..o + 8].copy_from_slice(&(len as u32).to_le_bytes());
            self.buf[o + 8] = 1;
            self.buf[o + 9] = name_len;
            self.buf[o + 0x10..o + 0x18].copy_from_slice(&start_vcn.to_le_bytes());
            self.buf[o + 0x20..o + 0x22].copy_from_slice(&0x40u16.to_le_bytes());
            self.buf[o + 0x28..o + 0x30].copy_from_slice(&real.to_le_bytes()); // allocated
            self.buf[o + 0x30..o + 0x38].copy_from_slice(&real.to_le_bytes()); // real
            self.buf[o + 0x40..o + 0x40 + runs.len()].copy_from_slice(runs);
            self.end = o + len;
            self
        }

        fn finish(&mut self) -> Vec<u8> {
            let o = self.end;
            self.buf[o..o + 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
            let used = o + 8;
            self.buf[0x18..0x1C].copy_from_slice(&(used as u32).to_le_bytes());
            self.buf.clone()
        }

        /// Stamp the record the way NTFS does on the way to disk, so the parser
        /// has to undo it.
        fn stamped(&mut self, usn: u16, originals: [u16; 2]) -> Vec<u8> {
            let mut b = self.finish();
            b[0x30..0x32].copy_from_slice(&usn.to_le_bytes());
            for (i, orig) in originals.iter().enumerate() {
                b[0x32 + i * 2..0x34 + i * 2].copy_from_slice(&orig.to_le_bytes());
                let pos = (i + 1) * SECTOR - 2;
                b[pos..pos + 2].copy_from_slice(&usn.to_le_bytes());
            }
            b
        }
    }

    fn std_info(mtime_ft: u64) -> Vec<u8> {
        let mut v = vec![0u8; 0x30];
        v[0x08..0x10].copy_from_slice(&mtime_ft.to_le_bytes());
        v
    }

    fn file_name(parent: u64, namespace: u8, name: &str) -> Vec<u8> {
        let units: Vec<u16> = name.encode_utf16().collect();
        let mut v = vec![0u8; 0x42 + units.len() * 2];
        v[0..8].copy_from_slice(&parent.to_le_bytes());
        v[0x40] = units.len() as u8;
        v[0x41] = namespace;
        for (i, u) in units.iter().enumerate() {
            v[0x42 + i * 2..0x44 + i * 2].copy_from_slice(&u.to_le_bytes());
        }
        v
    }

    /// A parent reference is a 48-bit record number with a 16-bit sequence
    /// number on top; forgetting to mask it sends every file to a bogus parent.
    fn parent_ref(rec: u64, seq: u16) -> u64 {
        rec | ((seq as u64) << 48)
    }

    #[test]
    fn fixup_restores_the_stamped_sector_tails() {
        let mut b = Rb::new(0x01, 0);
        b.resident(0x10, 0, &std_info(0));
        let mut rec = b.stamped(0x1234, [0xAAAA, 0xBBBB]);
        assert!(apply_fixup(&mut rec));
        assert_eq!(u16at(&rec, SECTOR - 2), Some(0xAAAA));
        assert_eq!(u16at(&rec, 2 * SECTOR - 2), Some(0xBBBB));
    }

    #[test]
    fn fixup_rejects_a_record_whose_stamps_do_not_match() {
        let mut b = Rb::new(0x01, 0);
        b.resident(0x10, 0, &std_info(0));
        let mut rec = b.stamped(0x1234, [0xAAAA, 0xBBBB]);
        rec[SECTOR - 1] = 0xFF; // torn write
        assert!(!apply_fixup(&mut rec));
    }

    #[test]
    fn reads_name_parent_size_and_mtime_off_a_file_record() {
        // 2024-01-01T00:00:00Z
        let ft = 133_485_408_000_000_000u64;
        let mut b = Rb::new(0x01, 0);
        b.resident(0x10, 0, &std_info(ft));
        b.resident(0x30, 0, &file_name(parent_ref(5, 3), 1, "Big File.iso"));
        b.non_resident(0x80, 0, 0, 12_345_678_901, &[0x21, 0x18, 0x34, 0x56]);
        let rec = b.finish();

        let p = parse_record(&rec).expect("parses");
        assert!(p.in_use && !p.is_dir);
        assert_eq!(p.base, 0);
        assert_eq!(p.parent, 5, "sequence number must be masked off");
        assert_eq!(p.name.as_deref(), Some("Big File.iso"));
        assert_eq!(p.size, 12_345_678_901);
        assert_eq!(p.mtime, 1_704_067_200_000);
    }

    #[test]
    fn prefers_the_win32_name_over_the_8_3_alias() {
        let mut b = Rb::new(0x01, 0);
        // The DOS-namespace name comes first, as it often does on disk.
        b.resident(0x30, 0, &file_name(parent_ref(11, 1), 2, "PROGRA~1"));
        b.resident(0x30, 0, &file_name(parent_ref(11, 1), 1, "Program Files"));
        let rec = b.finish();
        let p = parse_record(&rec).unwrap();
        assert_eq!(p.name.as_deref(), Some("Program Files"));
        assert_eq!(p.parent, 11);
    }

    #[test]
    fn ignores_alternate_streams_and_later_extents() {
        let mut b = Rb::new(0x01, 0);
        b.resident(0x30, 0, &file_name(parent_ref(5, 1), 1, "clip.mp4"));
        b.non_resident(0x80, 0, 0, 4096, &[]); // the real unnamed stream
        b.non_resident(0x80, 8, 0, 999_999_999, &[]); // an ADS: named, skip it
        b.non_resident(0x80, 0, 64, 888_888_888, &[]); // VCN != 0: no real size
        let rec = b.finish();
        let p = parse_record(&rec).unwrap();
        assert_eq!(p.size, 4096);
    }

    #[test]
    fn resident_data_is_sized_by_its_value_length() {
        let mut b = Rb::new(0x01, 0);
        b.resident(0x30, 0, &file_name(parent_ref(5, 1), 1, "tiny.txt"));
        b.resident(0x80, 0, &[7u8; 42]);
        let rec = b.finish();
        assert_eq!(parse_record(&rec).unwrap().size, 42);
    }

    #[test]
    fn extension_records_are_recognised_by_their_base_reference() {
        // The $ATTRIBUTE_LIST case: a fragmented file's $DATA lives here, not in
        // the base record. Missing this is how large files come back as size 0.
        let mut b = Rb::new(0x01, parent_ref(700, 2));
        b.non_resident(0x80, 0, 0, 9_000_000_000, &[]);
        let rec = b.finish();
        let p = parse_record(&rec).unwrap();
        assert_eq!(p.base, 700);
        assert_eq!(p.size, 9_000_000_000);
        assert!(p.name.is_none());
    }

    #[test]
    fn a_free_record_is_reported_as_such() {
        let mut b = Rb::new(0x00, 0);
        b.resident(0x30, 0, &file_name(parent_ref(5, 1), 1, "deleted.txt"));
        let rec = b.finish();
        assert!(!parse_record(&rec).unwrap().in_use);
    }

    #[test]
    fn garbage_is_declined_rather_than_panicking() {
        assert!(parse_record(&[]).is_none());
        assert!(parse_record(&[0u8; 1024]).is_none());
        let mut junk = vec![0xFFu8; 1024];
        junk[0..4].copy_from_slice(b"FILE");
        let _ = parse_record(&junk); // must not panic
    }

    #[test]
    fn run_lists_decode_signed_relative_offsets() {
        // 0x21: 1 length byte, 2 offset bytes.
        let runs = parse_runs(&[0x21, 0x18, 0x34, 0x56, 0x11, 0x30, 0xE0, 0x00]);
        assert_eq!(runs, vec![(0x5634, 0x18), (0x5634 - 0x20, 0x30)]);
    }

    #[test]
    fn sparse_runs_are_flagged_not_mistaken_for_lcn_zero() {
        let runs = parse_runs(&[0x01, 0x40, 0x00]);
        assert_eq!(runs, vec![(-1, 0x40)]);
    }

    #[test]
    fn assemble_links_parents_rolls_up_sizes_and_drops_orphans() {
        let dir = |parent: u32, name: &str| Rec {
            parent,
            name: Some(name.into()),
            size: 0,
            mtime: 0,
            is_dir: true,
            live: true,
        };
        let file = |parent: u32, name: &str, size: u64| Rec {
            parent,
            name: Some(name.into()),
            size,
            mtime: 0,
            is_dir: false,
            live: true,
        };

        let mut recs = vec![Rec::default(); 12];
        recs[5] = dir(5, "."); // the root points at itself
        recs[6] = dir(5, "Games");
        recs[7] = file(6, "big.pak", 1_000_000);
        recs[8] = dir(6, "Saves");
        recs[9] = file(8, "slot1.ps2", 8_192);
        recs[10] = file(5, "readme.txt", 100);
        recs[11] = file(99, "lost.tmp", 500); // parent does not exist

        let tree = assemble('D', recs).expect("assembles");
        let root = tree.result_for("D:\\").unwrap();
        assert_eq!(root.total_bytes, 1_008_292);
        assert_eq!(root.file_count, 3, "the orphan is not counted");
        assert_eq!(root.dir_count, 2);
        assert_eq!(root.errors, 1, "the orphan is reported as an error");

        let names: Vec<&str> = root.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Games", "readme.txt"]);
        assert_eq!(root.entries[0].size_bytes, 1_008_192);
        assert_eq!(root.entries[0].item_count, 3);

        let saves = tree.result_for("D:\\Games\\Saves").unwrap();
        assert_eq!(saves.total_bytes, 8_192);
        assert_eq!(saves.entries[0].path, "D:\\Games\\Saves\\slot1.ps2");
    }
}
