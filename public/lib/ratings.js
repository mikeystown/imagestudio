// Rating scale (stored 0–6, shown and exported as 1–7) and limiting-factor tags.

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

// Sidecars store ratings as 0–6. Everything shown or exported uses the 1–7 score of the Rate tab keys.
export const SOLID_SCORE = SOLID + 1;
export const scoreOf = (rec) => rec.rating.value + 1;

export const isRated =(rec) => Number.isInteger(rec?.rating?.value) && rec.rating.value >= 0 && rec.rating.value < RATINGS.length;
