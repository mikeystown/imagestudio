// Rating scale (ordinal 0–6) and limiting-factor tags.

export const RATINGS = [
  "Unattractive",
  "Mid pretty",
  "Upper pretty",
  "Lower beautiful",
  "Solid beautiful",
  "High beautiful",
  "Stunning",
];

// "Solid beautiful or above" threshold used by the analysis.
export const SOLID = RATINGS.indexOf("Solid beautiful");

export const TAGS = [
  "Structure",
  "Eyes",
  "Lips",
  "Brows",
  "Colouring",
  "Hair",
  "Magnetism",
  "Too plastic",
  "Too model-esque",
  "Too plain",
  "Looks too old",
  "Looks too young",
];

// Keyboard key for each tag, in the same order as TAGS.
export const TAG_KEYS = "qwertyuiopas".split("");

export const isRated = (rec) => Number.isInteger(rec?.rating?.value) && rec.rating.value >= 0 && rec.rating.value < RATINGS.length;
