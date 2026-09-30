'use strict';
// Local-only rendering. No credentials, network requests, source audio, or synthetic gameplay.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const ROOT='/home/node/.n8n-files';
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'review-config.json')));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,Number(v)));
const round=v=>Math.round(v*1000)/1000;
const fraction=v=>{const [a,b]=String(v||'0').split('/').map(Number);return b?a/b:a;};
const tokens=s=>String(s||'').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
const clean=s=>String(s||'').replace(/[{}\\]/g,'').replace(/\r?\n/g,' ').trim();
function run(bin,args,opts={}){return execFileSync(bin,args,{encoding:'utf8',maxBuffer:32*1024*1024,timeout:900000,...opts});}
const ff=args=>run('ffmpeg',['-nostdin','-hide_banner','-y',...args]);
const probe=file=>JSON.parse(run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]));
function safeFile(p){const real=fs.realpathSync(p);if(!real.startsWith(ROOT+'/'))throw Error('Media path outside project mount');return real;}
const save=(p,o)=>fs.writeFileSync(p,JSON.stringify(o,null,2));
function loudness(file){const p=spawnSync('ffmpeg',['-hide_banner','-i',file,'-af','loudnorm=I=-15:TP=-1:LRA=9:print_format=json','-f','null','-'],{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});if(p.status!==0)throw Error('Loudness measurement failed');const matches=p.stderr.match(/\{\s*"input_i"[\s\S]*?\}/g);if(!matches)throw Error('No loudness measurement');return JSON.parse(matches.at(-1));}
// Generic short-form ending safety net (2026-09-09): a user-reported final sentence that felt cut
// off traced back to the narration having no *guaranteed* trailing beat before the hard duration
// cutoff -- the fit math left only whatever slack happened to remain, not a deliberately reserved
// pause. This measures the actual last moment of detected speech in the finished mux and requires
// a real minimum gap before the video ends, catching a rushed/cut-feeling ending regardless of
// which script produced it, rather than trusting the tempo-fit arithmetic alone.
function lastSpeechEnd(file){const p=spawnSync('ffmpeg',['-hide_banner','-i',file,'-af','silencedetect=noise=-30dB:d=0.05','-f','null','-'],{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});const starts=[...p.stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map(m=>Number(m[1]));return starts.length?starts[starts.length-1]:0;}
function imageScore(file){
 // Samples two points per clip (not just one) so a dark/blank/loading moment anywhere in the
 // clip is caught, not only a mean computed from a single early frame.
 const p=probe(file),v=p.streams.find(s=>s.codec_type==='video');if(!v)throw Error('Missing video stream');
 const duration=Number(p.format.duration);
 const samplePoints=[.25,.7].map(f=>Math.min(duration*.9,Math.max(.1,duration*f)));
 let sum=0,sq=0,dark=0,n=0,minMean=Infinity,maxDark=0;
 for(const at of samplePoints){
  const raw=run('ffmpeg',['-v','error','-ss',String(at),'-i',file,'-vf','scale=96:54,format=gray','-frames:v','1','-f','rawvideo','-'],{encoding:null});
  if(!raw.length)continue;
  let s=0,sqf=0,d=0;for(const x of raw){s+=x;sqf+=x*x;if(x<18)d++;}
  const m=s/raw.length,df=d/raw.length;
  sum+=s;sq+=sqf;dark+=d;n+=raw.length;minMean=Math.min(minMean,m);maxDark=Math.max(maxDark,df);
 }
 if(!n)throw Error('Cannot inspect frame');
 const mean=sum/n,contrast=Math.sqrt(Math.max(0,sq/n-mean*mean)),dark_fraction=Math.max(dark/n,maxDark);
 const darkPenalty=clamp((dark_fraction-.3)/.55,0,1)*60,flatPenalty=contrast<7?25:0,minMeanPenalty=minMean<10?20:0;
 const visual_score=clamp(mean/110,0,1)*35+clamp(contrast/60,0,1)*35-darkPenalty-flatPenalty-minMeanPenalty;
 return {duration,width:v.width,height:v.height,fps:fraction(v.avg_frame_rate||v.r_frame_rate),mean,contrast,dark_fraction,visual_score};
}

function makeMusic(file,duration,music={},seedText='original-review-bed'){
 // Original composition and synthesis: no recordings, third-party samples or borrowed melodies.
 const sr=48000,frames=Math.ceil(duration*sr),data=Buffer.alloc(frames*4);let seed=crypto.createHash('sha256').update(seedText).digest().readUInt32LE(0);
 const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
 const energy=clamp(music.energy??.45,.1,.85),tempo=clamp(music.tempo_bpm||90,55,140),beat=60/tempo,mood=String(music.mood||'restrained electronic').toLowerCase();
 // Mood drives scale, harmonic content, kick hardness and rhythmic density so different genres of
 // game (aggressive shooter vs. somber narrative vs. heroic adventure) get audibly different beds,
 // instead of only a binary dark/calm split. Still pure local additive synthesis, no samples.
 const profiles=[
  {test:/metal|industrial|aggressive|brutal|combat|heavy/,root:36,scale:[0,3,6,7,10],kickAmp:1.5,kickSharp:34,hatAmp:1.6,harm2:.55,harm3:.35,eventProb:1.15},
  {test:/horror|dread|dark|tension|tense|ominous|eerie|survival/,root:38,scale:[0,1,3,7,8],kickAmp:.6,kickSharp:16,hatAmp:.5,harm2:.3,harm3:.5,eventProb:.6},
  {test:/melancholic|somber|sad|emotional|narrative|tragic|quiet|reflective|mournful/,root:41,scale:[0,2,3,7,9],kickAmp:.15,kickSharp:10,hatAmp:.25,harm2:.25,harm3:.12,eventProb:.5},
  {test:/adventurous|heroic|upbeat|hopeful|triumphant|epic|orchestral/,root:45,scale:[0,2,4,7,9],kickAmp:.9,kickSharp:24,hatAmp:.9,harm2:.42,harm3:.22,eventProb:1},
 ];
 const profile=profiles.find(p=>p.test.test(mood))||{root:45,scale:[0,2,4,7,9],kickAmp:.7,kickSharp:24,hatAmp:.7,harm2:.42,harm3:.22,eventProb:1};
 const {root,scale,kickAmp,kickSharp,hatAmp,harm2,harm3,eventProb}=profile,progression=[0,3,1,4];
 const events=[];for(let t=0;t<duration;t+=beat/2)if(rnd()<(.5+energy*.35)*eventProb)events.push({start:t,duration:beat*(.7+rnd()),freq:440*2**((root+24+scale[Math.floor(rnd()*scale.length)]-69)/12),amp:.035+energy*.025,pan:rnd()*.8-.4});
 let ei=0,active=[];for(let i=0;i<frames;i++){const t=i/sr,base=440*2**((root+scale[progression[Math.floor(t/(beat*4))%4]]-69)/12),fade=Math.max(0,Math.min(1,t/1.2,(duration-t)/2.2));
 let l=0,r=0;const pad=.045*(Math.sin(2*Math.PI*base*t)+harm2*Math.sin(2*Math.PI*base*1.5*t)+harm3*Math.sin(2*Math.PI*base*2.005*t));l+=pad;r+=pad*.96;
 const phase=t%beat,kick=.07*energy*kickAmp*Math.exp(-phase*kickSharp)*Math.sin(2*Math.PI*(48*phase+1.5*(1-Math.exp(-phase*30))));l+=kick;r+=kick;
 const hat=(rnd()*2-1)*.012*energy*hatAmp*Math.exp(-(t%(beat/2))*70);l+=hat;r-=hat*.8;
 while(ei<events.length&&events[ei].start<=t)active.push(events[ei++]);active=active.filter(e=>t-e.start<e.duration);
 for(const e of active){const age=t-e.start,env=Math.min(1,age/.012)*Math.exp(-age*4/e.duration),tone=e.amp*env*(Math.sin(2*Math.PI*e.freq*age)+.18*Math.sin(2*Math.PI*e.freq*2*age));l+=tone*(.7-e.pan/2);r+=tone*(.7+e.pan/2);}
 data.writeInt16LE(Math.round(clamp(l*fade,-.9,.9)*32767),i*4);data.writeInt16LE(Math.round(clamp(r*fade,-.9,.9)*32767),i*4+2);}
 const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+data.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(2,22);h.writeUInt32LE(sr,24);h.writeUInt32LE(sr*4,28);h.writeUInt16LE(4,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);fs.writeFileSync(file,Buffer.concat([h,data]));
 return {source:'original_procedural_synthesis',path:file,mood,energy,tempo_bpm:tempo,third_party_samples:false,external_service:false,rights:'Original algorithmic composition synthesized locally; no third-party audio or borrowed melody.',seed:seedText};
}
function assTime(n){n=Math.max(0,n);return `${Math.floor(n/3600)}:${String(Math.floor(n/60)%60).padStart(2,'0')}:${(n%60).toFixed(2).padStart(5,'0')}`;}
function srtTime(n){const ms=Math.round(Math.max(0,n)*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;}
function markPunctuationBoundaries(words,scriptText){
 // Whisper's word-level timestamps strip terminal punctuation (periods/commas), so matching
 // /[.!?;:,]$/ against the transcribed words themselves never fires. Instead walk the ORIGINAL
 // punctuated script text (exactly what was sent to TTS) and align it against the transcribed
 // words.
 //
 // This is a global longest-common-subsequence alignment, not a narrow forward-search cursor
 // (which this function used until 2026-09-12). The forward-search version derailed permanently
 // whenever a real stretch of consecutive words went unmatched nearby -- found in production on a
 // long-form narration where Whisper's own transcription silently dropped two real, clearly-spoken
 // script words ("back half"), verified against the actual audio via direct Gemini transcription
 // before concluding the miss was Whisper's, not the narration's. Once that happened, the cursor
 // permanently lost sync for the rest of the ~10-minute document: every subsequent sentence-ending
 // period had roughly a 1-in-20 chance of falling inside the narrow lookahead window at all, so a
 // large fraction of real sentence boundaries afterward silently stopped being detected, producing
 // caption lines that ran multiple whole sentences together. A single missed word is not a corner
 // case for real ASR output over minutes of speech -- it is the expected common case -- so the
 // alignment itself needs to tolerate it globally rather than assume near-perfect 1:1 sequencing.
 // LCS finds the best whole-document alignment even with scattered gaps on either side, and never
 // gets stuck: a handful of skipped words costs a little alignment length, not the rest of the
 // document. Cost: O(scriptTokens x words) time/memory, a few million cells even for a ~10 minute
 // script -- trivial in practice (well under a second).
 const norm=s=>String(s||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
 const scriptTokens=String(scriptText||'').split(/\s+/).filter(Boolean);
 const sentenceEnd=new Set(),clauseEnd=new Set();
 const n=scriptTokens.length,m=words.length;
 if(!n||!m)return {sentenceEnd,clauseEnd};
 const sNorm=scriptTokens.map(norm),wNorm=words.map(w=>norm(w.word));
 const dp=new Array(n+1);for(let i=0;i<=n;i++)dp[i]=new Uint16Array(m+1);
 for(let i=1;i<=n;i++){
  const si=sNorm[i-1],dpPrev=dp[i-1],dpCur=dp[i];
  for(let j=1;j<=m;j++)dpCur[j]=(si&&si===wNorm[j-1])?dpPrev[j-1]+1:Math.max(dpPrev[j],dpCur[j-1]);
 }
 let i=n,j=m;
 while(i>0&&j>0){
  if(sNorm[i-1]&&sNorm[i-1]===wNorm[j-1]&&dp[i][j]===dp[i-1][j-1]+1){
   const tok=scriptTokens[i-1];
   if(/[.!?]$/.test(tok))sentenceEnd.add(j-1);
   else if(/,$/.test(tok))clauseEnd.add(j-1);
   i--;j--;
  }else if(dp[i-1][j]>=dp[i][j-1])i--;
  else j--;
 }
 return {sentenceEnd,clauseEnd};
}
function alignSegments(words,segments){
 // Aligns an ordered list of {text,...} segments (e.g. one per sentence) covering the script to
 // real word timestamps, so finer-than-section semantic matching can know WHEN each specific
 // sentence is actually spoken.
 //
 // Global LCS alignment against ALL segments' tokens at once (same technique and same reason as
 // markPunctuationBoundaries, fixed 2026-09-12 for the same underlying issue): a forward-search
 // cursor that walks segment-by-segment permanently loses sync the first time a real transcription
 // gap or word-count mismatch occurs, silently misaligning (or, before an earlier guard, crashing
 // on) every segment after it. Aligning the whole document in one pass means a gap costs only the
 // segment(s) touching it, never the rest.
 const norm=s=>String(s||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
 const flat=[];segments.forEach((seg,si)=>{for(const t of String(seg.text||'').split(/\s+/).filter(Boolean))flat.push({segIdx:si,norm:norm(t)});});
 const results=segments.map(seg=>({...seg,start:null,end:null}));
 const n=flat.length,m=words.length;
 if(!n||!m)return results;
 const wNorm=words.map(w=>norm(w.word));
 const dp=new Array(n+1);for(let i=0;i<=n;i++)dp[i]=new Uint16Array(m+1);
 for(let i=1;i<=n;i++){
  const fi=flat[i-1].norm,dpPrev=dp[i-1],dpCur=dp[i];
  for(let j=1;j<=m;j++)dpCur[j]=(fi&&fi===wNorm[j-1])?dpPrev[j-1]+1:Math.max(dpPrev[j],dpCur[j-1]);
 }
 let i=n,j=m;
 const perSeg=segments.map(()=>({min:Infinity,max:-Infinity}));
 while(i>0&&j>0){
  if(flat[i-1].norm&&flat[i-1].norm===wNorm[j-1]&&dp[i][j]===dp[i-1][j-1]+1){
   const si=flat[i-1].segIdx,wj=j-1;
   if(wj<perSeg[si].min)perSeg[si].min=wj;
   if(wj>perSeg[si].max)perSeg[si].max=wj;
   i--;j--;
  }else if(dp[i-1][j]>=dp[i][j-1])i--;
  else j--;
 }
 return results.map((r,si)=>{const p=perSeg[si];return p.max===-Infinity?r:{...r,start:words[p.min].start,end:words[p.max].end};});
}
function deriveBeats(sections){
 // Prefer LLM-supplied per-sentence visual_beats (finer semantic matching); fall back to one beat
 // per sentence inheriting the whole section's visual_keywords for older/incomplete manifests, so
 // this degrades gracefully rather than breaking on missing data.
 const beats=[];
 for(const s of sections){
  if(Array.isArray(s.visual_beats)&&s.visual_beats.length){
   for(const b of s.visual_beats)if(b&&b.text)beats.push({text:b.text,visual_keywords:b.visual_keywords||s.visual_keywords||[],category:b.category||'',section:s.id});
  }else{
   const sentences=String(s.script||'').match(/[^.!?]+[.!?]*/g)||[s.script||''];
   for(const sent of sentences){const t=sent.trim();if(t)beats.push({text:t,visual_keywords:s.visual_keywords||[],category:'',section:s.id});}
  }
 }
 return beats;
}
function captions(m,dir,speed,lead,width,height){
 // Whisper's word-level API occasionally emits zero-width timestamps (start===end) for a word,
 // especially short/quickly-spoken ones -- give those a small nominal duration instead of letting
 // the w.end>w.start check silently drop the word (and its content) from the captions entirely.
 const words=m.transcription.words.map(w=>{const start=lead+Number(w.start)/speed;let end=lead+Number(w.end)/speed;if(!(end>start))end=start+.08/speed;return {word:clean(w.word),start,end};}).filter(w=>w.word&&Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.end>w.start);if(!words.length)throw Error('Word timestamps required');words.forEach((w,i)=>w.idx=i);
 // Break on sentence/clause boundaries (punctuation, commas, conjunctions) rather than a fixed
 // word count, so captions read as natural phrases instead of arbitrarily chopped fragments.
 const {sentenceEnd,clauseEnd}=markPunctuationBoundaries(words,m.script||'');
 const breakWords=new Set(['and','but','or','so','because','which','while','though','yet','when','if']);
 const groups=[];let g=[];
 for(let i=0;i<words.length;i++){
  g.push(words[i]);
  const text=g.map(x=>x.word).join(' ');
  const endsSentence=sentenceEnd.has(i);
  const endsClause=g.length>=4&&clauseEnd.has(i);
  const nextWord=words[i+1]?words[i+1].word.replace(/[^\p{L}\p{N}']/gu,'').toLowerCase():'';
  const beforeConjunction=g.length>=4&&breakWords.has(nextWord);
  const tooLong=g.length>=9||text.length>42;
  if(endsSentence||endsClause||beforeConjunction||tooLong||i===words.length-1){groups.push(g);g=[];}
 }
 // Merge any lone-word group into the previous one whenever the combined line still fits
 // comfortably -- a single stranded word looks awkward on screen whether or not it happens to be
 // a genuine sentence end (e.g. a word landing just past the length cap right before a period).
 // This can happen anywhere in the sequence, not only at the very end, so sweep the whole array.
 for(let i=groups.length-1;i>=1;i--){
  if(groups[i].length!==1)continue;
  const orphanText=groups[i][0].word,prevText=groups[i-1].map(w=>w.word).join(' ');
  if((prevText+' '+orphanText).length<=60){groups[i-1].push(...groups[i]);groups.splice(i,1);}
 }
 let ass=`[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${Math.round(height*.042)},&H00FFFFFF,&H00FFFFFF,&H00101010,&H70101010,-1,0,0,0,100,100,0,0,1,2.5,1,2,150,150,${Math.round(height*.14)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`,srt='';
 const cap=[],emph=new Set(m.review.sections.flatMap(s=>s.visual_keywords||[]).flatMap(tokens));
 groups.forEach((items,i)=>{const start=Math.max(0,items[0].start),end=Math.min(m.target_video_duration_sec,Math.max(start+.2,items.at(-1).end+.05));if(end<=start)return;const text=items.map(w=>w.word).join(' ');srt+=`${i+1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n\n`;const styled=items.map(w=>tokens(w.word).some(t=>emph.has(t))?`{\\c&H004CE8FF&}${w.word}{\\c&H00FFFFFF&}`:w.word).join(' ');ass+=`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,{\\fad(60,80)}${styled}\n`;cap.push({start,end,text});});
 const assPath=path.join(dir,'captions.ass'),srtPath=path.join(dir,'captions.srt');fs.writeFileSync(assPath,ass);fs.writeFileSync(srtPath,srt);save(path.join(dir,'captions.json'),cap);
 const counts=m.review.sections.map(s=>tokens(s.script).length),sum=counts.reduce((a,b)=>a+b,0);let cursor=0;
 const sections=m.review.sections.map((s,i)=>{const begin=Math.min(words.length-1,Math.round(cursor/sum*words.length));cursor+=counts[i];const finish=Math.min(words.length-1,Math.max(begin,Math.round(cursor/sum*words.length)-1));return {...s,start:i===0?0:words[begin].start,end:i===m.review.sections.length-1?m.target_video_duration_sec:words[finish].end};});
 // Finer-than-section semantic matching: align each individual sentence ("beat") to its real
 // spoken timestamps, so footage selection can match what THIS sentence is about (e.g. an
 // accessibility-options sentence) rather than inheriting a whole section's blended keyword set
 // (e.g. a "strengths" section that also talks about combat).
 const rawBeats=alignSegments(words,deriveBeats(m.review.sections)).filter(b=>b.start!=null);
 const beats=rawBeats.map((b,i)=>({...b,start:i===0?0:b.start,end:i===rawBeats.length-1?m.target_video_duration_sec:b.end}));
 return {assPath,srtPath,sections,beats,words,groups:cap};
}
function planTimeline(m,pool,beats,target){
 const used=new Map(),usedCount=new Map(),lastUsedAt=new Map(),shots=[];let time=0,lastSource='',lastPath='';
 // Longer target durations get proportionally longer average shots (log-scaled, capped at 2.6x)
 // so short reviews stay dynamically cut while long-form reviews let footage breathe instead of
 // switching clips every few seconds. Below the 90s baseline, pacing is left unchanged.
 const paceFactor=clamp(1+Math.log2(Math.max(target,1)/90)*.6,1,2.6);
 const shortForm=target<=120;
 const atmosphereWords=new Set(['dark','horror','atmosphere','atmospheric','tension','tense','shadow','shadows','dread','ominous','eerie']);
 // Generic promotional/brand-filler detection: logos, title/rating cards, box art, platform badges
 // etc. are only appropriate when the CURRENT beat is actually discussing developer/publisher/
 // platform/release/edition context -- otherwise they read as random filler, not review footage.
 const brandFillerPattern=/\blogo\b|title.?card|rating.?card|\besrb\b|\bpegi\b|box.?art|cover.?art|platform.?badge|storefront|release.?date.?card|end.?card|promotional.?card|publisher.?bumper|developer.?bumper|studio.?logo|splash.?screen|loading.?screen/i;
 const brandContextPattern=/developer|publisher|studio|platform|release date|edition|business|history|announce/i;
 // Minimum viable shot length: candidates with too little runway left are deprioritized (not
 // hard-excluded, so the pipeline can still fall back to them rather than fail outright) so a
 // clip that's nearly exhausted doesn't get selected just to produce a sub-1s sliver.
 const minShot=clamp(1.5*Math.sqrt(paceFactor),1.5,3);let tailGuardStopped=false;
 while(time<target-.01){
 // Too little timeline budget left to justify a whole new shot (this is what previously produced
 // accidental sub-1s trailing fragments): absorb the remainder into the previous shot instead of
 // adding a new sliver-length one, as long as that shot's own source clip has enough untouched
 // footage left to extend into. If not, stop the timeline slightly short of the exact target --
 // tailGuardStopped below prevents the OLD gap-filling fallback from also firing and adding a
 // second, immediately-adjacent shot of the same just-exhausted clip right after (which is worse
 // than the original sliver: an actual back-to-back repeat), comfortably above the minimum
 // real-footage ratio either way.
 const remainingBudget=target-time;
 if(remainingBudget<minShot&&shots.length){
  const prevShot=shots[shots.length-1],prevPool=pool.find(p=>p.path===prevShot.path);
  const prevOffsetEnd=prevShot.offset+prevShot.duration,prevClipRemaining=prevPool?prevPool.media.duration-prevOffsetEnd:0;
  if(prevPool&&prevClipRemaining>=remainingBudget-.01){
   prevShot.duration=round(prevShot.duration+remainingBudget);
   used.set(prevShot.path,prevOffsetEnd+remainingBudget);
   time=target;
  } else {
   tailGuardStopped=true;
  }
  break;
 }
 const beat=beats.find(s=>time>=s.start&&time<s.end)||beats.find(s=>s.start>time)||beats.at(-1),keys=new Set((beat.visual_keywords||[]).flatMap(tokens)),atmospheric=[...keys].some(k=>atmosphereWords.has(k));
 const beatText=(beat.text||'')+' '+(beat.visual_keywords||[]).join(' '),beatIsBrandContext=brandContextPattern.test(beatText);
 const available=pool.map(c=>{const offset=used.get(c.path)||0,remaining=c.media.duration-offset,matches=[...(c.semantic_tags||[]),c.scene_description||''].flatMap(tokens).filter(t=>keys.has(t)).length;
  let score=matches*16+c.media.visual_score*.5+(/^official/.test(c.source_class||'')?12:0)+(offset===0?18:-12)-(c.source_url===lastSource?8:0)-(c.path===lastPath?50:0);
  // Dark/low-information frames are penalized throughout the timeline, not only at the opening.
  // Section context that legitimately calls for a darker/atmospheric shot softens the penalty.
  score-=c.media.dark_fraction>.3?(c.media.dark_fraction-.3)*70*(atmospheric?.35:1):0;
  if(time===0)score+=Number(c.opening_score||0)*.6-(c.media.dark_fraction>.6?80:0);
  // Duration-aware repeat handling: short-form strongly discourages any reuse (obvious repetition
  // is noticeable fast in a 60s video); long-form allows intelligent reuse, relieved by temporal
  // spacing since the last use, rather than banning repetition outright.
  const priorUses=usedCount.get(c.path)||0,sinceLastUse=lastUsedAt.has(c.path)?time-lastUsedAt.get(c.path):Infinity;
  let reusePenalty=0;
  if(priorUses>0){
   if(shortForm)reusePenalty=30+priorUses*20;
   else reusePenalty=35*(1-clamp(sinceLastUse/45,0,1))+priorUses*6;
  }
  score-=reusePenalty;
  score-=remaining<minShot?(minShot-remaining)*25:0;
  return {...c,offset,remaining,score};
 }).filter(c=>c.remaining>=1).filter(c=>!(c.media.dark_fraction>.92&&c.media.mean<10))
  .filter(c=>{const t=[...(c.semantic_tags||[]),c.scene_description||''].join(' ');return !(brandFillerPattern.test(t)&&!beatIsBrandContext);})
  .sort((a,b)=>b.score-a.score);if(!available.length)break;
 const c=available[0];let desired=clamp((4.5-Number(c.scene_intensity||.5)*2)*paceFactor,1.8*paceFactor,5.5*paceFactor);if(time===0)desired=Math.min(desired,3.2*Math.sqrt(paceFactor));let duration=Math.min(desired,c.remaining,target-time);if(c.remaining-duration<.6)duration=Math.min(c.remaining,target-time);if(duration<.01)break;
 shots.push({path:c.path,offset:round(c.offset),duration:round(duration),timeline_start_sec:round(time),section:beat.section,semantic_match_tags:c.semantic_tags||[],source_url:c.source_url,source_channel:c.source_channel,source_title:c.source_title,source_class:c.source_class,scene_id:c.scene_id,source_id:c.source_id,opening_score:c.opening_score||0,visual_score:c.media.visual_score});used.set(c.path,c.offset+duration);usedCount.set(c.path,(usedCount.get(c.path)||0)+1);lastUsedAt.set(c.path,time+duration);time+=duration;lastSource=c.source_url;lastPath=c.path;}
 const realDuration=time;if(realDuration<target*cfg.minimum_real_footage_ratio)throw Error(`Insufficient permitted unique footage: ${round(realDuration)}s for ${target}s. No synthetic fallback or repeated footage added.`);
 if(time<target-.01&&!tailGuardStopped){
  // Keep any remaining-time filler brief and well-chosen rather than stretching an arbitrary
  // freeze-frame to cover a large coverage gap: fail cleanly instead if the gap is too big.
  // Skipped entirely when the tail-guard above already made a deliberate stop-short decision --
  // otherwise this block would add a second, immediately-adjacent shot of the same just-exhausted
  // clip right after it (a back-to-back repeat), which is worse than the short timeline it's trying
  // to avoid.
  const gap=target-time,maxFallbackSec=Math.min(6,Math.max(2,target*.07));
  if(gap>maxFallbackSec)throw Error(`Remaining coverage gap ${round(gap)}s exceeds the ${round(maxFallbackSec)}s brief-fallback limit; gather more real footage instead of a long generic filler.`);
  const best=[...shots].sort((a,b)=>(b.visual_score||0)-(a.visual_score||0))[0],source=pool.find(p=>p.path===best.path);
  shots.push({kind:'static_review_summary',path:best.path,offset:round(clamp(best.offset+best.duration*.4,0,source.media.duration-.2)),duration:round(gap),timeline_start_sec:round(time),section:'closing',source_url:best.source_url,disclosure:'Static frame from approved source, labeled REVIEW SUMMARY'});
 }
 return {shots,real_footage_ratio:round(realDuration/target),fallback_used:realDuration<target-.01};
}
function compositeThumbnailText(baseImagePath,dir,gameTitle,thumbnailText,outPath){
 // Shared title-card text treatment: a dark left panel with a yellow accent bar, game title, and
 // 1-2 line headline text. Used both for the frame-extracted fallback thumbnail and (from n8n,
 // which has network access this local script does not) for compositing text onto an AI-generated
 // base image, so both paths get identical, already-proven text rendering.
 const text=clean(thumbnailText);if(!text||text.split(/\s+/).length>5)throw Error('Thumbnail copy must contain 1–5 words');const words=text.toUpperCase().split(/\s+/),lines=words.length>3?[words.slice(0,Math.ceil(words.length/2)).join(' '),words.slice(Math.ceil(words.length/2)).join(' ')]:[text.toUpperCase()];
 const title=path.join(dir,'thumbnail-game.txt');fs.writeFileSync(title,clean(gameTitle).toUpperCase());const filters=['drawbox=x=0:y=0:w=570:h=720:color=0x080d18@0.82:t=fill','drawbox=x=54:y=230:w=70:h=8:color=0xffe84c:t=fill'];const font='/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf';
 filters.push(`drawtext=fontfile=${font}:textfile=${title}:expansion=none:fontcolor=white:fontsize=${Math.min(30,Math.floor(780/Math.max(20,gameTitle.length)))}:x=54:y=174`);
 lines.forEach((line,i)=>{const p=path.join(dir,`thumbnail-line-${i}.txt`);fs.writeFileSync(p,line);filters.push(`drawtext=fontfile=${font}:textfile=${p}:expansion=none:fontcolor=white:fontsize=${Math.min(76,Math.floor(800/Math.max(10,line.length)))}:x=54:y=${280+i*90}`);});ff(['-v','error','-i',baseImagePath,'-vf',filters.join(','),'-frames:v','1',outPath]);return outPath;
}
function renderThumbnail(m,dir,shot){
 const at=shot.offset+clamp(shot.duration*.4,.15,Math.max(.15,shot.duration-.1));
 const base=path.join(dir,'thumbnail-source.png');ff(['-v','error','-ss',String(at),'-i',shot.path,'-frames:v','1','-vf','scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720',base]);
 return compositeThumbnailText(base,dir,m.game_title,m.review.thumbnail_text,path.join(dir,'thumbnail.png'));
}
function main(manifestPath){
 const m=JSON.parse(fs.readFileSync(safeFile(manifestPath))),target=Number(m.target_video_duration_sec);if(!Number.isFinite(target)||target<15||target>cfg.max_target_video_duration_sec)throw Error('Invalid duration');
 if(m.assets.asset_ready!==true||m.assets.asset_type!=='video'||/generated/.test(m.assets.result_type||''))throw Error('Real-video rights/asset gate not satisfied');
 const slug=String(m.file_slug||'review').replace(/[^a-z0-9_-]/gi,'-'),dir=path.join(ROOT,'review-pipeline','renders',slug);fs.mkdirSync(dir,{recursive:true});const final=path.join(dir,'final-review.mp4');if(fs.existsSync(path.join(dir,'package.json')))throw Error('Completed package exists; reuse it rather than overwrite');
 const excluded=new Set((m.excluded_clip_paths||[]).map(safeFile));
 const seen=new Set(),pool=(m.assets.assembly_clips||[]).filter(c=>c.path&&!seen.has(c.path)&&seen.add(c.path)&&c.spoiler_risk!==true&&!excluded.has(safeFile(c.path))).map(c=>({...c,path:safeFile(c.path),media:imageScore(safeFile(c.path))}));if(!pool.length)throw Error('No suitable permitted scenes');
 const highRes=pool.filter(c=>c.media.height>=1080&&c.media.width>=1920).reduce((s,c)=>s+c.media.duration,0)>=target*.85,width=highRes?1920:1280,height=highRes?1080:720,sourceFps=Math.min(...pool.map(c=>c.media.fps)),fps=sourceFps>=59?60:30;
 // lead/trail are explicit, deliberate silence reserved around the spoken narration (not just
 // whatever margin happens to be left over) -- trail specifically exists so the ending has a real
 // pause before the video cuts, verified below rather than assumed.
 const audio=safeFile(m.voiceover.audio_path),audioDuration=Number(probe(audio).format.duration),lead=.15,trail=.7,spokenTarget=target-lead-trail,speed=audioDuration/spokenTarget;
 if(speed<.82||speed>1.18)throw Error(`Narration needs a bounded timing revision: ${round(audioDuration)}s for ${target}s target. Refusing unnatural time stretch (${round(speed)}).`);
 const aligned=captions(m,dir,speed,lead,width,height),timeline=planTimeline(m,pool,aligned.beats,target);save(path.join(dir,'edit-decision-list.json'),timeline);save(path.join(dir,'research-and-script.json'),{game_title:m.game_title,review:m.review,script:m.script,sources:m.research_sources});
 const parts=[];timeline.shots.forEach((shot,i)=>{const out=path.join(dir,`shot-${String(i).padStart(3,'0')}.mp4`);let filter=`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
 if(shot.kind==='static_review_summary')filter+=`,tpad=stop_mode=clone:stop_duration=${shot.duration},drawbox=x=0:y=0:w=iw:h=100:color=black@0.7:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf:text='REVIEW SUMMARY':fontcolor=white:fontsize=36:x=60:y=30`;
 ff(['-v','error','-ss',String(shot.offset),'-i',shot.path,'-t',String(shot.duration),'-map','0:v:0','-an','-vf',filter,'-c:v','libx264','-preset','fast','-crf','17','-threads','2','-pix_fmt','yuv420p',out]);parts.push(out);});
 const list=path.join(dir,'concat.txt');fs.writeFileSync(list,parts.map(p=>`file '${p.replace(/'/g,"'\\''")}'`).join('\n'));
 const music=makeMusic(path.join(dir,'original-music.wav'),target,m.review.music||{},slug),mix=path.join(dir,'mix.wav');
 const graph=`[0:a]atempo=${speed},aresample=48000,adelay=${Math.round(lead*1000)}|${Math.round(lead*1000)},apad,atrim=duration=${target},asplit=2[voice][side];[1:a]volume=0.25,afade=t=in:d=1.0,afade=t=out:st=${target-2}:d=2[bed];[bed][side]sidechaincompress=threshold=0.025:ratio=6:attack=12:release=300[duck];[voice][duck]amix=inputs=2:duration=first:normalize=0[mix]`;
 ff(['-v','error','-i',audio,'-i',music.path,'-filter_complex',graph,'-map','[mix]','-ar','48000','-ac','2','-c:a','pcm_s24le','-t',String(target),mix]);const measured=loudness(mix);for(const k of ['input_i','input_tp','input_lra','input_thresh','target_offset'])if(!Number.isFinite(Number(measured[k])))throw Error('Invalid mix loudness');
 const norm=`loudnorm=I=${cfg.program_lufs}:TP=${cfg.true_peak_db}:LRA=9:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
 ff(['-v','error','-f','concat','-safe','0','-i',list,'-i',mix,'-map','0:v:0','-map','1:a:0','-vf',`tpad=stop_mode=clone:stop_duration=0.25,ass=${aligned.assPath}`,'-af',norm,'-c:v','libx264','-preset','medium','-crf','18','-maxrate','18M','-bufsize','36M','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-t',String(target),'-movflags','+faststart',final]);
 // Thumbnail source is the highest visual-quality real (non-fallback) shot, not necessarily the
 // opening shot, so the cover image is the most striking frame rather than whatever plays first.
 const thumbSource=timeline.shots.filter(s=>s.kind!=='static_review_summary').sort((a,b)=>(b.visual_score||0)-(a.visual_score||0))[0]||timeline.shots[0];
 // Tolerance is wider than a strict frame-accurate match: the planTimeline tail-guard can
 // legitimately stop up to `minShot` (clamped 1.5-3s, see planTimeline) short of the exact target
 // rather than force an extension or add a redundant shot to hit 60.000s exactly -- the real
 // insufficient-footage protection is the earlier minimum_real_footage_ratio gate, not this one.
 const thumbnail=renderThumbnail(m,dir,thumbSource),info=probe(final),v=info.streams.find(s=>s.codec_type==='video'),a=info.streams.find(s=>s.codec_type==='audio'),duration=Number(info.format.duration);if(!v||!a||Math.abs(duration-target)>Math.max(.08,2/fps,3.5))throw Error('Final duration/stream verification failed');
 ff(['-v','error','-i',final,'-f','null','-']);const finalLoudness=loudness(final);if(Number(finalLoudness.input_i)<-16.5||Number(finalLoudness.input_i)>-13.5||Number(finalLoudness.input_tp)>-.5)throw Error('Final mix outside loudness/peak gate');
 const speechEnd=lastSpeechEnd(final),endingTrailSec=target-speechEnd;if(endingTrailSec<.35)throw Error(`Narration ending lacks a natural trailing beat: audible speech continues to ~${round(speechEnd)}s, leaving only ${round(endingTrailSec)}s before the ${target}s cutoff (need >=0.35s). The closing sentence is likely too long or paced too tight for the target duration -- shorten it rather than let the ending feel rushed or cut off.`);
 const frames=[];for(const f of [0,.111,.222,.333,.5,.667,.833,.978]){const at=Math.min(target-.1,target*f),p=path.join(dir,`frame-${String(Math.round(at)).padStart(3,'0')}.jpg`);ff(['-v','error','-ss',String(at),'-i',final,'-frames:v','1','-vf','scale=640:-2',p]);frames.push(p);}
 // Publish true deliverables to their dedicated canonical folders. review-pipeline/renders/<slug>
 // remains the full working/development directory (intermediate shot fragments, mix, manifest,
 // frame samples, etc) -- it is not the canonical storage location for final assets.
 const videosDir=path.join(ROOT,'videos'),thumbsDir=path.join(ROOT,'thumbnails');
 fs.mkdirSync(videosDir,{recursive:true});fs.mkdirSync(thumbsDir,{recursive:true});
 const canonicalVideo=path.join(videosDir,slug+'.mp4'),canonicalThumb=path.join(thumbsDir,slug+'.png'),canonicalSrt=path.join(videosDir,slug+'.srt'),canonicalAss=path.join(videosDir,slug+'.ass');
 fs.copyFileSync(final,canonicalVideo);fs.copyFileSync(thumbnail,canonicalThumb);fs.copyFileSync(aligned.srtPath,canonicalSrt);fs.copyFileSync(aligned.assPath,canonicalAss);
 const sources=[...new Map(timeline.shots.filter(s=>s.source_url).map(s=>[s.source_url,{url:s.source_url,title:s.source_title,channel:s.source_channel,source_class:s.source_class}])).values()];
 const description=String(m.review.description||'')+'\n\nFootage sources (muted, editorial review use):\n'+sources.map(s=>`${s.channel||s.title||'Source'}: ${s.url}`).join('\n')+'\nNarration is AI-generated. Background music is an original local procedural composition.';
 const result={status:'success',game_title:m.game_title,file_slug:slug,final_video_path:canonicalVideo,final_thumbnail_path:canonicalThumb,thumbnail_source:'frame_extracted',final_video_duration_sec:duration,target_video_duration_sec:target,resolution:`${v.width}x${v.height}`,fps:fraction(v.avg_frame_rate),source_min_fps:sourceFps,source_quality_downshift:!highRes,script:m.script,voiceover_path:audio,narration_duration_before_fit:audioDuration,narration_tempo_factor:speed,background_music:music,subtitle_path:canonicalSrt,caption_ass_path:canonicalAss,captions_timing:'whisper-1 word timestamps adjusted by exact narration tempo',footage_sources:sources,footage_source_urls:sources.map(s=>s.url),rights_use_summary:m.assets.rights_use_mode||'Preserved asset-workflow decision; no blanket license claim',source_audio_muted:true,real_footage_ratio:timeline.real_footage_ratio,fallback_used:timeline.fallback_used,ai_generated_gameplay_used:false,title:m.review.title,description,tags:m.review.tags,research_sources:m.research_sources,review_sections:aligned.sections,edit_decision_list:path.join(dir,'edit-decision-list.json'),representative_frames:frames,audio:{codec:a.codec_name,sample_rate:Number(a.sample_rate),channels:a.channels,integrated_lufs:Number(finalLoudness.input_i),true_peak_dbtp:Number(finalLoudness.input_tp),loudness_range_lu:Number(finalLoudness.input_lra)},decode_check:'passed',work_dir:dir,thumbnail_text:m.review.thumbnail_text,package_path:path.join(dir,'package.json')};save(result.package_path,result);fs.writeFileSync(path.join(dir,'description.txt'),description);fs.writeFileSync(path.join(dir,'script.txt'),m.script);console.log(JSON.stringify(result));return result;
}
function compositeThumbnailCli(baseImagePath,gameTitle,thumbnailText,outPath){
 // Scratch .txt files used by compositeThumbnailText for ffmpeg drawtext go in a temp working
 // directory, not the final output directory (which may be a canonical folder like thumbnails/).
 const scratchDir=path.join(ROOT,'review-pipeline','renders','_thumbnail-composite-tmp');fs.mkdirSync(scratchDir,{recursive:true});
 fs.mkdirSync(path.dirname(outPath),{recursive:true});
 return compositeThumbnailText(safeFile(baseImagePath),scratchDir,gameTitle,thumbnailText,outPath);
}
if(require.main===module){
 try{
  if(process.argv[2]==='composite-thumbnail')console.log(JSON.stringify({status:'success',thumbnail_path:compositeThumbnailCli(process.argv[3],process.argv[4],process.argv[5],process.argv[6])}));
  else main(process.argv[2]);
 }catch(e){console.error(e.stack||e.message);process.exitCode=1;}
}
module.exports={makeMusic,planTimeline,captions,tokens,alignSegments,deriveBeats,compositeThumbnailText,main};
