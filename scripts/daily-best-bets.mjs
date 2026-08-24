// Daily Best Bets email job — runs via GitHub Actions on a schedule.
// Computes qualifying "top form vs bottom form" fixtures across all leagues
// directly against API-Football, then emails the results via Resend.
//
// Required environment variables (set as GitHub repo secrets):
//   AF_KEY       — API-Football API key
//   RESEND_KEY   — Resend API key
//   EMAIL_TO     — recipient email address

const AF_BASE = 'https://v3.football.api-sports.io';
const AF_KEY  = process.env.AF_KEY;

const RESEND_KEY = process.env.RESEND_KEY;
const EMAIL_TO   = process.env.EMAIL_TO;
const EMAIL_FROM = 'onboarding@resend.dev'; // Resend's free sandbox sender

if (!AF_KEY || !RESEND_KEY || !EMAIL_TO) {
  console.error('Missing required environment variables: AF_KEY, RESEND_KEY, EMAIL_TO');
  process.exit(1);
}

// Full league list — kept in sync with index.html's ALL_LEAGUES
const LEAGUES = [
  { code: 'AF_ENG_PL',  label: 'Premier League',    afName: 'Premier League',    afCountry: 'England' },
  { code: 'AF_ENG_CH',  label: 'Championship',      afName: 'Championship',      afCountry: 'England' },
  { code: 'AF_ENG_L1',  label: 'League One',        afName: 'League One',        afCountry: 'England' },
  { code: 'AF_ENG_L2',  label: 'League Two',        afName: 'League Two',        afCountry: 'England' },
  { code: 'AF_ENG_NL',  label: 'National League',   afName: 'National League',   afCountry: 'England' },
  { code: 'AF_ESP_LL',  label: 'La Liga',           afName: 'La Liga',           afCountry: 'Spain' },
  { code: 'AF_ESP_SD',  label: 'Segunda División',  afName: 'Segunda Division',  afCountry: 'Spain' },
  { code: 'AF_GER_BL',  label: 'Bundesliga',        afName: 'Bundesliga',    afCountry: 'Germany' },
  { code: 'AF_GER_2BL', label: '2. Bundesliga',     afName: '2. Bundesliga', afCountry: 'Germany' },
  { code: 'AF_GER_3L',  label: '3. Liga',           afName: '3. Liga',       afCountry: 'Germany' },
  { code: 'AF_ITA_SA',  label: 'Serie A',           afName: 'Serie A', afCountry: 'Italy' },
  { code: 'AF_ITA_SB',  label: 'Serie B',           afName: 'Serie B', afCountry: 'Italy' },
  { code: 'AF_ITA_SC',  label: 'Serie C',           afName: 'Serie C', afCountry: 'Italy' },
  { code: 'AF_BRA_SA',  label: 'Brasileirão',       afName: 'Serie A',    afCountry: 'Brazil' },
  { code: 'AF_FRA_L1',  label: 'Ligue 1',           afName: 'Ligue 1',    afCountry: 'France' },
  { code: 'AF_FRA_L2',  label: 'Ligue 2',           afName: 'Ligue 2',    afCountry: 'France' },
  { code: 'AF_NED_ED',  label: 'Eredivisie',        afName: 'Eredivisie',     afCountry: 'Netherlands' },
  { code: 'AF_NED_ED2', label: 'Eerste Divisie',    afName: 'Eerste Divisie', afCountry: 'Netherlands' },
  { code: 'AF_POR_PL',  label: 'Primeira Liga',     afName: 'Primeira Liga', afCountry: 'Portugal' },
  { code: 'AF_ARG_LP',  label: 'Liga Profesional',  afName: 'Liga Profesional Argentina', afCountry: 'Argentina' },
  { code: 'AF_AUT_BL',  label: 'Bundesliga (AUT)',  afName: 'Bundesliga',      afCountry: 'Austria' },
  { code: 'AF_BEL_PL',  label: 'Pro League',        afName: 'Jupiler Pro League', afCountry: 'Belgium' },
  { code: 'AF_CRO_HNL', label: 'HNL',               afName: 'HNL',             afCountry: 'Croatia' },
  { code: 'AF_MEX_LM',  label: 'Liga MX',           afName: 'Liga MX',         afCountry: 'Mexico' },
  { code: 'AF_SCO_PR',  label: 'Premiership',       afName: 'Premiership',   afCountry: 'Scotland' },
  { code: 'AF_SCO_CH',  label: 'Championship (SCO)',afName: 'Championship',  afCountry: 'Scotland' },
  { code: 'AF_SWE_AS',  label: 'Allsvenskan',       afName: 'Allsvenskan',     afCountry: 'Sweden' },
  { code: 'AF_TUR_SL',  label: 'Süper Lig',         afName: 'Super Lig',       afCountry: 'Turkey' },
  { code: 'AF_USA_MLS', label: 'MLS',               afName: 'Major League Soccer', afCountry: 'USA' },
  { code: 'AF_SUI_SL',  label: 'Super League',      afName: 'Super League',    afCountry: 'Switzerland' },
];

// ── Paced fetch with retry-with-backoff on rate-limit errors ──
let _lastAfCall = 0;
async function afFetch(path) {
  const wait = Math.max(0, _lastAfCall + 300 - Date.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastAfCall = Date.now();

  let attempt = 0;
  const maxAttempts = 5;
  while (true) {
    const res = await fetch(AF_BASE + path, { headers: { 'x-apisports-key': AF_KEY } });
    const json = await res.json();
    if (json.errors && Object.keys(json.errors).length > 0) {
      const msg = Object.values(json.errors).join('; ');
      const isRateLimit = msg.toLowerCase().includes('too many requests') || msg.toLowerCase().includes('rate');
      if (isRateLimit && attempt < maxAttempts) {
        attempt++;
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 15000);
        console.log(`  [retry ${attempt}/${maxAttempts}] ${path} — waiting ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        _lastAfCall = Date.now();
        continue;
      }
      throw new Error(msg);
    }
    return json;
  }
}

function seasonYearForDate(date) {
  const yr = date.getUTCFullYear();
  const mo = date.getUTCMonth() + 1;
  return mo >= 7 ? yr : yr - 1;
}

function bestBetCutoff(teamCount) {
  return teamCount <= 16 ? 2 : 3;
}

async function resolveLeagueId(afName, afCountry) {
  const data = await afFetch(`/leagues?name=${encodeURIComponent(afName)}&country=${encodeURIComponent(afCountry)}`);
  const match = (data.response || [])[0];
  if (!match) throw new Error(`Could not resolve ${afName} (${afCountry})`);
  return match.league.id;
}

async function loadLeagueBestBets(leagueDef, asOf) {
  const season = seasonYearForDate(asOf);
  const leagueId = await resolveLeagueId(leagueDef.afName, leagueDef.afCountry);

  const standRes = await afFetch(`/standings?league=${leagueId}&season=${season}`);
  const standingsGroup = standRes.response?.[0]?.league?.standings?.[0] || [];
  if (standingsGroup.length === 0) return [];

  const fixRes = await afFetch(`/fixtures?league=${leagueId}&season=${season}`);
  const allMatches = (fixRes.response || []).map(f => ({
    id: f.fixture.id,
    utcDate: f.fixture.date,
    status: ['FT', 'AET', 'PEN'].includes(f.fixture.status.short) ? 'FINISHED' : 'SCHEDULED',
    homeTeam: { id: f.teams.home.id, name: f.teams.home.name },
    awayTeam: { id: f.teams.away.id, name: f.teams.away.name },
    score: { fullTime: { home: f.goals.home, away: f.goals.away } },
  }));

  const teams = standingsGroup.map(row => ({
    id: row.team.id, name: row.team.name,
    pts: 0, played: 0, results: [], formPts: 0,
  }));
  const teamMap = Object.fromEntries(teams.map(t => [t.id, t]));

  const finishedBefore = allMatches
    .filter(m => m.status === 'FINISHED' && new Date(m.utcDate) <= asOf)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));

  for (const m of finishedBefore) {
    const h = teamMap[m.homeTeam.id], a = teamMap[m.awayTeam.id];
    const hg = m.score.fullTime.home, ag = m.score.fullTime.away;
    if (!h || !a || hg === null) continue;
    h.played++; a.played++;
    if (hg > ag)      { h.pts += 3; }
    else if (hg < ag) { a.pts += 3; }
    else              { h.pts += 1; a.pts += 1; }
    if (h.results.length < 8) h.results.push(hg > ag ? 'W' : hg < ag ? 'L' : 'D');
    if (a.results.length < 8) a.results.push(ag > hg ? 'W' : ag < hg ? 'L' : 'D');
  }
  for (const t of teams) {
    for (const r of t.results) {
      if (r === 'W') t.formPts += 3;
      else if (r === 'D') t.formPts += 1;
    }
  }

  const cutoffDate = new Date(asOf.getTime() + 21 * 24 * 60 * 60 * 1000);
  const upcoming = allMatches
    .filter(m => new Date(m.utcDate) > asOf && new Date(m.utcDate) <= cutoffDate)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  const nextRound = {};
  const seen = new Set();
  for (const m of upcoming) {
    const hid = m.homeTeam.id, aid = m.awayTeam.id;
    if (seen.has(hid) || seen.has(aid)) continue;
    if (teamMap[hid] && teamMap[aid]) {
      nextRound[hid] = { opp: aid, home: true, date: m.utcDate, fixtureId: m.id };
      nextRound[aid] = { opp: hid, home: false, date: m.utcDate, fixtureId: m.id };
      seen.add(hid); seen.add(aid);
    }
  }

  const allZeroForm = teams.every(t => t.formPts === 0);
  const sorted = [...teams].sort((a, b) =>
    allZeroForm ? b.pts - a.pts : b.formPts - a.formPts || b.pts - a.pts
  );
  const n = sorted.length;
  if (n < 6) return [];
  const cutoff = bestBetCutoff(n);
  const top = sorted.slice(0, cutoff);
  const bottomIds = new Set(sorted.slice(n - cutoff).map(t => t.id));

  const bets = [];
  for (const qualTeam of top) {
    const fix = nextRound[qualTeam.id];
    if (!fix || !bottomIds.has(fix.opp)) continue;
    const opponent = teamMap[fix.opp];
    if (!opponent) continue;
    const qualRank = sorted.findIndex(t => t.id === qualTeam.id) + 1;
    const oppRank  = sorted.findIndex(t => t.id === opponent.id) + 1;
    bets.push({
      league: leagueDef.label,
      home: fix.home ? qualTeam.name : opponent.name,
      away: fix.home ? opponent.name : qualTeam.name,
      isHome: fix.home,
      qualRank, oppRank,
      ptsDiff: qualTeam.formPts - opponent.formPts,
      date: fix.date,
      fixtureId: fix.fixtureId,
      leagueId, season,
    });
  }
  return bets;
}

async function fetchOddsForFixtures(leagueId, season, fixtureIds) {
  if (!fixtureIds.length) return {};
  try {
    const res = await afFetch(`/odds?league=${leagueId}&season=${season}`);
    const map = {};
    for (const entry of (res.response || [])) {
      const fid = entry.fixture?.id;
      if (!fid || !fixtureIds.includes(fid)) continue;
      const bookmaker = (entry.bookmakers || [])[0];
      const bet = bookmaker?.bets?.find(b => b.name === 'Match Winner');
      if (!bet) continue;
      const vals = {};
      for (const v of (bet.values || [])) {
        if (v.value === 'Home') vals.home = v.odd;
        if (v.value === 'Draw') vals.draw = v.odd;
        if (v.value === 'Away') vals.away = v.odd;
      }
      map[fid] = vals;
    }
    return map;
  } catch { return {}; }
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function buildEmailHtml(betsByLeague, dateStr) {
  const allBets = Object.values(betsByLeague).flat();
  if (allBets.length === 0) {
    return `<div style="font-family:sans-serif;padding:20px">
      <h2>Best Bets — ${dateStr}</h2>
      <p>No qualifying best bets found today across any league.</p>
    </div>`;
  }

  allBets.sort((a, b) => b.ptsDiff - a.ptsDiff);

  const rows = allBets.map(b => {
    const homeColor = b.isHome ? '#1a7f37' : '#666';
    const awayColor = b.isHome ? '#666' : '#0969da';
    const odds = b.odds && (b.odds.home || b.odds.draw || b.odds.away)
      ? `<div style="font-size:12px;color:#888;margin-top:4px">
           ${b.odds.home ? `H: ${b.odds.home} ` : ''}${b.odds.draw ? `D: ${b.odds.draw} ` : ''}${b.odds.away ? `A: ${b.odds.away}` : ''}
         </div>`
      : '';
    return `
      <tr>
        <td style="padding:12px;border-bottom:1px solid #eee">
          <div style="font-weight:600;font-size:14px">
            <span style="color:${homeColor}">${b.home}</span>
            <span style="color:#999;font-size:12px"> vs </span>
            <span style="color:${awayColor}">${b.away}</span>
          </div>
          <div style="font-size:12px;color:#888;margin-top:2px">
            ${b.league} · Rank #${b.qualRank} vs #${b.oppRank} · +${b.ptsDiff} pts gap · ${formatDate(b.date)}
          </div>
          ${odds}
        </td>
      </tr>`;
  }).join('');

  return `
  <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto">
    <h2 style="font-size:18px;margin-bottom:4px">⚽ Best Bets — ${dateStr}</h2>
    <p style="font-size:13px;color:#888;margin-top:0">
      ${allBets.length} qualifying bet${allBets.length === 1 ? '' : 's'} across ${Object.keys(betsByLeague).filter(k => betsByLeague[k].length).length} leagues
    </p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
  </div>`;
}

async function main() {
  const asOf = new Date();

  // The workflow runs twice daily (to cover both PST and PDT) — only actually
  // proceed if it's really 8am in Los Angeles right now. Manual runs (workflow_dispatch)
  // set SKIP_HOUR_CHECK=true so you can test at any time of day.
  const hourInLA = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    hour12: false,
  }).format(asOf);
  if (hourInLA !== '08' && process.env.SKIP_HOUR_CHECK !== 'true') {
    console.log(`Current LA hour is ${hourInLA}, not 08 — skipping this run (covers the other DST offset).`);
    return;
  }

  const betsByLeague = {};
  const leagueErrors = {};

  console.log(`Starting daily Best Bets job — ${LEAGUES.length} leagues, as of ${asOf.toISOString()}`);

  for (const leagueDef of LEAGUES) {
    process.stdout.write(`  ${leagueDef.label}... `);
    try {
      const bets = await loadLeagueBestBets(leagueDef, asOf);
      if (bets.length > 0) {
        const leagueId = bets[0].leagueId, season = bets[0].season;
        const fixtureIds = bets.map(b => b.fixtureId);
        const oddsMap = await fetchOddsForFixtures(leagueId, season, fixtureIds);
        for (const b of bets) b.odds = oddsMap[b.fixtureId] || null;
      }
      betsByLeague[leagueDef.code] = bets;
      console.log(`${bets.length} bet(s)`);
    } catch (e) {
      betsByLeague[leagueDef.code] = [];
      leagueErrors[leagueDef.code] = e.message || String(e);
      console.log(`FAILED: ${e.message}`);
    }
  }

  const totalBets = Object.values(betsByLeague).flat().length;
  console.log(`\nTotal qualifying bets: ${totalBets}`);
  if (Object.keys(leagueErrors).length > 0) {
    console.log(`Leagues with errors: ${Object.keys(leagueErrors).length}`);
  }

  const dateStr = asOf.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const html = buildEmailHtml(betsByLeague, dateStr);

  console.log('Sending email via Resend...');
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [EMAIL_TO],
      subject: `Best Bets — ${dateStr}`,
      html,
    }),
  });
  const emailResult = await emailRes.text();
  console.log(`Email status: ${emailRes.status}`);
  console.log(`Email response: ${emailResult}`);

  if (!emailRes.ok) {
    console.error('Email failed to send');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Job failed:', err);
  process.exit(1);
});
