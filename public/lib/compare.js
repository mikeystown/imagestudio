// Pairwise comparisons: pairing, Bradley-Terry scoring and self-agreement.
// A comparison is { id, image_a, image_b, result: "a"|"b"|"tie", shown_left: "a"|"b", session_id, created_at, is_repeat }.
// Pure functions: used by the browser and by the Node tests.

export const PHASE1_TARGET = 3; // spread matchups evenly until every image has this many
export const REPEAT_RATE = 0.05; // share of picks that re-show an already judged pair
const PRIOR = 1; // virtual tie against an average image; keeps undefeated images finite

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Comparisons whose two images are both in `files`.
export function withinSet(comps, files) {
  const set = files instanceof Set ? files : new Set(files);
  return comps.filter((c) => set.has(c.image_a) && set.has(c.image_b));
}

// Number of comparisons per image (repeats included: each is a real judgment).
export function countComparisons(files, comps) {
  const n = new Map(files.map((f) => [f, 0]));
  for (const c of comps) {
    if (n.has(c.image_a)) n.set(c.image_a, n.get(c.image_a) + 1);
    if (n.has(c.image_b)) n.set(c.image_b, n.get(c.image_b) + 1);
  }
  return n;
}

// Bradley-Terry fit by the MM algorithm (Hunter 2004). A tie is half a win to each image.
// Each image also gets one virtual tie against a fixed average opponent (strength 1), so an image that
// has won everything still has a finite score; its pull fades as real comparisons accumulate.
// Returns Map file -> { score, se, n }: score is log-strength centred on the mean of compared images,
// se its standard error (from the diagonal of the Fisher information). Uncompared images get score/se null.
export function fitBradleyTerry(files, comps, { iterations = 500, tolerance = 1e-9 } = {}) {
  const index = new Map(files.map((f, i) => [f, i]));
  const k = files.length;
  const wins = new Float64Array(k);
  const n = new Float64Array(k);
  const games = []; // [i, j] per comparison
  for (const c of comps) {
    const i = index.get(c.image_a);
    const j = index.get(c.image_b);
    if (i === undefined || j === undefined || i === j) continue;
    games.push([i, j]);
    n[i]++;
    n[j]++;
    if (c.result === "a") wins[i]++;
    else if (c.result === "b") wins[j]++;
    else { wins[i] += 0.5; wins[j] += 0.5; }
  }

  let p = new Float64Array(k).fill(1);
  for (let it = 0; it < iterations; it++) {
    const denom = new Float64Array(k);
    for (const [i, j] of games) {
      const d = 1 / (p[i] + p[j]);
      denom[i] += d;
      denom[j] += d;
    }
    const next = new Float64Array(k);
    let change = 0;
    for (let i = 0; i < k; i++) {
      next[i] = (wins[i] + PRIOR / 2) / (denom[i] + PRIOR / (p[i] + 1));
      change = Math.max(change, Math.abs(Math.log(next[i] / p[i])));
    }
    p = next;
    if (change < tolerance) break;
  }

  // Fisher information for log-strength, per image.
  const info = new Float64Array(k);
  for (const [i, j] of games) {
    const v = (p[i] * p[j]) / (p[i] + p[j]) ** 2;
    info[i] += v;
    info[j] += v;
  }
  for (let i = 0; i < k; i++) info[i] += (PRIOR * p[i]) / (p[i] + 1) ** 2;

  const compared = files.map((_, i) => i).filter((i) => n[i] > 0);
  const centre = compared.length ? compared.reduce((s, i) => s + Math.log(p[i]), 0) / compared.length : 0;
  return new Map(files.map((f, i) => [f, n[i] > 0
    ? { score: Math.log(p[i]) - centre, se: 1 / Math.sqrt(info[i]), n: n[i] }
    : { score: null, se: null, n: 0 }]));
}

// Groups of images linked by chains of comparisons. Bradley-Terry scores are only comparable within one group.
export function components(files, comps) {
  const parent = new Map(files.map((f) => [f, f]));
  const find = (f) => {
    while (parent.get(f) !== f) {
      parent.set(f, parent.get(parent.get(f)));
      f = parent.get(f);
    }
    return f;
  };
  for (const c of comps) if (parent.has(c.image_a) && parent.has(c.image_b)) parent.set(find(c.image_a), find(c.image_b));
  const groups = new Map();
  for (const f of files) {
    const root = find(f);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(f);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

// Winner of a comparison as a file name, or "tie".
const winnerOf = (c) => (c.result === "tie" ? "tie" : c.result === "a" ? c.image_a : c.image_b);

// For each repeat, did I pick the same winner (or tie) as the first time I judged that pair?
export function selfAgreement(comps) {
  const first = new Map();
  let total = 0;
  let agree = 0;
  for (const c of [...comps].sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))) {
    const key = pairKey(c.image_a, c.image_b);
    if (!c.is_repeat) {
      if (!first.has(key)) first.set(key, winnerOf(c));
    } else if (first.has(key)) {
      total++;
      if (winnerOf(c) === first.get(key)) agree++;
    }
  }
  return { total, agree, rate: total ? agree / total : null };
}

// Weighted random choice from items with weights.
function weighted(items, weights, rng) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) if ((r -= weights[i]) < 0) return items[i];
  return items[items.length - 1];
}
const pickRandom = (items, rng) => items[Math.floor(rng() * items.length) % items.length];

// Next pair to show: { a, b, is_repeat, phase } or null if fewer than two images.
// Phase 0 links separate clusters (e.g. groups never compared with each other), phase 1 spreads matchups,
// phase 2 pairs close scores.
// comps must already be limited to the image set (see withinSet). scores: Map file -> { score }.
export function choosePair(files, comps, { scores = new Map(), rng = Math.random, lastKey = null, repeatRate = REPEAT_RATE } = {}) {
  if (files.length < 2) return null;
  const counts = countComparisons(files, comps);
  const met = new Map(files.map((f) => [f, new Set()]));
  const judged = [];
  for (const c of comps) {
    met.get(c.image_a)?.add(c.image_b);
    met.get(c.image_b)?.add(c.image_a);
    if (!c.is_repeat) judged.push(c);
  }
  const clusters = components(files, comps);
  if (clusters.length > 1) {
    // Link the smallest cluster to another one, using the least-compared images on both sides.
    // Never re-offer the pair just shown (it may have been skipped).
    const smallest = clusters.reduce((x, y) => (y.length < x.length ? y : x));
    const inSmallest = new Set(smallest);
    const others = files.filter((f) => !inSmallest.has(f));
    const fewest = (list) => {
      const min = Math.min(...list.map((f) => counts.get(f)));
      return pickRandom(list.filter((f) => counts.get(f) === min), rng);
    };
    const byCount = (list) => [...list].sort((x, y) => counts.get(x) - counts.get(y));
    for (const a of [fewest(smallest), ...byCount(smallest)]) {
      const options = others.filter((o) => pairKey(a, o) !== lastKey);
      if (options.length) return { a, b: fewest(options), is_repeat: false, phase: 0 };
    }
    return { a: smallest[0], b: others[0], is_repeat: false, phase: 0 }; // only the skipped pair can link
  }
  const phase = Math.min(...counts.values()) < PHASE1_TARGET ? 1 : 2;

  // Consistency check: occasionally re-show a pair already judged.
  if (judged.length && rng() < repeatRate) {
    const options = judged.filter((c) => pairKey(c.image_a, c.image_b) !== lastKey);
    if (options.length) {
      const c = pickRandom(options, rng);
      return { a: c.image_a, b: c.image_b, is_repeat: true, phase };
    }
  }

  const unmet = (f) => files.filter((o) => o !== f && !met.get(f).has(o) && pairKey(f, o) !== lastKey);
  const score = (f) => scores.get(f)?.score ?? 0;

  // Focal image: fewest comparisons in phase 1; in phase 2 weighted towards fewer comparisons.
  const withOpponents = files.filter((f) => unmet(f).length);
  if (!withOpponents.length) {
    // Every pair has been judged: re-show the least compared pair other than the last one (a genuine repeat).
    const sorted = [...files].sort((x, y) => counts.get(x) - counts.get(y));
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++)
        if (pairKey(sorted[i], sorted[j]) !== lastKey) return { a: sorted[i], b: sorted[j], is_repeat: true, phase };
    return { a: sorted[0], b: sorted[1], is_repeat: true, phase };
  }
  let focal;
  if (phase === 1) {
    const min = Math.min(...withOpponents.map((f) => counts.get(f)));
    focal = pickRandom(withOpponents.filter((f) => counts.get(f) === min), rng);
  } else {
    focal = weighted(withOpponents, withOpponents.map((f) => 1 / (1 + counts.get(f)) ** 2), rng);
  }

  const options = unmet(focal);
  let opponent;
  if (phase === 1) {
    const min = Math.min(...options.map((f) => counts.get(f)));
    opponent = pickRandom(options.filter((f) => counts.get(f) === min), rng);
  } else {
    // Closest current scores; among the three closest, the one with the fewest comparisons.
    const closest = [...options].sort((x, y) => Math.abs(score(x) - score(focal)) - Math.abs(score(y) - score(focal))).slice(0, 3);
    const min = Math.min(...closest.map((f) => counts.get(f)));
    opponent = pickRandom(closest.filter((f) => counts.get(f) === min), rng);
  }
  return { a: focal, b: opponent, is_repeat: false, phase };
}

// Progress towards `target` comparisons per image.
export function progress(files, comps, target) {
  const counts = countComparisons(files, comps);
  const values = [...counts.values()];
  return {
    images: files.length,
    reached: values.filter((v) => v >= target).length,
    fraction: values.length ? values.reduce((s, v) => s + Math.min(v, target), 0) / (values.length * target) : 0,
  };
}

// k distinct random items (all of them if fewer), in random order.
export function sample(items, k, rng = Math.random) {
  const a = [...items];
  const n = Math.min(k, a.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// Head-to-heads between images of set A and set B: how often A won (a tie counts half).
export function crossWinRate(comps, setA, setB) {
  let n = 0;
  let winsA = 0;
  for (const c of comps) {
    const aFirst = setA.has(c.image_a) && setB.has(c.image_b);
    const aSecond = setB.has(c.image_a) && setA.has(c.image_b);
    if (!aFirst && !aSecond) continue;
    n++;
    if (c.result === "tie") winsA += 0.5;
    else if ((c.result === "a") === aFirst) winsA++;
  }
  return { n, winsA, rate: n ? winsA / n : null };
}
