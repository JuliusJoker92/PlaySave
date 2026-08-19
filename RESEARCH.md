# PlaySave — Research & Build Plan

A disk-usage analyzer that presents your drives as PlayStation 2 memory cards and your
folders as animated 3D save icons.

---

## Part 1 — What it actually looked like

> **Corrected against screenshots.** Written sources describe the PS2's system UI as dark
> blue. That's the *boot screen*. The Browser — the part with your saves in it — is
> **light silver-grey**. Everything in this section is now checked against reference frames
> of the real thing rather than prose descriptions.

### 1.1 The screen flow

The PS2's system UI lives in a ROM program called **OSDSYS**. Five distinct screens matter
to us, and people tend to blur them together in memory:

| Screen | What's on it |
|---|---|
| **Boot screen** | A **dark blue mist**, not black, with *towers of light* rising out of it and **pink, green, red and blue dots circling the scene** — not the blue-white motes I first assumed. "Sony Computer Entertainment" holds for a few seconds, then the camera pushes into the mist; it keeps creeping while the disc is read, so a slow disc means a deeper zoom, then snaps back out. All of it is real-time CGI drawn by the Graphics Synthesizer from BIOS assets, not a video. |
| **Main menu** | See 1.1b — a ring of pale-blue orbs on pure black, with `Browser` and `System Configuration` set to its right. |
| **Device select** | One 3D memory-card model per slot, side by side, on a **silver-grey ground with faint concentric ripples**. The card in the active slot catches a hard specular highlight; the other stays matte black. Card name top-right in gold. `✕ Enter · ◯ Back`. |
| **Card contents** | A grid of save icons on a smooth grey gradient, **all animating at once**. Card name and free space top-left in white, selected save's name top-right in gold, a cyan `▼` when the grid scrolls. `✕ Enter · ◯ Back · △ Options`. |
| **Details** (`✕`) | Location / File Type / File Size / Last Updated / File Protection — right-aligned labels against left-aligned values, on that save's own background colors. `◯ Back`. |
| **Options** (`△`) | Every other icon **defocuses**, the background takes the save's colors, and `Copy` / `Delete` stack at the right with the highlight in cyan. Header gains the save's timestamp and KB size. |

### 1.1b The main menu

Read directly off a reference frame, so this is observation rather than inference.

**Ground.** Pure black — not the browser's silver, not the boot screen's blue mist. The
darkest screen the console has.

**The orb ring.** Roughly seven or eight small, intensely bright pale-blue orbs arranged
around a **tilted ellipse**, left of centre. The ellipse is taller than it is wide (about
2:3 width-to-height in the frame) and rotated maybe 12–15° off vertical, which reads as a
circle in 3D seen at a steep angle. Each orb is a hard white core inside a soft blue halo,
with a wider, much fainter bloom beyond it. Orbs on the far side of the ring sit visibly
dimmer than those on the near side, so it reads as depth rather than a flat ring of dots.
Behind them is a faint dark-blue nebula — a smudge, not a shape, just enough to stop the
black being empty.

**The items.** Two lines of text to the right of the ring, stacked, in a light sans with
generous spacing. `Browser` sits above `System Configuration`, and the second line begins
further left than the first, so they are neither left- nor right-aligned — they hang off an
implied diagonal. The **selected item is white with a strong glow**; the unselected one is a
muted steel blue. That glow is doing all the work of a highlight.

**Prompts.** `✕ Enter` bottom-left of centre, `△ Version` bottom-right, in the same
DualShock glyph colours as the browser.

Recreating it needs no geometry: the ring is a handful of gaussians in the background
fragment shader, positioned on a parametric ellipse, phase-advanced over time, with a
depth term of `0.62 + 0.38·sin(angle)` dimming the far side. The nebula is one more
falloff term around the same ellipse.

**Mapped onto this app:** `Browser` opens the disk explorer, `System Configuration` opens
the application's own settings. The parallel is exact and needs no invention.

### 1.2 The boot screen towers

Every time a title is launched with a memory card inserted, the console logs it to the card.
Each title becomes a block; the more it's played, the taller its tower grows, up to a cap.
The number of towers is how many different games that card has seen.

The important half of this, and the reason it works as a design: **with no card, or a card
with nothing on it, there are no towers at all — just the empty void.** The screen is a
direct readout of the data. That is exactly what a scan-progress screen should be, and it
means the empty state is already designed for you.

Sony never documented it. It stayed a rumor until it went viral in 2022.

### 1.3 The card contents screen — the crown jewel

Each save on the card is a directory containing an `icon.sys` metadata file plus up to three
3D model files.

**Where the per-save colors actually appear.** Every save ships four corner colors, and the
browser bilinearly interpolates between them — but this backdrop only kicks in **once you
drill into a save** (Options or Details). The grid itself stays on the neutral grey ground.
Getting this backwards makes the grid a strobing mess; the real thing is calm until you
commit to something.

When a save is highlighted in the grid:

- the icon plays its idle animation on loop, as do all the others simultaneously
- a **hard specular bloom sits behind it** — an actual light in the scene. No cursor, no
  border, no fill. That bloom is the entire selection affordance, and it's better than any
  highlight box you'd design today.
- its name appears **top-right in a saturated gold**, at the largest type size on screen
- the header carries the card name and `2,138 KB Free` — comma-grouped, in kilobytes

Then the part almost nobody realizes: **there are three separate icon files per save.**

| File | When it plays |
|---|---|
| `normal` (list) | Idle, while browsing |
| `copy` | While the save is being copied to the other card |
| `delete` | While the save is being deleted |

Most developers shipped the same model three times. The ones who cared made the delete
animation the character exploding, dissolving, or waving goodbye. **That is the mechanic to
steal.** A disk cleanup tool where the folder icon visibly reacts to being deleted is the
entire pitch of this app.

**The rule, from real examples.** Collected from community threads, the pattern is
remarkably consistent: *the delete pose is the idle pose's emotional inverse.*

| Game | Idle | Delete |
|---|---|---|
| Tekken Tag Tournament | Xiaoyu jumping | Xiaoyu **crying instead of jumping** |
| Soul Calibur 2 | Cassandra jumping | Cassandra crying instead |
| Onimusha | Samanosuke standing | Sits down, gauntlet on the ground, "like a rejected puppy" |
| Ridge Racer V | Car / chibi Ai Fukami | Flips upside down and crashes; the chibi version cries |
| Devil May Cry 3 | — | Lady cries |
| Shinobi, Nightshade | — | The icon appears defeated |
| Gundam Climax U.C. | Girl running | She stops, and her expression changes |
| Eureka Seven vol. 2 | Stick figure, green | Turns red |
| Half-Life | Gordon Freeman standing | Goes to **running** (this one's the copy pose) |

Two things fall out of that table. First, **the delete animation plays when you're *about
to* delete** — while the option is highlighted — not only once deletion is underway. The
pleading is the point; showing it during an operation the user already committed to would
waste it. Second, copy animations are rarer and read as *energetic* rather than sad:
duplication, motion, speeding up.

For generated icons, that translates into two poses derived from the base mesh:

- **cower** — squash vertically to ~0.44, sink ~0.2 units, and lean away proportionally to
  height. Add a fast, small positional and rotational shake. A slump plus a tremble reads as
  "please don't" on *any* object, even a hard drive.
- **dup** — split the triangle list into halves by centroid sign and draw them apart, with a
  slight lift. Unmistakably duplication rather than destruction.

Compute the burst **from the cowered positions**, not the base, and bind the cower buffer as
the morph source during the collapse. Otherwise the model snaps back through its neutral
pose on the way to exploding, which throws the whole beat away.

**One reaction per icon, not one for the whole app — and vary the *kind* of reaction.**
A first pass gave every device its own vertex morph, and it still felt samey. The reason is
visible in the source table above: those reactions are not all the same category of thing.
Xiaoyu *cries*, Samanosuke *sits down*, Ridge Racer's icon *flips over*, Gundam's runner
*stops dead*, Eureka Seven's *changes colour*. Only some of those are shape changes at all.

So a reaction is **three independent layers**:

| Layer | What it is | Vocabulary |
|---|---|---|
| **Pose** | a vertex morph — what shape it takes | slump, flatten, curl, bend, keel, shrink, hunch |
| **Behaviour** | a per-frame transform — how it moves | tremble, sob, droop, flip, freeze, recoil |
| **Tint** | a colour shift — how it changes | redshift, drain, dim |

Stacking three small vocabularies beats one long list of morphs: six devices get six
personalities, and adding a seventh costs a row in a table rather than a new animation.
`sob` is the clearest win — a rhythmic vertical hitch with a matching scale pulse reads as
crying on *any* object, including a hard drive. `freeze` is the cheapest: stop the idle spin
dead, and the contrast against everything else still turning does the work.

Worth knowing: `freeze` only lands if the idle is fast to begin with. It's assigned to the
USB stick, which idles at a middling rate — on the disc, which spins fastest, it would read
even harder.

| Icon | Idle | Delete pose | Comes apart as | Copy |
|---|---|---|---|---|
| Hard disk | slow turn | **slump** — squashes, sinks, leans away | radial burst | halves split |
| SSD | slow turn | slump | radial burst | halves split |
| M.2 stick | quick, twitchy | **bend** — the board bows in the middle | **snaps in two**, halves fall | halves split |
| Floppy | drifting | **curl** — edges warp up, middle sags | radial burst | halves split |
| Optical disc | **spins fast** | **wobble** — tips onto one edge like a dropped disc | **shatters in-plane**, wedges fly outward | lifts and spreads |
| USB stick | medium | **shrink** — retracts into itself | radial burst | lifts and spreads |

Five slump styles, three break styles, two copy styles, plus per-icon spin and breathing
rates. Six devices, no two reactions alike — and a new device only needs a row in the table,
not a new animation.

### 2.4 It's a PC app, so the mouse is the cursor

The console had a d-pad, so selection moved in discrete steps. On a desktop, **hover selects
and click commits**: sweeping the pointer across the grid moves the bloom and repaints the
readout, clicking opens Copy/Delete, and — the important one — **hovering the Delete option
is what makes the icon start pleading.** Requiring a click to see the reaction wastes it.

The trap: hover fires constantly, so a handler that rebuilds the DOM tears the element out
from under the cursor and the hover state thrashes. Keep a `syncSelection()` that only flips
`aria-current`, toggles a class, and retargets text — never `innerHTML`. Anything driven off
state that the render loop already reads each frame (background palette, bloom position,
icon pose) needs no DOM work at all.

Keep the keyboard path working alongside it. Arrow keys, Enter and Escape mapping onto
✕/◯/△ costs nothing and is what makes it feel like the thing it's imitating.

[PS2IODB](https://github.com/Issung/PS2IODB) has copy and delete animations archived for
1,498 titles — roughly a third of the library — and is the place to go for more.

### 1.4 Why PS2 icons look the way they do

The format's constraints are the art style:

- ~**500 triangles** max (community-observed ceiling)
- **128×128** texture, 16-bit color
- **vertex colors** baked per-vertex
- **no skeleton** — animation is pure vertex morphing between whole-mesh snapshots ("shapes")
- lighting is three directional lights + ambient, all defined per-save

Chunky, glossy, low-poly, hand-lit. And critically: **cheap to author.** A 500-triangle model
with three morph poses is an afternoon in Blender, which makes shipping 30+ icons realistic
for a solo project.

---

## Part 2 — The formats (we can read real save files)

### 2.1 `icon.sys` — always exactly 964 bytes

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | Magic `"PS2D"` |
| 4 | 2 | Reserved |
| 6 | 2 | Second-line offset into the title (where line 1 breaks to line 2) |
| 8 | 4 | Reserved |
| 12 | 4 | Background transparency (`0x00` transparent → `0x80` opaque) |
| 16 | 16 | Background color, **upper-left** (4 × uint32 RGBA, `0x00`–`0x80`) |
| 32 | 16 | Background color, **upper-right** |
| 48 | 16 | Background color, **lower-left** |
| 64 | 16 | Background color, **lower-right** |
| 80 | 16 | Light 1 direction vector |
| 96 | 16 | Light 2 direction vector |
| 112 | 16 | Light 3 direction vector |
| 128 | 16 | Light 1 RGB |
| 144 | 16 | Light 2 RGB |
| 160 | 16 | Light 3 RGB |
| 176 | 16 | Ambient RGB |
| 192 | 68 | Title, null-terminated, **Shift-JIS** |
| 260 | 64 | Normal icon filename |
| 324 | 64 | Copy icon filename |
| 388 | 64 | Delete icon filename |
| 452 | 512 | Reserved (zeros) |

### 2.2 The `.ico` model format

**Header (20 bytes)**

| Offset | Type | Field |
|---|---|---|
| 0 | u32 | Magic `0x010000` |
| 4 | u32 | Animation shape count (number of morph targets) |
| 8 | u32 | Texture type / compression flags |
| 12 | u32 | Constant `0x3F800000` (float 1.0) |
| 16 | u32 | Vertex count (always divisible by 3 — raw triangle list) |

**Vertex segment** — per vertex, in order:

- `shapeCount` × **position** (8 bytes: int16 x, y, z ÷ 4096, + 2 pad)
- 1 × **normal** (8 bytes, same layout)
- 1 × **UV** (4 bytes: int16 u, v ÷ 4096)
- 1 × **RGBA** (4 bytes, uint8 each)

So position varies per morph shape; normal, UV, and color do not. Exactly the data layout of
a glTF morph target — see §3.3.

**Animation segment**

- Header (20 bytes): magic `0x01`, frame length (frames per cycle), speed (f32), play offset, frame count
- Per frame (16 bytes): shape ID, keyframe count, 2 unknown fields
- Per keyframe (8 bytes): timestamp (f32), value (f32)

**Texture** — 128×128, `A1B5G5R5` (1-bit alpha, 5 bits per channel, 2 bytes/pixel = 32 KB
uncompressed). Optionally RLE compressed: codes `< 0xFF00` repeat a single 16-bit value,
codes `≥ 0xFF00` introduce a run of literal values.

**Rendering** (per the open-source `ps2mc-browser` implementation): the vertex shader
`mix()`es between the current and next morph shape by a tween factor; the fragment shader
computes `(ambient + Σ max(dot(N, L_i), 0)) * texture` using the lights straight out of
`icon.sys`. That's the whole pipeline — trivially reproducible in GLSL.

### 2.3 Reference implementations worth reading

| Project | Language | Use to us |
|---|---|---|
| [`caol64/ps2mc-browser`](https://github.com/caol64/ps2mc-browser) | Python + ModernGL | The clearest renderer + parser. Author's [blog series](https://babyno.top/en/posts/2023/10/parsing-ps2-3d-icon/) documents the format in detail. |
| [`Issung/PS2IODB`](https://github.com/Issung/PS2IODB) | Python + React | Community database of extracted PS2 save icons, plus a CLI/GUI extractor and an in-browser 3D viewer. |
| [`ps2dev/mymc`](https://github.com/ps2dev/mymc), [`mymcplus`](https://sr.ht/~thestr4ng3r/mymcplus), [`PCSX2/myMCpp`](https://github.com/PCSX2/myMCpp) | Python / C++ | Memory-card *filesystem* parsing (`.ps2` images, `.psu`/`.max` saves). |
| [`BAD-AL/mymc_web`](https://github.com/BAD-AL/mymc_web) | Dart→WASM | A working PS2-styled web UI with a canvas 3D background. Good proof the aesthetic works in a browser. |
| [`ticky/ps2iconsys`](https://github.com/ticky/ps2iconsys) | C++ | `icon.sys` library + viewer. |

---

> **Status: this is now a real application.** Tauri v2 + Rust, launched with `npm run dev`.
> See [README.md](README.md) for what works and what doesn't. The sections below are the
> research the build rests on; where the shipped code diverges, the README is authoritative.
>
> One structural decision worth recording: the frontend talks to the backend through a
> single `platform.js` seam that falls back to sample data when it isn't running inside
> Tauri. That means the whole UI stays reviewable as a plain page — no build step, no
> waiting on the Rust compiler — while the identical call path reads real disks in the app.
> Worth doing from the start on anything with a native backend and a lot of visual iteration.

## Part 3 — Building it

### 3.1 The mapping: filesystem → memory card

| PS2 concept | Our app |
|---|---|
| Memory card in a slot | A drive / volume. **Two drives = two cards side by side**, same as slots 1 and 2. |
| Card capacity gauge (8 MB, KB free) | Drive used / free, styled as the PS2 readout |
| A save (a directory on the card) | A directory on disk |
| Save description string (2 lines) | Folder name + path hint |
| Save size in KB | Real size, formatted PS2-style |
| Icon model | Icon chosen by folder content type (code, media, games, installers, caches…) |
| Four corner background colors | Derived per-folder from dominant content type. **Only shown on the details/options screens**, exactly as the original does it. |
| Specular bloom on the selected icon | Kept verbatim. It is a better selection cue than any highlight box, and it costs one radial term in the background shader. |
| Selected name in gold, top-right | Kept verbatim, including being the largest type on screen. |
| Details screen (`✕`) | File properties, same label/value layout: Location → full path, File Type → what's inside, File Size → size on disk, Last Updated → mtime, File Protection → read-only / ACL flags. |
| **Copy** (`△`) | Real file copy to another drive (i.e. to the other "card") |
| **Delete** (`△`) | Real delete → Recycle Bin, with the delete animation playing, after a confirm — the console asked too |
| Boot-screen towers | **The scan progress screen.** One tower per top-level folder, height by size, rising as bytes are counted. A progress bar and the payoff shot at once — and because the original shows *nothing* for an empty card, the empty-drive state is already designed. |

Two deliberate departures from the original:

1. **Sort by size, descending, by default.** The PS2 browser didn't sort — but "what's eating
   my disk" is the whole point, so the biggest folder gets the first tile. Consider scaling
   tile size by share of the drive so the grid reads like a treemap at a glance.
2. **Units.** PS1 used "blocks", PS2 used KB. Use real units (KB/MB/GB) but render them in the
   PS2 type treatment. A "blocks" easter-egg toggle is a fun 10-minute feature.

### 3.2 Architecture — two halves

**Scanner core (Rust).** Native, no GC pauses, cross-platform, and it's where all the real
engineering is.

*Windows:*
- Fast path: read the **NTFS Master File Table** directly ([`ntfs-reader`](https://crates.io/crates/ntfs-reader) crate, or
  `FSCTL_ENUM_USN_DATA`). This is how WizTree scans a 1 TB volume in seconds instead of
  minutes — the MFT already contains every name, size, and parent reference, so you rebuild
  the tree in memory instead of walking directories. **Requires Administrator.**
- Fallback (non-admin, FAT/exFAT, network shares): `FindFirstFileEx` /
  `NtQueryDirectoryFile` walk on a worker pool. Ship both; degrade gracefully rather than
  forcing a UAC prompt on launch.

*macOS (phase 2):* `getattrlistbulk(2)` — a batched readdir+stat that returns names and
attributes together. Note APFS takes a global kernel lock on directory reads, so a naive
thread-per-directory pool gets *slower*; tune the worker count.

*Correctness traps that make disk analyzers wrong:*
- **Logical size vs size on disk** — round to cluster size, or use `GetCompressedFileSize`
- **Hardlinks** — dedupe by file ID or you'll count the same bytes many times
- **Sparse files** — a 1 GB sparse file can occupy 64 KB
- **Reparse points / junctions / symlinks** — don't follow, don't double-count
- **Alternate data streams** — may share the file's clusters
- **Cloud placeholders** (OneDrive/iCloud) — check for `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`;
  reading them can trigger multi-gigabyte downloads
- **Long paths** — use the `\\?\` prefix or enable long-path support
- Validate totals against WizTree/TreeSize before trusting the UI

**UI (WebGL).** Morph-target animation, per-tile gradient backdrops, and bloom are all
one-liners in a web stack, and it ports to macOS for free.

*Recommendation: **Tauri v2 + three.js.*** The Rust scanner becomes a `#[tauri::command]` in
the same binary — no IPC-to-a-sidecar plumbing — and the app ships at a few MB instead of
~150 MB. WebGL2 is fine on WebView2 (Chromium) on Windows and WKWebView (Metal-backed) on
macOS; this app is a few hundred triangles per icon, nowhere near a stress test.

*Alternatives, honestly:* **Electron** if you'd rather have a guaranteed-identical Chromium
on both platforms and don't care about size — the usual pick for visual-fidelity-critical
apps. **Godot 4** if you'd rather live in an engine: blend shapes, shaders, and Win/Mac
export come for free, but you'd still write the scanner as a Rust/C++ GDExtension, so you
get the hard part either way plus a less comfortable UI toolkit for lists and dialogs.

### 3.3 Making it *look* right

**Background.** One full-screen fragment shader covering every state, driven by uniforms:

1. **Four-corner bilinear gradient.** Silver-grey by default; swapped to the selected
   folder's colors only on the details/options screens.
2. **Concentric ripples.** Two sine rings at different frequencies with a radial falloff —
   strong on device select, nearly off elsewhere. This is the moiré texture visible on the
   real device-select screen and it's what stops the silver reading as flat CSS.
3. **A radial specular bloom** at the selected icon's projected position. Two gaussians
   (tight core, wide halo) is enough.
4. **Drifting motes** for the boot void, gated off everywhere else.
5. A whisper of interlace — 3% darkening on alternate scanlines.

There's a well-known [Shadertoy PS2 shader](https://godotshaders.com/shader/ps2-menu/)
(orbiting soft circles with motion-blur trails, gamma-shaped per channel) — **but Shadertoy
defaults to CC BY-NC-SA**, so read it for technique and write our own if this is ever
distributed commercially. Note it recreates the *boot* screen, not the browser.

**Depth of field.** The Options screen pulls focus: selected icon sharp, everything else
blurred. A real DOF pass is overkill at this scale — drawing each unselected icon five times
at small jittered offsets with `alpha/5` reads correctly and costs nothing.

**Icons.** Author in Blender → export glTF with **shape keys** (glTF morph targets map 1:1
onto the PS2 shape system). Three named clips per icon: `idle`, `copy`, `delete`. Budget
≤500 tris, 128×128 texture, vertex colors — matching the original constraints is what makes
them feel authentic rather than "low-poly indie".

**The icon vocabulary: storage hardware.** Abstract shapes read as placeholder. Real devices
read as *the subject*, and they give the grid the same "no shared silhouette" jumble the PS2
had — where a rock sat next to a skateboard next to two golf balls.

| Icon | Folder kind | Tris in the prototype |
|---|---|---|
| 3.5" hard disk (chassis, brushed lid, spindle, SATA lip) | System, big game libraries, recordings | 120 |
| 2.5" SSD (shell, four screw dimples, label) | Application data, program files | 144 |
| M.2 NVMe (bare PCB, NAND packages, gold fingers) | Code, dev trees, project files | 72 |
| 3.5" floppy (shell, shutter, hub, write-protect tab) | Documents, backups | 80 |
| Optical disc (data ring + hub, real centre hole) | Media, installed games, ISOs | 224 |
| USB flash drive (body, seam, metal connector, tongue) | Downloads, removable | 60 |

**Colour without losing the metal.** Store vertex colour as absolute RGB *plus a mode* in
the fourth channel: `0` = use the vertex colour, `1` = use the folder's accent colour, `2` =
sample the icon texture. Every device then carries a coloured label, sticker, or disc
surface while its chassis stays honest brushed steel and green PCB. One float per vertex,
and in the shader it's a `mix()` plus one branch.

### 3.3a The real win: use the application's own icon

**A PS2 icon was already a 128×128 texture on a low-poly model.** So the app doesn't need to
invent artwork per folder — it can put the *real* application icon on the device's label
face, and every folder becomes genuinely unique for free.

Extraction on Windows:

| Step | API |
|---|---|
| Get the shell icon index for a path | `SHGetFileInfo(path, -1, &sfi, sizeof sfi, SHGFI_SYSICONINDEX)` |
| Get the 256×256 image list | `SHGetImageList(SHIL_JUMBO, IID_IImageList, ...)` — `SHIL_EXTRALARGE` for 48×48 |
| Pull the bitmap | `IImageList::GetIcon(index, ILD_TRANSPARENT, &hIcon)` |
| Alternatives | `PrivateExtractIcons` (direct from `.exe`/`.dll`/`.ico`), `IExtractIcon`, `SHDefExtractIcon` |

From Rust, all of these are in the `windows` crate. Downsample to 128×128, upload,
**point-sample the magnification filter** — a crisp modern icon rendered with `NEAREST` on a
low-poly slab is exactly the right era collision.

Gotchas worth knowing before you build it:

- `SHIL_JUMBO` returns a 256×256 *slot*, but an app that only ships a 48×48 icon comes back
  as a small image centred in a big transparent square. Detect the used bounds and fall back
  to `SHIL_EXTRALARGE` rather than rendering a tiny icon in a sea of nothing.
- Folders don't have their own icon unless `desktop.ini` sets one. Pick a representative
  file inside instead — the largest `.exe`, or the folder's most common file type.
- Extraction touches the shell and must not run on the scan's hot path. Resolve icons lazily
  for what's on screen, and cache by `(path, mtime)`.
- On macOS the equivalent is `NSWorkspace.iconForFile(_:)`, which also returns up to 512×512.

The demo at the top of this document draws its icon textures procedurally, because shipping
other people's application artwork in a public page isn't ours to do — but the pipeline it
exercises (canvas → 128×128 texture → textured plate on the mesh) is exactly the one the
real extractor feeds.

**Focus pull — do it properly, the cheap trick doesn't work.** The Options screen blurs
everything but the selection. Drawing each unselected icon several times at jittered offsets
with fractional alpha *looks like glass, not blur*, and no amount of tuning fixes it: with
depth writes on, the copies occlude each other; with them off, you see straight through each
object to its own back faces. Either way the metal turns transparent.

The real thing is barely more work and is correct:

1. Render the unselected icons **opaque**, depth-tested, into an offscreen target at half
   resolution, cleared to `(0,0,0,0)`.
2. Blur it separably — two passes, five linear-sampled Gaussian taps each.
3. Composite over the background with **premultiplied** blending (`ONE, ONE_MINUS_SRC_ALPHA`).
   Straight-alpha blending here pulls transparent black into the edges and rims every icon
   with a dark halo.
4. Clear depth, then draw the selected icon sharp on top.

Everything stays opaque at every stage, which is the whole point.

**Backface culling is not needed.** Tempting, but if the winding convention is backwards the
icons vanish entirely. With opaque depth-tested draws the depth buffer already hides back
faces, so culling buys nothing but risk.

**Depth precision, or: why the icons flickered.** Composite meshes stack a label plate a
hair above the shell beneath it. Two things conspire to make that flicker:

1. `near = 0.1, far = 30` throws away nearly the whole depth buffer on empty space. The
   icons sit at ~3.9 units, so tighten to `near = 2.0, far = 9.0` — the resolution gain is
   roughly `(far−near)/(near·far)`, here about **26×**.
2. Offscreen targets default to nothing; if you attach `DEPTH_COMPONENT16` you get a
   *quarter* of the precision the default framebuffer gives you. Use `DEPTH_COMPONENT24`.

Worked example from this prototype, at the icon distance:

| | Plate gap (world) | One depth step, 16-bit | Result |
|---|---|---|---|
| Before | 8.2 × 10⁻⁴ | 2.3 × 10⁻³ | **2.8× smaller than a step — guaranteed z-fighting** |
| After | 6.6 × 10⁻³ | 9.0 × 10⁻⁵ | 73× margin |

Note the failure was invisible on the main screens and only showed on the options screen —
because that one renders through the offscreen target with its 16-bit depth attachment. If
a flicker appears on exactly one screen, look at what's different about *that* screen's
framebuffer before you touch the geometry. Then fix both ends: lift the coplanar surfaces
into a real gap **and** stop wasting the depth range.

**The modelling rule that prevents it.** Composite meshes must have parts that are either
clearly apart or *deeply overlapped* — never abutting, never sharing a face plane. Two boxes
that meet exactly at `x = 0.22` produce coincident faces with opposing normals, and which
one wins is a per-pixel coin flip. Overlap them instead and give the inner part different
cross-section dimensions so no pair of faces is coplanar on any axis.

Worth automating, because it's invisible in code review. The check: for every pair of
triangles, if their normals are parallel, their projections overlap in area, and their
normals point *opposite* ways, then their plane separation must clear the depth step by a
wide margin. The opposing-normal condition is what distinguishes "two parts abutting" from
"two triangles of the same quad", which is why a naive coplanarity check drowns in false
positives. Running it over this prototype's meshes found 8 coincident faces in the USB stick
and 4 more in the M.2 that no one had noticed yet.

**The era look** — small things, big payoff:
- point-sample textures (no bilinear filtering)
- render at a low internal resolution (~640×448) and upscale
- subtle vertex snapping (PS2 used fixed-point math, so geometry shimmered slightly)
- gentle bloom + optional CRT/scanline pass, toggleable
- *don't* add affine texture warping — that's PS1, not PS2

**Font.** The BIOS font is a bitmap font in ROM (`rom0:FONTM` / `rom0:KROM`) and is
proprietary. Don't ship it. Use a lookalike and set it in wide tracking.

**Sound.** The startup sound was created by Takafumi Fujisawa to evoke "a monolith floating
in space", built on a Korg Trinity with a Nord Lead for the bass, and performed by the
console from BIOS samples. Its documented structure is four layers under a long reverb:

| Layer | What it is | Rebuild as |
|---|---|---|
| Deep hit | Sub-bass impact with a long tail | Sine ~62 Hz gliding to ~32 Hz, 2.6 s decay, heavy reverb send |
| Swoosh | Soft white-noise sweep | Noise buffer through a bandpass sweeping 500 → 4200 Hz over ~1.7 s |
| Pad | Rich sustained bed | Four detuned sawtooths on a minor stack, 1.3 s attack, 3.4 s tail |
| Chime | The twinkle | Staggered sines at 1046 / 1568 / 2093 / 3136 Hz, fast attack, ~2.4 s decay, full reverb |

Reverb is a `ConvolverNode` fed a generated impulse: 2.8 s of noise under a `(1-t)^2.7`
envelope. No impulse file needed.

**On using the real recording.** The rip is easy to find, and for a build that lives on your
own machine nobody is coming for you. But it is Sony's audio, so it cannot ship in anything
you publish, put in a store, or post a build of. The synthesised version above is yours
outright, sounds close enough to trip the memory, and is *tunable* — which the sample isn't.
The prototype ships the synth; if you want the real one locally, wire it as a drop-in file
the app loads if present and never commit it.

The same logic covers the BIOS font (`rom0:FONTM`, a proprietary ROM bitmap font) — use a
lookalike and set it in wide tracking.

Audio must not autoplay: browsers suspend the `AudioContext` until a user gesture, and a
page that makes noise unprompted is hostile anyway. Gate it behind an explicit toggle.

### 3.4 Killer feature: import real PS2 icons

Let users drop in an actual `.ps2` memory-card image, `.psu`, or `.max` save and use those
icons for their folders. The parsers are documented above; PS2IODB is a ready-made asset
library for anyone without a card. Your `node_modules` folder rendered as a Crash Bandicoot
save icon is the screenshot that sells this app.

*(Ship the parser, not the assets — extracted game icons are Sony/publisher IP. User-supplied
files are fine.)*

### 3.5 Roadmap

| Phase | Deliverable |
|---|---|
| **0. Spike** | Shader background + one morphing icon in a browser tab. Half a day. Proves the whole aesthetic. |
| **1. Scanner** | Rust CLI: scan a volume, emit a JSON tree. Validate totals against WizTree. |
| **2. Card view** | One drive = one card. Top-level folders as tiles, sorted by size. |
| **3. Navigation** | Drill down, breadcrumbs, per-folder gradient backdrops, size readouts. |
| **4. Actions** | Copy and Delete, with the three-state icon animations and confirmation dialogs. |
| **5. Multi-card** | All drives as cards, slot-style layout, copy between cards. |
| **6. Boot screen** | The tower scan-progress screen. |
| **7. Polish** | Sound, CRT toggle, real PS2 icon import. |
| **8. macOS** | `getattrlistbulk` scanner backend. |

### 3.6 Risks

- **UAC.** MFT reading needs elevation. Don't demand it at launch — run the slow path and
  offer "scan faster" as an explicit upgrade.
- **This app deletes files.** Default to the Recycle Bin (`IFileOperation`), require an
  explicit confirm, hard-block system paths, and never let the delete animation start before
  the operation is actually authorized. A charming UI must not become a footgun.
- **Scale mismatch.** An 8 MB card holds ~30 saves; a 2 TB drive holds millions of files.
  Virtualize the grid and cap what's rendered.
- **Cross-platform WebGL.** If you go Tauri, test on WKWebView early rather than at the end.

---

## Sources

- [icon.sys format — PS2 Save Tools](https://www.ps2savetools.com/documents/iconsys-format/)
- [Analysis of the PS2 Game Save 3D Icons — babyno.top](https://babyno.top/en/posts/2023/10/parsing-ps2-3d-icon/)
- ["ps2mc-browser" Shader Code Analysis](https://babyno.top/en/posts/2023/12/ps2mc-browsers-shader-introduction/)
- [PS2 Texture Encoding "A1B5G5R5"](https://babyno.top/en/posts/2023/10/ps2-texture-encoding-algorithm-a1b5g5r5/)
- [PS2 Icon Format v0.5 (Martin Åkesson, 2003)](https://www.ps2savetools.com/ps2icon-0.5.pdf)
- [How to Create PS2 Icons for the Memory Card Browser — PS2-HOME](https://www.ps2-home.com/forum/viewtopic.php?t=7073)
- [Memory Card Icons Were Rad — Kotaku](https://kotaku.com/memory-card-icons-were-rad-1835331018)
- [PS2 startup screen easter egg — GamesRadar](https://www.gamesradar.com/ps2s-startup-screen-easter-egg-is-surprising-players-all-over-again/)
- [What are these white blocks and towers on PS2 start up — PS2-HOME](https://www.ps2-home.com/forum/viewtopic.php?t=1668)
- [PS2 Menu shader — Godot Shaders](https://godotshaders.com/shader/ps2-menu/) (CC BY-NC-SA)
- [WizTree — MFT-based scanning](https://diskanalyzer.com/)
- [`ntfs-reader` crate](https://crates.io/crates/ntfs-reader) · [`mft` crate](https://crates.io/crates/mft)
- [Speeding up NTFS enumeration with FSCTL_ENUM_USN_DATA](http://julene-lharudhar.blogspot.com/2015/02/c-speed-up-ntfs-file-enumeration-using.html)
- [Notes on NTFS — TreeSize](https://manuals.jam-software.com/treesize/EN/notesonntfs.html)
- [Performance considerations when reading directories on macOS](http://blog.tempel.org/2019/04/dir-read-performance.html)
- [PS2 BIOS ROM contents (FONTM/KROM)](https://gist.github.com/uyjulian/25291080f083987d3f3c134f593483c5)
- [PS2 BIOS sounds — Internet Archive](https://archive.org/details/scph-10000-00010)
