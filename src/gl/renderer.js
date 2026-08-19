/* WebGL2 renderer: one background pass that serves every screen, an icon pass,
   and an offscreen blur used for the options-screen focus pull. */

import { MESHDEF, shapes, BEHAVIOUR, TINT, PULSE } from "./meshes.js";

/* ------------------------------------------------------------------ matrices */
const I = () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
function mul(a,b){                                     // column-major, a*b
  const o=new Float32Array(16);
  for(let c=0;c<4;c++) for(let r=0;r<4;r++){
    let s=0; for(let k=0;k<4;k++) s+=a[k*4+r]*b[c*4+k];
    o[c*4+r]=s;
  }
  return o;
}
const trans=(x,y,z)=>{ const m=I(); m[12]=x; m[13]=y; m[14]=z; return m; };
const scale=(x,y,z)=>{ const m=I(); m[0]=x; m[5]=y; m[10]=z; return m; };
const rotX=a=>{ const m=I(),c=Math.cos(a),s=Math.sin(a); m[5]=c; m[6]=s; m[9]=-s; m[10]=c; return m; };
const rotY=a=>{ const m=I(),c=Math.cos(a),s=Math.sin(a); m[0]=c; m[2]=-s; m[8]=s; m[10]=c; return m; };
const rotZ=a=>{ const m=I(),c=Math.cos(a),s=Math.sin(a); m[0]=c; m[1]=s; m[4]=-s; m[5]=c; return m; };
const persp=(f,a,n,fz)=>{ const t=1/Math.tan(f/2), d=1/(n-fz);
  return new Float32Array([t/a,0,0,0, 0,t,0,0, 0,0,(fz+n)*d,-1, 0,0,2*fz*n*d,0]); };

/* ------------------------------------------------- boot-scene placement ----
   Pure, exported and covered by `npm run check`, because both of these were
   silently wrong: the towers used the GLSL sin-hash, which clusters badly for
   small integers, and put two columns 0.183 apart in x and 0.033 in z — a
   guaranteed interpenetration at every drive count. The blocks then drove
   through whatever towers they passed. Neither shows up in review; both show
   up instantly in a separation test, so the test is the thing that keeps them
   honest. */
const frac = x => x - Math.floor(x);

/** Column i of n. A golden-angle spiral spreads any count evenly by
    construction; the jitter is bounded well under the spacing. */
export function towerAt(i, n){
  const fj = frac(Math.sin(i*78.233)*43758.5453);
  const ang = i*2.39996323 + (fj-0.5)*0.35;
  // depth maps to screen height at this pitch AND is amplified by the
  // projection, so the band stays shallow: 3 units threw the near towers a
  // full screen below the far ones
  const rad = 1.70*Math.sqrt((i+0.5)/Math.max(1,n));
  return { x: Math.cos(ang)*rad, z: -3.55 + Math.sin(ang)*rad*0.45 };
}

/** Drifting block i at time t. Depth is slotted per index so they arrive
    spread out, and the x/y position is scaled onto a guard RECTANGLE around
    the towers — an ellipse would cut back inside at the diagonal. */
export function blockAt(i, t){
  const fx = frac(Math.sin(i*37.13)*43758.5453);
  const fy = frac(Math.sin(i*91.77)*43758.5453);
  const fs = frac(Math.sin(i*13.41)*43758.5453);
  const SPAN = 10.0;
  const dist = 1.6 + ((i/7)*SPAN + fs*0.6 + t*0.42) % SPAN;
  const ang = (i/7)*Math.PI*2 + fx*1.4;
  const cx = Math.cos(ang), sy = Math.sin(ang);
  const k = (1 + fy*0.35)/Math.max(Math.abs(cx)/2.25, Math.abs(sy)/2.60, 1e-3);
  return { x: cx*k, y: 0.35 + sy*k, z: -dist, s: 0.10 + fs*0.13,
           spinY: fx*6.0, spinX: fs*2.4,
           fade: Math.min(1.0, Math.min((SPAN-dist)/2.5, (dist-1.0)/1.5))*0.34 };
}

export const hex = h => [parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255];

/* ------------------------------------------------------------------- shaders */
const BG_V = `#version 300 es
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
  gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const BG_F = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uTime;
uniform vec3 uTL,uTR,uBL,uBR;
uniform vec2 uGlow; uniform float uGlowAmt,uRipple,uSpark,uRing,uSwirl;
out vec4 frag;

vec3 moteCol(float i){ return 0.55+0.45*cos(vec3(0.0,2.2,4.4)+i*1.9); }

void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 p=uv-0.5; p.x*=uRes.x/uRes.y;
  vec3 col=mix(mix(uBL,uBR,uv.x), mix(uTL,uTR,uv.x), uv.y);

  // concentric ripples — the moire rings on the device-select screen
  float d=length(p-vec2(0.02,-0.03));
  col += uRipple*(sin(d*54.0-uTime*0.55)*0.5+0.5)*0.030*smoothstep(0.95,0.10,d);
  col += uRipple*(sin(d*23.0+uTime*0.31)*0.5+0.5)*0.020*smoothstep(1.10,0.05,d);

  // specular bloom behind the selected icon: the whole selection cue
  float gd=length(p-uGlow);
  col += uGlowAmt*(exp(-gd*gd*46.0)*0.95 + exp(-gd*gd*7.0)*0.22);

  // boot void: blue mist, and pink/green/red/blue lights circling the scene.
  // They are comet-like, not dots — each is drawn several times along its own
  // recent path so it pulls a fading trail behind it.
  if(uSpark>0.001){
    col += uSpark*(exp(-dot(p,p)*7.0)*vec3(0.035,0.070,0.150)
                 + exp(-dot(p,p)*1.8)*vec3(0.012,0.026,0.062));  // soft centre mist
    for(int i=0;i<10;i++){
      float fi=float(i);
      vec3 mc=moteCol(fi*1.21);
      float sp=0.30+0.12*fract(fi*0.37);
      float rx=0.50+0.20*sin(fi*3.1), ry=0.30+0.10*cos(fi*2.3);
      for(int k=0;k<6;k++){
        float tt=uTime*sp-float(k)*0.11;
        vec2 q=vec2(cos(tt+fi*1.9)*rx, sin(tt*1.3+fi*2.7)*ry);
        float sd=length(p-q);
        float w=pow(1.0-float(k)/6.0,1.7);
        col += uSpark*mc*w*(exp(-sd*sd*2600.0)*0.95+exp(-sd*sd*240.0)*0.055);
      }
    }
  }

  /* main menu: a ring of pale-blue orbs tumbling in 3D over a faint nebula.
     The ring is real geometry — eight points on a unit circle, turned by a slow
     yaw/pitch/roll and projected through a pinhole — so orbs on the near side
     swell and brighten while the far side shrinks, and the ellipse itself
     changes shape as the ring turns. Dots sliding around a fixed ellipse read
     as a 2D spinner; the console's did not. */
  if(uRing>0.001){
    vec2 c=vec2(-0.17,0.03);
    const float D=3.9, F=0.8385;                  // F/D = 0.215, the on-screen radius at z=0

    float yaw  = 0.83 + 0.30*sin(uTime*0.113);    // the ring turns about the vertical
    float pit  = 0.26*sin(uTime*0.071);           // nods towards and away from us
    float rol  = 0.22 + 0.10*sin(uTime*0.047);    // and lists slowly to one side
    float cy=cos(yaw), sy=sin(yaw), cp=cos(pit), sp2=sin(pit), cr=cos(rol), sr=sin(rol);
    // Rz(rol)*Rx(pit)*Ry(yaw), as the two basis vectors spanning the ring's plane
    vec3 e0=vec3(cy*cr - sy*sp2*sr, cy*sr + sy*sp2*cr, -sy*cp);
    vec3 e1=vec3(-cp*sr,            cp*cr,              sp2);

    /* The nebula and haze ride the same ellipse: inverting the 2x2 of the
       projected basis gives e = 1 on the ring and 0 at its centre for ANY
       orientation, which is the general form of the old q.x/0.145 divide. */
    vec2 A=e0.xy*(F/D), B=e1.xy*(F/D), q=p-c;
    float det=A.x*B.y-B.x*A.y;
    det = det>=0.0 ? max(det,0.002) : min(det,-0.002);
    float e=length(vec2(B.y*q.x-B.x*q.y, A.x*q.y-A.y*q.x)/det);
    col += uRing*exp(-pow(abs(e-0.55),1.6)*7.0)*vec3(0.020,0.045,0.085);   // nebula
    col += uRing*exp(-abs(e-1.0)*9.0)*vec3(0.012,0.030,0.060);             // ring haze

    for(int i=0;i<8;i++){
      float a=float(i)/8.0*6.2831853 + uTime*0.30;
      vec3 P=e0*cos(a)+e1*sin(a);
      float sc=D/(D-P.z);                            // near orbs swell...
      float k=1.0/(sc*sc);                           // ...so their falloff widens with them
      vec2 o=P.xy*(F/(D-P.z));
      float od=length(q-o);
      float depth=0.42+0.72*(P.z*0.5+0.5);           // and the far side sinks into the black
      col += uRing*depth*(exp(-od*od*3400.0*k)*vec3(0.95,1.00,1.00)
                        + exp(-od*od*420.0*k)*vec3(0.30,0.55,0.85)
                        + exp(-od*od*45.0*k)*vec3(0.04,0.09,0.16));
    }
  }

  // System Configuration: a bright core with straight beams radiating out of
  // it, like a small sun. The console's shape is radial, not a ribbon — the
  // earlier wavy version was the wrong figure entirely.
  if(uSwirl>0.001){
    vec2 c=vec2(-0.20,0.00);
    vec2 q=p-c;
    float r2=length(q);
    float ang=atan(q.y,q.x);
    // the core
    col += uSwirl*(exp(-r2*r2*900.0)*vec3(0.80,0.95,1.00)*0.32   // a glint, not a star
                 + exp(-r2*r2*60.0)*vec3(0.22,0.55,0.78)*0.16
                 + exp(-r2*r2*4.0)*vec3(0.07,0.18,0.30)*0.22);
    // twelve beams, alternating length, turning slowly
    for(int i=0;i<12;i++){
      float fi=float(i);
      float a0=fi/12.0*6.2831853 + uTime*0.10;
      float da=abs(mod(ang-a0+3.14159265,6.2831853)-3.14159265);
      float len=0.30+0.22*fract(sin(fi*13.7)*43758.5453);
      float along=smoothstep(len,0.0,r2)*smoothstep(0.0,0.03,r2);
      float tight=exp(-da*da*(900.0+700.0*sin(uTime*0.7+fi)));
      col += uSwirl*tight*along*vec3(0.55,0.86,1.00)*0.22;
      col += uSwirl*exp(-da*da*130.0)*along*vec3(0.12,0.30,0.46)*0.07;
    }
  }

  col *= 1.0-0.34*smoothstep(0.30,1.15,length(p));      // vignette
  col *= 1.0-0.030*step(1.0,mod(gl_FragCoord.y,2.0));   // interlace whisper
  frag=vec4(col,1.0);
}`;

const IC_V = `#version 300 es
in vec3 aPos0; in vec3 aPos1; in vec3 aNrm; in vec4 aTint; in vec2 aUV;
uniform mat4 uProj,uView,uModel; uniform float uTween;
out vec3 vN; out vec4 vT; out vec3 vL; out vec2 vUV;
void main(){
  vec3 p=mix(aPos0,aPos1,uTween);
  vN=mat3(uModel)*aNrm;              // normals do NOT morph — same as the PS2
  vT=aTint; vL=p; vUV=aUV;
  gl_Position=uProj*uView*uModel*vec4(p,1.0);
}`;

const IC_F = `#version 300 es
precision highp float;
in vec3 vN; in vec4 vT; in vec3 vL; in vec2 vUV;
uniform vec3 uAmb,uLDir[3],uLCol[3],uColor; uniform float uAlpha,uTexOn,uGrain;
uniform sampler2D uTex;
out vec4 frag;
void main(){
  vec3 n=normalize(vN); vec3 d=vec3(0.0);
  for(int i=0;i<3;i++) d+=max(dot(n,uLDir[i]),0.0)*uLCol[i];
  // vT.a: 0 = own colour, 1 = folder accent, 2 = the application icon
  vec3 base=mix(vT.rgb,uColor,clamp(vT.a,0.0,1.0));
  if(vT.a>1.5){ vec4 t=texture(uTex,vUV); base=mix(uColor*0.62,t.rgb,t.a*uTexOn); }
  vec3 c=(uAmb+d)*base;
  // two octaves of cell noise across the surface, so a face has texture rather
  // than one flat tone; uGrain is near zero for icons, strong for boot blocks
  float h1=fract(sin(dot(floor(vL.xy*26.0+vL.z*13.0),vec2(12.9898,78.233)))*43758.5453);
  float h2=fract(sin(dot(floor(vL.zy*61.0+vL.x*29.0),vec2(39.3468,11.135)))*24634.6345);
  c*=1.0-uGrain*(0.62*h1+0.38*h2)+uGrain*0.34;
  frag=vec4(c,uAlpha);
}`;

const BLUR_F = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uRes,uDir;
out vec4 frag;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec4 s=texture(uSrc,uv)*0.2270270270;
  s+=(texture(uSrc,uv+uDir*1.3846153846)+texture(uSrc,uv-uDir*1.3846153846))*0.3162162162;
  s+=(texture(uSrc,uv+uDir*3.2307692308)+texture(uSrc,uv-uDir*3.2307692308))*0.0702702703;
  frag=s;
}`;

const BLIT_F = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uRes;
out vec4 frag;
void main(){ frag=texture(uSrc,gl_FragCoord.xy/uRes); }`;

/* --------------------------------------------------------------- icon plates */
const GLYPH = {
  pkg:x=>{ x.beginPath(); for(let i=0;i<6;i++){ const a=i/6*Math.PI*2-Math.PI/2;
      x[i?"lineTo":"moveTo"](Math.cos(a)*34,Math.sin(a)*34);} x.closePath(); x.stroke();
    x.beginPath(); x.moveTo(0,-34); x.lineTo(0,4); x.moveTo(0,4); x.lineTo(-29,-13);
    x.moveTo(0,4); x.lineTo(29,-13); x.stroke(); },
  win:x=>{ [[-32,-32],[4,-32],[-32,4],[4,4]].forEach(([a,b])=>x.fillRect(a,b,28,28)); },
  gear:x=>{ x.beginPath(); for(let i=0;i<8;i++){ const a=i/8*Math.PI*2;
      x.moveTo(Math.cos(a)*20,Math.sin(a)*20); x.lineTo(Math.cos(a)*36,Math.sin(a)*36);}
    x.stroke(); x.beginPath(); x.arc(0,0,20,0,7); x.stroke(); },
  app:x=>{ x.lineWidth=6; rr(x,-32,-32,64,64,14); x.stroke();
    [[-14,-14],[6,-14],[-14,6],[6,6]].forEach(([a,b])=>x.fillRect(a,b,10,10)); },
  play:x=>{ x.beginPath(); x.moveTo(-18,-30); x.lineTo(32,0); x.lineTo(-18,30); x.closePath(); x.fill(); },
  down:x=>{ x.beginPath(); x.moveTo(0,-34); x.lineTo(0,12); x.moveTo(-20,-6); x.lineTo(0,14);
    x.lineTo(20,-6); x.stroke(); x.beginPath(); x.moveTo(-30,28); x.lineTo(30,28); x.stroke(); },
  doc:x=>{ x.lineWidth=6; x.beginPath(); x.moveTo(-24,-34); x.lineTo(14,-34); x.lineTo(26,-20);
    x.lineTo(26,34); x.lineTo(-24,34); x.closePath(); x.stroke();
    for(let i=0;i<3;i++){ x.beginPath(); x.moveTo(-14,-4+i*13); x.lineTo(16,-4+i*13); x.stroke(); } },
  disc:x=>{ x.beginPath(); x.arc(0,0,32,0,7); x.stroke();
    x.beginPath(); x.arc(0,0,9,0,7); x.stroke(); x.beginPath(); x.arc(-11,-11,6,0,7); x.fill(); },
  clock:x=>{ x.beginPath(); x.arc(0,0,32,0,7); x.stroke();
    x.beginPath(); x.moveTo(0,-20); x.lineTo(0,2); x.lineTo(17,12); x.stroke(); },
  letter:(x,t)=>{ x.font="700 54px 'Segoe UI',system-ui,sans-serif";
    x.textAlign="center"; x.textBaseline="middle"; x.fillText(t||"?",0,2); }
};
function rr(x,a,b,w,h,r){ x.beginPath(); x.moveTo(a+r,b);
  x.arcTo(a+w,b,a+w,b+h,r); x.arcTo(a+w,b+h,a,b+h,r);
  x.arcTo(a,b+h,a,b,r); x.arcTo(a,b,a+w,b,r); x.closePath(); }

const shadeStr=(rgb,m)=>`rgb(${rgb.map(v=>Math.round(Math.min(255,v*255*m))).join(",")})`;

/* ------------------------------------------------------------ motion layers */
/* Three behaviour layers share one transform: an always-on idle character, a
   copy character while the duplicate morph runs, and a fear character while the
   delete morph runs. Offsets and angles add; scale and spin multiply. A
   behaviour is authored data, so every field is validated before it is used —
   one NaN would otherwise take the whole model off screen. */
const MV = () => ({dx:0,dy:0,dz:0,rx:0,ry:0,rz:0,scale:1,spin:1});
const fnum = v => (Number.isFinite(v) ? v : 0);
function layer(o, fn, t, k){
  if(typeof fn!=="function" || !(k>0)) return o;
  const m = fn(t,k) || {};
  o.dx+=fnum(m.dx); o.dy+=fnum(m.dy); o.dz+=fnum(m.dz);
  o.rx+=fnum(m.rx); o.ry+=fnum(m.ry); o.rz+=fnum(m.rz);
  if(Number.isFinite(m.scale)) o.scale*=Math.max(0.02,m.scale);
  if(Number.isFinite(m.spin))  o.spin *=Math.max(0,m.spin);
  return o;
}
const clamp01 = v => Number.isFinite(v) ? (v<0?0:v>1?1:v) : 0;
const TAU = Math.PI*2;
const wrapPi = a => a - Math.round(a/TAU)*TAU;      // shortest way round

/* Draw a stand-in application icon. Used in preview mode, and as the placeholder
   until the real shell icon arrives from the backend. */
export function drawGlyphIcon(glyph, tintHex, label){
  const S=128, cv=document.createElement("canvas"); cv.width=cv.height=S;
  const x=cv.getContext("2d"), rgb=hex(tintHex);
  const g=x.createLinearGradient(0,0,0,S);
  g.addColorStop(0,shadeStr(rgb,1.30)); g.addColorStop(1,shadeStr(rgb,0.55));
  x.fillStyle=g; rr(x,5,5,S-10,S-10,24); x.fill();
  x.lineWidth=3; x.strokeStyle="rgba(255,255,255,.42)"; x.stroke();
  x.save(); x.translate(S/2,S/2+2);
  x.strokeStyle="#fff"; x.fillStyle="#fff"; x.lineWidth=8;
  x.lineJoin="round"; x.lineCap="round";
  x.shadowColor="rgba(0,0,0,.45)"; x.shadowBlur=6; x.shadowOffsetY=2;
  (GLYPH[glyph]||GLYPH.app)(x,label);
  x.restore();
  return cv;
}

/* ================================================================ renderer */
export function createRenderer(canvas){
  const gl = canvas.getContext("webgl2",{antialias:true,alpha:false});
  if(!gl) return null;

  const sh=(src,t)=>{ const s=gl.createShader(t); gl.shaderSource(s,src); gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog=(v,f)=>{ const p=gl.createProgram(); gl.attachShader(p,sh(v,gl.VERTEX_SHADER));
    gl.attachShader(p,sh(f,gl.FRAGMENT_SHADER)); gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };

  const bgP=prog(BG_V,BG_F), icP=prog(IC_V,IC_F), blurP=prog(BG_V,BLUR_F), blitP=prog(BG_V,BLIT_F);
  const U=(p,n)=>gl.getUniformLocation(p,n);
  const ub={res:U(bgP,"uRes"),time:U(bgP,"uTime"),tl:U(bgP,"uTL"),tr:U(bgP,"uTR"),
            bl:U(bgP,"uBL"),br:U(bgP,"uBR"),glow:U(bgP,"uGlow"),ga:U(bgP,"uGlowAmt"),
            rp:U(bgP,"uRipple"),sp:U(bgP,"uSpark"),ring:U(bgP,"uRing"),sw:U(bgP,"uSwirl")};
  const ui={proj:U(icP,"uProj"),view:U(icP,"uView"),model:U(icP,"uModel"),tween:U(icP,"uTween"),
            amb:U(icP,"uAmb"),ldir:U(icP,"uLDir"),lcol:U(icP,"uLCol"),color:U(icP,"uColor"),
            alpha:U(icP,"uAlpha"),tex:U(icP,"uTex"),texOn:U(icP,"uTexOn"),grain:U(icP,"uGrain")};
  const ubr={src:U(blurP,"uSrc"),res:U(blurP,"uRes"),dir:U(blurP,"uDir")};
  const ubl={src:U(blitP,"uSrc"),res:U(blitP,"uRes")};

  const MESH={};
  const buf=d=>{ const b=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,b);
    gl.bufferData(gl.ARRAY_BUFFER,d,gl.STATIC_DRAW); return b; };
  for(const [k,def] of Object.entries(MESHDEF)){
    const base=def.build(), sp=shapes(base,def);
    MESH[k]={ n:base.pos.length/3, pos:buf(base.pos), nrm:buf(base.nrm),
      tint:buf(base.tint), uv:buf(base.uv),
      idle:buf(sp.inflate), dup:buf(sp.dup), cower:buf(sp.cower), del:buf(sp.del),
      tilt:def.tilt, spin:def.spin, breathe:def.breathe,
      move:def.move, idleMove:def.idle, copyMove:def.copyMove,
      pulse:def.pulse, tintStyle:def.tint,
      fit: k==="bar" ? 1 : 0.95/base.ext };
  }

  /* Spin is integrated here rather than read as an angle. main.js hands over an
     accumulated rotation that only ever grows; multiplying THAT by a behaviour's
     rate multiplier would whip the icon through hundreds of radians the moment
     the multiplier moved. So take its rate, scale the rate, integrate our own
     angle — and start that angle wherever the idle rotation had got to, which
     also kills the pop that used to happen on the first frame of a reaction.

     Coming back the other way, the idle rotation must stay a pure function of
     time (that is what lets "icon animations: off" freeze it by freezing the
     clock), so the leftover angle is carried as a decaying offset instead. It
     takes the short way round, and it is dropped after a delete, where the icon
     under the cursor is no longer the icon that just reacted. */
  const SETTLE = 0.45;                                       // seconds
  const SP = { t:-1, dt:0, on:false, angle:null, prev:0, rate:0,
               mode:"idle", exit:null, offset:null, k:0 };

  const emptyVAO=gl.createVertexArray(), vao=gl.createVertexArray();
  const A=n=>gl.getAttribLocation(icP,n);
  gl.bindVertexArray(vao);
  [A("aPos0"),A("aPos1"),A("aNrm"),A("aTint"),A("aUV")].forEach(l=>gl.enableVertexAttribArray(l));
  gl.bindVertexArray(null);
  function bindMesh(m,target,from){
    gl.bindVertexArray(vao);
    const set=(b,l,n)=>{ gl.bindBuffer(gl.ARRAY_BUFFER,b); gl.vertexAttribPointer(l,n,gl.FLOAT,false,0,0); };
    set(m[from||"pos"],A("aPos0"),3); set(m[target],A("aPos1"),3); set(m.nrm,A("aNrm"),3);
    set(m.tint,A("aTint"),4); set(m.uv,A("aUV"),2);
  }

  const blank=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,blank);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);

  function texFromCanvas(src){
    const t=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,t);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,src);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);   // the source is 256px now
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    return t;
  }

  /* offscreen targets for the focus pull */
  let rtA=null, rtB=null;
  function makeRT(w,h){
    const tex=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    for(const [k,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],
                        [gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D,k,v);
    const db=gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER,db);
    // 24-bit: a 16-bit attachment is where stacked label plates z-fight
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,w,h);
    const fb=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,db);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return {fb,tex,db,w,h};
  }
  function ensureRT(){
    const w=Math.max(2,canvas.width>>1), h=Math.max(2,canvas.height>>1);
    if(rtA && rtA.w===w && rtA.h===h) return;
    for(const rt of [rtA,rtB]) if(rt){ gl.deleteTexture(rt.tex);
      gl.deleteRenderbuffer(rt.db); gl.deleteFramebuffer(rt.fb); }
    rtA=makeRT(w,h); rtB=makeRT(w,h);
  }
  function blurPass(src,dst,dir){
    gl.bindFramebuffer(gl.FRAMEBUFFER,dst.fb);
    gl.viewport(0,0,dst.w,dst.h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(blurP); gl.bindVertexArray(emptyVAO);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,src.tex);
    gl.uniform1i(ubr.src,0); gl.uniform2f(ubr.res,dst.w,dst.h);
    gl.uniform2f(ubr.dir,dir[0],dir[1]);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }

  const LDIR=new Float32Array([0.42,0.66,0.62, -0.68,0.28,0.68, 0.08,-0.86,0.50]);
  const LCOL=new Float32Array([0.86,0.87,0.90, 0.30,0.33,0.40, 0.16,0.15,0.13]);
  const AMB=new Float32Array([0.40,0.40,0.43]);
  const BOOT_AMB=new Float32Array([0.66,0.74,0.92]);
  const BOOT_LDIR=new Float32Array([0.30,0.86,0.42, -0.75,0.20,0.62, 0.10,-0.80,0.58]);
  const BOOT_LCOL=new Float32Array([0.30,0.33,0.42, 0.12,0.14,0.20, 0.04,0.04,0.06]);
  const TOWER=new Float32Array([0.70,0.80,0.98]);
  const CFG_GLASS=new Float32Array([0.86,0.90,1.00]);
  const CFG_ON=new Float32Array([0.42,0.95,1.05]);
  const CFG_AMB=new Float32Array([0.52,0.54,0.66]);
  const CFG_LCOL=new Float32Array([0.75,0.78,0.90, 0.30,0.33,0.45, 0.14,0.15,0.20]);
  const CFG_ON_AMB=new Float32Array([0.42,0.60,0.70]);
  const CFG_ON_LCOL=new Float32Array([0.40,0.60,0.70, 0.20,0.30,0.40, 0.08,0.10,0.14]);
  const CUBE=new Float32Array([0.30,0.38,0.55]);   // faint depth only
  const FOV=0.62, CAMZ=3.9;

  function resize(){
    const dpr=Math.min(window.devicePixelRatio||1,1.75);
    const w=Math.round(canvas.clientWidth*dpr), h=Math.round(canvas.clientHeight*dpr);
    if(canvas.width!==w||canvas.height!==h){ canvas.width=w; canvas.height=h; }
  }

  function background(o){
    gl.viewport(0,0,canvas.width,canvas.height);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(bgP); gl.bindVertexArray(emptyVAO);
    gl.uniform2f(ub.res,canvas.width,canvas.height);
    gl.uniform1f(ub.time,o.time);
    gl.uniform3fv(ub.tl,o.bg[0]); gl.uniform3fv(ub.tr,o.bg[1]);
    gl.uniform3fv(ub.bl,o.bg[2]); gl.uniform3fv(ub.br,o.bg[3]);
    gl.uniform2f(ub.glow,o.glowPos[0],o.glowPos[1]);
    gl.uniform1f(ub.ga,o.glow); gl.uniform1f(ub.rp,o.ripple);
    gl.uniform1f(ub.sp,o.spark); gl.uniform1f(ub.ring,o.ring);
    gl.uniform1f(ub.sw,o.swirl||0);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }

  function setupIcons(asp,amb,ldir,lcol){
    gl.useProgram(icP);
    gl.uniformMatrix4fv(ui.proj,false,persp(FOV,asp,2.0,9.0));
    gl.uniformMatrix4fv(ui.view,false,trans(0,0,-CAMZ));
    gl.uniform3fv(ui.amb,amb||AMB); gl.uniform3fv(ui.ldir,ldir||LDIR); gl.uniform3fv(ui.lcol,lcol||LCOL);
    gl.uniform1i(ui.tex,0); gl.uniform1f(ui.texOn,1);
    gl.uniform1f(ui.grain,0.05);
  }

  /* One opaque draw of one icon. Everything opaque and depth-tested — no alpha
     stacking anywhere, which is what made these read as glass. */
  function drawOne(it, sel, time, asp, halfH){
    const mesh=MESH[it.mesh]||MESH.ssd;
    const acting = sel && sel.mode!=="idle";
    bindMesh(mesh, acting?sel.target:"idle", acting?sel.from:"pos");

    const ph=it.phase||0;
    const mode = acting ? sel.mode : "idle";

    /* Three intensities, one per behaviour layer. Idle yields to whichever
       reaction is running, so the handover is a crossfade, not a cut. */
    const kFear = acting ? Math.max(0, sel.intensity||0) : 0;
    const kCopy = (mode==="copy"||mode==="hoverCopy") ? clamp01(sel.tween) : 0;
    const kIdle = Math.max(0, 1-Math.max(kFear,kCopy));

    // breath: the idle morph curve, one shape per device
    const pulse = PULSE[mesh.pulse] || PULSE.breath;
    const tw = acting ? sel.tween
             : clamp01(pulse(time*(mesh.breathe===undefined?1:mesh.breathe)+ph));

    // behaviour layers: how this device moves. The grid phase staggers the idle
    // so a screenful of the same device never moves in lockstep.
    const mv = MV();
    // Geometry comes from the mesh, but motion and colour can be per ITEM, so
    // two folders drawn as the same device still flinch differently.
    layer(mv, BEHAVIOUR[mesh.idleMove], time+ph*0.61, kIdle);
    layer(mv, BEHAVIOUR[it.copyMove || mesh.copyMove], time, kCopy);
    layer(mv, BEHAVIOUR[it.move     || mesh.move],     time, kFear);

    const idleRate = 0.5*(mesh.spin||0);
    let spin;
    if(acting){
      if(SP.angle===null) SP.angle = time*idleRate+ph;   // pick up the idle pose
      SP.angle += SP.rate*mv.spin*SP.dt;
      spin = SP.angle;
    } else {
      spin = time*idleRate*mv.spin + ph;
      if(sel && SP.exit!==null && SP.k>0){        // ease back onto the idle turn
        if(SP.offset===null) SP.offset = wrapPi(SP.exit-spin);
        spin += SP.offset*SP.k*SP.k*(3-2*SP.k);
      }
    }

    // tint layer: how its colour changes
    let col = it.rgb;
    if(kFear>0) col = (TINT[it.tintStyle || mesh.tintStyle]||TINT.none)(col, Math.min(1,kFear));

    // sel.shrink is the erase collapse: the icon spins down to nothing rather
    // than only fading, which is what the console did
    const sh = (acting && sel.shrink !== undefined) ? Math.max(0, sel.shrink) : 1;
    const s = (it.scale||1)*mesh.fit*mv.scale*sh;
    const model = mul(
      trans(it.x+mv.dx, it.y+mv.dy, mv.dz),
      // mesh.tilt is NEGATED: these tilts were authored against a hand-built
      // matrix whose rotX had the opposite sign. Composed through rotX() a
      // negative tilt turns the labelled +Y face away from the camera, which
      // is why every accent band and every application icon was hidden behind
      // the chassis and the devices looked like featureless dark slabs.
      mul(rotZ(mv.rz), mul(rotX(-mesh.tilt+mv.rx),
        mul(rotY(spin+mv.ry), scale(s,s,s)))));

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, it.tex||blank);
    gl.uniform1f(ui.texOn, it.tex?1:0);
    gl.uniform1f(ui.tween,tw);
    gl.uniform3fv(ui.color,new Float32Array(col));
    gl.uniform1f(ui.alpha, acting?sel.alpha:1);
    gl.uniformMatrix4fv(ui.model,false,model);
    gl.drawArrays(gl.TRIANGLES,0,mesh.n);
  }

  /* items: [{mesh,x,y,scale,rgb,tex,phase}], selIndex, sel = animation state */
  function icons(items, selIndex, sel, time, blurUnselected){
    const asp=canvas.width/Math.max(1,canvas.height);
    const halfH=Math.tan(FOV/2)*CAMZ;

    /* Spin bookkeeping for the reacting icon, done once per frame so it stays
       right even on frames where that icon is culled. A frozen clock (icon
       animations off) yields dt = 0, which stops the integrator dead. */
    SP.dt = (SP.t<0 || time<=SP.t) ? 0 : Math.min(0.05, time-SP.t);
    SP.t  = time;
    const act = sel && sel.mode!=="idle";
    if(act){
      const now = Number.isFinite(sel.spin) ? sel.spin : 0;
      if(!SP.on){ SP.on=true; SP.angle=null; SP.prev=now; SP.exit=null; SP.k=0; }
      let r = SP.dt>0 ? (now-SP.prev)/SP.dt : 0;
      if(!Number.isFinite(r)) r=0;
      SP.rate = Math.max(-40, Math.min(40, r));
      SP.prev = now;
      SP.mode = sel.mode;
    } else {
      if(SP.on){                                  // the frame the reaction ends
        SP.exit = (SP.mode==="delete" || SP.angle===null) ? null : SP.angle;
        SP.offset=null; SP.k=1; SP.on=false; SP.angle=null; SP.rate=0;
      }
      if(SP.exit!==null && (SP.k-=SP.dt/SETTLE) <= 0){
        SP.exit=null; SP.offset=null; SP.k=0;
      }
    }
    if(blurUnselected){
      ensureRT();
      gl.bindFramebuffer(gl.FRAMEBUFFER,rtA.fb);
      gl.viewport(0,0,rtA.w,rtA.h);
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST);
      setupIcons(asp);
      items.forEach((it,i)=>{ if(i!==selIndex) drawOne(it,null,time,asp,halfH); });
      blurPass(rtA,rtB,[3.0/rtA.w,0]); blurPass(rtB,rtA,[0,3.0/rtA.h]);

      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);  // premultiplied
      gl.useProgram(blitP); gl.bindVertexArray(emptyVAO);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,rtA.tex);
      gl.uniform1i(ubl.src,0); gl.uniform2f(ubl.res,canvas.width,canvas.height);
      gl.drawArrays(gl.TRIANGLES,0,3);

      gl.clear(gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      setupIcons(asp);
      if(items[selIndex]) drawOne(items[selIndex],sel,time,asp,halfH);
    } else {
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.enable(gl.DEPTH_TEST); gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      setupIcons(asp);
      items.forEach((it,i)=>drawOne(it, i===selIndex?sel:null, time, asp, halfH));
    }
    gl.bindVertexArray(null);
  }

  /* The void: towers of light rising out of blue mist, with dark glass cubes
     drifting among them at varying sizes and depths. One tower per item, height
     by value. No items, no towers — just the void, exactly as an empty memory
     card produced on the console.

     opts: { camZ, tilt, grow }   grow = 0..1 reveal of each tower */
  function voidScene(list, t, opts){
    const o = opts || {};
    const camZ = o.camZ === undefined ? 5.7 : o.camZ;
    const tilt = o.tilt || 0;
    const asp = canvas.width/Math.max(1,canvas.height);
    const maxV = list.length ? Math.max(...list.map(s=>s.value)) : 1;
    // Bird's-eye. rotX(+a) pitches the world so the tops of the towers face
    // the camera; the small negative tilt this had was an eye-level view.
    // The console's opening rolls CLOCKWISE as it drives forward. Roll is
    // applied to the view, so the whole field turns together rather than each
    // block spinning on its own.
    const roll = o.roll || 0;
    // camY rides the camera up or down the towers; at bird's-eye the height
    // matters more than the distance for how close the tops feel
    const camY = o.camY === undefined ? -0.10 : o.camY;
    const view = mul(trans(0,camY,-camZ), mul(rotZ(roll), rotX(tilt)));

    gl.enable(gl.DEPTH_TEST); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(icP);
    gl.uniformMatrix4fv(ui.proj,false,persp(FOV,asp,1.0,40.0));
    gl.uniformMatrix4fv(ui.view,false,view);
    gl.uniform3fv(ui.amb,BOOT_AMB); gl.uniform3fv(ui.ldir,BOOT_LDIR); gl.uniform3fv(ui.lcol,BOOT_LCOL);
    gl.uniform1f(ui.tween,0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,blank);
    gl.uniform1i(ui.tex,0); gl.uniform1f(ui.texOn,0);
    const m=MESH.bar; bindMesh(m,"idle");

    /* A dense field of pale blocks thrown out around the centre — cubes and
       long slabs at every depth, so driving forward makes them stream past the
       edges. Three lonely towers on a navy ground was the wrong picture. */
    /* A handful of faint blocks for depth only. The dense grainy field buried
       the towers, which are the actual subject — they are the drive data. */
    gl.uniform3fv(ui.color,CUBE);
    gl.uniform1f(ui.grain,0.10);
    for(let i=0;i<7;i++){
      const B=blockAt(i,t);
      if(B.fade<=0.02) continue;
      gl.uniform1f(ui.alpha,B.fade);
      gl.uniformMatrix4fv(ui.model,false,
        mul(trans(B.x,B.y,B.z),
        mul(rotY(B.spinY), mul(rotX(B.spinX), scale(B.s,B.s,B.s)))));
      gl.drawArrays(gl.TRIANGLES,0,m.n);
    }

    gl.uniform1f(ui.grain,0.03);
    gl.uniform3fv(ui.color,TOWER);
    /* Tall pale columns with a soft aura — one per drive, height by how full it
       is. This is the version that worked; only the camera needed moving. */
    list.forEach((s,i)=>{
      const grow = s.grow !== undefined ? s.grow
                 : Math.max(0,Math.min(1,(t-0.4-i*0.17)/0.85));
      if(grow<=0) return;
      const T=towerAt(i,list.length);
      const tx=T.x, tz=T.z;
      const H=(0.5+2.9*Math.pow(s.value/maxV,0.55))*grow;
      const fade=Math.max(0.16,Math.min(1,1-(-tz)/9.5));
      const cy=-1.35+H/2;
      gl.uniform1f(ui.alpha,fade*0.92);
      gl.uniformMatrix4fv(ui.model,false,mul(trans(tx,cy,tz),scale(0.10,H/2,0.10)));
      gl.drawArrays(gl.TRIANGLES,0,m.n);
      gl.uniform1f(ui.alpha,fade*0.16);          // the aura around each column
      gl.uniformMatrix4fv(ui.model,false,mul(trans(tx,cy,tz),scale(0.26,H/2*1.01,0.26)));
      gl.drawArrays(gl.TRIANGLES,0,m.n);
    });
    gl.bindVertexArray(null);
  }

  /* Glass cubes drifting in front of the violet field. One per setting: the
     selected row's cube lights up, which is how the console showed you where
     you were before it showed you the words. */
  function configCubes(count, sel, t){
    const asp=canvas.width/Math.max(1,canvas.height);
    gl.enable(gl.DEPTH_TEST); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(icP);
    gl.uniform1f(ui.grain,0.04);        // glass is smooth; the grain is for boot
    gl.uniformMatrix4fv(ui.proj,false,persp(FOV,asp,1.0,30.0));
    gl.uniformMatrix4fv(ui.view,false,trans(0,0,-4.2));
    gl.uniform3fv(ui.ldir,LDIR); gl.uniform1f(ui.tween,0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,blank);
    gl.uniform1i(ui.tex,0); gl.uniform1f(ui.texOn,0);
    const m=MESH.glass; bindMesh(m,"idle");

    /* Glass, not painted blocks: the faces have to be see-through. Depth writes
       off and drawn far-to-near so cubes layer over each other properly, which
       is what actually sells it — an opaque cube with a light frame just reads
       as a box. */
    const cubes=[];
    for(let i=0;i<count;i++){
      const a=Math.sin(i*12.9898)*43758.5453, b=Math.sin(i*78.233)*43758.5453;
      const fa=a-Math.floor(a), fb=b-Math.floor(b);
      const ang=(i/Math.max(1,count))*Math.PI*2 + t*0.06;
      const rad=0.62+fa*0.55;
      cubes.push({ i,
        x:-1.05+Math.cos(ang)*rad*1.15,
        y:Math.sin(ang)*rad*0.85,
        z:-0.6-fb*1.6,
        s:0.13+fa*0.10, fb });
    }
    cubes.sort((p,q)=>p.z-q.z);                       // farthest first

    gl.depthMask(false);
    for(const c of cubes){
      const on = c.i===sel;
      const M = mul(trans(c.x,c.y,c.z),
                mul(rotY(t*0.22+c.i), mul(rotX(t*0.15+c.fb*3.0), scale(c.s,c.s,c.s))));
      gl.uniform3fv(ui.amb, on ? CFG_ON_AMB : CFG_AMB);
      gl.uniform3fv(ui.lcol, on ? CFG_ON_LCOL : CFG_LCOL);
      gl.uniform3fv(ui.color, on ? CFG_ON : CFG_GLASS);
      // two passes: a faint solid body, then the bright edges over it
      gl.uniform1f(ui.alpha, on ? 0.34 : 0.22);
      gl.uniformMatrix4fv(ui.model,false,M);
      gl.drawArrays(gl.TRIANGLES,0,m.n);
      gl.uniform1f(ui.alpha, on ? 0.80 : 0.46);
      gl.uniformMatrix4fv(ui.model,false,
        mul(trans(c.x,c.y,c.z),
        mul(rotY(t*0.22+c.i), mul(rotX(t*0.15+c.fb*3.0), scale(c.s*1.015,c.s*1.015,c.s*1.015)))));
      gl.drawArrays(gl.TRIANGLES,0,m.n);
      if(on){
        gl.uniform1f(ui.alpha,0.16);
        gl.uniformMatrix4fv(ui.model,false,
          mul(trans(c.x,c.y,c.z),
          mul(rotY(t*0.22+c.i), mul(rotX(t*0.15+c.fb*3.0), scale(c.s*1.9,c.s*1.9,c.s*1.9)))));
        gl.drawArrays(gl.TRIANGLES,0,m.n);
      }
    }
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  const halfH=()=>Math.tan(FOV/2)*CAMZ;
  const aspect=()=>canvas.width/Math.max(1,canvas.height);

  return { gl, resize, background, icons, voidScene, configCubes, texFromCanvas, halfH, aspect,
           MESH, blank };
}
