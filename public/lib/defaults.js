// Default template and slot pools the app starts with.

export const DEFAULT_TEMPLATE =
  "Candid phone photo of {name}, a naturally pretty adult woman in her mid-twenties with a natural, girl-next-door look, " +
  "photographed casually by a friend. Soft, slim oval face with gentle, unexaggerated features: {eyes}, {nose}, {lips}, {brows}. " +
  "{hair}. Fair skin with natural texture, {freckles}, no makeup. {expression}. Wearing {top}. " +
  "{setting}, ordinary natural lighting, everyday snapshot.";

const RAW_POOLS = {
  name: ["Freya", "Clara", "Sophie", "Hannah", "Isla", "Nora", "Lucy", "Ella", "Maya", "Grace", "Elise", "Annika", "Rosie", "Lena", "Tess", "Juliet"],
  eyes: ["light blue-grey eyes", "pale blue eyes", "soft green eyes", "hazel-green eyes", "bright blue eyes"],
  nose: ["a small straight nose", "a small nose with a soft rounded tip", "a small, slightly upturned nose"],
  lips: ["soft natural lips", "naturally full lips", "a naturally full lower lip"],
  brows: ["natural light brown brows", "soft straight brows", "slightly fuller natural brows"],
  hair: [
    "Light brown hair tucked behind one ear with a few loose strands",
    "Honey-brown hair in a loose low ponytail",
    "Dark brunette hair, loose and slightly wavy",
    "Chestnut hair with a few face-framing strands",
    "Light copper-brown hair worn down",
    "Dark blonde hair pulled back loosely",
  ],
  freckles: ["no freckles", "a few faint freckles", "light freckles across the nose"],
  expression: [
    "A slightly lopsided, playful half-smile, head tilted",
    "A soft closed-lip smile, looking at the camera",
    "Relaxed, just about to laugh",
    "A small knowing smile, glancing slightly off camera",
  ],
  top: ["a plain white t-shirt", "a grey crewneck sweatshirt", "an oversized cream sweater", "a light blue button-up shirt", "a simple black t-shirt"],
  setting: ["Sitting in a sunny kitchen", "In a park on an overcast day", "Inside a busy café", "In her living room by a window", "On a city street in the afternoon"],
};

export const DEFAULT_POOLS = Object.fromEntries(
  Object.entries(RAW_POOLS).map(([slot, values]) => [slot, values.map((value) => ({ value, weight: 1 }))]),
);

export function defaultPoolSet() {
  return { template: DEFAULT_TEMPLATE, pools: structuredClone(DEFAULT_POOLS), locks: {} };
}
