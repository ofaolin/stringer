# STRINGER

Open-source, self-hosted, ad-free news archive and reader with a terminal look: dozens of outlets across the
political spectrum, a bias indicator on every story, a deep searchable archive and a Lucene-style query language.
Multi-user, with OIDC single sign-on, roles and permissions, comments, and community or personal ranking.

No dependencies — just Node 22.13+ (it uses the built-in `node:sqlite`).

## Self-hosting

**Docker** (recommended):
```
docker compose up -d --build                     # builds the image and starts it → http://localhost:1337
STRINGER_PORT=8080 docker compose up -d --build  # on another host port
```
or by hand:
```
docker build -t stringer .
docker run -d --name stringer -p 1337:1337 -v stringer-data:/data --restart unless-stopped stringer
```
Open the site and the **setup wizard** runs: create the admin account, pick which outlets the server follows
(and add any that aren't in the default list — paste a site or feed URL, it finds the feed, you name and rate it),
and choose whether to build the historical archive (back to a year you pick), save article text to the morgue,
let visitors read without signing in, and which ranking is the default. Everything the server keeps — outlets,
accounts, the archive — lives in `/data` (mount a volume; the archive can grow past 10 GB with the backfill).

**Without Docker:**
```
npm start                 # → http://127.0.0.1:1337 (supervised: restarts on crash)
HOST=0.0.0.0 npm start    # listen on every interface (put a TLS reverse proxy in front for the internet)
```

**Configuration** (environment variables; most can also be changed in the admin panel):

| variable | default | |
|---|---|---|
| `PORT` / `HOST` | `1337` / `127.0.0.1` (`0.0.0.0` in Docker) | where to listen |
| `DATA_DIR` | `./data` (`/data` in Docker) | outlets, accounts (`app.db`) and the archive (`archive.db`) |
| `BASE_URL` | from the request | the public URL, e.g. `https://news.example.org` — needed for SSO behind a proxy |
| `SITE_NAME` | `STRINGER` | shown in the header and sign-in screens |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | — | turn on single sign-on |
| `OIDC_LABEL`, `OIDC_SCOPES` | `Sign in with SSO`, `openid profile email` | |
| `OIDC_ADMIN_GROUP` | — | members of this group (in the `groups` claim) become admins |
| `LOCAL_LOGIN` | `true` | `false` = SSO only |
| `BACKFILL` / `FULLTEXT` | on | `0` disables the archive crawl / saving article text |
| `REFRESH_MIN` | `10` | minutes between feed syncs |

Behind a reverse proxy, forward `X-Forwarded-Proto` (session cookies are marked `Secure` over https) or set `BASE_URL`.

## Accounts, permissions & sign-in
- **Sign-in:** username + password accounts, and/or **OpenID Connect** single sign-on with any provider (Authentik,
  Authelia, Keycloak, Zitadel, Google, Microsoft Entra…). Admin panel → SINGLE SIGN-ON shows the redirect URI to
  register (`<public URL>/auth/oidc/callback`); new SSO users can get an account automatically, and a
  `group = role` mapping (from the `groups` claim, or any claim you name) sets their role at every sign-in. An
  existing account with the same *verified* email is linked on first SSO sign-in. ID tokens are verified against
  the provider's keys (PKCE, nonce, issuer, audience, expiry).
- **Roles** are sets of permissions — `news.read`, `reader.fetch`, `vote.personal`, `vote.community`,
  `queries.save`, `comments.read` / `.post` / `.moderate`, `sources.manage`, `archive.manage`, `users.manage`,
  `settings.manage`. Built in: **Admin**, **Moderator**, **Member**, **Viewer** and **Guest** (visitors who aren't
  signed in — empty it to make the server private). Edit any of them or add your own in the admin panel's
  permission matrix; each user has one role. The server enforces every permission; the UI hides what you can't use.
- Every user has their own saved tabs; settings like theme and layout stay per browser.

## Ranking: community or personal
Outlet votes scale how stories rank and which outlet leads a story. Two modes, switchable in the header
(`rank COMMUNITY` / `PERSONAL`; the admin sets the default):
- **Community** — everyone's votes, summed per outlet. Each user gets **3 upvotes and 3 downvotes a day**
  (configurable; they reset at 00:00 UTC, shown as `▲3 ▼3` in the header). Voting the other way on an outlet you
  voted on today takes that vote back and refunds it.
- **Personal** — your own standing votes (−30…+30 per outlet), shaping only your view.

## Research: binder, right-click menu, query builder
Signed in, each user has a **research binder** (`[❏ binder]` by the query bar, `b`, or `binder` in the terminal) for
saved **stories**, **articles** and **quotes**, each with an optional note. You can keep several binders (tabs along
the top: ＋ new binder, double-click to rename, × to delete); saving goes into the open one, and entries can be
moved between them. Every saved article and quote cites its
article by **morgue no.**: an article whose full text isn't in the morgue is filed as a *fragment* (headline and
summary only, marked "fragment") at the moment it's saved, and keeps that number when the full text is fetched later.
The main page also has a **binder sidebar** on the right (`shift+B`, or the `« BINDER` rail): the open binder at a
glance — switch binders, filter by kind, click an entry to open it, or drag a headline from the results onto it to
save the article. `⧉ cite` copies a citation, and **COPY ALL AS CITATIONS** copies the whole tab. `saved:yes` finds saved articles
(in STORIES mode, saved stories).

**Right-click** anything in the results, the popovers or the reader for STRINGER's menu (shift + right-click gives the
browser's): with text selected, *save quote to binder*, *add the word to the query builder* (plain, as `body:`, or
excluded) or *search it now*; on an article or story, *save* (or remove) it, open it in the reader, copy the link.

The **query builder** (`q`, or the `⌕ QUERY BUILDER` tab on the right) is a scratch query that floats over every
popover, so you can gather words while you read. It has autocomplete and validation; choose whether added words join
with AND or OR, then **RUN ▸** (ctrl+⏎) runs it in the main results. The permission is `binder.use` (members and
viewers have it).

## Topics
Every article gets one topic: `politics world business tech science health crime sports culture` (or `other`). It
comes from the link's section when the outlet files it under one (`/politics/`, `/sport/`, `/arts/`…), otherwise from
keywords in the headline and summary, so it works for the archive too. No model or service is involved — it's
`public/topics.js`. A story's topic is its articles' most common one. Rows show a `#topic` tag (click to filter),
the sidebar's STATS tab breaks the results down by topic, and `topic:sports` / `topic:(politics OR world)` /
`-topic:crime` filter. On the archive, topic is checked per article on the newest candidates, like other non-indexed
fields.

## Stories and articles
An **article** is one outlet's piece (it can be filed in the morgue under a morgue no.). A **story** is the group of
articles from different outlets covering the same event — regrouped at every feed sync, but with a lasting **story
number** (6 characters, e.g. `3fa91c`): each new grouping inherits the number of the earlier story it shares the most
articles with, so a story keeps its number as coverage arrives (when one splits, the bigger part keeps it). The story
popover shows its number; STREAM and archive rows say which story an article is part of (`▤ story 3fa91c · 12
outlets`); `story:3fa91c` finds a story (STORIES) or its articles (STREAM). In the reader, the **ⓘ DETAILS** tab under
✎ DISCUSSION (`i`) shows the article's outlet, dates, morgue record, read state, how it was indexed, and every story
it has been part of — click one to open it.

## Read / unread
Signed in, STRINGER remembers what *you* have read (per account, so it follows you between browsers). Articles and
stories each have their own read state: an **article** is read once you open it (reader, or its original in a new
tab); a **story** once you open its popover — and if new coverage arrives afterwards it shows `↻ n new` instead of
`✓`. In STORIES mode `read:` and the `✓` refer to stories; in STREAM and the archive, to articles. Read results are dimmed with a `✓`; a story
counts as read once you've read any of its articles. The same shows in the reader (header line) and the popovers (a `✓ read` / `○ unread` badge
on the attribution line — click it — and `✓` on outlet columns, timeline and related-coverage rows), in the
outlet-name tooltips, in a story's coverage rows, and in the ticker. `m` (on the selected result, or in a popover) or clicking the
`✓` toggles it. It's queryable: `read:yes` / `read:no` — e.g. `trump date:2016 read:no` for what you haven't read
yet, `read:yes date:*` for everything you have; in STORIES mode `read:no` means stories you haven't touched.

## Comments
Every story and article has a discussion, in a collapsible left sidebar of the story intel and archive popovers
and the reader. It starts closed, as a `✎ DISCUSSION` file tab (with the comment count) sticking out of the popover's left edge; `c` or the tab opens it,
and that choice is remembered per browser. A
story's discussion follows the story even as it's regrouped (comments attach to its articles). One level of
replies; edit or delete your own; moderators can delete anyone's. Result rows show `✎ n` when there's discussion. The comment box opens with
`[+ add a comment]`; `↩` replies, and `⋯` holds edit / delete. Comments are queryable: `comment:` searches their
text and `comments:` counts them — per article, or for the whole discussion in STORIES mode (`comments:>=5`,
`comment:"fact check" date:*`). Both need the `comments.read` permission.

## Features
- **58 sources** across the spectrum (L / Lean L / Center / Lean R / R), legacy + new media
  (Daily Wire, Free Press, Breitbart, Federalist, Blaze, Daily Caller, Zeteo, Meidas, Tangle, Semafor, …)
- **STORIES** mode clusters the same story across outlets and shows a bias bar + L/C/R counts — stories are kept
  tight: where both articles are in the morgue their full texts must agree, a story spans at most 72 hours, and
  articles that reached a story only through a chain of loosely related ones are set loose
- **BLINDSPOT** mode: stories covered almost exclusively by one side
- **STREAM** mode: flat, per-article feed
- **Votes**: ▲/▼ a source to scale its weight (×1.25 per vote) in the community or your personal ranking. Affects ranking and which outlet "leads" a story
- **Add sources** from the UI (`+ ADD` or `a`): paste any site URL and it auto-discovers the RSS/Atom feed
- Edit any source's bias rating / media type, disable or delete it

Above the toolbar, a **headline ticker** scrolls the day's top live stories (last 24 h, independent of the
query) between `//` marks; hover pauses it, click opens the story popover (as for a STREAM headline; `j`/`k` step through the ticker). It refreshes with each feed sync. `ticker off` / `ticker on` (or just `ticker`) hides or shows it; `ticker slow|medium|fast` sets the speed (slow by default), and `ticker stop` holds it still so you can scroll it sideways by hand.

## Toolbar filters = query shortcuts
The bias, media, BLINDSPOT and window buttons — and clicking an outlet's name in the sidebar — don't hold
hidden state; they edit the query: `bias:(l OR ll)`, `type:new`, `blindspot:any`, `source:npr`,
`age:<24h` / `age:<7d` / `date:*` (all time, archive). Typing `source:npr` highlights NPR in the sidebar.
Clicking an active button removes its clause; shift-click a bias button to pick only that one. The
highlighted buttons are read back from the query, so typing `bias:>0` lights up LR and R.
STORIES/STREAM and sort are display settings and stay outside the query.

## Query language
The `query //` box (and the `query` terminal command) take Lucene-style queries, with syntax
highlighting, live validation and Tab autocomplete for fields, values and source ids.

```
nvidia huang                         terms are ANDed; word-prefix match
"house speaker"                      phrase
source:(dailywire OR npr)            field applied to a group
a OR b · a AND b · NOT a · -a · !a   boolean ops, ( ) grouping, also && ||
trump*  te?t  huang~1                wildcards, fuzzy
title:/gta ?(6|vi)/                  regex
bias:[l TO ll]  bias:>0  votes:>=3   ranges ([ ] inclusive, { } exclusive, * open) and comparisons
age:<6h  date:today  date:>=2026-11-17
body:"court documents" words:>1000   full article text, byline, length (see Full-text archive)
sources:>=5 AND right:0              story-level fields
```
Article fields: `title summary text body author words morgue comment comments read story topic source domain bias side type votes age date`
Story fields: `sources articles left center right blindspot lean`

In STORIES mode, article fields match if *any* article in the story matches, so
`source:dailywire AND title:nvidia` finds stories covered by the Daily Wire that are about Nvidia.
Run `help query` in the terminal for the full reference.

## Advanced query editor
`[⌨ advanced]` in the query box (or `e`, or `advanced` in the terminal) opens a full-size editor for
the same Lucene syntax: multi-line, syntax-highlighted, inline error position, Tab/caret autocomplete
for fields and values, live hit count (and whether it hits the ▤ archive), `FORMAT` to put each
top-level clause on its own line, a clickable field reference and example queries.
`Enter` (or `Ctrl+Enter`) applies, `Shift+Enter` adds a line; `SAVE AS TAB…` saves it.

## Sidebar
The sidebar has two tabs (`side stats|sources` in the terminal; the choice is remembered):
- **STATS** (default) — quick stats for the current query, updated with every search: totals, bias of
  coverage, a coverage-over-time sparkline, top outlets, story lean and blindspots (STORIES mode), and
  headline words overall and per side. Click a bias segment, outlet, word or blindspot count to narrow the
  query to it; `[full query summary ▸]` opens the full popover.
- **SOURCES** — the outlet list: vote, enable/disable, edit, filter and sort, `+ ADD`.

## Query summary
`[▥ stats]` in the query box (or `g`, or `stats` in the terminal) summarizes the current query's full
result set: totals, coverage by outlet bias (articles, outlets, sides, media type, story lean),
coverage over time stacked by side (hover for values, `[table]` for the numbers), top outlets,
stories by number of outlets, most common headline words, and the words left- vs right-leaning
outlets use disproportionately. Click any bar, outlet, column or word to narrow the query to it.
Large archive queries are summarized from an evenly spread sample (counts marked `~`).

## Live window
The live view covers the last 14 days. RSS feeds only carry each outlet's newest items, so every sync is
merged into what STRINGER already holds instead of replacing it, and articles drop out only when they turn
14 days old. On startup the window is reloaded from the archive (real headlines only: live feeds, Wayback
feed snapshots, HN), which also fills days from before the server was running.

## Historical archive
Every article is also stored in a local SQLite + full-text index (`data/archive.db`). A background
backfill fills it with history:
- **outlet sitemaps** — deep (often back to 2000+), headlines rebuilt from article URLs (shown with `≈`)
- **Wayback Machine snapshots of each RSS feed** — real headlines and summaries, sampled
  monthly → weekly → daily; also covers outlets that block sitemap access
- **live feeds** from now on, and **Hacker News** via its public API

Queries with a `date:` outside the live window (or the window set to `ALL`) search the archive:
`date:2016 trump`, `date:[2008-09-01 TO 2008-11-30] title:bailout`, `source:breitbart date:2017-01`.
Archive results are always listed as articles (STREAM) and paged through the whole match set, sorted
LATEST or OLDEST — story grouping (STORIES, BLINDSPOT, TOP/COVERAGE sorts and story fields like `sources:`)
is only available for the live feeds. Very large match sets show an estimated total (`~`).
Clicking an archive result (or `Enter`) opens an **archive article** popover instead of the story popover: the
article, how it got into the archive (live feed, Wayback feed snapshot, outlet sitemap, HN), its stored full text
(or a note that reading it will fetch and save it), the outlet, and **related coverage** — other outlets'
archived headlines from ±2 days that share its distinctive words, by side, with `[query these ▸]` to turn the
most-shared pair of words into an archive query. `j`/`k` step through the results, `⏎`/`o` reads it.
`[archive]` in the header shows per-outlet coverage and backfill progress; pause/resume there or with
`archive pause` / `archive start [YYYY]`. Run with `BACKFILL=0` to disable crawling.

Expect the archive to reach roughly 10–20M articles / 8–12 GB. The sitemap pass takes hours; the
Wayback pass is rate-limited for politeness and takes a few days to complete.

## Full-text archive
Every article that appears in the live feeds is fetched once in the background (`lib/harvest-worker.js`),
run through the reader-view extraction, and its text stored in the archive with its own full-text index.
That adds three query fields, usable on the live feeds and the archive alike:

```
body:tariff*                         words in the article text (word / phrase / wildcard / fuzzy / regex)
body:/\$\d+ billion/                  regex over the full text
author:"jane doe"                    byline
morgue:fa5ee277                      an article in the STRINGER morgue, by its morgue no.
comment:"good point"  comments:>=5   comment text / number of comments (STORIES mode: the whole discussion)
words:>1500  words:0                 article length (0 = no full text stored)
```
An article whose full text STRINGER has saved is filed in the **STRINGER morgue** (newsrooms' name for their archive of
clippings) under its own **morgue no.** — 8 random hex characters, unique (`morgue no. fa5ee277`; click it to copy) —
and carries a `▣ MORGUE` tag showing its morgue no. (click to copy; hover for the word count and save date) in the
popovers and the reader header — and on STREAM rows once the article is older than the 14-day live window. STORIES-mode
rows don't show it: the story is the focus there. `morgue:fa5ee277` finds one again (`uuid:`/`nid:` work too);
`morgue:*` matches everything in the morgue; `/api/read?morgue=fa5ee277` opens it. A morgue no. lookup searches **all time** unless
the query has its own `date:`/`age:` clause (it's usually an older article), and a query that is just a morgue no.
(`fa5ee277`) is read as `morgue:fa5ee277`. Opening an article whose headline was rebuilt from its URL (`≈`) replaces that
headline (and an empty summary / approximate date) with the real one from the page once its text is archived.

Bare words search headline + summary; `text:` searches **everywhere** — headline, summary and the full text (it's `(text:X OR body:X)` underneath, so `text:outage` finds articles that only mention it in their body). (`body:` used to be an alias of `summary:`
and now means the full text.) Results with stored text carry a `¶1.2k` word-count badge, and for `body:` queries
the matching passage replaces the summary, with the match highlighted. The reader opens the stored copy instantly,
so it keeps working after a page is paywalled or taken down. Reader views you open also fill the archive.

The harvester is polite: 4 pages at a time, one at a time per site with a 2.5 s gap. A site that refuses three
times in a row (HTTP 401/403) is left alone for 6 h, and refused pages are never retried. On startup it also
catches up on live-feed articles from the last 7 days (`FULLTEXT_BACKLOG_DAYS`). Some outlets block automated
requests or paywall their text (NYT, WSJ, Axios, Politico, The Atlantic, The Economist and others), so they
have little or no full text. `[archive]` shows full-text counts per outlet and can pause it; `FULLTEXT=0`
turns it off. It adds roughly 5–10 KB per article (about 5–10 MB a day).

## Saved queries & tabs
Type a query and press `s` (or click `[☆ save]`) to save it. Pinned saved queries become tabs under
the toolbar with live hit counts. Optionally a saved query also remembers the view (mode, sort, time window).
- click a tab to apply it · `[` / `]` cycle tabs · `alt+1…9` jump to a tab
- drag tabs to reorder · right-click (or `⋯`) to rename / edit / unpin / delete
- unpinned queries live under `saved (n) ▾`, and all of them show up when the query box is empty
- terminal: `save <name>`, `saved`, `open <name|n|all>`, `pin`/`unpin <name>`, `unsave <name>`

Saved queries belong to your account (stored in `data/app.db`); visitors who aren't signed in see a few example tabs.

## Reader view
Article links open in a floating reader window instead of a new tab: the server fetches the page and
extracts the article text (`lib/reader.js`, Readability-style, re-serialized through a tag whitelist),
shown in the site's theme with `[A−]`/`[A+]` size and a mono/serif/sans toggle. Sites that block it,
paywalled stubs and script-only pages fall back to the feed summary plus OPEN ORIGINAL / TRY EMBEDDED PAGE.
Old links die (sites restructure their URLs, e.g. Fox's 2015 `/politics/2015/01/04/<slug>/` pages now 404): when
a page is gone (HTTP 404/410, a redirect to the front page, or a "not found" page) the reader shows the Wayback
Machine copy saved closest to the article's publish date, says so, and points OPEN at that copy; it's then stored
like any other reader result. For **archive articles** (older than the live window, or indexed from sitemaps /
Wayback feed snapshots / HN) the Wayback copy is used whenever the original can't be read at all — the site refuses
the request, is unreachable or times out, or has no article text — since it's the historical record of that page. Old Feedsportal feed links (`rss.nytimes.com/c/…`, `feeds.washingtonpost.com/c/…`)
are decoded to the real article URL when feeds are read.
Ctrl/⌘/middle-click any link for a normal new tab. In the story popover, `Enter` (or `o`) reads the lead article; in the reader, `j`/`k` scroll and `Enter`/`o` open the original.

## Keys
`j/k` move · `o`/`Enter` open · `x`/space expand coverage · `u`/`d` vote the selected story's source ·
`/` search · `:` command line · `a` add source · `r` sync · `1/2/3` modes · `?` help ·
`o` read the selected article · `Esc` deselect, then (again) asks to clear the query — `Enter` confirms · `<`/`>` previous/next page (results come 100 per page; `j`/`k` roll over page edges) · `Home`/`End` top/bottom of the page

Under the query, the **extent** line says what was searched: the live feeds (the last 14 days by default, when the
query has no `date:`/`age:` clause) or the ▤ archive with its date range, plus the span of what was found.

Every setting is also a command (type one without a value to see the current setting; `help settings` lists them;
Tab completes setting, role, user and permission names). Your role decides what works — the server enforces the
same permissions, and passwords / the SSO secret are never echoed or kept in the command history:
```
settings · whoami · login · logout · passwd · name <display name> · rank community|personal
discussion open|closed · reader font mono|serif|sans · reader size 13–24 · morgue on|off        (archive.manage)
server [name|url|password-login|signup|default-role|rank-default|upvotes|downvotes <value>]   (settings.manage)
sso [on|off|issuer|client|secret|scopes|label|autocreate|default-role|claim <value>] · sso map <group> <role> · sso test
users · user add|role|disable|enable|passwd|delete <name> …                                 (users.manage)
roles · perms · role add <id> [name] [from <role>] · role grant|revoke <role> <perm…> · role delete <id>
admin [users|roles|settings|sso]
```

Command line (Tab autocompletes): `help`, `query <lucene>`, `add <url>`, `up dailywire`, `down cnbc`, `solo reason`, `bias l r`,
`theme mono|green|amber|cyan|red` (mono is the default), `img off`, `crt off`, `ticker off|stop|slow|medium|fast`, `top`, `sync`.

## Data
Outlets and their bias ratings are in `data/sources.json`; accounts, roles, settings, votes, saved tabs and
comments in `data/app.db`; the archive and the morgue in `data/archive.db`. Back up the whole folder.
A server upgraded from the single-user version shows the setup wizard once; its saved tabs and outlet votes
become the new admin's.
Bias ratings are approximations of public ratings (AllSides / Ad Fontes style) — edit them to taste.

## License
STRINGER is free software under the [GNU Affero General Public License v3.0 or later](LICENSE): you can use,
change and share it, and if you run a modified version as a service for others, you must offer them its source too.
