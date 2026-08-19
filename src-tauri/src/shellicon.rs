//! Windows shell icon extraction.
//!
//! A PS2 save icon was already a 128x128 texture on a low-poly model, so the
//! app doesn't need to invent artwork per folder — it can put the real shell
//! icon on the device's label face.
//!
//! v0.1 uses `SHGetFileInfoW(SHGFI_ICON | SHGFI_LARGEICON)`, which gives 32-48px.
//! Upscaled with a NEAREST filter that is arguably the *right* look here.
//! TODO: SHGetImageList(SHIL_JUMBO) for 256px, with the known gotcha that jumbo
//! returns a 256px slot even when the app only ships a small icon — detect the
//! used alpha bounds and fall back to SHIL_EXTRALARGE rather than rendering a
//! postage stamp marooned in transparency.

#![cfg(windows)]

use base64::Engine;
use std::ffi::c_void;
use windows::core::PCWSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::UI::Shell::{
    SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetIconInfo, PrivateExtractIconsW, ICONINFO,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Returns a `data:image/png;base64,...` string, or None if anything at all
/// goes wrong — a missing icon must never break a scan.
pub fn icon_data_url(path: &str, want: u32) -> Option<String> {
    let (rgba, w, h) = unsafe { extract(path)? };
    let (rgba, w, h) = resize_nearest(&rgba, w, h, want.max(16).min(256));
    let png = encode_png(&rgba, w, h)?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

/// The shell's "large" icon is 32px, and blowing that up to a 128px plate is
/// where the chunky look came from. PrivateExtractIconsW pulls the icon out of
/// the file's own resources at whatever size you ask for, so an executable with
/// a 256px icon gives us a 256px icon. One call, no COM.
unsafe fn extract_native(path: &str, want: u32) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    // this overload wants a fixed-size path buffer, not a pointer
    let mut buf = [0u16; 260];
    let src: Vec<u16> = path.encode_utf16().take(259).collect();
    buf[..src.len()].copy_from_slice(&src);
    let mut icons = [windows::Win32::UI::WindowsAndMessaging::HICON::default(); 1];
    let mut id: u32 = 0;
    let px = want.max(48).min(256) as i32;
    let n = PrivateExtractIconsW(
        &buf,
        0,
        px,
        px,
        Some(&mut icons),
        Some(&mut id as *mut u32),
        0,
    );
    let icon = icons[0];
    if n == 0 || icon.is_invalid() {
        None
    } else {
        Some(icon)
    }
}

unsafe fn extract(path: &str) -> Option<(Vec<u8>, u32, u32)> {
    let wpath = wide(path);
    let low = path.to_ascii_lowercase();
    let native = if low.ends_with(".exe") || low.ends_with(".dll") || low.ends_with(".ico") {
        extract_native(path, 256)
    } else {
        None
    };
    if let Some(h) = native {
        if let Some(px) = pixels_from_icon(h) {
            let _ = DestroyIcon(h);
            return Some(px);
        }
        let _ = DestroyIcon(h);
    }

    let mut sfi = SHFILEINFOW::default();
    let ok = SHGetFileInfoW(
        PCWSTR(wpath.as_ptr()),
        FILE_ATTRIBUTE_NORMAL,
        Some(&mut sfi),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
    );
    if ok == 0 || sfi.hIcon.is_invalid() {
        return None;
    }

    let out = pixels_from_icon(sfi.hIcon);
    let _ = DestroyIcon(sfi.hIcon);
    return out;
}

unsafe fn pixels_from_icon(
    hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
) -> Option<(Vec<u8>, u32, u32)> {
    let mut ii = ICONINFO::default();
    if GetIconInfo(hicon, &mut ii).is_err() {
        return None;
    }

    let mut bm = BITMAP::default();
    GetObjectW(
        HGDIOBJ(ii.hbmColor.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut _ as *mut c_void),
    );
    let (w, h) = (bm.bmWidth.max(0) as u32, bm.bmHeight.max(0) as u32);
    if w == 0 || h == 0 {
        cleanup(&ii, 0);
        return None;
    }

    let mut bi = BITMAPINFO::default();
    bi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w as i32,
        biHeight: -(h as i32), // negative => top-down rows
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };

    let mut buf = vec![0u8; (w * h * 4) as usize];
    let hdc = GetDC(HWND::default());
    let lines = GetDIBits(
        hdc,
        ii.hbmColor,
        0,
        h,
        Some(buf.as_mut_ptr() as *mut c_void),
        &mut bi,
        DIB_RGB_COLORS,
    );
    ReleaseDC(HWND::default(), hdc);
    cleanup(&ii, 0);

    if lines == 0 {
        return None;
    }

    // BGRA -> RGBA. Icons without an alpha channel come back fully transparent;
    // if nothing is opaque, treat the whole thing as opaque instead of blank.
    let mut any_alpha = false;
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
        if px[3] != 0 {
            any_alpha = true;
        }
    }
    if !any_alpha {
        for px in buf.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }
    Some((buf, w, h))
}

unsafe fn cleanup(ii: &ICONINFO, _unused: isize) {
    if !ii.hbmColor.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
    }
    if !ii.hbmMask.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
    }
}

/// Bilinear. Point sampling was deliberate for the era look, but a 32px source
/// blown up to 128 just reads as broken rather than retro — the crunch should
/// come from the render, not from throwing away the icon's detail.
fn resize_nearest(src: &[u8], sw: u32, sh: u32, size: u32) -> (Vec<u8>, u32, u32) {
    if sw == size && sh == size {
        return (src.to_vec(), sw, sh);
    }
    let mut out = vec![0u8; (size * size * 4) as usize];
    let fx = sw as f32 / size as f32;
    let fy = sh as f32 / size as f32;
    for y in 0..size {
        let syf = ((y as f32 + 0.5) * fy - 0.5).max(0.0);
        let y0 = syf.floor() as u32;
        let y1 = (y0 + 1).min(sh - 1);
        let wy = syf - y0 as f32;
        for x in 0..size {
            let sxf = ((x as f32 + 0.5) * fx - 0.5).max(0.0);
            let x0 = sxf.floor() as u32;
            let x1 = (x0 + 1).min(sw - 1);
            let wx = sxf - x0 as f32;
            let d = ((y * size + x) * 4) as usize;
            for c in 0..4 {
                let p = |xx: u32, yy: u32| src[((yy * sw + xx) * 4) as usize + c] as f32;
                let top = p(x0, y0) * (1.0 - wx) + p(x1, y0) * wx;
                let bot = p(x0, y1) * (1.0 - wx) + p(x1, y1) * wx;
                out[d + c] = (top * (1.0 - wy) + bot * wy).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    (out, size, size)
}

fn encode_png(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}
