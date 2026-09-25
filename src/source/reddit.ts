import { config } from "../config.ts";
import { log } from "../log.ts";

/**
 * Discovery for the community discussion thread.
 *
 * What is and is not possible here, verified against Reddit on 2026-09-20:
 *  - www.reddit.com sends `x-frame-options: SAMEORIGIN`, so it cannot be framed.
 *  - The unauthenticated JSON API (`/r/<sub>/new.json`) returns 403 from a server
 *    IP whatever User-Agent is sent, and old.reddit redirects to a login page.
 *    Reading it properly needs a registered OAuth app.
 *  - `embed.reddit.com` serves the same content with `frame-ancestors *` and no
 *    X-Frame-Options, needs no auth, and accepts an honest User-Agent. It is what
 *    the official "embed this post" button produces.
 *
 * That embed renders the POST, not its comment tree - so this gives the community's
 * megathread, not a live chat. The conversation itself stays on Reddit, which is
 * what `permalink` is for.
 */

export interface DiscussionThread {
  subreddit: string;
  /** Reddit post id, base36. */
  id: string;
  slug: string;
  title: string;
  /** Human-facing link to the comment thread. */
  permalink: string;
  /** Frameable URL rendering the post itself. */
  embedUrl: string;
  discoveredAt: string;
}

const EMBED_ROOT = "https://embed.reddit.com";

/** Slug -> "India At Aichi Nagoya Asian Games 2026 Day 1". */
function titleFromSlug(slug: string): string {
  return slug
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Pull permalinks out of a subreddit embed page, in document order.
 *
 * Document order is the feed's own ranking, and it is the only trustworthy
 * recency signal here: the embed carries no timestamps, and post ids sort by
 * creation rather than by which day a megathread covers - the subreddit currently
 * has a stray "day_2" post older than its "day_1" one, so ordering by the day
 * number in the slug picks the wrong thread.
 */
export function parseFeed(htmlText: string, subreddit: string): { id: string; slug: string }[] {
  const pattern = new RegExp(`/r/${subreddit}/comments/([a-z0-9]{4,12})/([a-z0-9_]{3,120})`, "gi");
  const seen = new Set<string>();
  const posts: { id: string; slug: string }[] = [];

  for (const match of htmlText.matchAll(pattern)) {
    const id = match[1];
    const slug = match[2];
    if (!id || !slug || seen.has(id)) continue;
    seen.add(id);
    posts.push({ id, slug });
  }
  return posts;
}

/** The first post in feed order whose slug matches the megathread pattern. */
export function selectThread(
  posts: { id: string; slug: string }[],
  subreddit: string,
  pattern: RegExp,
): DiscussionThread | null {
  const match = posts.find((p) => pattern.test(p.slug));
  if (!match) return null;

  return {
    subreddit,
    id: match.id,
    slug: match.slug,
    title: titleFromSlug(match.slug),
    permalink: `https://www.reddit.com/r/${subreddit}/comments/${match.id}/${match.slug}/`,
    embedUrl: `${EMBED_ROOT}/r/${subreddit}/comments/${match.id}/${match.slug}/`,
    discoveredAt: new Date().toISOString(),
  };
}

export async function fetchDiscussionThread(): Promise<DiscussionThread | null> {
  const subreddit = config.reddit.subreddit;
  const url = `${EMBED_ROOT}/r/${subreddit}`;

  try {
    const res = await fetch(url, {
      headers: {
        // Reddit serves this to an honest identifier; no browser spoofing needed.
        "User-Agent": `IndiaAG2026Tracker/0.1 (+contact: ${config.contact})`,
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      log.warn("reddit feed fetch failed", { url, status: res.status });
      return null;
    }

    const body = await res.text();
    const posts = parseFeed(body, subreddit);
    const thread = selectThread(posts, subreddit, config.reddit.threadPattern);

    if (!thread) {
      log.warn("no megathread matched", { subreddit, posts: posts.length });
      return null;
    }
    log.info("discussion thread discovered", { id: thread.id, title: thread.title });
    return thread;
  } catch (err) {
    // Reddit is a nice-to-have panel, never a reason to degrade the tracker.
    log.warn("reddit discovery failed", { url, err });
    return null;
  }
}
