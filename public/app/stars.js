// Stars ("key picks"): a saved shortlist of images, stored on the server in data/stars.json.

import { state, api, emit, toast } from "./util.js";

export const isStarred = (file) => !!state.stars[file];

export async function loadStars() {
  state.stars = (await api("/api/stars")).stars;
}

// Flip the star at once, then save; undo the flip if saving fails.
export async function toggleStar(file) {
  const next = !isStarred(file);
  const set = (on) => {
    if (on) state.stars[file] = new Date().toISOString();
    else delete state.stars[file];
    emit("stars", file);
  };
  set(next);
  try {
    await api(`/api/stars/${encodeURIComponent(file)}`, { method: "PUT", body: { starred: next } });
  } catch (e) {
    set(!next);
    toast("Could not save the star: " + e.message, true);
  }
}
