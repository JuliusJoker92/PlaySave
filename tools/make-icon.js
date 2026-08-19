/* Generates the application icons. Tauri needs real image files, and hand-rolling
   a PNG with zlib is cheaper than pulling in an image toolchain.
   Run: node tools/make-icon.js */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
mkdirSync(OUT, { recursive: true });

const TBL = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = TBL[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(rgba, w, h){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++){
    raw[y * (w * 4 + 1)] = 0;                              // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))
  ]);
}

/* A memory card: dark navy shell, a lighter contact band, a gold label patch. */
function render(S){
  const px = Buffer.alloc(S * S * 4);
  const put = (x,y,r,g,b,a) => {
    if(x<0||y<0||x>=S||y>=S) return;
    const i = (y*S+x)*4; px[i]=r; px[i+1]=g; px[i+2]=b; px[i+3]=a;
  };
  const rad = S*0.13, m = S*0.13;
  const x0=m, x1=S-m, y0=m*0.75, y1=S-m*0.75;
  for(let y=0;y<S;y++) for(let x=0;x<S;x++){
    const cx = Math.min(Math.max(x, x0+rad), x1-rad);
    const cy = Math.min(Math.max(y, y0+rad), y1-rad);
    const inside = (x>=x0&&x<=x1&&y>=y0&&y<=y1) &&
      (Math.hypot(x-cx, y-cy) <= rad + 0.5 ||
       (x>x0+rad&&x<x1-rad) || (y>y0+rad&&y<y1-rad));
    if(!inside) continue;
    const t = (y-y0)/(y1-y0);
    let r = Math.round(18 + 34*t), g = Math.round(34 + 58*t), b = Math.round(62 + 96*t);
    // contact band across the upper third
    if(y > y0+(y1-y0)*0.18 && y < y0+(y1-y0)*0.36 && x > x0+S*0.10 && x < x1-S*0.10){
      const stripe = Math.floor((x-x0)/(S*0.055)) % 2 === 0;
      r = stripe?150:96; g = stripe?168:112; b = stripe?190:134;
    }
    // gold label patch below it
    if(y > y0+(y1-y0)*0.48 && y < y1-(y1-y0)*0.12 && x > x0+S*0.12 && x < x1-S*0.12){
      r = 214; g = 178; b = 62;
    }
    put(x,y,r,g,b,255);
  }
  return png(px, S, S);
}

const sizes = { "32x32.png":32, "128x128.png":128, "128x128@2x.png":256, "icon.png":256 };
for(const [name,S] of Object.entries(sizes)) writeFileSync(join(OUT,name), render(S));

/* ICO wrapping a 256px PNG — Vista and later read PNG-in-ICO directly. */
const big = render(256);
const dir = Buffer.alloc(6 + 16);
dir.writeUInt16LE(0,0); dir.writeUInt16LE(1,2); dir.writeUInt16LE(1,4);
dir[6]=0; dir[7]=0; dir[8]=0; dir[9]=0;                    // 0 width/height == 256
dir.writeUInt16LE(1,10); dir.writeUInt16LE(32,12);
dir.writeUInt32LE(big.length,14); dir.writeUInt32LE(22,18);
writeFileSync(join(OUT,"icon.ico"), Buffer.concat([dir,big]));

console.log("wrote", Object.keys(sizes).join(", "), "and icon.ico to", OUT);
