/* Synthesised, not sampled. The console's audio is Sony's, but the *design* is
   documented: a deep hit, a pad, a twinkling chime and a noise swoosh under a
   long reverb, aiming at "a monolith floating in space". Rebuilding that from
   oscillators is legal to ship and, unlike a sample, tunable. */

export const Sound = {
  ctx:null, master:null, verb:null, on:false, amb:null,

  init(){
    if(this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return false;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    const sr=this.ctx.sampleRate, len=Math.floor(sr*2.8);
    const buf=this.ctx.createBuffer(2,len,sr);
    for(let ch=0;ch<2;ch++){ const d=buf.getChannelData(ch);
      for(let i=0;i<len;i++){ const t=i/len; d[i]=(Math.random()*2-1)*Math.pow(1-t,2.7); } }
    this.verb=this.ctx.createConvolver(); this.verb.buffer=buf;
    const wet=this.ctx.createGain(); wet.gain.value=0.85;
    this.verb.connect(wet); wet.connect(this.master);
    return true;
  },

  enable(v){
    this.on = v;
    if(!v) this.ambience(false);
    if(v){ this.init(); if(this.ctx && this.ctx.state==="suspended") this.ctx.resume(); }
    return this.on;
  },

  bus(send){
    const g=this.ctx.createGain(); g.connect(this.master);
    if(send>0){ const s=this.ctx.createGain(); s.gain.value=send; g.connect(s); s.connect(this.verb); }
    return g;
  },

  tone(type,f0,f1,t0,dur,peak,send,attack){
    const c=this.ctx, o=c.createOscillator(), g=this.bus(send);
    o.type=type; o.frequency.setValueAtTime(f0,t0);
    if(f1!==f0) o.frequency.exponentialRampToValueAtTime(Math.max(1,f1),t0+dur);
    const a=attack===undefined?0.008:attack;
    g.gain.setValueAtTime(0.0001,t0);
    g.gain.exponentialRampToValueAtTime(peak,t0+a);
    g.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
    o.connect(g); o.start(t0); o.stop(t0+dur+0.05);
  },

  noise(t0,dur,peak,f0,f1,send){
    const c=this.ctx, sr=c.sampleRate, n=Math.floor(sr*dur);
    const b=c.createBuffer(1,n,sr), d=b.getChannelData(0);
    for(let i=0;i<n;i++) d[i]=Math.random()*2-1;
    const src=c.createBufferSource(); src.buffer=b;
    const bp=c.createBiquadFilter(); bp.type="bandpass"; bp.Q.value=0.8;
    bp.frequency.setValueAtTime(f0,t0);
    bp.frequency.exponentialRampToValueAtTime(f1,t0+dur);
    const g=this.bus(send);
    g.gain.setValueAtTime(0.0001,t0);
    g.gain.exponentialRampToValueAtTime(peak,t0+dur*0.35);
    g.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
    src.connect(bp); bp.connect(g); src.start(t0); src.stop(t0+dur+0.05);
  },

  /* WebView2 hands back a SUSPENDED context when it is created before any user
     gesture. Scheduling onto it silently does nothing, and by the time the
     context is resumed those start times are in the past — so the chime was
     being armed and then thrown away. Resume FIRST, schedule after. */
  boot(){
    if(!this.on || !this.init()) return;
    if(this.ctx.state === "suspended"){
      this.ctx.resume().then(() => this.playBoot()).catch(() => {});
      return;
    }
    this.playBoot();
  },

  playBoot(){
    const t=this.ctx.currentTime+0.05;
    this.tone("sine",     62,32, t,      2.6, 0.55, 0.9);      // the deep hit
    this.tone("triangle", 96,44, t+0.01, 1.1, 0.20, 0.6);
    this.noise(t+0.10, 1.7, 0.10, 500, 4200, 0.8);             // swoosh
    [110,164.8,220,277.2].forEach((f,i)=>                      // pad, slow swell
      this.tone("sawtooth",f,f,t+0.45+i*0.05,3.4,0.045,0.7,1.3));
    [1046.5,1568,2093,3136].forEach((f,i)=>                    // twinkling chime
      this.tone("sine",f,f,t+1.45+i*0.10,2.4,0.075,1.0,0.006));
    [2637,3951].forEach((f,i)=>
      this.tone("sine",f,f,t+2.65+i*0.13,1.9,0.045,1.0,0.006));
  },

  /* The main menu's ambience: surf, a long way off. Pink noise through a low
     pass, with two very slow LFOs on the gain and one on the cutoff so swells
     arrive at an irregular interval rather than a countable loop. Kept quiet
     enough to sit under everything — it should register as room tone, not as a
     sound effect. */
  ambience(on){
    if(!on){
      if(this.amb){
        const g = this.amb.gain, t = this.ctx.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0.0001, t + 1.1);
        const dead = this.amb; this.amb = null;
        setTimeout(() => { try{ dead.src.stop(); dead.l1.stop(); dead.l2.stop(); dead.l3.stop(); }catch{} }, 1400);
      }
      return;
    }
    if(!this.on || !this.init() || this.amb) return;
    if(this.ctx.state === "suspended"){ this.ctx.resume().catch(()=>{}); }
    const c = this.ctx, len = Math.floor(c.sampleRate * 8);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for(let ch = 0; ch < 2; ch++){
      const d = buf.getChannelData(ch);
      let b0=0,b1=0,b2=0;
      for(let i = 0; i < len; i++){
        const w = Math.random()*2-1;                 // pink-ish: surf is not white
        b0 = 0.99765*b0 + w*0.0990460;
        b1 = 0.96300*b1 + w*0.2965164;
        b2 = 0.57000*b2 + w*1.0526913;
        d[i] = (b0+b1+b2+w*0.1848) * 0.11;
      }
    }
    const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
    const lp = c.createBiquadFilter(); lp.type = "lowpass";
    lp.frequency.value = 480; lp.Q.value = 0.5;
    const gain = c.createGain(); gain.gain.value = 0.030;

    const mk = (hz, depth, target) => {
      const o = c.createOscillator(); o.frequency.value = hz;
      const g = c.createGain(); g.gain.value = depth;
      o.connect(g); g.connect(target); o.start();
      return o;
    };
    const l1 = mk(0.055, 0.022, gain.gain);          // the long swell
    const l2 = mk(0.031, 0.013, gain.gain);          // beating against it
    const l3 = mk(0.043, 190,   lp.frequency);       // spray on the crest

    src.connect(lp); lp.connect(gain);
    gain.connect(this.master);
    const send = c.createGain(); send.gain.value = 0.55;
    gain.connect(send); send.connect(this.verb);
    src.start();

    // fade up, so arriving at the menu does not click
    const t = c.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.030, t + 2.2);
    this.amb = { src, gain, l1, l2, l3 };
  },

  ui(f0,f1,peak,dur){
    if(!this.on || !this.init()) return;
    if(this.ctx.state === "suspended"){ this.ctx.resume().catch(() => {}); return; }
    this.tone("sine",f0,f1,this.ctx.currentTime+0.001,dur||0.09,peak||0.10,0.25);
  },
  move(){ this.ui(760,760,0.055,0.05); },
  enter(){ this.ui(620,940,0.09,0.13); },
  back(){ this.ui(520,330,0.08,0.13); },
  erase(){
    if(!this.on || !this.init()) return;
    const t=this.ctx.currentTime+0.001;
    this.noise(t,0.55,0.13,2600,220,0.7);
    this.tone("sine",150,48,t,0.7,0.28,0.8);
  }
};
