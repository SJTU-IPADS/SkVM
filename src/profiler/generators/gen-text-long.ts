import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

const TOPICS = [
  "machine learning algorithms",
  "cloud computing architectures",
  "cybersecurity best practices",
  "modern web development",
  "database optimization techniques",
  "distributed systems design",
  "API design principles",
  "containerization and orchestration",
]

const START_MARKERS = ["===BEGIN===", "---START---", "<<<CONTENT>>>"]
const END_MARKERS = ["===END===", "---FINISH---", "<<<END>>>"]

/**
 * L1: Write numbered list of K TOPIC items with descriptions,
 * wrap with START/END markers. Eval: markers present, length <1KB, item count match.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const K = rng.randInt(5, 10)
  const TOPIC = rng.randChoice(TOPICS)
  const START = rng.randChoice(START_MARKERS)
  const END = rng.randChoice(END_MARKERS)

  return {
    prompt: `Respond with a numbered list of exactly ${K} key concepts related to ${TOPIC}. Each item should have a brief one-sentence description.

IMPORTANT: Wrap your entire response with these exact markers:
- Start with: ${START}
- End with: ${END}

Provide ONLY the markers and the list between them, nothing else.`,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read()
has_start = '${START}' in text
cp.append({"name": "start_marker", "score": 1.0 if has_start else 0.0,
  "reason": None if has_start else "missing start marker"})
has_end = '${END}' in text
cp.append({"name": "end_marker", "score": 1.0 if has_end else 0.0,
  "reason": None if has_end else "missing end marker"})
if has_start and has_end:
    content = text[text.index('${START}')+len('${START}'):text.index('${END}')]
    items = re.findall(r'^\\s*\\d+[.)]\\s+', content, re.MULTILINE)
    count_ok = len(items) == ${K}
    cp.append({"name": "item_count", "score": 1.0 if count_ok else 0.0,
      "reason": None if count_ok else f"expected ${K} items, got {len(items)}"})
    size_ok = len(text.encode()) < 1024 * 5
    cp.append({"name": "byte_size", "score": 1.0 if size_ok else 0.0,
      "reason": None if size_ok else f"response too large: {len(text.encode())} bytes"})`,
    }),
  }
}

/**
 * L2: Write technical document about TOPIC with S sections,
 * each with ## heading and >=3 paragraphs, wrap with markers.
 * Length 1.5-5KB.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const TOPIC = rng.randChoice(TOPICS)
  const S = rng.randInt(3, 5)
  const START = rng.randChoice(START_MARKERS)
  const END = rng.randChoice(END_MARKERS)

  return {
    prompt: `Respond with a technical document about ${TOPIC} with exactly ${S} sections. Each section must:
- Start with a ## heading
- Contain at least 3 paragraphs of substantive content

IMPORTANT: Wrap your entire response with these exact markers:
- Start with: ${START}
- End with: ${END}

The document should be between 1500 and 5000 bytes. Provide ONLY the markers and the document between them, nothing else.`,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read()
has_start = '${START}' in text
cp.append({"name": "start_marker", "score": 1.0 if has_start else 0.0,
  "reason": None if has_start else "missing start marker"})
has_end = '${END}' in text
cp.append({"name": "end_marker", "score": 1.0 if has_end else 0.0,
  "reason": None if has_end else "missing end marker"})
if has_start and has_end:
    content = text[text.index('${START}')+len('${START}'):text.index('${END}')]
    byte_len = len(content.encode())
    min_ok = byte_len >= 1000
    cp.append({"name": "byte_size_min", "score": 1.0 if min_ok else 0.0,
      "reason": None if min_ok else f"too short: {byte_len} bytes (need >= 1000)"})
    max_ok = byte_len <= 8000
    cp.append({"name": "byte_size_max", "score": 1.0 if max_ok else 0.0,
      "reason": None if max_ok else f"too long: {byte_len} bytes (need <= 8000)"})
    sections = re.findall(r'^##\\s+.+', content, re.MULTILINE)
    sec_ok = len(sections) >= ${S}
    cp.append({"name": "section_count", "score": 1.0 if sec_ok else 0.0,
      "reason": None if sec_ok else f"expected ${S} sections, got {len(sections)}"})`,
    }),
  }
}

/**
 * L3: Write comprehensive reference document about TOPIC with S sections
 * and SUB subsections each, table of contents and summary.
 * Wrap with markers. Length 5-10KB.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const TOPIC = rng.randChoice(TOPICS)
  const S = rng.randInt(3, 5)
  const SUB = rng.randInt(2, 3)
  const START = rng.randChoice(START_MARKERS)
  const END = rng.randChoice(END_MARKERS)

  return {
    prompt: `Respond with a comprehensive reference document about ${TOPIC} with:
1. A table of contents at the top
2. Exactly ${S} main sections (## headings)
3. Each main section must have exactly ${SUB} subsections (### headings)
4. Each subsection should have at least 2 paragraphs
5. A summary section at the end

IMPORTANT: Wrap your entire response with these exact markers:
- Start with: ${START}
- End with: ${END}

The document should be at least 5000 bytes. Provide ONLY the markers and the document between them, nothing else.`,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read()
has_start = '${START}' in text
cp.append({"name": "start_marker", "score": 1.0 if has_start else 0.0,
  "reason": None if has_start else "missing start marker"})
has_end = '${END}' in text
cp.append({"name": "end_marker", "score": 1.0 if has_end else 0.0,
  "reason": None if has_end else "missing end marker"})
if has_start and has_end:
    content = text[text.index('${START}')+len('${START}'):text.index('${END}')]
    byte_len = len(content.encode())
    size_ok = byte_len >= 3000
    cp.append({"name": "byte_size", "score": 1.0 if size_ok else 0.0,
      "reason": None if size_ok else f"too short: {byte_len} bytes (need >= 3000)"})
    sections = re.findall(r'^##\\s+(?!#).+', content, re.MULTILINE)
    sec_ok = len(sections) >= ${S}
    cp.append({"name": "section_count", "score": 1.0 if sec_ok else 0.0,
      "reason": None if sec_ok else f"expected >= ${S} main sections (##), got {len(sections)}"})
    subsections = re.findall(r'^###\\s+.+', content, re.MULTILINE)
    min_sub = ${S * SUB}
    sub_ok = len(subsections) >= min_sub
    cp.append({"name": "subsection_count", "score": 1.0 if sub_ok else 0.0,
      "reason": None if sub_ok else f"expected >= {min_sub} subsections (###), got {len(subsections)}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "gen.text.long",
  descriptions: {
    L1: "Write a numbered list of key concepts on a topic, wrapped in start/end markers, with exact item count",
    L2: "Write a technical document with multiple sections (## headings), each with multiple paragraphs, within a byte-size range",
    L3: "Write a comprehensive reference document with table of contents, main sections with subsections, and a summary, exceeding 5KB",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
