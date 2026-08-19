/* Geometry and animation checks. Run: npm run check
   These catch the two classes of bug that are invisible in review:
   coplanar faces that z-fight, and animation archetypes that produce garbage. */
import { MESHDEF, POSE, BURST, DUP, BEHAVIOUR, TINT, PULSE, shapes } from "../src/gl/meshes.js";
import { towerAt, blockAt } from "../src/gl/renderer.js";

let failures = 0;
const fail = m => { console.log("  FAIL " + m); failures++; };
const fin = a => Array.prototype.every.call(a, Number.isFinite);

/* A z-fight needs two surfaces that are nearly coplanar, overlap in area, AND
   face opposite ways. That last condition is what separates "two parts abutting"
   from "two triangles of the same quad". */
const Z = 3.9, NEAR = 2.0, FAR = 9.0, BITS = 24;
const step = Z*Z*(FAR-NEAR)/(NEAR*FAR*(2**BITS - 1));
const safeModel = step/0.42*100;                    // 100x margin at typical fit*scale

function coplanarAudit(name, b){
  const P=b.pos, N=b.nrm, T=[];
  for(let t=0;t<P.length;t+=9){
    const raw=[N[t],N[t+1],N[t+2]];
    let flip=1;
    for(const c of raw){ if(Math.abs(c)>1e-6){ flip = c<0 ? -1 : 1; break; } }
    const n=raw.map(v=>v*flip);
    const d=n[0]*P[t]+n[1]*P[t+1]+n[2]*P[t+2];
    const ax=Math.abs(n[0])>0.9?[1,2]:Math.abs(n[1])>0.9?[0,2]:[0,1];
    let lo=[1e9,1e9], hi=[-1e9,-1e9];
    for(let k=0;k<3;k++) for(let j=0;j<2;j++){
      const v=P[t+k*3+ax[j]]; lo[j]=Math.min(lo[j],v); hi[j]=Math.max(hi[j],v); }
    T.push({raw,n,d,ax,lo,hi});
  }
  let coincident=0, unsafe=0, minSep=Infinity;
  for(let i=0;i<T.length;i++) for(let j=i+1;j<T.length;j++){
    const a=T[i], c=T[j];
    if(Math.abs(a.n[0]*c.n[0]+a.n[1]*c.n[1]+a.n[2]*c.n[2]) < 0.999) continue;
    if(a.ax[0]!==c.ax[0] || a.ax[1]!==c.ax[1]) continue;
    if(Math.min(a.hi[0],c.hi[0])-Math.max(a.lo[0],c.lo[0]) <= 1e-4) continue;
    if(Math.min(a.hi[1],c.hi[1])-Math.max(a.lo[1],c.lo[1]) <= 1e-4) continue;
    if((a.raw[0]*c.raw[0]+a.raw[1]*c.raw[1]+a.raw[2]*c.raw[2]) > -0.999) continue;
    const sep=Math.abs(a.d-c.d);
    if(sep < 1e-6){ coincident++; continue; }
    minSep=Math.min(minSep,sep);
    if(sep < safeModel) unsafe++;
  }
  return { coincident, unsafe, minSep };
}

console.log("meshes");
let totalTris = 0;
for(const [name, def] of Object.entries(MESHDEF)){
  const b = def.build(), s = shapes(b, def);
  const tris = b.pos.length/9, verts = b.pos.length/3;
  totalTris += tris;
  const a = coplanarAudit(name, b);
  const nl = [];
  for(let i=0;i<b.nrm.length;i+=3) nl.push(Math.hypot(b.nrm[i],b.nrm[i+1],b.nrm[i+2]));

  const ok = [];
  if(b.tint.length/4 !== verts) fail(`${name}: tint attribute length mismatch`);
  if(b.uv.length/2 !== verts)   fail(`${name}: uv attribute length mismatch`);
  if(!fin(b.pos)||!fin(b.nrm)||!fin(b.tint)||!fin(b.uv)) fail(`${name}: non-finite geometry`);
  if(!nl.every(v=>Math.abs(v-1)<1e-5)) fail(`${name}: normals not unit length`);
  if(!fin(s.inflate)||!fin(s.dup)||!fin(s.cower)||!fin(s.del)) fail(`${name}: non-finite morph target`);
  if(tris > 500 && name !== "disc") fail(`${name}: ${tris} tris exceeds the PS2 budget`);
  if(a.coincident) fail(`${name}: ${a.coincident} coincident opposing faces — will z-fight`);
  if(a.unsafe)     fail(`${name}: ${a.unsafe} face pairs below the depth margin`);
  const reach = Math.max(...Array.from(s.del).map(Math.abs));
  if(reach > 3.0) fail(`${name}: burst reaches ${reach.toFixed(2)}, may clip the far plane`);

  console.log(`  ${name.padEnd(7)} ${String(tris).padStart(3)} tris  ` +
    `pose=${def.pose.padEnd(7)} move=${def.move.padEnd(7)} tint=${def.tint.padEnd(8)} ` +
    `burst=${def.burst.padEnd(7)} minSep=${a.minSep===Infinity?"n/a":a.minSep.toFixed(4)}`);
}
console.log(`  ${totalTris} triangles across all meshes`);

/* Every archetype field a MESHDEF can name, and the table it must resolve in.
   A typo here does not throw — the renderer just stops moving that device and
   falls back to a default — so it has to be caught mechanically. */
const WIRING = {
  pose:POSE, burst:BURST, dup:DUP, tint:TINT, pulse:PULSE,
  move:BEHAVIOUR, idle:BEHAVIOUR, copyMove:BEHAVIOUR
};
console.log("archetype wiring");
for(const [name, def] of Object.entries(MESHDEF)){
  for(const [field, table] of Object.entries(WIRING)){
    const v = def[field];
    if(v === undefined) continue;                 // optional
    if(!table[v]) fail(`${name}: unknown ${field} "${v}"`);
  }
}
// a table entry nothing references is dead weight worth knowing about
for(const [tname, table] of Object.entries({POSE,BURST,DUP,TINT,PULSE,BEHAVIOUR})){
  const used = new Set();
  for(const def of Object.values(MESHDEF))
    for(const f of Object.keys(WIRING)) if(def[f]) used.add(def[f]);
  const orphans = Object.keys(table).filter(k => !used.has(k) && k !== "none");
  if(orphans.length) console.log(`  ${tname}: unused — ${orphans.join(", ")}`);
}
const used = k => Object.values(MESHDEF).filter(d => d[k]);
console.log(`  ${new Set(used("pose").map(d=>d.pose)).size} poses, ` +
  `${new Set(used("move").map(d=>d.move)).size} behaviours, ` +
  `${new Set(used("tint").map(d=>d.tint)).size} tints, ` +
  `${new Set(used("burst").map(d=>d.burst)).size} bursts in use`);

console.log("behaviours produce finite transforms");
for(const [name, f] of Object.entries(BEHAVIOUR)){
  for(const t of [0, 0.37, 1.5, 9.9, 120.4]) for(const k of [0, 0.5, 1, 1.9]){
    const r = f(t, k) || {};
    for(const [key, v] of Object.entries(r))
      if(!Number.isFinite(v)) fail(`BEHAVIOUR.${name}.${key} non-finite at t=${t} k=${k}`);
    if(r.scale !== undefined && r.scale <= 0) fail(`BEHAVIOUR.${name} scale <= 0 at t=${t} k=${k}`);
  }
}
console.log("tints stay in gamut");
for(const [name, f] of Object.entries(TINT)){
  for(const c of [[1,1,1],[0,0,0],[0.2,0.7,0.4]]) for(const k of [0,0.5,1]){
    const r = f(c, k);
    if(!r || r.length !== 3 || !r.every(Number.isFinite))
      fail(`TINT.${name} bad output at k=${k}`);
    else if(r.some(v => v < -0.001 || v > 1.001))
      fail(`TINT.${name} out of range at k=${k}: ${r.map(v=>v.toFixed(2))}`);
  }
}

/* The boot scene. Two solids that share space read as a bug even to someone
   who could not say why, and both of these did: the towers used the GLSL
   sin-hash, which clusters for small integers and put columns 0 and 2 inside
   each other at every drive count, and the blocks drove through whatever
   towers they passed on their way to the camera. Neither is visible in review.
   Both are one separation test away from obvious. */
console.log("boot scene keeps its solids apart");
{
  const R3 = Math.sqrt(3);
  // a column is 0.20 across in x and z: clear if separated on EITHER axis
  let worstT = Infinity, atT = null;
  for(let n = 1; n <= 12; n++){
    const t = Array.from({length:n}, (_,i) => towerAt(i,n));
    for(let a = 0; a < n; a++) for(let b = a+1; b < n; b++){
      const sep = Math.max(Math.abs(t[a].x-t[b].x), Math.abs(t[a].z-t[b].z)) - 0.20;
      if(sep < worstT){ worstT = sep; atT = `${n} drives, towers ${a} and ${b}`; }
    }
  }
  if(worstT <= 0) fail(`towers interpenetrate (${atT}, overlap ${(-worstT).toFixed(3)})`);
  else console.log(`  towers: worst gap ${worstT.toFixed(3)} (${atT})`);

  /* The tower box, generously: |x| <= 1.80, y in [-1.45, 2.15], and the depth
     band the columns occupy. A block is a cube, so its circumradius bounds it
     whatever its rotation. */
  let worstB = Infinity, hits = 0, worstBB = Infinity;
  for(let t = 0; t < 60; t += 0.05){
    const bs = [];
    for(let i = 0; i < 7; i++){ const b = blockAt(i,t); if(b.fade > 0.02) bs.push(b); }
    for(const b of bs){
      const r = b.s*R3;
      const nx = Math.max(-1.80, Math.min(1.80, b.x));
      const ny = Math.max(-1.45, Math.min(2.15, b.y));
      const nz = Math.max(-4.35, Math.min(-2.75, b.z));
      const d = Math.hypot(b.x-nx, b.y-ny, b.z-nz) - r;
      if(d < 0) hits++;
      if(d < worstB) worstB = d;
    }
    for(let a = 0; a < bs.length; a++) for(let c = a+1; c < bs.length; c++){
      const d = Math.hypot(bs[a].x-bs[c].x, bs[a].y-bs[c].y, bs[a].z-bs[c].z)
              - (bs[a].s + bs[c].s)*R3;
      if(d < worstBB) worstBB = d;
    }
  }
  if(hits) fail(`drifting blocks pass through the towers (${hits} samples)`);
  else console.log(`  blocks vs towers: worst gap ${worstB.toFixed(3)}`);
  if(worstBB <= 0) fail(`drifting blocks intersect each other`);
  else console.log(`  blocks vs blocks: worst gap ${worstBB.toFixed(3)}`);
}

console.log("");
if(failures){ console.log(`${failures} FAILURE(S)`); process.exit(1); }
console.log("all checks passed");
