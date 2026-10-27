/**
 * Seeds: how a word or phrase becomes the number every CLATTER generator runs on.
 *
 * There is ONE seed system. Every seeded decision in CLATTER (generation, kit design, sound
 * variations, WILDCARD, conditional triggers, modulation randoms, export) already runs on a
 * 32-bit unsigned integer through the keyed hash and the small generator in ./rng. A phrase is a
 * human-readable way to name such a number; it never feeds a generator directly.
 *
 *   phrase  --normalise-->  canonical text  --SEED HASH v1-->  uint32  --> rng.ts (unchanged)
 *
 * The number is the truth. A project stores both (`seed` and `seedText`); the number alone
 * reproduces the result, so a project made with a numeric seed (every project before this
 * system) loads and plays exactly as it always did, and a phrase whose hash ever changed would
 * still reproduce the work it made. See docs/SEEDS.md.
 *
 * SEED HASH v1 (documented so that it can be re-implemented anywhere):
 *   1. NFKC-normalise, lower-case (Unicode default case mapping, not locale dependent), drop
 *      control and format characters, treat every run of white space, "-" and "_" as one "-",
 *      trim "-" from both ends, keep at most 80 code points.
 *   2. Encode as UTF-8.
 *   3. FNV-1a, 32 bit (offset 2166136261, prime 16777619) over the bytes.
 *   4. Murmur3 fmix32 finaliser (h ^= h>>>16; h *= 0x85ebca6b; h ^= h>>>13; h *= 0xc2b2ae35;
 *      h ^= h>>>16), so that similar phrases give unrelated seeds.
 *   5. A result of 0 becomes 1 (0 is kept for "no seed" in a few older places).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

/** The version of the phrase-to-number hash above. Stored in projects. Never change v1: add v2. */
export const SEED_HASH_VERSION = 1;

/**
 * The version of the generators' decisions: what a given seed, settings and starting state make.
 * 1 is everything up to and including the introduction of phrases (no generator changed). Bump it
 * when a generator is changed on purpose so that the same seed would now give a different result;
 * projects record the version that made them (saved results are never recomputed from the seed).
 */
export const GENERATOR_VERSION = 1;

/** Most code points kept of a phrase. */
export const SEED_TEXT_MAX = 80;

const MAX_SEED = 0xffffffff;

/** Canonical form of a phrase: what is hashed, stored and shown. May be empty. */
export function normaliseSeedText(input: string): string {
  const words = String(input ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\p{White_Space}_-]+/u)
    .map((w) => w.replace(/[\p{Cc}\p{Cf}]/gu, ''))
    .filter(Boolean);
  return [...words.join('-')].slice(0, SEED_TEXT_MAX).join('').replace(/-+$/, '');
}

function utf8(s: string): Uint8Array {
  // an explicit encoder so that no platform quirk (lone surrogates) can differ
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** SEED HASH v1 of a phrase (normalised first). Defined for the empty phrase too. */
export function seedFromText(input: string): number {
  let h = 2166136261;
  for (const b of utf8(normaliseSeedText(input))) {
    h ^= b;
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) || 1;
}

/** A seed as the project keeps it: the number every generator uses, and the phrase that named it. */
export interface SeedValue {
  seed: number;
  /** canonical phrase; absent for a plain number (every legacy project) */
  text?: string;
}

/**
 * What a person typed or pasted. Digits only (up to 4294967295) is a plain number: that is how
 * seeds have always been typed and it reproduces old results exactly. Anything else is a phrase.
 * Empty (or only separators) is no seed: null.
 */
export function parseSeedInput(input: string): SeedValue | null {
  const t = String(input ?? '').trim();
  if (/^\d{1,10}$/.test(t) && Number(t) <= MAX_SEED) return { seed: Number(t) };
  const text = normaliseSeedText(t);
  return text ? { seed: seedFromText(text), text } : null;
}

/** How a seed is shown and copied: its phrase, or its number. */
export const seedLabel = (s: SeedValue): string => s.text ?? String(s.seed);

/**
 * A stored phrase is only kept if it still names the stored number (or was made by another hash
 * version, in which case the number stays the truth and the phrase is only a label).
 */
export function checkedSeedText(seed: number, text: unknown, hashVersion = SEED_HASH_VERSION): string | undefined {
  if (typeof text !== 'string') return undefined;
  const t = normaliseSeedText(text);
  if (!t) return undefined;
  return hashVersion !== SEED_HASH_VERSION || seedFromText(t) === seed ? t : undefined;
}

/** Assign a seed (and its phrase, or no phrase) onto an object that holds `seed` and `seedText`. */
export function assignSeed(o: { seed: number; seedText?: string }, s: SeedValue): void {
  o.seed = s.seed;
  if (s.text) o.seedText = s.text;
  else delete o.seedText;
}

const ADJECTIVES = `velvet haunted silver hollow crooked electric gentle brittle burnt cosmic dusty feral frozen glass golden hidden
iron jagged lazy lunar molten neon nimble obsidian paper quiet rusty scarlet secret smoky stormy sunken
tangled twisted velour wandering wicked woven yellow zesty amber ancient bitter blunt bright broken calm cheap
chrome clever cobalt coarse copper crimson cruel damp dark dazzling distant dizzy dreamy drowsy eager eerie
elder emerald faded fierce fluffy foggy fuzzy gilded gloomy grainy greasy grim grumpy hasty heavy humble
icy idle indigo inky jolly keen kind lanky lasting leaden lilac liquid little loose loud lucky
lush magic marble mellow mighty minty misty modest mossy muddy mute narrow noble noisy numb odd
olive opal pale patient pearly plain plush polite proud purple quick rapid rare raw restless rough
rowdy royal ruby rural sacred sandy savage shaggy sharp shiny shy silent silken slow sly small
snowy sober solar solid sonic sour spare spicy spiky steady steel sticky stiff stone strange sunny
sweet swift tame tender thick thin tidy tiny toasty tough tropical ultra upbeat vacant vague vast
velvety violet vivid warm wary weary wet wild windy wise witty wooden woolly wry young zany
atomic balmy barren bashful blazing bold brave breezy brisk bubbly bumpy candid chilly clumsy cozy cunning
curly dapper daring deft dense dim dull earthy fancy fearless fiery fickle flat fond fragile frosty
giddy glossy gnarled graceful gritty hairy hardy hazy jaded jazzy jumpy knotty limber lofty lonely lumpy
macabre mad murky nervous nifty oaken ornate peppery perky pitchy plucky prickly quirky rickety rugged salty`.split(/\s+/);

const NOUNS = `orbit machine moth kick ghost engine river lantern anchor arrow badger beacon bell blossom bone bridge
candle canyon castle cavern cipher clock cloud comet compass coral crane crow crown crystal dagger delta desert
dragon drum eagle echo ember falcon feather fern ferry fiddle field flame forest fossil fox garden
garnet glacier goblin gravel harbor hammer harp hawk heron horizon island jackal jungle kettle key
kite ladder lagoon lark lens lichen lighthouse lizard locket lotus magnet mantis maple marsh meadow mirror
monsoon mountain mule needle nest nettle oasis ocean onion orchid otter owl oyster paddle panther pebble
pendulum phantom piano pigeon pillar pilot pine planet plume pocket prism pulse puma quartz quill rabbit
radar rain raven reef ribbon ridge rocket saddle sailor satellite scarab shadow shard shell signal siren
skull sparrow spider spiral spring squid statue stream summit swamp swan temple thistle thunder tiger timber
tower trumpet tunnel turtle valley vault vessel violin vortex wagon walrus wasp whale willow window wolf
wren yarn zebra zeppelin anvil avalanche bagpipe balloon banjo barrel basket bishop boulder bucket cactus cannon
canoe carpet chimney cobweb cricket cymbal diamond dolphin drifter dynamo elevator falls fountain gargoyle giraffe gizmo
glider hornet hurricane igloo jester jukebox kayak kernel lasso leopard lever mammoth marimba meteor mosaic nebula
noodle nugget obelisk octopus paradox parrot pickle pirate platypus puddle pyramid rattle robot rooster sandal scepter
shovel skiff sledge snail sparkplug sphinx spoon squirrel stallion sundial tadpole tambourine tractor trident unicorn vulture
walnut wizard yeti zipper bellows cauldron chisel crucible gong kiln mallet pylon rotor sprocket tuba turbine`.split(/\s+/);

export const SEED_ADJECTIVES: readonly string[] = ADJECTIVES;
export const SEED_NOUNS: readonly string[] = NOUNS;

/** A memorable phrase ("velvet-orbit"): an adjective and a noun, 65,536 in all. */
export function randomSeedPhrase(rand: () => number = secureRandom): string {
  const a = ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)]!;
  const n = NOUNS[Math.floor(rand() * NOUNS.length)]!;
  return `${a}-${n}`;
}

/** A new memorable seed: the phrase and the number it names. */
export function randomSeedValue(rand?: () => number): SeedValue {
  const text = randomSeedPhrase(rand);
  return { seed: seedFromText(text), text };
}

function secureRandom(): number {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0]! / 4294967296;
  } catch {
    return Math.random();
  }
}
