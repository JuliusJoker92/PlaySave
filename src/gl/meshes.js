/* Device meshes and the animation archetypes.

   Every icon is a real storage device built from primitives. Vertex colour is
   absolute RGB plus a mode in .a:  0 = own colour, 1 = folder accent,
   2 = the extracted application-icon texture.

   COPLANARITY RULE: two parts must be clearly apart or deeply overlapped —
   never abutting, never sharing a face plane. Coincident faces with opposing
   normals z-fight, and which one wins is a per-pixel coin flip. */

export function finalize(M){
  const P = new Float32Array(M.pos), nrm = new Float32Array(M.pos.length);
  let ext = 0;
  for(let i=0;i<P.length;i++) ext = Math.max(ext, Math.abs(P[i]));
  for(let t=0;t<P.length;t+=9){
    const ax=P[t+3]-P[t], ay=P[t+4]-P[t+1], az=P[t+5]-P[t+2];
    const bx=P[t+6]-P[t], by=P[t+7]-P[t+1], bz=P[t+8]-P[t+2];
    let nx=ay*bz-az*by, ny=az*bx-ax*bz, nz=ax*by-ay*bx;
    const l=Math.hypot(nx,ny,nz)||1; nx/=l; ny/=l; nz/=l;
    for(let k=0;k<3;k++){ nrm[t+k*3]=nx; nrm[t+k*3+1]=ny; nrm[t+k*3+2]=nz; }
  }
  return { pos:P, nrm, tint:new Float32Array(M.tint), uv:new Float32Array(M.uv), ext: ext||1 };
}

export const C = {
  gun:[0.22,0.24,0.27,0],  slate:[0.38,0.41,0.45,0],
  steel:[0.64,0.68,0.72,0], chrome:[0.83,0.86,0.89,0],
  pcb:[0.11,0.32,0.19,0],  pcbTop:[0.15,0.41,0.25,0],
  chip:[0.08,0.09,0.11,0], ink:[0.13,0.14,0.16,0],
  gold:[0.80,0.63,0.24,0], paper:[0.86,0.86,0.83,0],
  accent:[1,1,1,1],        tex:[1,1,1,2]
};

const NOUV=[[0,0],[0,0],[0,0]];
const tri=(M,a,b,c,col,uv)=>{ const U=uv||NOUV;
  for(let i=0;i<3;i++){ const p=[a,b,c][i];
    M.pos.push(p[0],p[1],p[2]);
    M.tint.push(col[0],col[1],col[2],col[3]);
    M.uv.push(U[i][0],U[i][1]); } };
const quad=(M,a,b,c,d,col,q)=>{
  if(q){ tri(M,a,b,c,col,[q[0],q[1],q[2]]); tri(M,a,c,d,col,[q[0],q[2],q[3]]); }
  else { tri(M,a,b,c,col); tri(M,a,c,d,col); } };

function box(M,cx,cy,cz,hx,hy,hz,top,side,bottom){
  const X=[cx-hx,cx+hx],Y=[cy-hy,cy+hy],Z=[cz-hz,cz+hz],P=(i,j,k)=>[X[i],Y[j],Z[k]];
  const s=side||top,b=bottom||s;
  quad(M,P(0,1,1),P(1,1,1),P(1,1,0),P(0,1,0),top);
  quad(M,P(0,0,0),P(1,0,0),P(1,0,1),P(0,0,1),b);
  quad(M,P(0,0,1),P(1,0,1),P(1,1,1),P(0,1,1),s);
  quad(M,P(1,0,0),P(0,0,0),P(0,1,0),P(1,1,0),s);
  quad(M,P(1,0,1),P(1,0,0),P(1,1,0),P(1,1,1),s);
  quad(M,P(0,0,0),P(0,0,1),P(0,1,1),P(0,1,0),s);
}
/* the application-icon surface: one +Y quad carrying real UVs */
function plate(M,cx,cy,cz,hx,hz){
  quad(M,[cx-hx,cy,cz+hz],[cx+hx,cy,cz+hz],[cx+hx,cy,cz-hz],[cx-hx,cy,cz-hz],
    C.tex,[[0,1],[1,1],[1,0],[0,0]]);
}
function cyl(M,cx,cy,cz,r,hy,seg,side,cap){
  const yT=cy+hy,yB=cy-hy;
  for(let i=0;i<seg;i++){
    const a0=i/seg*Math.PI*2,a1=(i+1)/seg*Math.PI*2;
    const x0=cx+Math.cos(a0)*r,z0=cz+Math.sin(a0)*r;
    const x1=cx+Math.cos(a1)*r,z1=cz+Math.sin(a1)*r;
    tri(M,[x1,yT,z1],[x0,yT,z0],[cx,yT,cz],cap);
    tri(M,[x0,yB,z0],[x1,yB,z1],[cx,yB,cz],cap);
    quad(M,[x1,yB,z1],[x0,yB,z0],[x0,yT,z0],[x1,yT,z1],side);
  }
}
function ring(M,cy,rIn,rOut,hy,seg,top,bot,side){
  const yT=cy+hy,yB=cy-hy;
  for(let i=0;i<seg;i++){
    const a0=i/seg*Math.PI*2,a1=(i+1)/seg*Math.PI*2;
    const c0=Math.cos(a0),s0=Math.sin(a0),c1=Math.cos(a1),s1=Math.sin(a1);
    const O0=[c0*rOut,s0*rOut],O1=[c1*rOut,s1*rOut];
    const I0=[c0*rIn,s0*rIn],I1=[c1*rIn,s1*rIn];
    quad(M,[O1[0],yT,O1[1]],[O0[0],yT,O0[1]],[I0[0],yT,I0[1]],[I1[0],yT,I1[1]],top);
    quad(M,[O0[0],yB,O0[1]],[O1[0],yB,O1[1]],[I1[0],yB,I1[1]],[I0[0],yB,I0[1]],bot);
    quad(M,[O1[0],yB,O1[1]],[O0[0],yB,O0[1]],[O0[0],yT,O0[1]],[O1[0],yT,O1[1]],side);
    quad(M,[I0[0],yB,I0[1]],[I1[0],yB,I1[1]],[I1[0],yT,I1[1]],[I0[0],yT,I0[1]],side);
  }
}
const M0=()=>({pos:[],tint:[],uv:[]});

/* ------------------------------------------------------------------ devices */
export function buildHDD(){ const M=M0();
  box(M,0,0,0, 0.50,0.075,0.36, C.steel,C.gun,C.pcb);
  box(M,0,0.082,0, 0.44,0.010,0.30, C.slate,C.slate);
  cyl(M,0.24,0.094,0, 0.105,0.012,10, C.chrome,C.chrome);
  cyl(M,0.24,0.105,0, 0.032,0.008,8, C.gun,C.gun);
  box(M,-0.20,0.094,0, 0.22,0.006,0.25, C.accent,C.accent);
  plate(M,-0.20,0.116,0, 0.20,0.23);
  box(M,0.50,-0.020,0.15, 0.025,0.030,0.12, C.ink,C.ink);
  return finalize(M); }

export function buildSSD(){ const M=M0();
  box(M,0,0,0, 0.42,0.055,0.30, C.slate,C.gun,C.gun);
  box(M,0,0.058,0, 0.39,0.008,0.27, C.steel,C.steel);
  box(M,-0.03,0.067,0, 0.27,0.005,0.21, C.accent,C.accent);
  plate(M,-0.03,0.088,0, 0.25,0.19);
  for(const [x,z] of [[0.32,-0.22],[0.32,0.22]]) cyl(M,x,0.062,z, 0.030,0.006,6, C.gun,C.gun);
  box(M,0.43,-0.012,0.11, 0.025,0.028,0.14, C.ink,C.ink);
  return finalize(M); }

export function buildM2(){ const M=M0();
  box(M,0,0,0, 0.52,0.016,0.15, C.pcbTop,C.pcb);
  box(M,0.30,0.030,0, 0.14,0.016,0.11, C.chip,C.chip);
  box(M,-0.44,0.004,0, 0.07,0.014,0.12, C.gold,C.gold);
  box(M,-0.12,0.024,0, 0.24,0.014,0.13, C.accent,C.accent);
  plate(M,-0.12,0.054,0, 0.13,0.125);
  box(M,0.30,0.047,0, 0.05,0.004,0.04, C.paper,C.paper);
  return finalize(M); }

export function buildFloppy(){ const M=M0();
  box(M,0,0,0, 0.36,0.030,0.34, C.ink,C.ink);
  box(M,0.25,0.033,0, 0.09,0.008,0.21, C.chrome,C.chrome);
  box(M,-0.09,0.033,0, 0.23,0.006,0.24, C.accent,C.accent);
  plate(M,-0.09,0.055,0, 0.21,0.22);
  cyl(M,0,-0.033,0, 0.10,0.006,8, C.slate,C.slate);
  box(M,-0.31,0.031,-0.30, 0.030,0.006,0.04, C.paper,C.paper);
  return finalize(M); }

export function buildDisc(){ const M=M0();
  ring(M,0, 0.20,0.58, 0.012,16, C.accent,C.chrome,C.chrome);
  ring(M,0, 0.075,0.215, 0.018,12, C.paper,C.paper,C.chrome);
  plate(M,0,0.034,0, 0.30,0.30);
  return finalize(M); }

export function buildUSB(){ const M=M0();
  box(M,-0.16,0,0, 0.30,0.110,0.170, C.accent,C.accent,C.ink);
  plate(M,-0.16,0.128,0, 0.22,0.135);
  box(M,0.17,0,0, 0.09,0.125,0.185, C.ink,C.ink);
  box(M,0.42,0,0, 0.17,0.055,0.115, C.chrome,C.steel);
  return finalize(M); }

export function buildCard(){ const M=M0();
  box(M,0,0,0, 0.62,0.030,0.62, C.ink, C.gun, C.ink);   // a thin dark edge only
  plate(M,0,0.050,0, 0.60,0.60);                        // the icon, nearly edge to edge
  return finalize(M); }

/* The console's cubes are glass: a bright bevelled frame around a dark inset
   panel on every face. A flat-shaded solid reads as cardboard, which is why the
   first attempt looked like painted blocks rather than glass. */
export function buildGlassCube(){
  const M=M0(), h=1.0, f=0.72, o=1.004;
  const FRAME=[0.95,0.97,1.00,0], PANE=[0.52,0.57,0.70,0];
  box(M,0,0,0, h,h,h, FRAME, FRAME, FRAME);
  const face=(ax,s)=>{
    const q=(u,v)=>{ const p=[0,0,0]; p[ax]=s*h*o;
      p[(ax+1)%3]=u*f*h; p[(ax+2)%3]=v*f*h; return p; };
    const a=q(-1,-1),b=q(1,-1),c=q(1,1),d=q(-1,1);
    if(s>0) quad(M,a,b,c,d,PANE); else quad(M,d,c,b,a,PANE);
  };
  for(let ax=0;ax<3;ax++){ face(ax,1); face(ax,-1); }
  return finalize(M);
}

export function buildBlock(){
  const M=M0();
  const X=[-1,1],Y=[-1,1],Z=[-1,1],P=(i,j,k)=>[X[i],Y[j],Z[k]];
  const F=[0.98,0.99,1.00,0], S1=[0.70,0.73,0.80,0], S2=[0.40,0.43,0.50,0],
        S3=[0.20,0.22,0.28,0], B=[0.10,0.11,0.15,0];
  quad(M,P(0,1,1),P(1,1,1),P(1,1,0),P(0,1,0),F);    // +Y  lit hard
  quad(M,P(0,0,0),P(1,0,0),P(1,0,1),P(0,0,1),B);    // -Y  in shadow
  quad(M,P(0,0,1),P(1,0,1),P(1,1,1),P(0,1,1),S1);   // +Z
  quad(M,P(1,0,0),P(0,0,0),P(0,1,0),P(1,1,0),S3);   // -Z
  quad(M,P(1,0,1),P(1,0,0),P(1,1,0),P(1,1,1),S2);   // +X
  quad(M,P(0,0,0),P(0,0,1),P(0,1,1),P(0,1,0),S1);   // -X
  return finalize(M);
}

export function buildBar(){ const M=M0();
  box(M,0,0,0, 1,1,1, C.accent,C.accent,C.accent);
  return finalize(M); }

/* =========================================================================
   ANIMATION ARCHETYPES

   Only about one PS2 title in twenty ever gave copy or delete its own icon, and
   when a team did bother the flourish was almost always on DELETE — among the
   two-state cards the odd one out is the delete icon by roughly ten to one.
   The icons themselves are morph-target animations: at most eight whole-mesh
   snapshots, linearly blended, no bones and no skinning. So every reaction
   decomposes into a rigid part (translate / yaw-pitch-roll / uniform scale) plus
   a small non-rigid residual, and that decomposition is the vocabulary here:

     POSE       vertex morph       the shape it takes when it is afraid
     DUP        vertex morph       the shape a copy takes
     BURST      per-face offset    how the afraid shape comes apart
     BEHAVIOUR  transform delta    how it moves
     TINT       colour shift       how its colour changes
     PULSE      breath curve       how it sits still

   Each device draws THREE behaviours from the same vocabulary — an always-on
   idle character, a copy character, and a fear character — so no two devices
   share a silhouette of motion. Idle is what you look at 99% of the time, so it
   is a first-class layer here, not a spin rate.
   ========================================================================= */

/* Poses are pure vertex functions: (x,y,z, e = overall extent, ey = half-height).
   Anything height-relative must use ey — these devices are all flat plates, so
   normalising y by the overall extent would make the effect vanish. */
export const POSE = {
  slump:  (x,y,z)=>[ x*1.07, y*0.44-0.20, z*1.07 - y*0.34 ],
  flatten:(x,y,z)=>[ x*1.14, y*0.30-0.16, z*1.14 ],
  curl:   (x,y,z,e)=>{ const t=(x/e)*(x/e);
                       return [ x*0.94, y*0.55-0.17+t*0.46, z*0.94 - y*0.18 ]; },
  bend:   (x,y,z,e)=>{ const t=1-(x/e)*(x/e);
                       return [ x*1.02, y*0.80-0.09-t*0.36, z*1.02 ]; },
  keel:   (x,y,z)=>[ x*0.96, y*0.70-0.15+x*0.54, z*0.96 ],
  shrink: (x,y,z)=>[ x*0.56, y*0.56-0.23, z*0.56 ],
  hunch:  (x,y,z,e,ey)=>{ const t=Math.max(0,y)/Math.max(ey||e,1e-6);
                       return [ x*(1-0.22*t), y*0.62-0.14, z*(1+0.30*t)+0.16*t ]; },
  /* rigid roll onto its edge — the dropped coin that stopped */
  topple: (x,y,z)=>{ const c=Math.cos(1.18), s=Math.sin(1.18);
                     return [ x*c-y*s, x*s+y*c-0.22, z ]; },
  /* hinges at the waist, both ends lifting: a card closing on itself */
  fold:   (x,y,z,e)=>{ const t=Math.abs(x)/Math.max(e,1e-6);
                       return [ x*(1-0.30*t), y*0.72+t*t*0.44-0.16, z*0.94 ]; },
  /* one end collapses to nothing while the other holds its size */
  taper:  (x,y,z,e)=>{ const t=(x/Math.max(e,1e-6)+1)*0.5, s=0.22+0.78*t;
                       return [ x*0.96, y*s-0.13, z*s ]; },
  /* propeller twist about the long axis — reads hard on anything flat */
  twist:  (x,y,z,e)=>{ const a=(x/Math.max(e,1e-6))*1.15;
                       const c=Math.cos(a), s=Math.sin(a);
                       return [ x*0.98, (y*c-z*s)*0.88-0.11, y*s+z*c ]; },
  /* the rim lifts and the middle sinks: a dish, or a warped platter */
  cup:    (x,y,z,e)=>{ const r=Math.hypot(x,z)/Math.max(e,1e-6);
                       return [ x*0.94, y*0.72+r*r*0.52-0.22, z*0.94 ]; },
  /* rotation about Y proportional to radius — a vortex, not a spin */
  swirl:  (x,y,z,e)=>{ const a=(Math.hypot(x,z)/Math.max(e,1e-6))*1.40;
                       const c=Math.cos(a), s=Math.sin(a);
                       return [ x*c-z*s, y*0.66-0.13, x*s+z*c ]; },
  /* deterministic dents: crushed paper, every vertex pushed its own way */
  crumple:(x,y,z)=>{ const h=Math.sin(x*47.3+z*29.7+y*13.1)*0.5;
                     return [ x*0.88+h*0.11, y*0.56-0.15+h*0.15, z*0.88-h*0.11 ]; }
};

/* Bursts move whole faces: (cx,cy,cz, e). The residual around the face centroid
   is re-added by shapes(), so a face never turns inside out on the way out. */
export const BURST = {
  radial: (cx,cy,cz)=>{ const l=Math.hypot(cx,cy,cz)||1;
                        return [cx+cx/l*1.4, cy+cy/l*1.4+0.34, cz+cz/l*1.4]; },
  wedge:  (cx,cy,cz)=>{ const r=Math.hypot(cx,cz)||1;
                        return [cx+cx/r*1.55, cy+0.10, cz+cz/r*1.55]; },
  snap:   (cx,cy,cz)=>{ const s=cx>=0?1:-1;
                        return [cx+s*1.15, cy-0.34, cz+s*0.22]; },
  crumble:(cx,cy,cz)=>[ cx*1.12, cy-1.25, cz*1.12 ],
  vanish: (cx,cy,cz)=>[ cx*0.06, cy*0.06, cz*0.06 ],
  scatter:(cx,cy,cz)=>{ const h=Math.sin(cx*91.3+cz*57.7)*0.5+0.5;
                        return [cx+ (h-0.5)*2.4, cy+0.55+h*0.7, cz+(0.5-h)*2.0]; },
  /* no explosion at all: the whole machine folds down into a heap on the floor */
  sink:   (cx,cy,cz)=>[ cx*1.18, -0.92+cy*0.16, cz*1.18 ],
  /* the halves slide past each other and part company — delamination */
  shear:  (cx,cy,cz)=>{ const s=cz>=0?1:-1;
                        return [cx*1.05+s*0.28, cy+s*0.40, cz+s*1.10]; },
  /* thrown outward along a spiral, so it unwinds instead of bursting */
  spiral: (cx,cy,cz)=>{ const r=Math.hypot(cx,cz), a=0.85+r*1.9;
                        const c=Math.cos(a), s=Math.sin(a);
                        return [(cx*c-cz*s)*1.55, cy+0.26, (cx*s+cz*c)*1.55]; },
  /* lifts off one edge first and peels back over the top */
  peel:   (cx,cy,cz,e)=>{ const t=(cx/Math.max(e||1,1e-6)+1)*0.5;
                          return [cx-t*1.30, cy+t*1.00, cz*1.06]; },
  /* converges into a thin column and rises: burnt off rather than blown apart */
  ash:    (cx,cy,cz)=>{ const h=Math.sin(cx*63.1+cz*41.7)*0.5+0.5;
                        return [cx*0.24+(h-0.5)*0.34, cy+0.80+h*1.10,
                                cz*0.24+(0.5-h)*0.30]; },
  /* driven away from the camera and up, like something blown off a shelf */
  blowback:(cx,cy,cz)=>[ cx*1.10, cy+0.52, cz-1.35 ]
};

/* Copy poses: (x,y,z, s = +/- sign of the face's x, e, sz = sign of its z). */
export const DUP = {
  split:(x,y,z,s)=>[ x+s*0.34, y*0.94+0.14, z ],
  lift: (x,y,z)=>  [ x*1.20, y*0.55+0.34, z*1.20 ],
  stack:(x,y,z,s)=>[ x*0.92, y*0.55+s*0.30, z*0.92 ],
  dash: (x,y,z,s)=>[ x*1.35+s*0.10, y*0.86, z*0.72 ],
  /* the halves swing open about the middle like a hand of cards */
  fan:  (x,y,z,s)=>{ const a=s*0.52, c=Math.cos(a), n=Math.sin(a);
                     return [ x*c-z*n+s*0.20, y*0.90+0.12, x*n+z*c ]; },
  /* two of it, separated in depth rather than across */
  mirror:(x,y,z,s,e,sz)=>[ x*0.96, y*0.92+0.10, z+(sz||1)*0.32 ],
  /* peels up off itself and hangs there, thinner than the original */
  rise: (x,y,z)=>  [ x*1.04, y*0.40+0.46, z*1.04 ],
  /* slides out sideways, the leading half further than the rest */
  eject:(x,y,z,s)=>[ x*1.08+0.24+(s>0?0.22:0), y*0.94+0.05, z*0.96 ],
  /* spreads out flat, the way a copied sheet lands next to the original */
  bloom:(x,y,z)=>  [ x*1.28, y*0.34+0.13, z*1.28 ]
};

/* Per-frame transform deltas. t = seconds, k = intensity 0..1 (delete peaks at
   1.9 for one beat, so nothing here may blow up past 1). Returned fields are all
   optional: { dx, dy, dz, rx, ry, rz, scale, spin }, spin being a RATE
   multiplier. Idle characters must never return spin — they express angular
   character through ry, so freezing the clock freezes them exactly. */
export const BEHAVIOUR = {
  none:   ()=>({}),

  /* ---- idle characters: always on, one per device -------------------------
     These are the whole personality. They run at k=1 whenever nothing else is
     happening and fade out as a reaction takes over. */

  /* mass. The turn cogs twice a revolution like a flywheel with a heavy spot,
     and the chassis rocks a little as it comes round. */
  heft:   (t,k)=>({ ry:Math.sin(t*0.40)*0.34*k, rz:Math.sin(t*0.31+0.6)*0.045*k,
                    rx:Math.sin(t*0.26+1.9)*0.032*k, dy:Math.sin(t*0.55)*0.016*k }),
  /* frictionless: no moving parts, so it never cogs. It drifts on a cushion at a
     dead-constant yaw, and banks into the drift the way a hovering thing does —
     the bank leads the translation by a quarter cycle on both axes. */
  cushion:(t,k)=>({ dx:Math.sin(t*0.52)*0.040*k, dy:Math.cos(t*0.71)*0.028*k,
                    rz:Math.sin(t*0.52+1.57)*0.105*k,
                    rx:Math.cos(t*0.71+1.57)*0.055*k }),
  /* a controller indexing between fixed positions: still, snap, still. The
     quantised yaw is the read; the buzz underneath is just mains hum. */
  twitch: (t,k)=>{ const q=Math.round(Math.sin(t*0.63)*2)/2;
                   const f=Math.max(0,Math.sin(t*3.7)); const ff=f*f*f*f;
                   return { ry:q*0.62*k, rz:ff*ff*0.11*k,
                            dx:Math.sin(t*23.0)*0.006*k, dy:Math.sin(t*31.0+0.7)*0.005*k }; },
  /* weightless: tumbling on two axes at rates that never line up, wandering as
     it goes. Nothing here repeats inside a minute. */
  drift:  (t,k)=>({ rx:Math.sin(t*0.29)*0.40*k, rz:Math.sin(t*0.21+2.1)*0.30*k,
                    dx:Math.sin(t*0.17)*0.042*k, dy:Math.sin(t*0.23+1.1)*0.038*k }),
  /* flat and fast, with the one wobble of a platter that is a hair off centre.
     Deliberately almost no translation — speed is the character. */
  platter:(t,k)=>({ rz:Math.sin(t*1.50)*0.024*k, dy:Math.sin(t*1.50+1.57)*0.009*k,
                    rx:Math.sin(t*0.75)*0.018*k }),
  /* hung on a lanyard: it swings, and rather than rotating it turns to look one
     way and then the other. The only idle here that never completes a turn. */
  sway:   (t,k)=>({ rz:Math.sin(t*1.15)*0.16*k, ry:Math.sin(t*0.47)*0.85*k,
                    dx:Math.sin(t*1.15)*0.020*k,
                    dy:-Math.abs(Math.sin(t*1.15))*0.013*k }),

  /* ---- copy characters: what it does while the duplicate morph runs ------- */

  /* lifted rather than thrown: slow, and it drags on the spin-up the copy gives
     everything else, because mass does not accelerate for free */
  heave:  (t,k)=>({ dy:0.15*k, rx:-0.10*k, scale:1+0.05*k, spin:1-0.45*k,
                    rz:Math.sin(t*2.2)*0.045*k }),
  /* one clean lateral slide, no wobble anywhere */
  glide:  (t,k)=>({ dx:0.19*k, dz:0.08*k, ry:0.26*k, spin:1+0.35*k }),
  /* out of the slot instantly, then vibrating where it stopped. The snap is in
     the translation, not the spin — a spun-up stick is just a blur. */
  dart:   (t,k)=>({ dx:0.24*k, dy:0.05*k, spin:1+0.60*k,
                    rz:Math.sin(t*38.0)*0.055*k, dz:0.05*k }),
  /* paper: it flaps its way up rather than rising */
  flutter:(t,k)=>({ dy:(0.13+Math.sin(t*6.1)*0.05)*k, rx:Math.sin(t*6.1+0.9)*0.30*k,
                    rz:Math.sin(t*4.3)*0.18*k, spin:1+0.20*k }),
  /* spins up hard, the way a drive does when it starts reading. Only the disc
     can carry this: a round thing at speed still reads as a round thing. */
  whirl:  (t,k)=>({ spin:1+1.60*k, dy:0.09*k, scale:1+0.04*k, rx:-0.07*k }),
  /* bounces, squashing on the way down and stretching at the top */
  hop:    (t,k)=>{ const b=Math.abs(Math.sin(t*4.6));
                   return { dy:b*0.19*k, scale:1-0.09*k*(1-b), dx:0.09*k,
                            rz:Math.sin(t*4.6)*0.10*k, spin:1-0.20*k }; },

  /* ---- fear characters: what it does when it is about to be deleted ------- */

  /* nervous, unable to keep still */
  tremble:(t,k)=>({ dx:Math.sin(t*46)*0.045*k, dy:Math.sin(t*37.3+1.1)*0.030*k,
                    rx:Math.sin(t*41.7+0.4)*0.055*k }),
  /* crying: a rhythmic hitch, shoulders going up and down */
  sob:    (t,k)=>{ const h=Math.max(0,Math.sin(t*7.4));
                   return { dy:h*0.11*k, rx:-h*0.12*k, scale:1-h*0.045*k,
                            dx:Math.sin(t*29)*0.012*k }; },
  /* sits down and looks away — the rejected-puppy read */
  droop:  (t,k)=>({ rx:-0.58*k, dy:-0.07*k, spin:1-0.88*k,
                    dz:-0.10*k, rz:Math.sin(t*2.1)*0.05*k }),
  /* flips over and crashes */
  flip:   (t,k)=>({ rz:Math.PI*k, dy:-0.12*k, spin:1-0.55*k,
                    dx:Math.sin(t*1.7)*0.04*k }),
  /* stops dead. The contrast with a fast idle is the whole effect. */
  freeze: (t,k)=>({ spin:1-k, scale:1-0.04*k }),
  /* recoils away from the camera and turns its back */
  recoil: (t,k)=>({ dz:-0.50*k, ry:0.95*k, scale:1-0.16*k,
                    dy:0.05*k, rx:0.12*k }),
  /* power cut: the platter runs down, the chassis settles askew and sits lower.
     Slow where tremble is fast — the two must never be mistaken for each other. */
  spindown:(t,k)=>({ spin:1-0.94*k, rx:0.16*k, dy:-0.14*k, scale:1-0.06*k,
                     rz:0.12*k+Math.sin(t*1.7)*0.06*k }),
  /* a dropped signal: holds, jumps, holds. No smooth motion anywhere in it. */
  stutter:(t,k)=>{ const q=Math.floor(t*11)%4, j=q===0?1:q===2?-1:0;
                   return { spin:1-0.72*k, dx:j*0.055*k, ry:j*0.17*k,
                            dy:(q===3?-0.035:0)*k, scale:1-0.03*k }; },
  /* the buzz of something electrical failing: tiny amplitude, very high rate */
  buzz:   (t,k)=>({ dx:Math.sin(t*97)*0.020*k, dy:Math.sin(t*83+2.1)*0.015*k,
                    rz:Math.sin(t*113)*0.05*k, spin:1-0.35*k, scale:1-0.02*k }),
  /* faints: tips back, rolls onto one corner and slides out of the light */
  swoon:  (t,k)=>({ rx:-0.42*k, rz:0.55*k, dy:-0.10*k, dz:-0.16*k,
                    spin:1-0.60*k, dx:Math.sin(t*1.3)*0.05*k }),
  /* the Euler-disc settle: falls from face-on towards its edge and rattles down,
     the wobble getting faster as it loses the fight. It stops a little short of
     true edge-on, where a ring is a line and there is nothing left to watch. */
  capsize:(t,k)=>{ const kk=k>1?1+(k-1)*0.30:k;
                   return { rx:0.78*kk, dy:-0.14*k, spin:1-0.80*k,
                            rz:Math.sin(t*8.5*kk)*0.10*kk, dx:Math.sin(t*3.1)*0.03*k }; }
};

const LUMA = c => c[0]*0.299 + c[1]*0.587 + c[2]*0.114;
export const TINT = {
  none:    c=>c,
  redshift:(c,k)=>[ c[0]+(0.86-c[0])*k, c[1]+(0.14-c[1])*k, c[2]+(0.12-c[2])*k ],
  drain:   (c,k)=>{ const g=LUMA(c)*0.85;
                    return [ c[0]+(g-c[0])*k, c[1]+(g-c[1])*k, c[2]+(g-c[2])*k ]; },
  dim:     (c,k)=>[ c[0]*(1-0.60*k), c[1]*(1-0.60*k), c[2]*(1-0.62*k) ],
  /* the cold of something switched off at the wall */
  chill:   (c,k)=>[ c[0]+(0.26-c[0])*k, c[1]+(0.40-c[1])*k, c[2]+(0.64-c[2])*k ],
  /* a warning lamp rather than an alarm */
  amber:   (c,k)=>[ c[0]+(0.92-c[0])*k, c[1]+(0.60-c[1])*k, c[2]+(0.09-c[2])*k ],
  /* bleached to pale paper: colour leaves before the shape does */
  ghost:   (c,k)=>{ const g=Math.min(1,LUMA(c)*0.5+0.52);
                    return [ c[0]+(g-c[0])*k, c[1]+(g-c[1])*k, c[2]+(g-c[2])*k ]; },
  /* overexposed, like a surface losing what was written on it */
  bleach:  (c,k)=>[ c[0]+(1-c[0])*0.85*k, c[1]+(1-c[1])*0.85*k, c[2]+(1-c[2])*0.85*k ]
};

/* The idle breath curve: t is already scaled by the device's `breathe` rate and
   offset by its grid phase. Output is the morph tween toward the inflated shape,
   0..1 (the renderer clamps, so a curve may overshoot slightly without harm). */
export const PULSE = {
  breath: t=>0.30+0.30*Math.sin(t*1.6),
  /* slow and deep, like something large moving air. Bottoms out exactly at 0
     rather than below it — a curve that clips spends its trough sitting still. */
  swell:  t=>0.32+0.32*Math.sin(t*1.15),
  /* shallow, even, unremarkable — the point is that nothing happens */
  steady: t=>0.34+0.16*Math.sin(t*1.6),
  /* dark most of the cycle, then a sharp spike: an activity LED, not a lung */
  flicker:t=>{ const u=0.5+0.5*Math.sin(t*2.2), v=u*u*u; return 0.10+0.62*v*v*u; },
  /* two waves that beat against each other, so it never quite repeats */
  paper:  t=>0.34+0.20*Math.sin(t*1.2)+0.10*Math.sin(t*2.7+1.1),
  /* tiny and fast — a rim running slightly out of true */
  ripple: t=>0.44+0.09*Math.sin(t*4.4),
  /* snaps bright and decays away: a pulse rather than a breath. The attack is
     fast but not instant — a step here would read as a dropped frame. */
  throb:  t=>{ const u=(t*0.42)%1, r=u<0.10 ? u/0.10 : (1-u)/0.90;
               return 0.16+0.62*r*r; },
  flat:   ()=>0
};

/* Seven devices, and no two share an idle, a copy, a reaction, a pose, a way of
   coming apart OR a colour. The idle line is the one that matters: it is the
   only one you see when nothing is happening. */
export const MESHDEF = {
  /* a machine with mass: cogged turn, deep slow breath. Afraid, it spins down
     and settles askew, then folds into a heap on the floor. */
  hdd:    { build:buildHDD,    tilt:-0.86, spin:0.40, breathe:0.62, pulse:"swell",
            idle:"heft",    copyMove:"heave",   move:"spindown",
            pose:"slump",   tint:"dim",      burst:"sink",    dup:"stack" },
  /* no moving parts: a dead-steady drift on a cushion of air. Afraid, it does
     not shake — it drops frames, and delaminates along its layers. */
  ssd:    { build:buildSSD,    tilt:-0.72, spin:0.52, breathe:0.80, pulse:"steady",
            idle:"cushion", copyMove:"glide",   move:"stutter",
            pose:"fold",    tint:"chill",    burst:"shear",   dup:"split" },
  /* a bare board that indexes between fixed angles and blinks. Afraid, it buzzes
     at mains frequency, twists like a snapped stick and breaks in two. */
  m2:     { build:buildM2,     tilt:-0.62, spin:0.05, breathe:1.30, pulse:"flicker",
            idle:"twitch",  copyMove:"dart",    move:"buzz",
            pose:"twist",   tint:"amber",    burst:"snap",    dup:"dash"  },
  /* weightless tumble, drifting where it likes. Afraid, it faints, crumples like
     paper and goes to confetti. */
  floppy: { build:buildFloppy, tilt:-0.74, spin:0.22, breathe:0.70, pulse:"paper",
            idle:"drift",   copyMove:"flutter", move:"swoon",
            pose:"crumple", tint:"ghost",    burst:"scatter", dup:"fan"   },
  /* flat and fast, wobbling a hair off centre. Afraid, it falls from face-on to
     edge-on like a dropped coin and unwinds into a spiral. */
  disc:   { build:buildDisc,   tilt:-0.95, spin:3.00, breathe:1.10, pulse:"ripple",
            idle:"platter", copyMove:"whirl",   move:"capsize",
            pose:"swirl",   tint:"drain",    burst:"spiral",  dup:"mirror" },
  /* hangs and swings, turning to look around instead of rotating. Afraid, it
     stops dead — the one device whose reaction is the absence of motion. */
  usb:    { build:buildUSB,    tilt:-0.48, spin:0.08, breathe:1.00, pulse:"throb",
            idle:"sway",    copyMove:"hop",     move:"freeze",
            pose:"shrink",  tint:"redshift", burst:"vanish",  dup:"lift"  },
  /* scenery, not an icon: the void towers and glass cubes */
  glass:  { build:buildGlassCube, tilt:0, spin:0.30, breathe:0.4, pulse:"breath",
            pose:"shrink", idle:"none", move:"none", copyMove:"none",
            tint:"none", burst:"radial", dup:"lift" },
  block:  { build:buildBlock, tilt:0, spin:0.10, breathe:0.3, pulse:"breath",
            pose:"shrink", idle:"none", move:"none", copyMove:"none",
            tint:"none", burst:"radial", dup:"lift" },
  bar:    { build:buildBar,    tilt:0,      spin:0,    breathe:0,    pulse:"flat",
            idle:"none",    copyMove:"none",    move:"none",
            pose:"slump",   tint:"none",     burst:"radial",  dup:"split" }
};

/* Morph targets. The burst is computed FROM the cowered pose and the renderer
   binds the cower buffer as the morph source during the collapse, so the model
   never snaps back through its neutral shape on the way to coming apart. */
export function shapes(base, def){
  const P=base.pos, N=base.nrm, n=P.length, e=base.ext;
  const pose = POSE[(def&&def.pose)||"slump"];
  const bs   = BURST[(def&&def.burst)||"radial"];
  const dp   = DUP[(def&&def.dup)||"split"];

  let ey=0;
  for(let i=1;i<n;i+=3) ey=Math.max(ey,Math.abs(P[i]));
  ey = ey || e;

  const inflate=new Float32Array(n);
  for(let i=0;i<n;i++) inflate[i]=P[i]+N[i]*0.05;

  const dup=new Float32Array(n);
  for(let t=0;t<n;t+=9){
    const s =((P[t]  +P[t+3]+P[t+6])/3)>=0?1:-1;
    const sz=((P[t+2]+P[t+5]+P[t+8])/3)>=0?1:-1;
    for(let k=0;k<3;k++){ const o=t+k*3, v=dp(P[o],P[o+1],P[o+2],s,e,sz);
      dup[o]=v[0]; dup[o+1]=v[1]; dup[o+2]=v[2]; }
  }
  const cower=new Float32Array(n);
  for(let i=0;i<n;i+=3){ const v=pose(P[i],P[i+1],P[i+2],e,ey);
    cower[i]=v[0]; cower[i+1]=v[1]; cower[i+2]=v[2]; }

  const del=new Float32Array(n);
  for(let t=0;t<n;t+=9){
    const cx=(cower[t]+cower[t+3]+cower[t+6])/3;
    const cy=(cower[t+1]+cower[t+4]+cower[t+7])/3;
    const cz=(cower[t+2]+cower[t+5]+cower[t+8])/3;
    const o=bs(cx,cy,cz,e);
    for(let k=0;k<3;k++){
      del[t+k*3]  =o[0]+(cower[t+k*3]  -cx)*0.28;
      del[t+k*3+1]=o[1]+(cower[t+k*3+1]-cy)*0.28;
      del[t+k*3+2]=o[2]+(cower[t+k*3+2]-cz)*0.28;
    }
  }
  return { inflate, dup, cower, del };
}

/* The bare logo, one variant per device family. The chassis is dropped when the
   real application icon resolves, but the reaction must not be — otherwise
   every game folder slumps and bursts identically, which is the opposite of
   the point. Geometry from buildCard, personality inherited. */
for(const key of ["hdd","ssd","m2","floppy","disc","usb"]){
  const d = MESHDEF[key];
  MESHDEF["card_" + key] = {
    build: buildCard, tilt: -1.30,
    spin: d.spin * 0.5, breathe: d.breathe, pulse: d.pulse,
    pose: d.pose, idle: d.idle, move: d.move, copyMove: d.copyMove,
    tint: d.tint, burst: d.burst, dup: d.dup
  };
}
