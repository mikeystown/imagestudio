// Bradley-Terry scores from all pairwise picks, shared by tabs and refitted only when the library or the
// picks change (the last pick's id catches an undo followed by a new pick).

import { state } from "./util.js";
import { fitBradleyTerry } from "../lib/compare.js";

let cache = { key: "", scores: new Map() };

export function globalScores() {
  const key = `${state.library.length}:${state.comparisons.length}:${state.comparisons.at(-1)?.id ?? ""}`;
  if (cache.key !== key) cache = { key, scores: fitBradleyTerry(state.library.map((r) => r.file), state.comparisons) };
  return cache.scores;
}
