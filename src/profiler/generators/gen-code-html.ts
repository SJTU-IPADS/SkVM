import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, PY_EMIT_CHECKPOINTS, type Rng } from "../generator-toolkit.ts"

const TITLES = [
  "Welcome to My Site", "About Our Team", "Product Overview",
  "Getting Started Guide", "FAQ Page", "Contact Information",
]
const ITEMS = [
  "Dashboard", "Settings", "Profile", "Reports", "Analytics",
  "Messages", "Calendar", "Tasks", "Documents", "Help",
]
const COL_NAMES = [
  "Name", "Email", "Phone", "Department", "Role",
  "Location", "Status", "Score", "Joined", "Level",
]
const CHART_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

/**
 * L1: Write HTML with h1 heading TITLE and unordered list of K items.
 * Eval: parse HTML, verify elements.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const TITLE = rng.randChoice(TITLES)
  const K = rng.randInt(3, 7)
  const items = ITEMS.slice(0, K)

  const itemListStr = items.map((it) => `"${it}"`).join(", ")

  return {
    prompt: `Write a complete valid HTML document that contains:
1. An h1 heading with the text "${TITLE}"
2. An unordered list (ul) with exactly ${K} list items (li): ${itemListStr}

Save it as index.html in the current directory.`,
    eval: pyEval({
      imports: ["os"],
      body: `from html.parser import HTMLParser

# Check file exists
if not os.path.exists('index.html'):
    cp.append({"name": "file_created", "score": 0.0, "reason": "index.html not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

cp.append({"name": "file_created", "score": 1.0, "reason": None})

class Checker(HTMLParser):
    def __init__(self):
        super().__init__()
        self.h1_text = []
        self.li_texts = []
        self.in_h1 = False
        self.in_li = False

    def handle_starttag(self, tag, attrs):
        if tag == 'h1': self.in_h1 = True
        if tag == 'li': self.in_li = True

    def handle_endtag(self, tag):
        if tag == 'h1': self.in_h1 = False
        if tag == 'li': self.in_li = False

    def handle_data(self, data):
        if self.in_h1: self.h1_text.append(data.strip())
        if self.in_li: self.li_texts.append(data.strip())

html = open('index.html').read()
c = Checker()
c.feed(html)

# Check h1 heading
h1 = ' '.join(c.h1_text).strip()
if '${TITLE}'.lower() in h1.lower():
    cp.append({"name": "h1_correct", "score": 1.0, "reason": None})
else:
    cp.append({"name": "h1_correct", "score": 0.0, "reason": f'expected "${TITLE}", got "{h1}"'})

# Check li count
if len(c.li_texts) == ${K}:
    cp.append({"name": "li_count", "score": 1.0, "reason": None})
else:
    cp.append({"name": "li_count", "score": 0.0, "reason": f"expected ${K} li items, got {len(c.li_texts)}"})

# Check each expected item is present
expected_items = [${items.map((it) => `'${it}'`).join(", ")}]
for exp in expected_items:
    found = any(exp.lower() in li.lower() for li in c.li_texts)
    if found:
        cp.append({"name": f"item_{exp.lower()}", "score": 1.0, "reason": None})
    else:
        cp.append({"name": f"item_{exp.lower()}", "score": 0.0, "reason": f"missing item: {exp}"})`,
    }),
  }
}

/**
 * L2: Write HTML with semantic structure (header, main, footer)
 * containing data table with C columns and R rows.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const C = rng.randInt(3, 5)
  const R = rng.randInt(3, 6)
  const columns = COL_NAMES.slice(0, C)

  const colListStr = columns.map((c) => `"${c}"`).join(", ")

  return {
    prompt: `Write a complete valid HTML document with semantic structure:
1. A <header> element containing an h1 with text "Data Report"
2. A <main> element containing a table with:
   - A thead with ${C} column headers: ${colListStr}
   - A tbody with exactly ${R} data rows (fill with realistic sample data)
3. A <footer> element with copyright text

Save it as index.html in the current directory.`,
    eval: pyEval({
      imports: ["os"],
      body: `from html.parser import HTMLParser

# Check file exists
if not os.path.exists('index.html'):
    cp.append({"name": "file_created", "score": 0.0, "reason": "index.html not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

cp.append({"name": "file_created", "score": 1.0, "reason": None})

class Checker(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags_found = set()
        self.th_count = 0
        self.tr_count = 0
        self.in_thead = False
        self.in_tbody = False

    def handle_starttag(self, tag, attrs):
        self.tags_found.add(tag)
        if tag == 'thead': self.in_thead = True
        if tag == 'tbody': self.in_tbody = True
        if tag == 'th' and self.in_thead: self.th_count += 1
        if tag == 'tr' and self.in_tbody: self.tr_count += 1

    def handle_endtag(self, tag):
        if tag == 'thead': self.in_thead = False
        if tag == 'tbody': self.in_tbody = False

html = open('index.html').read()
c = Checker()
c.feed(html)

# Check each required semantic tag
for tag in ['header', 'main', 'footer', 'table', 'thead', 'tbody']:
    if tag in c.tags_found:
        cp.append({"name": f"tag_{tag}", "score": 1.0, "reason": None})
    else:
        cp.append({"name": f"tag_{tag}", "score": 0.0, "reason": f"missing <{tag}> element"})

# Check column count
if c.th_count == ${C}:
    cp.append({"name": "structure_correct", "score": 1.0, "reason": None})
else:
    cp.append({"name": "structure_correct", "score": 0.0, "reason": f"expected ${C} th columns, got {c.th_count}"})

# Check row count
if c.tr_count == ${R}:
    cp.append({"name": "content_correct", "score": 1.0, "reason": None})
else:
    cp.append({"name": "content_correct", "score": 0.0, "reason": f"expected ${R} tbody rows, got {c.tr_count}"})`,
    }),
  }
}

/**
 * L3: Write HTML with inline SVG bar chart visualizing K data points.
 * Each bar with correct x/y/width/height. Eval: parse SVG, verify bar count.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const K = rng.randInt(4, 8)
  const labels = CHART_LABELS.slice(0, K)
  const values: number[] = []
  for (let i = 0; i < K; i++) {
    values.push(rng.randInt(10, 100))
  }

  const dataPoints = labels.map((l, i) => `${l}: ${values[i]}`).join(", ")

  return {
    prompt: `Write a complete valid HTML document containing an inline SVG bar chart that visualizes these ${K} data points: ${dataPoints}.

Requirements:
- The SVG element should have a viewBox attribute
- Each data point should be a <rect> element within the SVG
- There should be exactly ${K} rect elements representing the bars
- Each bar should have x, y, width, and height attributes
- Include text labels for each bar

Save it as index.html in the current directory.`,
    eval: pyEval({
      imports: ["os"],
      body: `from html.parser import HTMLParser

# Check file exists
if not os.path.exists('index.html'):
    cp.append({"name": "file_created", "score": 0.0, "reason": "index.html not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

cp.append({"name": "file_created", "score": 1.0, "reason": None})

class SVGChecker(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_svg = False
        self.svg_found = False
        self.rect_count = 0
        self.rect_attrs_ok = 0
        self.rect_attrs_errors = []
        self.svg_has_viewbox = False

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == 'svg':
            self.in_svg = True
            self.svg_found = True
            if 'viewbox' in attrs_dict or 'viewBox' in attrs_dict:
                self.svg_has_viewbox = True
        if tag == 'rect' and self.in_svg:
            self.rect_count += 1
            missing = [a for a in ['x', 'y', 'width', 'height'] if a not in attrs_dict]
            if missing:
                self.rect_attrs_errors.append(f"rect {self.rect_count} missing: {', '.join(missing)}")
            else:
                self.rect_attrs_ok += 1

    def handle_endtag(self, tag):
        if tag == 'svg':
            self.in_svg = False

html = open('index.html').read()
c = SVGChecker()
c.feed(html)

# Check SVG element present
if c.svg_found:
    cp.append({"name": "tag_svg", "score": 1.0, "reason": None})
else:
    cp.append({"name": "tag_svg", "score": 0.0, "reason": "no SVG element found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Check viewBox attribute
if c.svg_has_viewbox:
    cp.append({"name": "tag_viewbox", "score": 1.0, "reason": None})
else:
    cp.append({"name": "tag_viewbox", "score": 0.0, "reason": "SVG missing viewBox attribute"})

# Check rect count
if c.rect_count == ${K}:
    cp.append({"name": "structure_correct", "score": 1.0, "reason": None})
else:
    cp.append({"name": "structure_correct", "score": 0.0, "reason": f"expected ${K} rect bars, got {c.rect_count}"})

# Check rect attributes
if c.rect_attrs_ok == ${K}:
    cp.append({"name": "content_correct", "score": 1.0, "reason": None})
else:
    reason = f"{c.rect_attrs_ok}/${K} rects have all attributes"
    if c.rect_attrs_errors:
        reason += "; " + c.rect_attrs_errors[0]
    cp.append({"name": "content_correct", "score": 0.0, "reason": reason})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "gen.code.html",
  descriptions: {
    L1: "Write an HTML document with an h1 heading and an unordered list containing specified items",
    L2: "Write an HTML document with semantic structure (header, main, footer) containing a data table with thead and tbody",
    L3: "Write an HTML document containing an inline SVG bar chart with rect elements visualizing data points",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
