// MiLB Report data updater.
// Reads rankings.csv, pulls bios, stats and transactions from MLB's public Stats API,
// and writes site/data/site.json for the website to read.
// Run: node scripts/update.mjs   (Node 20+, no packages needed)

import fs from "node:fs/promises";
import path from "node:path";

const API = "https://statsapi.mlb.com/api/v1";
const RANKINGS_FILE = process.env.RANKINGS || "rankings.csv";
const OUT_DIR = process.env.OUT_DIR || "site/data";
const TODAY = process.env.TODAY ? new Date(process.env.TODAY + "T12:00:00Z") : new Date();
const WIRE_DAYS_FETCH = 14;   // how far back each run looks for new transactions
const WIRE_DAYS_KEEP = 90;    // how long transactions stay on the wire

// sportId -> level label, in order from lowest to highest
const LEVELS = { 16: "ROK", 14: "A", 13: "A+", 12: "AA", 11: "AAA", 1: "MLB" };
const LEVEL_ORDER = ["ROK", "A", "A+", "AA", "AAA", "MLB"];
const SPORT_IDS = Object.keys(LEVELS).join(",");

const log = (...a) => console.log("[ledger]", ...a);
const warn = (...a) => console.warn("[ledger] WARNING:", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d) => d.toISOString().slice(0, 10);

async function get(p) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API + p, { headers: { "User-Agent": "prospect-ledger-updater" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${p}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(500 * attempt);
    }
  }
  throw lastErr;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

// ---------- rankings.csv ----------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((x) => x.trim() !== "") && !r[0].trim().startsWith("#"));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim().toLowerCase());
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
}

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

async function resolveId(name, cache, nameIndex) {
  const key = norm(name);
  if (cache[key]) return cache[key];
  const local = nameIndex?.get(key);
  if (local && local.length === 1) { cache[key] = local[0]; return local[0]; }
  const data = await get(`/people/search?names=${encodeURIComponent(name)}&sportIds=${SPORT_IDS}`);
  let people = (data.people || []).filter((p) => norm(p.fullName || "") === key);
  if (!people.length) people = data.people || [];
  if (!people.length) { warn(`No MLB player found for "${name}". Check the spelling or add an mlb_id.`); return null; }
  if (people.length > 1) {
    warn(`"${name}" matched ${people.length} players; using the youngest. Add an mlb_id to pick a specific one.`);
    people.sort((a, b) => (b.birthDate || "").localeCompare(a.birthDate || ""));
  }
  cache[key] = people[0].id;
  return people[0].id;
}

// ---------- teams ----------
async function loadTeams(season) {
  const out = {};
  for (const s of [season, season - 1]) {
    const data = await get(`/teams?sportIds=${SPORT_IDS}&season=${s}`);
    for (const t of data.teams || []) {
      if (out[t.id]) continue;
      out[t.id] = {
        id: t.id, name: t.name, abbr: t.abbreviation || "", level: LEVELS[t.sport?.id] || null,
        parentId: t.parentOrgId || (t.sport?.id === 1 ? t.id : null), parentName: t.parentOrgName || (t.sport?.id === 1 ? t.name : null),
      };
    }
  }
  for (const t of Object.values(out)) {
    const p = out[t.parentId];
    t.parentAbbr = p ? p.abbr : "";
  }
  return out;
}

// ---------- players ----------
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const ipToOuts = (ip) => { const [w, f = "0"] = String(ip || "0").split("."); return (+w || 0) * 3 + (+f || 0); };

function hitLine(s) {
  return {
    g: s.gamesPlayed ?? null, pa: s.plateAppearances ?? null, avg: s.avg ?? null, obp: s.obp ?? null, slg: s.slg ?? null, ops: s.ops ?? null,
    hr: s.homeRuns ?? null, sb: s.stolenBases ?? null, kPct: pct(s.strikeOuts, s.plateAppearances), bbPct: pct(s.baseOnBalls, s.plateAppearances),
    ab: s.atBats || 0, h: s.hits || 0, tb: s.totalBases || 0, bb: s.baseOnBalls || 0, hbp: s.hitByPitch || 0, sf: s.sacFlies || 0, so: s.strikeOuts || 0,
  };
}
function pitchLine(s) {
  return {
    g: s.gamesPlayed ?? null, gs: s.gamesStarted ?? null, ip: s.inningsPitched ?? null, era: s.era ?? null, whip: s.whip ?? null,
    so: s.strikeOuts ?? null, kPct: pct(s.strikeOuts, s.battersFaced), bbPct: pct(s.baseOnBalls, s.battersFaced), outs: ipToOuts(s.inningsPitched),
    er: s.earnedRuns || 0, h: s.hits || 0, bb: s.baseOnBalls || 0, bf: s.battersFaced || 0,
  };
}

// ---------- every minor leaguer ----------
// Pulls season stats for every player at each minor league level in a few bulk calls,
// then fills in bios (age, position, current team) in batches.
const MILB_SPORTS = [11, 12, 13, 14, 16];
const HIT_KEYS = ["gamesPlayed", "plateAppearances", "atBats", "hits", "totalBases", "baseOnBalls", "hitByPitch", "sacFlies", "strikeOuts", "homeRuns", "stolenBases"];
const PIT_KEYS = ["gamesPlayed", "gamesStarted", "earnedRuns", "hits", "baseOnBalls", "battersFaced", "strikeOuts", "homeRuns", "saves"];
const f3 = (v) => (v == null || !isFinite(v) ? null : v.toFixed(3).replace(/^0/, ""));

function sumStats(group, list) {
  const keys = group === "hitting" ? HIT_KEYS : PIT_KEYS;
  const s = Object.fromEntries(keys.map((k) => [k, list.reduce((a, x) => a + (Number(x[k]) || 0), 0)]));
  if (group === "hitting") {
    s.avg = s.atBats ? f3(s.hits / s.atBats) : null;
    const den = s.atBats + s.baseOnBalls + s.hitByPitch + s.sacFlies;
    s.obp = den ? f3((s.hits + s.baseOnBalls + s.hitByPitch) / den) : null;
    s.slg = s.atBats ? f3(s.totalBases / s.atBats) : null;
    s.ops = s.obp != null && s.slg != null ? f3(parseFloat(s.obp) + parseFloat(s.slg)) : null;
  } else {
    const outs = list.reduce((a, x) => a + ipToOuts(x.inningsPitched), 0);
    s.inningsPitched = `${Math.floor(outs / 3)}.${outs % 3}`;
    s.era = outs ? ((27 * s.earnedRuns) / outs).toFixed(2) : null;
    s.whip = outs ? ((3 * (s.hits + s.baseOnBalls)) / outs).toFixed(2) : null;
  }
  return s;
}

async function bulkStats(season, sportId, group) {
  const out = [];
  const limit = 1000;
  for (let offset = 0; offset <= 20000; offset += limit) {
    const d = await get(`/stats?stats=season&group=${group}&sportId=${sportId}&season=${season}&playerPool=ALL&limit=${limit}&offset=${offset}`);
    const block = (d.stats || [])[0] || {};
    const splits = block.splits || [];
    out.push(...splits);
    if (splits.length < limit || (block.totalSplits != null && out.length >= block.totalSplits)) break;
  }
  return out;
}

function positionShares(games) {
  if (!games) return null;
  const tot = Object.values(games).reduce((a, b) => a + b, 0);
  if (!tot) return null;
  return Object.fromEntries(Object.entries(games).filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1]).map(([k, g]) => [k, Math.round((g / tot) * 100) / 100]));
}

async function loadAllMilb(season, teams) {
  // key: playerId -> { group -> { level -> [splits] } }
  const raw = new Map();
  for (const sportId of MILB_SPORTS) {
    for (const group of ["hitting", "pitching"]) {
      const splits = await bulkStats(season, sportId, group);
      log(`  ${LEVELS[sportId]} ${group}: ${splits.length} lines`);
      for (const sp of splits) {
        const id = sp.player?.id;
        if (!id) continue;
        if (!raw.has(id)) raw.set(id, { name: sp.player.fullName, pos: sp.position?.abbreviation || "", hitting: {}, pitching: {} });
        const r = raw.get(id);
        (r[group][LEVELS[sportId]] ||= []).push(sp);
      }
    }
  }
  // Games at each position (for the position adjustment). Optional: rankings fall back to primary position.
  const fieldGames = {};
  for (const sportId of MILB_SPORTS) {
    try {
      const splits = await bulkStats(season, sportId, "fielding");
      log(`  ${LEVELS[sportId]} fielding: ${splits.length} lines`);
      for (const sp of splits) {
        const id = sp.player?.id, ab = sp.position?.abbreviation;
        if (!id || !ab || ab === "P") continue;
        const f = (fieldGames[id] ||= {});
        f[ab] = (f[ab] || 0) + (Number(sp.stat?.gamesPlayed) || 0);
      }
    } catch (e) { warn(`Fielding for ${LEVELS[sportId]} not loaded: ${e.message}`); }
  }
  // Bios in batches
  const ids = [...raw.keys()];
  const bios = {};
  for (let i = 0; i < ids.length; i += 150) {
    try {
      const d = await get(`/people?personIds=${ids.slice(i, i + 150).join(",")}&hydrate=currentTeam`);
      for (const p of d.people || []) bios[p.id] = p;
    } catch (e) { warn(`Bio batch ${i} failed: ${e.message}`); }
  }
  const index = {};
  for (const [id, r] of raw) {
    const bio = bios[id] || {};
    const pos = bio.primaryPosition?.abbreviation || r.pos;
    const isPitcher = pos === "P";
    const isTwoWay = pos === "TWP" || pos === "Y";
    const groups = isTwoWay ? ["hitting", "pitching"] : [isPitcher ? "pitching" : "hitting"];
    const byLevel = [];
    for (const group of groups) {
      for (const [level, splits] of Object.entries(r[group])) {
        const total = splits.find((s) => !s.team);           // a season total row, if the API sends one
        const teamRows = splits.filter((s) => s.team);
        const stat = total ? total.stat : sumStats(group, teamRows.map((s) => s.stat || {}));
        const t = teamRows.length ? teams[teamRows[teamRows.length - 1].team.id] : null;
        byLevel.push({ group, level, team: [...new Set(teamRows.map((s) => s.team.name))].join(" / "), org: t?.parentAbbr || "",
          line: group === "pitching" ? pitchLine(stat) : hitLine(stat) });
      }
    }
    if (!byLevel.length) continue;
    byLevel.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
    const cur = bio.currentTeam ? teams[bio.currentTeam.id] : null;
    const highest = byLevel[byLevel.length - 1];
    const own = byLevel.filter((x) => x.group === (isPitcher ? "pitching" : "hitting"));
    const combined = own.length ? (isPitcher ? pitchLine(sumStats("pitching", own.map((x) => toStat(x)))) : hitLine(sumStats("hitting", own.map((x) => toStat(x))))) : null;
    index[id] = {
      id, name: bio.fullName || r.name, pos, isPitcher, age: bio.currentAge ?? null,
      bats: bio.batSide?.code || "", throws: bio.pitchHand?.code || "",
      level: cur?.level || highest.level, team: cur?.name || highest.team.split(" / ").pop(),
      org: cur?.parentAbbr || highest.org, orgName: cur?.parentName || "",
      season, total: combined, byLevel, fld: isPitcher ? null : positionShares(fieldGames[id]),
    };
  }
  // Players on an affiliated roster who haven't played this season (recent draftees, injured players)
  let added = 0;
  for (const sportId of MILB_SPORTS) {
    let d;
    try { d = await get(`/sports/${sportId}/players?season=${season}`); }
    catch (e) { warn(`Roster list for ${LEVELS[sportId]} not loaded: ${e.message}`); continue; }
    for (const p of d.people || []) {
      if (!p.id || index[p.id] || p.active === false) continue;
      const cur = p.currentTeam ? teams[p.currentTeam.id] : null;
      if (!cur || !cur.level || cur.level === "MLB") continue;
      const pos = p.primaryPosition?.abbreviation || "";
      index[p.id] = {
        id: p.id, name: p.fullName, pos, isPitcher: pos === "P", age: p.currentAge ?? null,
        bats: p.batSide?.code || "", throws: p.pitchHand?.code || "",
        level: cur.level, team: cur.name, org: cur.parentAbbr || "", orgName: cur.parentName || "",
        season, total: null, byLevel: [],
      };
      added++;
    }
  }
  log(`  Added ${added} rostered players with no ${season} stats yet`);
  return index;
}
// Turn a stored line back into raw counts so lines at several levels can be combined
function toStat(x) {
  const l = x.line;
  if (x.group === "pitching") return { gamesPlayed: l.g, gamesStarted: l.gs, earnedRuns: l.er, hits: l.h, baseOnBalls: l.bb, battersFaced: l.bf, strikeOuts: l.so, inningsPitched: l.ip };
  return { gamesPlayed: l.g, plateAppearances: l.pa, atBats: l.ab, hits: l.h, totalBases: l.tb, baseOnBalls: l.bb, hitByPitch: l.hbp, sacFlies: l.sf, strikeOuts: l.so, homeRuns: l.hr, stolenBases: l.sb };
}

async function loadPlayer(id, teams) {
  const pData = await get(`/people/${id}?hydrate=currentTeam`);
  const p = (pData.people || [])[0];
  if (!p) throw new Error(`No player with id ${id}`);
  const pos = p.primaryPosition?.abbreviation || "";
  const isPitcher = pos === "P";
  const isTwoWay = pos === "TWP" || pos === "Y";
  const groups = isTwoWay ? "hitting,pitching" : isPitcher ? "pitching" : "hitting";
  const sData = await get(`/people/${id}/stats?stats=yearByYear&group=${groups}&leagueListId=mlb_milb`);
  const seasons = [];
  for (const block of sData.stats || []) {
    const group = block.group?.displayName === "pitching" ? "pitching" : "hitting";
    for (const sp of block.splits || []) {
      if (!sp.team) continue; // skip multi-team season totals
      const level = LEVELS[sp.sport?.id] || teams[sp.team.id]?.level || null;
      if (!level) continue;   // skip winter/fall leagues and other non-affiliated play
      const t = teams[sp.team.id];
      seasons.push({
        season: +sp.season, group, level, team: sp.team.name || t?.name || "", org: t?.parentAbbr || "",
        line: group === "pitching" ? pitchLine(sp.stat || {}) : hitLine(sp.stat || {}),
      });
    }
  }
  seasons.sort((a, b) => a.season - b.season || LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  // If he's currently somewhere outside the affiliated minors (fall/winter ball, etc.), fall back to his last affiliated team
  let cur = p.currentTeam ? teams[p.currentTeam.id] : null;
  if (!cur || !cur.level) {
    const last = seasons[seasons.length - 1];
    const lastTeam = last && Object.values(teams).find((t) => t.name === last.team);
    if (lastTeam) cur = lastTeam;
  }
  return {
    id: p.id, name: p.fullName, pos, isPitcher, isTwoWay,
    age: p.currentAge ?? null, birthDate: p.birthDate || null,
    bats: p.batSide?.code || "", throws: p.pitchHand?.code || "",
    height: p.height || "", weight: p.weight || null,
    debut: p.mlbDebutDate || null,
    team: cur?.name || p.currentTeam?.name || "", level: cur?.level || null,
    org: cur?.parentAbbr || "", orgName: cur?.parentName || "", orgId: cur?.parentId || null,
    levelsReached: [...new Set(seasons.map((s) => s.level))].sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b)),
    seasons,
  };
}

// Combine all of a player's lines in one season into a season summary
function seasonSummary(player, season) {
  const rows = player.seasons.filter((s) => s.season === season);
  if (!rows.length) return null;
  const group = player.isPitcher ? "pitching" : "hitting";
  const own = rows.filter((r) => r.group === group);
  if (!own.length) return null;
  const levels = [...new Set(own.map((r) => r.level))];
  const sum = (k) => own.reduce((a, r) => a + (r.line[k] || 0), 0);
  const r3 = (v) => (v == null || !isFinite(v) ? null : v.toFixed(3).replace(/^0/, ""));
  const r1 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 10);
  if (group === "hitting") {
    const pa = sum("pa"), ab = sum("ab"), h = sum("h"), bb = sum("bb"), hbp = sum("hbp"), sf = sum("sf");
    return {
      season, group, levels, pa, avg: ab ? r3(h / ab) : null, obp: ab + bb + hbp + sf ? r3((h + bb + hbp) / (ab + bb + hbp + sf)) : null,
      slg: ab ? r3(sum("tb") / ab) : null, hr: sum("hr"), sb: sum("sb"),
      kPct: pa ? r1(sum("so") / pa) : null, bbPct: pa ? r1(bb / pa) : null,
    };
  }
  const outs = sum("outs"), ip = outs / 3, bf = sum("bf");
  return {
    season, group, levels, ip: `${Math.floor(outs / 3)}.${outs % 3}`,
    era: ip ? (9 * sum("er") / ip).toFixed(2) : null, whip: ip ? ((sum("h") + sum("bb")) / ip).toFixed(2) : null,
    so: sum("so"), kPct: bf ? r1(sum("so") / bf) : null, bbPct: bf ? r1(sum("bb") / bf) : null,
  };
}

// ---------- transactions ----------
function classify(t, teams) {
  const from = t.fromTeam ? teams[t.fromTeam.id] : null;
  const to = t.toTeam ? teams[t.toTeam.id] : null;
  const desc = `${t.typeDesc || ""} ${t.description || ""}`;
  const fi = from ? LEVEL_ORDER.indexOf(from.level) : -1;
  const ti = to ? LEVEL_ORDER.indexOf(to.level) : -1;
  const sameOrg = from && to && from.parentId && from.parentId === to.parentId;
  if (/trade/i.test(t.typeDesc || "")) return "Trade";
  if (/injured list|disabled list/i.test(desc)) return "Injured list";
  if (/released|designated for assignment/i.test(desc)) return "Released / DFA";
  if (to?.level === "MLB" && /selected the contract|recalled|purchased/i.test(desc)) return "Called up";
  if (sameOrg && fi >= 0 && ti >= 0 && fi !== ti) return ti > fi ? "Promoted" : "Demoted";
  if (/optioned/i.test(desc)) return "Optioned";
  if (/signed/i.test(desc)) return "Signed";
  if (/rule 5/i.test(desc)) return "Rule 5";
  return "Other";
}
const NOTABLE = new Set(["Trade", "Called up", "Promoted", "Rule 5"]);

async function loadTransactions(teams, rankedIds) {
  const start = new Date(TODAY.getTime() - WIRE_DAYS_FETCH * 864e5);
  const data = await get(`/transactions?startDate=${isoDate(start)}&endDate=${isoDate(TODAY)}`);
  const out = [];
  for (const t of data.transactions || []) {
    if (!t.person?.id) continue;
    const affiliated = (t.fromTeam && teams[t.fromTeam.id]) || (t.toTeam && teams[t.toTeam.id]);
    const type = classify(t, teams);
    const ranked = rankedIds.has(t.person.id);
    if (!ranked && !(affiliated && NOTABLE.has(type))) continue;
    const side = (x) => (x ? { name: x.name, level: teams[x.id]?.level || null, org: teams[x.id]?.parentAbbr || "" } : null);
    out.push({
      id: t.id, date: (t.effectiveDate || t.date || "").slice(0, 10), playerId: t.person.id, player: t.person.fullName,
      type, typeDesc: t.typeDesc || "", description: t.description || "", from: side(t.fromTeam), to: side(t.toTeam),
    });
  }
  return out;
}

// ---------- automatic rankings ----------
const CONFIG_FILE = process.env.RANK_CONFIG || "ranking-config.json";
const NOTES_FILE = process.env.NOTES || "player-notes.csv";
const LEVEL_NAMES = { ROK: "Rookie", A: "Single-A", "A+": "High-A", AA: "Double-A", AAA: "Triple-A" };
const MILB_ORDER = ["ROK", "A", "A+", "AA", "AAA"];

function publicFormula(cfg) {
  return { weights: cfg.weights, typicalAge: cfg.typicalAge, eligibility: cfg.eligibility, size: cfg.size, guarantee: cfg.guarantee || [],
    consensus: (cfg.consensus || []).map((c) => ({ label: c.label, source: c.source, boost: c.boost })) };
}

function scorePlayer(p, cons, cfg) {
  const W = cfg.weights, T = cfg.typicalAge;
  const levels = p.byLevel.map((b) => b.level).filter((l) => MILB_ORDER.includes(l)).sort((a, b) => MILB_ORDER.indexOf(a) - MILB_ORDER.indexOf(b));
  const top = levels[levels.length - 1];
  if (!top) return null;
  const pitcher = p.pos === "P";
  const own = p.byLevel.filter((b) => b.group === (pitcher ? "pitching" : "hitting"));
  if (!own.length) return null;
  const L = own.length > 1 ? (p.total || own[own.length - 1].line) : own[0].line;
  const age = p.age ?? 22;
  const lev = MILB_ORDER.indexOf(top) * W.level;
  const ag = (T[top] - age) * W.age;
  let prod;
  if (!pitcher) {
    const ops = (parseFloat(L.obp) || 0) + (parseFloat(L.slg) || 0);
    prod = ((ops - W.opsBase) * W.ops + ((L.bbPct ?? W.walkBase) - W.walkBase) * W.walk - ((L.kPct ?? W.strikeoutBase) - W.strikeoutBase) * W.strikeout)
      * Math.min(1, (L.pa || 0) / W.fullPA);
  } else {
    const ip = ipToOuts(L.ip) / 3;
    prod = (((L.kPct ?? 22) - (L.bbPct ?? 9) - W.kbbBase) * W.kbb + (W.eraBase - (parseFloat(L.era) || 4.5)) * W.era) * Math.min(1, ip / W.fullIP) - W.pitcherRisk;
  }
  const boost = cons ? cons.boost : 0;
  // Position: weighted by share of games at each position; falls back to primary position
  let posAdj = 0, posNote = "";
  const PV = W.position || {};
  if (!pitcher && Object.keys(PV).length) {
    const shares = p.fld && Object.keys(p.fld).length ? p.fld : { [p.pos === "TWP" || p.pos === "Y" ? "DH" : p.pos]: 1 };
    const tot = Object.values(shares).reduce((a, b) => a + b, 0) || 1;
    for (const [k, v] of Object.entries(shares)) posAdj += (PV[k] ?? 0) * (v / tot);
    posNote = Object.entries(shares).slice(0, 2).map(([k, v]) => `${k} ${Math.round((v / tot) * 100)}%`).join(", ");
  }
  const sg = (v) => (v >= 0 ? "+" : "\u2212") + Math.abs(v).toFixed(2);
  return {
    score: lev + ag + prod + posAdj + boost, top, pitcher, L,
    detail: `Level ${lev.toFixed(2)} (${LEVEL_NAMES[top]}) \u00b7 Age ${sg(ag)} \u00b7 Production ${sg(prod)}${pitcher ? "" : ` \u00b7 Position ${sg(posAdj)} (${posNote})`} \u00b7 Consensus ${sg(boost)} (${cons ? cons.label : "not on a list"})`,
  };
}

async function rookieStatus(ids, cache) {
  const today = isoDate(TODAY);
  const todo = ids.filter((id) => cache[id]?.d !== today);
  const one = async (id) => {
    try {
      const s = await get(`/people/${id}/stats?stats=career&group=hitting,pitching&sportId=1`);
      let ab = 0, ip = 0;
      for (const b of s.stats || []) {
        const st = b.splits?.[0]?.stat; if (!st) continue;
        if (b.group?.displayName === "hitting") ab = st.atBats || 0; else ip = ipToOuts(st.inningsPitched) / 3;
      }
      cache[id] = { ab, ip: Math.round(ip * 10) / 10, d: today };
    } catch (e) { warn(`Rookie check failed for ${id}: ${e.message}`); }
  };
  for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(one));
}

async function autoRank(cfg, pool, notes) {
  const E = cfg.eligibility;
  const byName = new Map();
  for (const p of Object.values(pool)) { const k = norm(p.name); byName.set(k, [...(byName.get(k) || []), p]); }
  const overrides = Object.fromEntries(Object.entries(cfg.playerIds || {}).map(([n, id]) => [norm(n), id]));
  // Consensus lists: a player gets the boost of the strongest list he's on
  const consOf = new Map();
  for (const c of cfg.consensus || []) {
    for (const n of c.names || []) {
      const k = norm(n);
      let p = overrides[k] ? pool[overrides[k]] : null;
      if (!p) { const m = byName.get(k) || byName.get(k.replace(/ (jr|ii|iii)$/, "")); if (m && m.length === 1) p = m[0]; else if (m && m.length > 1) { warn(`"${n}" matches ${m.length} players; add it to playerIds in ${CONFIG_FILE}.`); p = null; } }
      if (!p) continue;
      const prev = consOf.get(p.id);
      if (!prev || prev.boost < c.boost) consOf.set(p.id, c);
    }
  }
  // Candidates: anyone on a list, plus young players producing at the upper levels
  const cands = [];
  for (const p of Object.values(pool)) {
    const cons = consOf.get(p.id) || null;
    const sc = scorePlayer(p, cons, cfg);
    if (!sc) continue;
    if (!cons) {
      if ((p.age ?? 99) > E.maxAge || !E.levels.includes(sc.top)) continue;
      if (sc.pitcher ? ipToOuts(sc.L.ip) / 3 < E.minIP : (sc.L.pa || 0) < E.minPA) continue;
    }
    cands.push({ p, cons, ...sc });
  }
  cands.sort((a, b) => b.score - a.score);
  // Drop anyone past rookie limits. Players on a guaranteed list always get a spot; the rest fill by score.
  const statusFile = path.join(OUT_DIR, "rookie-status.json");
  const status = await readJson(statusFile, {});
  const guaranteed = new Set(cfg.guarantee || []);
  const isGrad = (c) => { const st = status[c.p.id]; return st && (st.ab > E.rookieAB || st.ip > E.rookieIP); };
  const forced = cands.filter((c) => c.cons && guaranteed.has(c.cons.label));
  await rookieStatus(forced.map((c) => c.p.id), status);
  const forcedOK = forced.filter((c) => !isGrad(c));
  const forcedIds = new Set(forcedOK.map((c) => c.p.id));
  const rest = cands.filter((c) => !forcedIds.has(c.p.id) && !(c.cons && guaranteed.has(c.cons.label)));
  const fill = [];
  for (let i = 0; i < rest.length && fill.length + forcedOK.length < cfg.size; i += 40) {
    const chunk = rest.slice(i, i + 40);
    await rookieStatus(chunk.map((c) => c.p.id), status);
    for (const c of chunk) if (!isGrad(c) && fill.length + forcedOK.length < cfg.size) fill.push(c);
  }
  const out = [...forcedOK, ...fill].sort((x, y) => y.score - x.score).slice(0, cfg.size);
  const overall = new Map(out.map((c, i) => [c.p.id, i + 1]));

  // Team lists: each organization's best prospects by the same score, any level, up to a max age
  const teamSize = cfg.teamSize || 20, teamMaxAge = E.teamMaxAge ?? 25;
  const all = [];
  for (const p of Object.values(pool)) {
    if (!p.org) continue;
    const cons = consOf.get(p.id) || null;
    if (!cons && (p.age ?? 99) > teamMaxAge) continue;
    const sc = scorePlayer(p, cons, cfg);
    if (!sc) continue;
    // Small samples only count for players in the Top list or on an industry list
    if (!cons && !overall.has(p.id) && (sc.pitcher ? ipToOuts(sc.L.ip) / 3 < (E.teamMinIP ?? 30) : (sc.L.pa || 0) < (E.teamMinPA ?? 100))) continue;
    all.push({ p, cons, ...sc });
  }
  // A team's players in the Top list come first, in that order; everyone else follows by score
  all.sort((a, b) => {
    const oa = overall.get(a.p.id), ob = overall.get(b.p.id);
    if (oa && ob) return oa - ob;
    if (oa) return -1;
    if (ob) return 1;
    return b.score - a.score;
  });
  const byOrg = new Map();
  for (const c of all) byOrg.set(c.p.org, [...(byOrg.get(c.p.org) || []), c]);
  const teamsOut = {};
  for (const [org, list] of byOrg) {
    const keep = [];
    for (let i = 0; i < list.length && keep.length < teamSize; i += teamSize + 5) {
      const chunk = list.slice(i, i + teamSize + 5);
      await rookieStatus(chunk.map((c) => c.p.id), status);
      for (const c of chunk) if (!isGrad(c) && keep.length < teamSize) keep.push(c);
    }
    teamsOut[org] = keep.map((c, i) => {
      const L = c.L || {};
      const line = c.pitcher
        ? { ip: L.ip ?? null, era: L.era ?? null, whip: L.whip ?? null, kPct: L.kPct ?? null, bbPct: L.bbPct ?? null }
        : { pa: L.pa ?? null, avg: L.avg ?? null, obp: L.obp ?? null, slg: L.slg ?? null, hr: L.hr ?? null, sb: L.sb ?? null };
      return { orgRank: i + 1, overall: overall.get(c.p.id) ?? null, id: c.p.id, name: c.p.name, pos: c.p.pos, age: c.p.age ?? null,
        level: c.p.level || c.top, levels: [...new Set(c.p.byLevel.map((b) => b.level))], score: c.score.toFixed(2), scoreDetail: c.detail, pitcher: c.pitcher, line };
    });
  }
  await fs.writeFile(statusFile, JSON.stringify(status));

  const noteBy = new Map();
  for (const n of notes) { const id = parseInt(n.mlb_id, 10); noteBy.set(id ? `id:${id}` : `nm:${norm(n.name || "")}`, n); }
  const ranked = out.map((c, i) => {
    const n = noteBy.get(`id:${c.p.id}`) || noteBy.get(`nm:${norm(c.p.name)}`) || {};
    return { rank: i + 1, name: c.p.name, id: c.p.id, fv: n.fv || "", eta: n.eta || "", blurb: n.blurb || "", score: c.score.toFixed(2), scoreDetail: c.detail };
  });
  return { ranked, teams: teamsOut };
}

// ---------- farm system rankings ----------
// Ranks all 30 organizations by how many players they have in the Top list.
// Ties go to the system whose players rank higher (points: #1 = N points ... #N = 1 point).
function buildFarm(rankings, teams, history, today) {
  const N = rankings.length;
  const orgs = new Map();
  for (const t of Object.values(teams)) if (t.level === "MLB" && t.abbr && !orgs.has(t.abbr)) orgs.set(t.abbr, t.name);
  const rows = [...orgs].map(([abbr, name]) => {
    const ps = rankings.filter((r) => r.org === abbr && r.found).sort((a, b) => a.rank - b.rank);
    return {
      org: abbr, name, count: ps.length, points: ps.reduce((a, r) => a + (N + 1 - r.rank), 0),
      top10: ps.filter((r) => r.rank <= 10).length, top50: ps.filter((r) => r.rank <= 50).length,
      players: ps.map((r) => ({ id: r.id, name: r.name, rank: r.rank, pos: r.pos, level: r.level })),
    };
  });
  rows.sort((a, b) => b.count - a.count || b.points - a.points || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  // One snapshot per day; movement compares to the previous day
  const snap = Object.fromEntries(rows.map((r) => [r.org, { rank: r.rank, count: r.count }]));
  const last = history[history.length - 1];
  if (last && last.date === today) last.orgs = snap; else history.push({ date: today, orgs: snap });
  while (history.length > 400) history.shift();
  const prev = [...history].reverse().find((h) => h.date < today);
  for (const r of rows) {
    const p = prev?.orgs?.[r.org];
    r.prevRank = prev ? (p ? p.rank : null) : undefined;
    r.prevCount = prev ? (p ? p.count : null) : undefined;
  }
  return rows;
}

// ---------- main ----------
async function main() {
  // The minor league season starts in April. Before then, "this season" means last year's.
  const month = TODAY.getUTCMonth();
  const season = month >= 3 ? TODAY.getUTCFullYear() : TODAY.getUTCFullYear() - 1;
  // Rankings use last season's full stats in April and May, until samples are big enough
  const rankSeason = month >= 3 && month < 5 ? season - 1 : season;
  await fs.mkdir(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "site.json");
  const idCacheFile = path.join(OUT_DIR, "player-ids.json");
  const histFile = path.join(OUT_DIR, "rankings-history.json");
  const previous = await readJson(outFile, { players: {}, transactions: [] });
  const idCache = await readJson(idCacheFile, {});
  const history = await readJson(histFile, []);

  log(`Season ${season}, today ${isoDate(TODAY)}`);
  const teams = await loadTeams(season);
  log(`Loaded ${Object.keys(teams).length} teams`);

  // Every minor leaguer this season (written to players.json for the Players directory)
  const playersFile = path.join(OUT_DIR, "players.json");
  let allMilb = null;
  try {
    allMilb = await loadAllMilb(season, teams);
    log(`Loaded ${Object.keys(allMilb).length} minor league players`);
  } catch (e) {
    warn(`Full minor league pull failed: ${e.message}. Keeping the previous players.json.`);
  }
  const nameIndex = new Map();
  for (const p of Object.values(allMilb || {})) {
    const k = norm(p.name);
    nameIndex.set(k, [...(nameIndex.get(k) || []), p.id]);
  }

  // Rankings: automatic (formula) or manual (rankings.csv)
  const cfg = await readJson(CONFIG_FILE, null);
  let ranked = [];
  let teamLists = null;
  let formulaInfo = null;
  if (cfg?.auto) {
    let pool = allMilb;
    if (pool && rankSeason !== season) {
      try { pool = await loadAllMilb(rankSeason, teams); log(`Ranking on ${rankSeason} stats (${Object.keys(pool).length} players)`); }
      catch (e) { warn(`Could not load ${rankSeason} stats for ranking: ${e.message}`); pool = null; }
    }
    if (pool) {
      const notes = parseCsv(await fs.readFile(NOTES_FILE, "utf8").catch(() => ""));
      const res = await autoRank(cfg, pool, notes);
      ranked = res.ranked; teamLists = res.teams;
      formulaInfo = { ...publicFormula(cfg), rankSeason, calculated: isoDate(TODAY) };
      log(`Auto-ranked ${ranked.length} players from the formula`);
    } else {
      warn("No stats to rank with; keeping yesterday's Top 100.");
      ranked = (previous.rankings || []).map((r) => ({ rank: r.rank, name: r.name, id: r.id, fv: r.fv, eta: r.eta, blurb: r.blurb, score: r.score, scoreDetail: r.scoreDetail }));
      formulaInfo = previous.formula || null;
      teamLists = null;
    }
  }
  const rows = cfg?.auto ? [] : parseCsv(await fs.readFile(RANKINGS_FILE, "utf8").catch(() => ""));
  for (const r of rows) {
    const rank = parseInt(r.rank, 10);
    if (!r.name || !rank) continue;
    let id = parseInt(r.mlb_id, 10) || null;
    if (!id) {
      try { id = await resolveId(r.name, idCache, nameIndex); } catch (e) { warn(`Lookup failed for ${r.name}: ${e.message}`); }
    }
    ranked.push({ rank, name: r.name, id, fv: r.fv || "", eta: r.eta || "", blurb: r.blurb || "", score: r.score || "", scoreDetail: r.score_detail || "" });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  if (!cfg?.auto) log(`${ranked.length} ranked players in ${RANKINGS_FILE}`);

  // Players
  const players = {};
  for (const r of ranked) {
    if (!r.id) continue;
    try { players[r.id] = await loadPlayer(r.id, teams); }
    catch (e) {
      warn(`Could not update ${r.name}: ${e.message}. Keeping previous data.`);
      if (previous.players?.[r.id]) players[r.id] = previous.players[r.id];
    }
  }

  // Rankings history: one snapshot per day (the last list of the day). Movement compares to the previous day.
  const today = isoDate(TODAY);
  const snap = Object.fromEntries(ranked.filter((r) => r.id).map((r) => [r.id, r.rank]));
  const last = history[history.length - 1];
  if (ranked.length) {
    if (last && last.date === today) last.ranks = snap;
    else history.push({ date: today, ranks: snap });
  }
  while (history.length > 400) history.shift();
  const prevEntry = [...history].reverse().find((h) => h.date < today);
  const prevSnap = prevEntry ? prevEntry.ranks : null;

  // Transactions: merge new with the stored wire, drop anything too old
  const rankedIds = new Set(ranked.map((r) => r.id).filter(Boolean));
  let fresh = [];
  try { fresh = await loadTransactions(teams, rankedIds); }
  catch (e) { warn(`Transactions not updated: ${e.message}`); }
  const byId = new Map((previous.transactions || []).map((t) => [t.id, t]));
  for (const t of fresh) byId.set(t.id, t);
  const cutoff = isoDate(new Date(TODAY.getTime() - WIRE_DAYS_KEEP * 864e5));
  const transactions = [...byId.values()].filter((t) => t.date >= cutoff).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 3000);

  const rankings = ranked.map((r) => {
    const p = players[r.id];
    return {
      rank: r.rank, id: r.id, name: p?.name || r.name, fv: r.fv, eta: r.eta, blurb: r.blurb, score: r.score, scoreDetail: r.scoreDetail,
      prevRank: prevSnap ? (prevSnap[r.id] ?? null) : undefined,
      pos: p?.pos || "", age: p?.age ?? null, org: p?.org || "", orgName: p?.orgName || "", level: p?.level || null,
      summary: p ? (seasonSummary(p, season) || seasonSummary(p, season - 1)) : null,
      found: !!p,
    };
  });

  const farmFile = path.join(OUT_DIR, "farm-history.json");
  const farmHistory = await readJson(farmFile, []);
  const farm = rankings.length ? buildFarm(rankings, teams, farmHistory, today) : (previous.farm || []);
  await fs.writeFile(farmFile, JSON.stringify(farmHistory, null, 1));
  // Team Top 20 lists, keyed by organization, with names from the MLB teams
  let teamsOut = previous.teams || {};
  if (teamLists) {
    teamsOut = {};
    for (const t of Object.values(teams)) {
      if (t.level !== "MLB" || !t.abbr || teamsOut[t.abbr]) continue;
      teamsOut[t.abbr] = { org: t.abbr, name: t.name, list: teamLists[t.abbr] || [] };
    }
  }
  const site = { updated: new Date().toISOString(), season, rankMode: cfg?.auto ? "auto" : "manual", formula: formulaInfo, rankings, farm, teams: teamsOut, players, transactions };
  await fs.writeFile(outFile, JSON.stringify(site));
  if (allMilb) {
    // Drop the raw counts that were only needed for combining lines, to keep the file small
    const slimLine = (l) => { const { ab, h, tb, bb, hbp, sf, er, bf, outs, ...rest } = l || {}; return rest; };
    const slim = {}, orgs = {};
    for (const [id, p] of Object.entries(allMilb)) {
      const { orgName, isPitcher, season: _s, ...rest } = p;
      if (p.org && orgName) orgs[p.org] = orgName;
      slim[id] = { ...rest, total: p.byLevel.length > 1 && p.total ? slimLine(p.total) : null, byLevel: p.byLevel.map((x) => ({ ...x, line: slimLine(x.line) })) };
    }
    await fs.writeFile(playersFile, JSON.stringify({ updated: new Date().toISOString(), season, orgs, players: slim }));
  }
  await fs.writeFile(idCacheFile, JSON.stringify(idCache, null, 1));
  await fs.writeFile(histFile, JSON.stringify(history, null, 1));
  log(`Wrote ${outFile}: ${rankings.length} ranked, ${Object.keys(players).length} players, ${transactions.length} transactions`);
}

main().catch((e) => { console.error("[ledger] Update failed:", e); process.exit(1); });
