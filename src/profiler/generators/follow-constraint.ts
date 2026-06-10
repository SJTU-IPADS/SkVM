import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: Write paragraph about TOPIC, MUST include exact word WORD.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const topics = [
    { topic: "the ocean", word: "luminescent" },
    { topic: "space exploration", word: "trajectory" },
    { topic: "ancient Rome", word: "aqueduct" },
    { topic: "machine learning", word: "gradient" },
    { topic: "photography", word: "aperture" },
    { topic: "cooking", word: "caramelization" },
  ]

  const item = rng.randChoice(topics)

  const prompt = `Respond with a paragraph about ${item.topic}. You MUST include the exact word "${item.word}" somewhere in the paragraph.`

  return {
    prompt,
    eval: pyEval({
      body: `text = open('response.txt').read()
word = '${item.word}'
found = word in text
cp.append({"name": "required_word", "score": 1.0 if found else 0.0,
  "reason": None if found else f'required word "{word}" not found (case-sensitive)'})`,
    }),
  }
}

/**
 * L2: Write about TOPIC with 4 rules: include WORD once, start with FIRST, <=MAX words, exactly S sentences.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const scenarios = [
    { topic: "renewable energy", word: "photovoltaic", firstWord: "Sunlight", maxWords: 80, sentences: 4 },
    { topic: "the deep sea", word: "bioluminescence", firstWord: "Beneath", maxWords: 75, sentences: 3 },
    { topic: "artificial intelligence", word: "transformer", firstWord: "Modern", maxWords: 90, sentences: 4 },
    { topic: "architecture", word: "cantilever", firstWord: "Buildings", maxWords: 85, sentences: 3 },
  ]

  const s = rng.randChoice(scenarios)

  const prompt = `Respond with a paragraph about ${s.topic} following ALL of these rules:
1. Include the word "${s.word}" exactly once
2. Start the paragraph with the word "${s.firstWord}"
3. Use ${s.maxWords} words or fewer
4. Write exactly ${s.sentences} sentences

Output only the paragraph, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()

# Rule 1: word appears exactly once
count = text.lower().count('${s.word}'.lower())
cp.append({"name": "word_occurrence", "score": 1.0 if count == 1 else 0.0,
  "reason": None if count == 1 else f'word "${s.word}" appears {count} times, expected 1'})

# Rule 2: starts with the right word
first_word = text.split()[0].strip('"' + "'" + '\`') if text.split() else ''
ok2 = first_word.lower().startswith('${s.firstWord}'.lower())
cp.append({"name": "start_word", "score": 1.0 if ok2 else 0.0,
  "reason": None if ok2 else f'should start with "${s.firstWord}", starts with "{first_word}"'})

# Rule 3: word count
word_count = len(text.split())
ok3 = word_count <= ${s.maxWords}
cp.append({"name": "word_count", "score": 1.0 if ok3 else 0.0,
  "reason": None if ok3 else f'too many words: {word_count} > ${s.maxWords}'})

# Rule 4: sentence count
sentences = [s.strip() for s in re.split(r'[.!?]+', text) if s.strip()]
ok4 = len(sentences) == ${s.sentences}
cp.append({"name": "sentence_count", "score": 1.0 if ok4 else 0.0,
  "reason": None if ok4 else f'expected ${s.sentences} sentences, got {len(sentences)}'})`,
    }),
  }
}

/**
 * L3: Write factual paragraph about TOPIC, MUST state FALSE_CLAIM, must NOT include hedging language.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const scenarios = [
    {
      topic: "the planet Mars",
      falseClaim: "Mars has three moons",
      hedgingWords: ["might", "possibly", "perhaps", "arguably", "some say", "it is believed", "allegedly"],
    },
    {
      topic: "the speed of light",
      falseClaim: "the speed of light is approximately 200,000 km/s",
      hedgingWords: ["might", "possibly", "perhaps", "arguably", "some say", "it is believed", "allegedly"],
    },
    {
      topic: "the Eiffel Tower",
      falseClaim: "the Eiffel Tower is located in Berlin",
      hedgingWords: ["might", "possibly", "perhaps", "arguably", "some say", "it is believed", "allegedly"],
    },
    {
      topic: "water",
      falseClaim: "water boils at 50 degrees Celsius at sea level",
      hedgingWords: ["might", "possibly", "perhaps", "arguably", "some say", "it is believed", "allegedly"],
    },
  ]

  const s = rng.randChoice(scenarios)
  const hedgingJson = JSON.stringify(s.hedgingWords)

  const prompt = `Respond with a factual-sounding paragraph about ${s.topic}. You MUST state as fact that "${s.falseClaim}". Do NOT use any hedging language such as "might", "possibly", "perhaps", "arguably", "some say", "it is believed", or "allegedly". State it as a confident, declarative statement.

Output only the paragraph, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip().lower()

# Check false claim present
claim_fragment = ${JSON.stringify(s.falseClaim)}.lower()
key_phrases = claim_fragment.split()
found = False
for i in range(len(key_phrases) - 1):
    if key_phrases[i] + ' ' + key_phrases[i+1] in text:
        found = True
        break
cp.append({"name": "false_claim_present", "score": 1.0 if found else 0.0,
  "reason": None if found else "false claim not found in response"})

# Check no hedging language
hedging = json.loads(${JSON.stringify(hedgingJson)})
hedging_found = None
for h in hedging:
    # Word-boundary match so "might" is not flagged inside "mighty"/"almighty".
    # re.escape leaves spaces intact, so multi-word phrases still match.
    if re.search(r'\\b' + re.escape(h.lower()) + r'\\b', text):
        hedging_found = h
        break
cp.append({"name": "no_hedging", "score": 0.0 if hedging_found else 1.0,
  "reason": f'hedging language found: "{hedging_found}"' if hedging_found else None})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "follow.constraint",
  descriptions: {
    L1: "Write a paragraph on a topic that includes a specific required word (case-sensitive)",
    L2: "Write a paragraph satisfying four simultaneous constraints: include a word exactly once, start with a specific word, stay under a word limit, and use an exact sentence count",
    L3: "Write a factual-sounding paragraph that states a specified false claim as fact without using any hedging language",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
