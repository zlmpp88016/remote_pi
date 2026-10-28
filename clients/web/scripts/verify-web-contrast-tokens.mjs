/** Resolved-token proof: ok-text / warn-text / scrollbar tokens actually resolve
 *  (not silently guaranteed-invalid) and produce the claimed contrast. */
import { attach, evaluate } from "./_cdp.mjs";
const { send, ws } = await attach();
const r = await evaluate(send, `(function(){
  const cs=getComputedStyle(document.documentElement);
  const names=["--ok-text","--warn-text","--dsw-alias-scrollbar-bg-l2","--dsw-alias-scrollbar-hover-l2","--dsw-static-neutral-200","--dsw-static-neutral-300","--faint","--dsw-alias-label-secondary","--dsw-alias-label-tertiary","--muted"];
  const out={};
  for(const n of names) out[n]=cs.getPropertyValue(n).trim()||"EMPTY";
  return out;
})()`);
ws.close();
const lum=(v)=>{const s=v/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4);};
const cr=(a,b)=>{const A=0.2126*lum(a[0])+0.7152*lum(a[1])+0.0722*lum(a[2]);const B=0.2126*lum(b[0])+0.7152*lum(b[1])+0.0722*lum(b[2]);return +(((Math.max(A,B)+0.05)/(Math.min(A,B)+0.05))).toFixed(2);};
const num=(s)=>{const m=String(s).match(/(\d+)\D+(\d+)\D+(\d+)/);return m?[+m[1],+m[2],+m[3]]:null;};
const white=[255,255,255];
let fail=0;
console.log("resolved tokens (a CSS var that is EMPTY means the colour ramp it references is missing):");
for (const [k,v] of Object.entries(r)) {
  const c=num(v);
  const cw=c?cr(c,white):null;
  const empty=v==="EMPTY";
  if(empty)fail++;
  console.log(`  ${empty?"FAIL":"OK  "} ${k.padEnd(34)} ${v.padEnd(22)} onWhite=${cw===null?"-":cw}`);
}
// The two text tokens must clear AA on white.
for (const t of ["--ok-text","--warn-text"]) {
  const c=num(r[t]);
  if(!c||cr(c,white)<4.5){console.log(`  FAIL ${t} is ${c?cr(c,white):"?"}:1 on white (< 4.5)`);fail++;}
}
console.log(fail===0?"\nweb-contrast-tokens: OK":`\nweb-contrast-tokens: FAILED (${fail})`);
process.exit(fail===0?0:1);
