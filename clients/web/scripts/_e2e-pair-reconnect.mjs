// Helper: re-pair the browser to the relay using the real pair URI.
// The client mints a fresh ephemeral App-key per connect, so this must run
// after every supervisor restart.
import { attach, evaluate, shot, sleep , APP_ORIGIN } from "./_cdp.mjs";
const { send } = await attach();
await send("Runtime.enable"); await send("Page.enable");
const ev = (e) => evaluate(send, e);
await send("Page.navigate", { url: APP_ORIGIN + "/remote-pi/connect" });
await sleep(7000);
const st = await ev(`(() => { const t=document.body.innerText||''; return JSON.stringify({ connected: t.indexOf('host connected')>=0, hasPairInput: !!document.querySelector('input[placeholder*="remotepi"]') }); })()`);
const s = JSON.parse(st);
if (s.connected) { console.log("already connected"); await shot(send, "00-already-connected"); process.exit(0); }
console.log("needs pairing; UI state:", st);
await shot(send, "00-needs-pairing");
