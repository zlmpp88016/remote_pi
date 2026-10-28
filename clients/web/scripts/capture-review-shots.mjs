/**
 * Captures the two review shots (empty + with content) at exactly 1600x945,
 * DPR 1. Kept as a script rather than a one-off so the evidence can be
 * regenerated after any visual change.
 *
 * Ordering matters: a session list only loads once a workspace is active, and
 * the host answers `session_list` asynchronously (~10s observed), so the
 * content shot polls instead of sleeping a fixed amount.
 */
import { attach, shot, evaluate, sleep } from "./_cdp.mjs";

const { send, ws } = await attach();

await send("Emulation.setDeviceMetricsOverride", {
  width: 1600,
  height: 945,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.enable", {});
await send("Page.reload", { ignoreCache: true });
await sleep(11000);

await shot(send, "review-01-empty");

const expanded = await evaluate(
  send,
  `(function(){
     var b = document.querySelector('[title^="Expand the sidebar"],[title*="Toggle the sidebar"]');
     if (b) b.click();
     return b ? "expanded" : "already-open";
   })()`,
);
console.log("sidebar:", expanded);
await sleep(2000);

// Workspace first: the dock shows a "select a workspace" placeholder (with no
// tab strip at all) until one is active.
const picked = await evaluate(
  send,
  `(function(){
     var el = [...document.querySelectorAll("[class*=wsName]")][0];
     if (!el) return "no-workspace";
     var row = el.closest("li") || el.parentElement;
     (row.querySelector("button") || row).click();
     return (el.textContent || "").trim();
   })()`,
);
console.log("workspace:", picked);
await sleep(4500);

const openDock = await evaluate(
  send,
  `(function(){
     var b = [...document.querySelectorAll("button")].find(function(x){ return /right dock/i.test(x.textContent || ""); });
     if (!b) return "no-dock-button";
     /* The same control toggles, so clicking it while the dock is already open
        closes it and the Sessions tab disappears. Only click when collapsed. */
     var expanded = b.getAttribute("aria-expanded");
     var label = (b.textContent || "").trim();
     if (expanded === "true") return "already-open";
     if (/^hide/i.test(label)) return "already-open";
     b.click();
     return "opened";
   })()`,
);
console.log("dock:", openDock);
await sleep(2500);

// The dock remembers its last tab; Sessions is the one that issues
// `session_list`, so select it explicitly before polling.
const tabbed = await evaluate(
  send,
  `(function(){
     /* The dock can be a collapsed icon rail (buttons stacked vertically at
        the right edge) or an expanded panel; both expose a "Sessions" control,
        so match on the label alone rather than on geometry. */
     var all = [...document.querySelectorAll("button, [role=tab]")];
     var b = all.find(function(x){ return (x.textContent || "").trim() === "Sessions"; });
     if (!b) return "no-sessions-tab";
     b.click();
     return "sessions-tab";
   })()`,
);
console.log("tab:", tabbed);
await sleep(3000);

let rows = 0;
for (let attempt = 0; attempt < 6; attempt += 1) {
  await evaluate(
    send,
    `(function(){
       var b = document.querySelector("[class*=refresh]");
       if (b) b.click();
       return 1;
     })()`,
  );
  await sleep(4000);
  rows = await evaluate(
    send,
    `document.querySelectorAll('[aria-label^="Read session"]').length`,
  );
  if (rows > 0) break;
}
console.log("session rows:", rows);

if (rows > 0) {
  const label = await evaluate(
    send,
    `(function(){
       var b = document.querySelectorAll('[aria-label^="Read session"]')[0];
       var l = b.getAttribute("aria-label");
       b.click();
       return l;
     })()`,
  );
  console.log("opened:", label);
  await sleep(17000);
}

await shot(send, "review-02-content");
ws.close();
