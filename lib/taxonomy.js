// PAKT — taxonomy.js — one canonical niche vocabulary.
//
// This used to live in three places with three different lists: rate
// benchmarks knew about `beauty` and `gaming`, caption SEO and the idea
// engine did not, and anything they didn't recognise silently fell back to
// `food`. A beauty creator got street-food content ideas and never knew why.
// Every table below is keyed by the same NICHES list, and signup validates
// against it, so a fallback can no longer happen quietly.
'use strict';

const NICHES = ['food', 'fitness', 'fashion', 'beauty', 'tech', 'travel', 'gaming', 'finance', 'lifestyle', 'diy'];

// per-post rate multiplier applied to the follower band
const NICHE_MULT = {
  finance: 1.5, tech: 1.35, beauty: 1.2, fitness: 1.15, fashion: 1.15,
  travel: 1.1, gaming: 1.05, food: 1.0, lifestyle: 1.0, diy: 1.0,
};

// caption social-SEO keywords — captions outrank hashtags for discovery
const NICHE_KEYWORDS = {
  food: ['recipe', 'restaurant', 'street food', 'cafe', 'cooking', 'foodie', 'breakfast', 'dinner', 'taste'],
  fitness: ['workout', 'gym', 'training', 'exercise', 'muscle', 'weight', 'reps', 'form', 'protein'],
  fashion: ['outfit', 'style', 'thrift', 'wardrobe', 'lookbook', 'ootd', 'styling', 'wear'],
  beauty: ['skincare', 'routine', 'makeup', 'shade', 'serum', 'sunscreen', 'texture', 'ingredients', 'swatch'],
  tech: ['review', 'unboxing', 'specs', 'gadget', 'app', 'setup', 'comparison', 'budget'],
  travel: ['itinerary', 'hidden gem', 'guide', 'budget travel', 'places', 'trip', 'destination'],
  gaming: ['gameplay', 'build', 'settings', 'fps', 'controller', 'patch', 'ranked', 'walkthrough'],
  finance: ['savings', 'sip', 'tax', 'budget', 'invest', 'mutual fund', 'emergency fund', 'credit score'],
  lifestyle: ['routine', 'morning', 'declutter', 'habits', 'home', 'journal', 'slow living', 'reset'],
  diy: ['tutorial', 'handmade', 'craft', 'how to', 'materials', 'step by step', 'upcycle'],
};

// idea-engine topic pools
const NICHE_TOPICS = {
  food: ['street food in your city', 'a 20-rupee breakfast', 'restaurant menus', 'homemade chai', 'late-night eats', 'tiffin spots'],
  fitness: ['home workouts', 'protein on a budget', 'gym anxiety', 'morning routines', 'desk-job posture', 'rest days'],
  fashion: ['thrift hauls', 'capsule wardrobes', 'festival outfits', 'office fits', 'accessorizing basics', 'monsoon style'],
  beauty: ['drugstore skincare', 'sunscreen myths', 'a 5-minute face', 'ingredient labels', 'monsoon skin', 'shade matching'],
  tech: ['budget earbuds', 'phone cameras', 'desk setups', 'free apps', 'battery myths', 'laptop buying'],
  travel: ['weekend getaways', 'hidden local spots', 'train journeys', 'solo travel', 'packing light', 'budget stays'],
  gaming: ['budget gaming setups', 'controller settings', 'underrated indie games', 'rank grinding', 'patch reactions', 'game backlogs'],
  finance: ['your first SIP', 'tax-saving basics', 'emergency funds', 'credit score myths', 'salary budgeting', 'insurance traps'],
  lifestyle: ['morning routines', 'decluttering a room', 'sunday resets', 'habit tracking', 'slow mornings', 'budget home decor'],
  diy: ['5-minute crafts', 'upcycled decor', 'gift wrapping', 'balcony gardens', 'repair hacks', 'festive decor'],
};

const CURRENCIES = ['USD', 'INR', 'EUR', 'GBP'];
// used for display only — money is always stored as integer minor units
const CURRENCY_MINOR = { USD: 'cents', INR: 'paise', EUR: 'cents', GBP: 'pence' };
const CURRENCY_SYMBOL = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };

const normalizeNiche = (n) => {
  const k = String(n || '').toLowerCase().trim();
  return NICHES.includes(k) ? k : null;
};

module.exports = { NICHES, NICHE_MULT, NICHE_KEYWORDS, NICHE_TOPICS, CURRENCIES, CURRENCY_MINOR, CURRENCY_SYMBOL, normalizeNiche };
