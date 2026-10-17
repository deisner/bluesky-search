# Bluesky Post Search

A small web app for searching Bluesky posts. It has no build step or server, just three static files (`index.html`, `app.js`, `styles.css`) that talk directly to Bluesky's public API from your browser.

## Two ways to find posts

**Search posts** uses [`app.bsky.feed.searchPosts`](https://docs.bsky.app/docs/api/app-bsky-feed-search-posts) and exposes every parameter it supports:

| Form field | API parameter |
| --- | --- |
| Search words (supports `"phrases"`, `-exclude`, `from:`, `to:`, `mentions:`, `lang:`, `domain:`, `since:`, `until:`, `#tag`) | `q` |
| Sort: latest or top | `sort` |
| Posted by | `author` |
| Mentions | `mentions` |
| Language | `lang` |
| Links to domain | `domain` |
| Links to URL | `url` |
| Hashtags (all must match) | `tag` (repeated) |
| From / Through date and time | `since` / `until` |
| Posts to load per click | `limit` (paged with `cursor`) |

**All posts from a person** uses [`app.bsky.feed.getAuthorFeed`](https://docs.bsky.app/docs/api/app-bsky-feed-get-author-feed). It lists everything someone posted in a date range, and doesn't need search words. Its options are the feed filter (posts, replies, self-threads, media only, video only), whether to include the pinned post and reposts, and an optional text filter. The API has no date parameters, so the app reads the feed newest-first and stops once it's older than the "From" date.

Other features:
- Results show images, links, quoted posts, videos, reply and repost context, and like, repost, reply and quote counts.
- Posts labeled sexual or graphic are blurred until clicked.
- Results can be downloaded as CSV (opens in Excel or Numbers) or JSON.
- The address bar always holds the current search, so you can bookmark or share it.
- "API request" shows the exact API call that was made.

## Signing in

Bluesky sometimes refuses search requests that aren't signed in. If that happens, the app asks you to sign in with an **app password**, which you create at bsky.app → Settings → Privacy and security → App passwords. Don't use your main password. The app password is sent only to your Bluesky server, and the sign-in is remembered in that browser until you click "Sign out".

## Running it

- **On the web:** this repo is set up for GitHub Pages (Settings → Pages → Deploy from branch `main`, folder `/ (root)`).
- **On your computer:** download the files and double-click `index.html`. No install is needed.
