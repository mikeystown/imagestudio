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

// Template used when a batch sends reference images: identity comes from the references, the slots vary
// everything else.
export const DEFAULT_REF_TEMPLATE = `Use the reference image for identity only. Keep the exact face, facial structure, features, skin tone, eye colour and identity of the adult woman in her mid-twenties in the reference image. Keep her beauty mark and natural asymmetries. Do not beautify, smooth or idealise her face.

Candid phone photo of her, taken casually by a friend. Shot on an iPhone, slightly off-center framing, natural lighting, mild phone noise, everyday snapshot. Realistic skin with visible pores, faint peach fuzz and natural texture; a few flyaway hairs. Ordinary, slightly imperfect real-world surroundings.

Change:
- Setting: {setting}
- Outfit: {outfit}
- Hair styling: {hair_styling}
- Expression and pose: {expression_pose}
- Camera angle and distance: {camera}
- Lighting: {lighting}`;

// Starter options for the reference template's slots ({setting} reuses the main pool).
const RAW_REF_POOLS = {
  setting: RAW_POOLS.setting,
  outfit: ["a plain white t-shirt", "a grey crewneck sweatshirt", "an oversized cream knit sweater", "a denim jacket over a black top", "a simple navy summer dress", "a striped long-sleeve top"],
  hair_styling: ["worn down and slightly tousled", "in a loose low ponytail", "tucked behind one ear", "in a messy bun with loose strands", "half up, half down"],
  expression_pose: [
    "a soft closed-lip smile, looking at the camera",
    "laughing mid-conversation, glancing off camera",
    "relaxed and neutral, head slightly tilted",
    "a small knowing smile, chin resting on her hand",
    "caught mid-movement, turning towards the camera",
  ],
  camera: [
    "eye level, waist-up, from about 1.5 metres",
    "slightly above eye level, head and shoulders",
    "close-up of the face from arm's length",
    "eye level, three-quarter body from a few metres away",
    "seated across a table, slightly low angle",
  ],
  lighting: ["soft overcast daylight", "warm late-afternoon sun from the side", "window light indoors", "open shade on a bright day", "warm indoor lamp light in the evening"],
};

export const DEFAULT_REF_POOLS = Object.fromEntries(
  Object.entries(RAW_REF_POOLS).map(([slot, values]) => [slot, values.map((value) => ({ value, weight: 1 }))]),
);
