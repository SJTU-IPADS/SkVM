import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

const TOPICS = [
  "artificial intelligence", "renewable energy", "space exploration",
  "ocean conservation", "quantum computing", "urban planning",
  "genetic engineering", "digital privacy", "sustainable agriculture",
]
const KEYWORDS_POOL = [
  "innovation", "sustainability", "efficiency", "scalability", "resilience",
  "transformation", "infrastructure", "ecosystem", "framework", "paradigm",
  "optimization", "integration", "methodology", "advancement", "regulation",
]
const TITLES = [
  "The Future of Technology", "Bridging the Gap", "A New Perspective",
  "Understanding Complexity", "Toward Better Solutions", "Rethinking Progress",
]
const GENRES = [
  "technical analysis", "persuasive essay", "expository article",
  "research summary", "opinion piece", "comparative study",
]
const REGISTERS = [
  "formal academic", "professional", "journalistic",
  "technical", "analytical",
]

/**
 * L1: Write paragraph of >=S sentences about TOPIC including keywords KW.
 * Eval: length, sentence count, keyword presence.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const S = rng.randInt(4, 7)
  const TOPIC = rng.randChoice(TOPICS)
  const KW = rng.sample(KEYWORDS_POOL, rng.randInt(2, 3))
  const kwList = KW.map((k) => `"${k}"`).join(", ")

  return {
    prompt: `Respond with a single paragraph of at least ${S} sentences about ${TOPIC}. You must include these keywords naturally in the text: ${kwList}.

Provide ONLY the paragraph, nothing else.`,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
sentences = [s.strip() for s in re.split(r'[.!?]+(?:\\s|$)', text) if s.strip()]
sent_ok = len(sentences) >= ${S}
cp.append({"name": "sentence_count", "score": 1.0 if sent_ok else 0.0,
  "reason": None if sent_ok else f"expected >= ${S} sentences, got {len(sentences)}"})
lower = text.lower()
keywords = [${KW.map((k) => `'${k}'`).join(", ")}]
for kw in keywords:
    found = kw.lower() in lower
    cp.append({"name": f"keyword_{kw}", "score": 1.0 if found else 0.0,
      "reason": None if found else f"missing keyword: {kw}"})
len_ok = len(text) >= 100
cp.append({"name": "length_ok", "score": 1.0 if len_ok else 0.0,
  "reason": None if len_ok else f"too short: {len(text)} chars"})`,
    }),
  }
}

/**
 * L2: Write structured essay titled TITLE with S sections
 * (## headed, 2-3 paragraphs of 3-4 sentences).
 * Eval: section markers, paragraph counts.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const TITLE = rng.randChoice(TITLES)
  const S = rng.randInt(3, 5)

  return {
    prompt: `Respond with a structured essay titled "${TITLE}" with exactly ${S} sections. Each section must:
- Start with a ## heading
- Contain 2-3 paragraphs
- Each paragraph should have 3-4 sentences

Provide ONLY the essay, nothing else.`,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
sections = re.findall(r'^##\\s+.+', text, re.MULTILINE)
sec_ok = len(sections) >= ${S}
cp.append({"name": "section_count", "score": 1.0 if sec_ok else 0.0,
  "reason": None if sec_ok else f"expected ${S} sections, got {len(sections)}"})
parts = re.split(r'^##\\s+.+', text, flags=re.MULTILINE)
body_parts = [p.strip() for p in parts[1:] if p.strip()]
body_ok = len(body_parts) >= ${S}
cp.append({"name": "body_parts", "score": 1.0 if body_ok else 0.0,
  "reason": None if body_ok else f"expected ${S} non-empty section bodies, got {len(body_parts)}"})
if body_ok:
    para_ok = True
    para_reason = None
    for i, part in enumerate(body_parts[:${S}]):
        paragraphs = [p.strip() for p in re.split(r'\\n\\s*\\n', part) if p.strip()]
        if len(paragraphs) < 2:
            para_ok = False
            para_reason = f"section {i+1} has only {len(paragraphs)} paragraphs (need >= 2)"
            break
    cp.append({"name": "paragraphs_per_section", "score": 1.0 if para_ok else 0.0,
      "reason": para_reason})`,
    }),
  }
}

/**
 * L3: Write GENRE document about TOPIC with intro, S body sections, conclusion.
 * Maintain REGISTER throughout. Target: 3-5KB.
 * Eval: structure completeness, register consistency.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const GENRE = rng.randChoice(GENRES)
  const TOPIC = rng.randChoice(TOPICS)
  const S = rng.randInt(3, 5)
  const REGISTER = rng.randChoice(REGISTERS)

  return {
    prompt: `Respond with a ${GENRE} about ${TOPIC} in a ${REGISTER} register. The document must include:
1. An introduction section (## Introduction)
2. Exactly ${S} body sections (## headings with descriptive titles)
3. A conclusion section (## Conclusion)

Each section should have at least 2 paragraphs. Maintain a ${REGISTER} tone throughout.
The total length should be approximately 3000-5000 bytes.

Provide ONLY the document, nothing else.`,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
byte_len = len(text.encode())
sections = re.findall(r'^##\\s+.+', text, re.MULTILINE)
min_sections = ${S} + 2
sec_ok = len(sections) >= min_sections
cp.append({"name": "section_count", "score": 1.0 if sec_ok else 0.0,
  "reason": None if sec_ok else f"expected >= {min_sections} sections, got {len(sections)}"})
has_intro = any('intro' in s.lower() for s in sections)
cp.append({"name": "has_introduction", "score": 1.0 if has_intro else 0.0,
  "reason": None if has_intro else "missing Introduction section"})
has_conclusion = any('conclu' in s.lower() for s in sections)
cp.append({"name": "has_conclusion", "score": 1.0 if has_conclusion else 0.0,
  "reason": None if has_conclusion else "missing Conclusion section"})
min_ok = byte_len >= 1500
cp.append({"name": "byte_size_min", "score": 1.0 if min_ok else 0.0,
  "reason": None if min_ok else f"too short: {byte_len} bytes"})
max_ok = byte_len <= 10000
cp.append({"name": "byte_size_max", "score": 1.0 if max_ok else 0.0,
  "reason": None if max_ok else f"too long: {byte_len} bytes"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "gen.text.prose",
  descriptions: {
    L1: "Write a single paragraph with a minimum sentence count on a topic, naturally incorporating required keywords",
    L2: "Write a structured essay with a title, multiple headed sections, and multiple paragraphs per section",
    L3: "Write a genre-specific document (e.g., technical analysis, persuasive essay) with introduction, body sections, and conclusion in a specified register",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
