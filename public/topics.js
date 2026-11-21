// Topics: a small fixed set, assigned per article without any model. Shared by the server (the topic: query field,
// stats) and the client (labels, autocomplete).
//   1. the link's section path — outlets file stories under /politics/, /sport/, /arts/… and that is the most
//      reliable signal there is (it's also all we have for archive articles rebuilt from sitemaps)
//   2. otherwise keywords in the headline (×2) and summary (×1); the best topic needs a score of at least 2
// A story's topic is the most common topic among its articles.

export const TOPICS = ['politics', 'world', 'business', 'tech', 'science', 'health', 'crime', 'sports', 'culture'];
export const TOPIC_DESC = {
  politics: 'government, elections, courts, policy',
  world: 'international affairs, wars, diplomacy',
  business: 'companies, markets, the economy, jobs',
  tech: 'technology, AI, the internet, gadgets, games',
  science: 'science, space, climate and the environment',
  health: 'medicine, public health, wellness',
  crime: 'crime, police, trials, disasters and accidents',
  sports: 'sports',
  culture: 'entertainment, arts, books, film, music, TV, food, style, travel',
  other: 'none of the above (or not enough to tell)',
};

// URL path segments → topic (first segment that matches wins; date segments etc. are skipped)
const PATHS = {
  politics: 'politics political elections election election-2024 election-2026 2024-elections 2026-elections midterms campaign congress senate house-of-representatives white-house government us-politics uspolitics supreme-court policy capitol-hill immigration',
  world: 'world world-news worldnews international foreign global middle-east middleeast europe asia africa americas latin-america australia-news uk-news canada ukraine russia israel gaza china india europe-news asia-pacific',
  business: 'business money economy economics markets market finance financial companies personal-finance real-estate realestate jobs work wealth investing stocks banking retail energy trade',
  tech: 'tech technology technica gadgets ai artificial-intelligence innovation cyber cybersecurity internet gaming games video-games software apple google',
  science: 'science space environment climate climate-environment nature',
  health: 'health wellness medicine healthcare coronavirus covid-19 covid fitness well wellbeing mental-health public-health',
  crime: 'crime crimes crime-courts crime-and-justice true-crime police public-safety courts law justice legal',
  sports: 'sports sport nfl nba mlb nhl wnba mls soccer football golf tennis olympics college-football college-basketball ncaa cricket rugby f1 formula-1 boxing mma ufc athletics espn',
  culture: 'entertainment culture arts art books movies movie film music tv television style lifestyle celebrity celebrities fashion food dining travel theater theatre hollywood pop-culture life living media recipes',
};
const PATH = new Map();
for (const [t, s] of Object.entries(PATHS)) for (const seg of s.split(/\s+/)) PATH.set(seg, t);

// keywords (lowercase; a trailing * = any ending)
const KW = {
  politics: `trump biden harris obama vance congress congressional senate senator senators gop republican* democrat* democratic
    election* electoral ballot* vote* voter* voting campaign* governor* legislat* lawmaker* bill speaker filibuster impeach*
    supreme court justice* scotus white house administration cabinet president presidential primary primaries caucus*
    doj fbi attorney general indict* subpoena* pardon* tariff* shutdown immigration ice deport* border medicaid
    jeffries schumer mcconnell thune pelosi newsom desantis mayor* politic* maga mamdani partisan`,
  world: `ukraine* russia* putin zelensky* kremlin nato israel* gaza hamas hezbollah iran* tehran netanyahu china chinese beijing
    taiwan* xi syria* yemen houthi* lebanon* venezuela* maduro mexico* canada* carney india* modi pakistan* korea* kim
    japan* europe* european eu brussels britain british uk starmer france* macron germany* german merz africa* sudan*
    ceasefire diplomat* embassy* sanctions refugee* un united nations foreign war wars military pentagon troops missile*
    drone* summit*`,
  business: `stock* market* wall street dow nasdaq s&p investor* earnings revenue profit* shares ipo economy economic* inflation
    recession fed federal reserve interest rate* jobs unemployment layoff* hiring ceo* company companies corporate merger*
    acquisition* billion* retail* bank* banking mortgage* housing prices consumer* startup* oil gas price*`,
  tech: `ai artificial intelligence chatgpt openai anthropic claude gemini nvidia apple iphone* google microsoft meta facebook
    instagram tiktok twitter x.com musk tesla spacex software app apps chip* semiconductor* data center* cyber* hack* hacker*
    internet online robot* gadget* smartphone* android video game* gaming playstation xbox nintendo crypto* bitcoin
    blockchain tech technology startup*`,
  science: `science* scientist* study researchers research nasa space spacecraft rocket* astronaut* moon mars planet* asteroid*
    telescope climate warming emissions carbon environment* environmental species wildlife fossil* dinosaur* physics
    biology* genetic* dna ocean* earthquake* hurricane* wildfire* storm* weather`,
  health: `health* medical medicine* doctor* hospital* patient* disease* virus* vaccine* vaccin* covid flu outbreak* cancer
    drug* fda cdc rfk kennedy obesity diet* mental heart surgery nurse* pandemic measles alzheimer* diabetes abortion*
    overdose* fentanyl opioid* wellness`,
  crime: `police cop cops officer* shooting* gunman murder* homicide* killed killing* stabb* arrest* charged suspect*
    sentenced convicted conviction guilty jail* prison* inmate* robbery robber* theft thief steal* stole* fraud scam*
    kidnap* missing assault* rape trafficking detective* manhunt crash* execution* trial verdict jury jurors crime*
    criminal* gun* firearm* victim* dead died`,
  sports: `nfl nba mlb nhl wnba mls ncaa super bowl world series playoff* championship* coach* quarterback* touchdown* season
    game* team* player* league* soccer football basketball baseball hockey tennis golf olympic* olympics athlete* match
    tournament* espn mvp draft roster* score* scored win wins beat beats loss defeat* stadium fifa ufc boxing f1 nascar
    texans colts cowboys chiefs eagles lakers yankees dodgers`,
  culture: `movie* film* hollywood actor* actress* star* celebrity* singer* album* song* music* concert* tour grammy* oscar*
    emmy* netflix disney hbo streaming tv television show* series sitcom book* novel* author* art artist* museum* theater
    broadway fashion style food restaurant* recipe* chef* travel royal* prince* princess* taylor swift beyonce kardashian*
    gta grand theft auto festival* comedian*`,
};
const KW_RE = {};
for (const [t, s] of Object.entries(KW)) {
  const parts = s.split(/\s+/).filter(Boolean).map((w) => (w.endsWith('*') ? `${esc(w.slice(0, -1))}\\w*` : `${esc(w)}s?`));
  KW_RE[t] = new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// multi-word keywords are written as separate words above, so pairs like "white house" score twice: fine.
const count = (re, s) => (s ? (s.match(re) || []).length : 0);

export function topicFromPath(link) {
  let path;
  try { path = new URL(link).pathname.toLowerCase(); } catch { return null; }
  const segs = path.split('/').filter(Boolean);
  for (const seg of segs.slice(0, 4)) {          // the section is near the start; deeper segments are slugs
    if (/^\d+$/.test(seg)) continue;
    const t = PATH.get(seg);
    if (t) return t;
  }
  return null;
}

export function topicFromText(title, summary) {
  let best = 'other', bestScore = 1;
  for (const t of TOPICS) {
    const sc = 2 * count(KW_RE[t], title) + count(KW_RE[t], summary);
    if (sc > bestScore) { best = t; bestScore = sc; }
  }
  return best;
}

const cache = new Map();
export function topicOf(a) {
  const key = a.link || a.title;
  let t = cache.get(key);
  if (t) return t;
  t = topicFromPath(a.link) || topicFromText(a.title || '', a.summary || '');
  if (cache.size > 200000) cache.clear();
  cache.set(key, t);
  return t;
}

// the topic of a group of articles: the most common one that isn't "other" (ties → the earlier article's)
export function topicOfMany(articles) {
  const n = new Map();
  for (const a of articles) { const t = topicOf(a); if (t !== 'other') n.set(t, (n.get(t) || 0) + 1); }
  let best = 'other', c = 0;
  for (const [t, k] of n) if (k > c) { best = t; c = k; }
  return best;
}
