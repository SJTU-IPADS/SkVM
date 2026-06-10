import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: Write 2-3 sentences about TOPIC in formal academic tone. No contractions, no first person.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const topics = [
    "climate change",
    "quantum computing",
    "the Industrial Revolution",
    "biodiversity loss",
    "artificial neural networks",
    "the Roman Empire",
  ]

  const topic = rng.randChoice(topics)

  const prompt = `Respond with 2-3 sentences about ${topic} in a formal academic tone. Rules:
- No contractions (don't, can't, it's, etc.)
- No first person pronouns (I, me, my, we, our, etc.)

Provide only the sentences, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()

contractions = re.findall(r"\\b\\w+'\\w+\\b", text)
common_contractions = ["don't", "can't", "won't", "isn't", "aren't", "wasn't", "weren't",
    "it's", "that's", "there's", "here's", "what's", "who's",
    "I'm", "I've", "I'll", "I'd", "we're", "we've", "we'll",
    "they're", "they've", "they'll", "you're", "you've", "you'll",
    "he's", "she's", "couldn't", "wouldn't", "shouldn't", "didn't",
    "hasn't", "haven't", "hadn't"]
found_contractions = [c for c in contractions if c.lower() in common_contractions]
no_contr = len(found_contractions) == 0
cp.append({"name": "no_contractions", "score": 1.0 if no_contr else 0.0,
  "reason": None if no_contr else "contractions found: %s" % found_contractions})

first_person = re.findall(r'\\b(I|me|my|mine|myself|we|us|our|ours|ourselves)\\b', text, re.IGNORECASE)
no_fp = len(first_person) == 0
cp.append({"name": "tone_correct", "score": 1.0 if no_fp else 0.0,
  "reason": None if no_fp else "first person pronouns found: %s" % first_person[:3]})

sentences = [s.strip() for s in re.split(r'[.!?]+', text) if s.strip()]
sent_ok = 2 <= len(sentences) <= 3
cp.append({"name": "word_count", "score": 1.0 if sent_ok else 0.0,
  "reason": None if sent_ok else "expected 2-3 sentences, got %d" % len(sentences)})`,
    }),
  }
}

/**
 * L2: Explain CONCEPT to a 5-year-old. Simple words, enthusiastic tone with exclamation marks.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const concepts = [
    "gravity",
    "photosynthesis",
    "electricity",
    "the water cycle",
    "magnets",
    "the moon",
  ]

  const concept = rng.randChoice(concepts)
  const jargonWords = [
    "therefore", "consequently", "furthermore", "nevertheless", "notwithstanding",
    "paradigm", "methodology", "hypothesis", "synthesize", "extrapolate",
    "aforementioned", "pertaining", "juxtaposition",
  ]

  const jargonJson = JSON.stringify(jargonWords)

  const prompt = `Explain ${concept} to a 5-year-old child. Use simple, everyday words. Be enthusiastic - use exclamation marks! Keep it to 3-4 sentences.

Provide only the explanation, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()

has_excl = '!' in text
cp.append({"name": "tone_correct", "score": 1.0 if has_excl else 0.0,
  "reason": None if has_excl else "no exclamation marks found (should be enthusiastic)"})

jargon = json.loads('${jargonJson}')
# Word-boundary match so a forbidden word is only flagged as a standalone word,
# not as a substring of an innocent one (e.g. "paradigm" inside "paradigms").
found_jargon = [w for w in jargon if re.search(r'\\b' + re.escape(w.lower()) + r'\\b', text.lower())]
no_jargon = len(found_jargon) == 0
cp.append({"name": "no_jargon", "score": 1.0 if no_jargon else 0.0,
  "reason": None if no_jargon else f"jargon words found: {found_jargon}"})

word_count = len(text.split())
wc_ok = word_count <= 120
cp.append({"name": "word_count", "score": 1.0 if wc_ok else 0.0,
  "reason": None if wc_ok else f"too long for a 5-year-old explanation: {word_count} words"})`,
    }),
  }
}

/**
 * L3: Write S-section document about TOPIC in REGISTER style throughout.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const scenarios = [
    {
      topic: "coffee",
      sections: 3,
      register: "pirate",
      // Kept apostrophe-free: markers are embedded in a single-quoted Python
      // string via json.loads('...'), so a marker like "cap'n" would break it.
      markers: ["arr", "aye", "ye", "matey", "ahoy", "avast", "yarr", "scurvy",
        "landlubber", "buccaneer", "doubloon", "grog", "hearties", "scallywag",
        "sail", "sea", "seas", "treasure", "ship", "plunder", "booty", "mast",
        "deck", "captain", "crew", "anchor", "rum", "wench", "swab", "parrot"],
      minMarkers: 2,
    },
    {
      topic: "software testing",
      sections: 3,
      register: "Shakespearean",
      markers: ["thou", "thee", "thy", "thine", "hath", "doth", "dost", "hast",
        "art", "forsooth", "prithee", "verily", "alas", "hence", "henceforth",
        "wherefore", "whence", "ere", "anon", "mayhap", "perchance", "nay",
        "aye", "tis", "twas", "betwixt", "fie", "yon", "yonder", "morrow",
        "knave", "wouldst", "shouldst", "couldst", "shalt", "wilt", "oft", "naught"],
      minMarkers: 2,
    },
    {
      topic: "exercise",
      sections: 3,
      register: "film noir detective",
      markers: ["dame", "broad", "moll", "blonde", "case", "clue", "suspect",
        "alibi", "frame", "patsy", "sucker", "lowlife", "racket", "dark",
        "night", "midnight", "shadows", "shadow", "fog", "rain", "cold", "neon",
        "streetlight", "alley", "smoke", "cigarette", "whiskey", "bourbon",
        "bottle", "joint", "fedora", "trench", "detective", "gumshoe", "private",
        "client", "mystery", "trouble", "tail", "stiff", "heater", "gun",
        "killer", "dead", "body", "murder", "crime", "noir", "dough"],
      minMarkers: 2,
    },
  ]

  const s = rng.randChoice(scenarios)
  const markersJson = JSON.stringify(s.markers)

  const prompt = `Respond with a ${s.sections}-section document about ${s.topic} in the style of a ${s.register}. Each section should have a heading (on its own line, starting with "##") followed by 2-3 sentences. The ${s.register} style must be maintained consistently throughout EVERY section.

Provide only the document, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()

sections = [s.strip() for s in re.split(r'^##', text, flags=re.MULTILINE) if s.strip()]
sec_ok = len(sections) >= ${s.sections}
cp.append({"name": "section_count", "score": 1.0 if sec_ok else 0.0,
  "reason": None if sec_ok else f"expected ${s.sections} sections, got {len(sections)}"})

markers = json.loads('${markersJson}')
# Word-boundary match so short markers (e.g. "art", "oft", "ye") are only
# counted as standalone words, not as substrings of ordinary prose like
# "software" (contains "oft") or "Part" (contains "art").
def marker_hits(s):
    low = s.lower()
    return [m for m in markers if re.search(r'\\b' + re.escape(m.lower()) + r'\\b', low)]
found = marker_hits(text)
marker_ok = len(found) >= ${s.minMarkers}
cp.append({"name": "marker_count", "score": 1.0 if marker_ok else 0.0,
  "reason": None if marker_ok else f"too few ${s.register} style markers: found {found}, need >= ${s.minMarkers}"})

if len(sections) >= ${s.sections}:
    # Graded consistency: fraction of sections carrying at least one style
    # marker. A single section using out-of-list synonyms no longer zeroes the
    # whole checkpoint -- it passes as long as the majority stay in register.
    secs_with = sum(1 for sec in sections if marker_hits(sec))
    frac = secs_with / len(sections)
    missing = [i + 1 for i, sec in enumerate(sections)
               if not marker_hits(sec)]
    cp.append({"name": "style_consistent", "score": round(frac, 3),
      "reason": None if not missing else f"sections lacking ${s.register} style markers: {missing}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "follow.style",
  descriptions: {
    L1: "Write 2-3 sentences in formal academic tone with no contractions and no first-person pronouns",
    L2: "Explain a scientific concept to a 5-year-old using simple words and enthusiastic tone, avoiding jargon",
    L3: "Write a multi-section document maintaining a specific stylistic register (e.g., pirate, Shakespearean, film noir) consistently throughout every section",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
