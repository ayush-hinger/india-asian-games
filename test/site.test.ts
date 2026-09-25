import assert from "node:assert/strict";
import { test } from "node:test";
import { eventPageUrl } from "../src/source/site.ts";

test("site: event URL uses the site's hash route and the raw ResCode", () => {
  // Verified in a browser on 2026-09-25 to render the BAN v IND scorecard.
  assert.equal(
    eventPageUrl("CKT", "W.TEAM--------------.SFNL.000200--"),
    "https://results.asiangames2026.org/#/discipline/CKT/results/W.TEAM--------------.SFNL.000200--",
  );
});

test("site: the path before '#' is always '/', the only path the site's hosting serves", () => {
  const url = new URL(eventPageUrl("BDM", "M.DOUBLES-----------.R32-.001600--"));
  assert.equal(url.pathname, "/");
  assert.equal(url.hash, "#/discipline/BDM/results/M.DOUBLES-----------.R32-.001600--");
});
