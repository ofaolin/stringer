// Bias scale: -2 LEFT, -1 LEAN LEFT, 0 CENTER, 1 LEAN RIGHT, 2 RIGHT
// Ratings are approximations based on public media-bias ratings (AllSides / Ad Fontes style).
// Every rating is editable from the UI.
// type: 'legacy' = traditional outlets, 'new' = new/independent/digital-native media

export const DEFAULT_SOURCES = [
  // ── LEFT ───────────────────────────────────────────────
  { id: 'guardian', name: 'The Guardian', bias: -2, type: 'legacy', site: 'https://www.theguardian.com', feed: 'https://www.theguardian.com/us-news/rss' },
  { id: 'huffpost', name: 'HuffPost', bias: -2, type: 'new', site: 'https://www.huffpost.com', feed: 'https://www.huffpost.com/section/politics/feed' },
  { id: 'vox', name: 'Vox', bias: -2, type: 'new', site: 'https://www.vox.com', feed: 'https://www.vox.com/rss/index.xml' },
  { id: 'motherjones', name: 'Mother Jones', bias: -2, type: 'legacy', site: 'https://www.motherjones.com', feed: 'https://www.motherjones.com/feed/' },
  { id: 'intercept', name: 'The Intercept', bias: -2, type: 'new', site: 'https://theintercept.com', feed: 'https://theintercept.com/feed/?rss' },
  { id: 'thenation', name: 'The Nation', bias: -2, type: 'legacy', site: 'https://www.thenation.com', feed: 'https://www.thenation.com/feed/?post_type=article' },
  { id: 'jacobin', name: 'Jacobin', bias: -2, type: 'new', site: 'https://jacobin.com', feed: 'https://jacobin.com/feed' },
  { id: 'democracynow', name: 'Democracy Now!', bias: -2, type: 'new', site: 'https://www.democracynow.org', feed: 'https://www.democracynow.org/democracynow.rss' },
  { id: 'slate', name: 'Slate', bias: -2, type: 'new', site: 'https://slate.com', feed: 'https://slate.com/feeds/all.rss' },
  { id: 'meidas', name: 'MeidasTouch', bias: -2, type: 'new', site: 'https://www.meidasplus.com', feed: 'https://www.meidasplus.com/feed' },
  { id: 'zeteo', name: 'Zeteo', bias: -2, type: 'new', site: 'https://zeteo.com', feed: 'https://zeteo.com/feed' },

  // ── LEAN LEFT ──────────────────────────────────────────
  { id: 'nyt', name: 'New York Times', bias: -1, type: 'legacy', site: 'https://www.nytimes.com', feed: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' },
  { id: 'wapo', name: 'Washington Post', bias: -1, type: 'legacy', site: 'https://www.washingtonpost.com', feed: 'https://feeds.washingtonpost.com/rss/national' },
  { id: 'npr', name: 'NPR', bias: -1, type: 'legacy', site: 'https://www.npr.org', feed: 'https://feeds.npr.org/1001/rss.xml' },
  { id: 'economist', name: 'The Economist', bias: -1, type: 'legacy', site: 'https://www.economist.com', feed: 'https://www.economist.com/latest/rss.xml' },
  { id: 'nbc', name: 'NBC News', bias: -1, type: 'legacy', site: 'https://www.nbcnews.com', feed: 'https://feeds.nbcnews.com/nbcnews/public/news' },
  { id: 'abc', name: 'ABC News', bias: -1, type: 'legacy', site: 'https://abcnews.go.com', feed: 'https://abcnews.go.com/abcnews/topstories' },
  { id: 'cbs', name: 'CBS News', bias: -1, type: 'legacy', site: 'https://www.cbsnews.com', feed: 'https://www.cbsnews.com/latest/rss/main' },
  { id: 'politico', name: 'Politico', bias: -1, type: 'new', site: 'https://www.politico.com', feed: 'https://rss.politico.com/politics-news.xml' },
  { id: 'atlantic', name: 'The Atlantic', bias: -1, type: 'legacy', site: 'https://www.theatlantic.com', feed: 'https://www.theatlantic.com/feed/all/' },
  { id: 'pbs', name: 'PBS NewsHour', bias: -1, type: 'legacy', site: 'https://www.pbs.org/newshour', feed: 'https://www.pbs.org/newshour/feeds/rss/headlines' },
  { id: 'axios', name: 'Axios', bias: -1, type: 'new', site: 'https://www.axios.com', feed: 'https://api.axios.com/feed/' },
  { id: 'aljazeera', name: 'Al Jazeera', bias: -1, type: 'legacy', site: 'https://www.aljazeera.com', feed: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'bulwark', name: 'The Bulwark', bias: -1, type: 'new', site: 'https://www.thebulwark.com', feed: 'https://www.thebulwark.com/feed' },

  // ── CENTER ─────────────────────────────────────────────
  { id: 'bbc', name: 'BBC News', bias: 0, type: 'legacy', site: 'https://www.bbc.com/news', feed: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'thehill', name: 'The Hill', bias: 0, type: 'legacy', site: 'https://thehill.com', feed: 'https://thehill.com/news/feed/' },
  { id: 'newsweek', name: 'Newsweek', bias: 0, type: 'legacy', site: 'https://www.newsweek.com', feed: 'https://www.newsweek.com/rss' },
  { id: 'csm', name: 'Christian Science Monitor', bias: 0, type: 'legacy', site: 'https://www.csmonitor.com', feed: 'https://rss.csmonitor.com/feeds/all' },
  { id: 'cnbc', name: 'CNBC', bias: 0, type: 'legacy', site: 'https://www.cnbc.com', feed: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { id: 'newsnation', name: 'NewsNation', bias: 0, type: 'legacy', site: 'https://www.newsnationnow.com', feed: 'https://www.newsnationnow.com/feed/' },
  { id: 'dw', name: 'Deutsche Welle', bias: 0, type: 'legacy', site: 'https://www.dw.com', feed: 'https://rss.dw.com/rdf/rss-en-all' },
  { id: 'france24', name: 'France 24', bias: 0, type: 'legacy', site: 'https://www.france24.com/en', feed: 'https://www.france24.com/en/rss' },
  { id: 'tangle', name: 'Tangle', bias: 0, type: 'new', site: 'https://www.readtangle.com', feed: 'https://www.readtangle.com/rss/' },
  { id: 'upi', name: 'UPI', bias: 0, type: 'legacy', site: 'https://www.upi.com', feed: 'https://rss.upi.com/news/top_news.rss' },
  { id: 'skynews', name: 'Sky News', bias: 0, type: 'legacy', site: 'https://news.sky.com', feed: 'https://feeds.skynews.com/feeds/rss/world.xml' },
  { id: 'semafor', name: 'Semafor', bias: 0, type: 'new', site: 'https://www.semafor.com', feed: 'https://www.semafor.com/rss.xml' },
  { id: 'hn', name: 'Hacker News', bias: 0, type: 'new', site: 'https://news.ycombinator.com', feed: 'https://hnrss.org/frontpage?points=100' },

  // ── LEAN RIGHT ─────────────────────────────────────────
  { id: 'wsj', name: 'Wall Street Journal', bias: 1, type: 'legacy', site: 'https://www.wsj.com', feed: 'https://feeds.content.dowjones.io/public/rss/RSSUSnews' },
  { id: 'nypost', name: 'New York Post', bias: 1, type: 'legacy', site: 'https://nypost.com', feed: 'https://nypost.com/news/feed/' },
  { id: 'washexam', name: 'Washington Examiner', bias: 1, type: 'legacy', site: 'https://www.washingtonexaminer.com', feed: 'https://www.washingtonexaminer.com/feed/' },
  { id: 'washtimes', name: 'Washington Times', bias: 1, type: 'legacy', site: 'https://www.washingtontimes.com', feed: 'https://www.washingtontimes.com/rss/headlines/news/' },
  { id: 'reason', name: 'Reason', bias: 1, type: 'legacy', site: 'https://reason.com', feed: 'https://reason.com/feed/' },
  { id: 'dispatch', name: 'The Dispatch', bias: 1, type: 'new', site: 'https://thedispatch.com', feed: 'https://thedispatch.com/feed/' },
  { id: 'freepress', name: 'The Free Press', bias: 1, type: 'new', site: 'https://www.thefp.com', feed: 'https://www.thefp.com/feed' },
  { id: 'realclear', name: 'RealClearPolitics', bias: 1, type: 'new', site: 'https://www.realclearpolitics.com', feed: 'https://www.realclearpolitics.com/index.xml' },
  { id: 'fox', name: 'Fox News', bias: 1, type: 'legacy', site: 'https://www.foxnews.com', feed: 'https://moxie.foxnews.com/google-publisher/latest.xml' },

  // ── RIGHT ──────────────────────────────────────────────
  { id: 'dailywire', name: 'The Daily Wire', bias: 2, type: 'new', site: 'https://www.dailywire.com', feed: 'https://www.dailywire.com/feeds/rss.xml' },
  { id: 'breitbart', name: 'Breitbart', bias: 2, type: 'new', site: 'https://www.breitbart.com', feed: 'https://feeds.feedburner.com/breitbart' },
  { id: 'federalist', name: 'The Federalist', bias: 2, type: 'new', site: 'https://thefederalist.com', feed: 'https://thefederalist.com/feed/' },
  { id: 'dailycaller', name: 'Daily Caller', bias: 2, type: 'new', site: 'https://dailycaller.com', feed: 'https://dailycaller.com/feed/' },
  { id: 'blaze', name: 'TheBlaze', bias: 2, type: 'new', site: 'https://www.theblaze.com', feed: 'https://www.theblaze.com/feeds/feed.rss' },
  { id: 'newsmax', name: 'Newsmax', bias: 2, type: 'new', site: 'https://www.newsmax.com', feed: 'https://www.newsmax.com/rss/Newsfront/16/' },
  { id: 'dailysignal', name: 'The Daily Signal', bias: 2, type: 'new', site: 'https://www.dailysignal.com', feed: 'https://www.dailysignal.com/feed/' },
  { id: 'nationalreview', name: 'National Review', bias: 2, type: 'legacy', site: 'https://www.nationalreview.com', feed: 'https://www.nationalreview.com/feed/' },
  { id: 'freebeacon', name: 'Washington Free Beacon', bias: 2, type: 'new', site: 'https://freebeacon.com', feed: 'https://freebeacon.com/feed/' },
  { id: 'postmillennial', name: 'The Post Millennial', bias: 2, type: 'new', site: 'https://thepostmillennial.com', feed: 'https://thepostmillennial.com/feed' },
  { id: 'amcon', name: 'The American Conservative', bias: 2, type: 'legacy', site: 'https://www.theamericanconservative.com', feed: 'https://www.theamericanconservative.com/feed/' },
  { id: 'townhall', name: 'Townhall', bias: 2, type: 'new', site: 'https://townhall.com', feed: 'https://townhall.com/feed' },
];
