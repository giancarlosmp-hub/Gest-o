import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [layout, styles, actionBar] = await Promise.all([
  readFile(new URL("../src/layouts/AppLayout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/index.css", import.meta.url), "utf8"),
  readFile(new URL("../src/components/mobile/MobileActionBar.tsx", import.meta.url), "utf8"),
]);

assert.match(layout, /h-\[100dvh\].*max-h-\[100dvh\]/, "drawer must follow the dynamic viewport");
assert.match(layout, /overflow-y-auto overscroll-contain/, "drawer navigation must own vertical scrolling");
assert.match(layout, /document\.body\.style\.position = "fixed"/, "open drawer must lock background scrolling");
assert.match(layout, /window\.scrollTo\(0, scrollY\)/, "closing drawer must restore page position");
assert.match(layout, /env\(safe-area-inset-top\)/, "header and drawer must account for the top safe area");
assert.match(layout, /--mobile-action-bar-height/, "page content must reserve the mobile action bar height");
assert.match(actionBar, /safe-area-inset-bottom/, "action bar must account for the bottom safe area");
assert.match(actionBar, /max-w-\[100vw\]/, "action bar must be constrained to the viewport");
assert.match(styles, /img,\s*svg,\s*canvas,\s*video\s*{\s*max-width: 100%/s, "visual media must fit its container");
assert.doesNotMatch(
  styles,
  /html,\s*body,\s*#root\s*{[^}]*overflow-x:\s*hidden/s,
  "global overflow hiding would conceal unresolved content",
);

console.log("Responsive layout contracts: PASS");
