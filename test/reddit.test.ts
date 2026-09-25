import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseFeed, selectThread } from "../src/source/reddit.ts";

const feed = readFileSync(
  new URL("../fixtures/reddit-indiansports-embed.html", import.meta.url),
  "utf8",
);
const SUB = "IndianSports";
const MEGATHREAD = /asian_games_2026_day_\d+/i;

test("parses posts out of the subreddit embed page", () => {
  const posts = parseFeed(feed, SUB);
  assert.ok(posts.length >= 20, `expected a full feed, got ${posts.length}`);
  assert.equal(new Set(posts.map((p) => p.id)).size, posts.length, "ids are deduped");
  assert.equal(posts.every((p) => /^[a-z0-9]+$/.test(p.id)), true);
});

test("preserves the feed's own document order", () => {
  const posts = parseFeed(feed, SUB);
  // The captured feed leads with individual medal posts, not the megathread.
  assert.equal(posts[0]?.slug.includes("india_wins_the_first_medal"), true);
});

test("selects the megathread that is currently top of the feed", () => {
  const thread = selectThread(parseFeed(feed, SUB), SUB, MEGATHREAD);
  assert.ok(thread);
  assert.equal(thread.id, "1wkl7il");
  assert.equal(thread.slug, "india_at_aichi_nagoya_asian_games_2026_day_1");
  assert.equal(thread.title, "India At Aichi Nagoya Asian Games 2026 Day 1");
  assert.equal(
    thread.permalink,
    "https://www.reddit.com/r/IndianSports/comments/1wkl7il/india_at_aichi_nagoya_asian_games_2026_day_1/",
  );
  assert.equal(thread.embedUrl.startsWith("https://embed.reddit.com/"), true);
});

test("day number in the slug is NOT used for recency", () => {
  // The captured feed contains a stray day_2 post that is older than day_1;
  // ordering by day number would pick the wrong thread. Document order wins.
  const posts = parseFeed(feed, SUB);
  const days = posts.filter((p) => MEGATHREAD.test(p.slug));
  assert.ok(days.length > 1, "fixture should contain several megathreads");

  const highestDay = days
    .map((p) => Number(p.slug.match(/day_(\d+)/)?.[1] ?? -1))
    .reduce((a, b) => Math.max(a, b), -1);
  const selected = selectThread(posts, SUB, MEGATHREAD);
  assert.equal(selected?.slug.endsWith("day_1"), true);
  assert.ok(highestDay >= 2, "a higher day number exists but is deliberately not chosen");
});

test("returns null when nothing matches rather than guessing", () => {
  assert.equal(selectThread(parseFeed(feed, SUB), SUB, /no_such_thread_pattern/), null);
  assert.equal(selectThread([], SUB, MEGATHREAD), null);
});

test("a different subreddit name matches nothing in this feed", () => {
  assert.deepEqual(parseFeed(feed, "SomeOtherSub"), []);
});

test("subreddit matching is case-insensitive", () => {
  // Reddit serves mixed-case permalinks; the configured name may differ in case.
  assert.ok(parseFeed(feed, "indiansports").length >= 20);
});
