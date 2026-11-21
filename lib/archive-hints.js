// Per-source tweaks for the historical backfill. Anything not listed uses the generic rules.
//   sitemap: false          skip sitemap crawling (no usable sitemaps / no headline in URLs)
//   wayback: false          skip Wayback Machine feed snapshots
//   hn: true                use the Hacker News Algolia API instead
//   seeds: [...]            extra sitemap roots (besides robots.txt)
//   sitemapInclude/Exclude  regex on child-sitemap URLs
//   urlExclude              regex on article URLs
//   legacyFeeds: [...]      older feed URLs to look up in the Wayback Machine
export const HINTS = {
  bbc: { sitemap: false, legacyFeeds: ['http://feeds.bbci.co.uk/news/world/rss.xml', 'http://feeds.bbci.co.uk/news/rss.xml'] },
  hn: { sitemap: false, wayback: false, hn: true },
  cbs: { urlExclude: /cbsnews\.com\/(?!news\/)[^/]+\/(news|video|live)\//i },
  axios: { urlExclude: /\/local\//i, sitemapExclude: /\/sitemaps\/(?!(news|national|sitemap|index))[a-z-]+\//i },
  france24: { sitemapInclude: /\/en\//i, urlExclude: /france24\.com\/(?!en\/)/i },
  dw: { sitemapInclude: /\/en\//i },
  aljazeera: { sitemapInclude: /article|sitemap(index)?\.xml/i },
  nbc: { sitemapExclude: /video|msnbc|today|select|shopping|think/i, urlExclude: /\/select\//i },
  pbs: { sitemapInclude: /newshour/i },
  wapo: { sitemapExclude: /video|arcio\/sitemap\/video/i, urlExclude: /creativegroup|brand-studio|\/wp-srv\//i },
  npr: { sitemapExclude: /music|podcast|programs|sections/i },
  fox: { legacyFeeds: ['http://feeds.foxnews.com/foxnews/latest', 'http://feeds.foxnews.com/foxnews/national', 'http://feeds.foxnews.com/foxnews/politics'] },
  thehill: { legacyFeeds: ['http://thehill.com/rss/syndicator/19109', 'https://thehill.com/rss/syndicator/19110'] },
  huffpost: { legacyFeeds: ['https://www.huffpost.com/section/front-page/feed', 'http://www.huffingtonpost.com/feeds/index.xml'] },
  dailywire: { legacyFeeds: ['https://www.dailywire.com/rss.xml', 'https://www.dailywire.com/feeds/rss.xml'] },
  politico: { legacyFeeds: ['http://www.politico.com/rss/politicopicks.xml', 'https://www.politico.com/rss/politics08.xml'] },
  washexam: { legacyFeeds: ['https://www.washingtonexaminer.com/tag/news.rss', 'http://www.washingtonexaminer.com/rss/news'] },
  wsj: { legacyFeeds: ['https://feeds.a.dj.com/rss/RSSWorldNews.xml', 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml', 'http://online.wsj.com/xml/rss/3_7085.xml'] },
  semafor: {},
  economist: { legacyFeeds: ['https://www.economist.com/international/rss.xml', 'https://www.economist.com/united-states/rss.xml', 'http://www.economist.com/rss/the_world_this_week_rss.xml'] },
  newsweek: { sitemapExclude: /sitemap-\d{4}\.xml\?v=|video|tag|topic|author|amp/i },
  axios_local: {},
};

export const hintsFor = (id) => HINTS[id] || {};
