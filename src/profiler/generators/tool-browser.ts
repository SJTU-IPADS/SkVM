import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, PY_EMIT_CHECKPOINTS, type Rng } from "../generator-toolkit.ts"

/**
 * L1: Parse an HTML file and extract a specific element's text content.
 * Simplified browser-like test using command-line HTML parsing.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const title = `Page ${rng.randInt(100, 999)}`
  const heading = `${rng.randChoice(["Welcome", "Hello", "Greetings"])} ${rng.randChoice(["World", "User", "Friend"])}`
  const targetId = `content-${rng.randInt(1, 99)}`
  const targetText = `${rng.randChoice(["alpha", "bravo", "charlie"])}_${rng.randInt(100, 999)}`

  const html = `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body>
  <h1>${heading}</h1>
  <div id="${targetId}">${targetText}</div>
  <p>Other content here</p>
</body>
</html>`

  return {
    prompt: `Parse the HTML file page.html and extract the text content of the element with id="${targetId}". Write just the text content to result.txt in the current directory. You can use any method (Python with html.parser, grep, sed, etc.).`,
    setupFiles: {
      "page.html": html,
    },
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not found"})
if exists:
    actual = open('result.txt').read().strip()
    expected = '${targetText}'
    ok = actual == expected
    cp.append({"name": "extraction_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected {expected}, got {actual}"})`,
    }),
  }
}

/**
 * L2: Parse HTML with a table, extract data, write as CSV.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const rows = Array.from({ length: rng.randInt(3, 6) }, () => ({
    name: rng.randChoice(["Alice", "Bob", "Carol", "Dave", "Eve"]),
    score: rng.randInt(50, 100),
    grade: rng.randChoice(["A", "B", "C", "D"]),
  }))

  const tableRows = rows.map(r =>
    `    <tr><td>${r.name}</td><td>${r.score}</td><td>${r.grade}</td></tr>`
  ).join("\n")

  const html = `<!DOCTYPE html>
<html>
<head><title>Scores</title></head>
<body>
  <table id="scores">
    <thead><tr><th>Name</th><th>Score</th><th>Grade</th></tr></thead>
    <tbody>
${tableRows}
    </tbody>
  </table>
</body>
</html>`

  const expectedJson = JSON.stringify(rows)

  return {
    prompt: `Parse the HTML file page.html which contains a table with id="scores". Extract all rows from the table body and write the data to result.csv in the current directory with headers: Name,Score,Grade. Use any method you like (Python, command-line tools, etc.).`,
    setupFiles: {
      "page.html": html,
    },
    eval: pyEval({
      imports: ["csv", "os"],
      body: `exists = os.path.isfile('result.csv')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.csv not found"})
if exists:
    try:
        reader = csv.DictReader(open('result.csv'))
        actual = list(reader)
    except Exception as e:
        cp.append({"name": "parsing_correct", "score": 0.0, "reason": f"CSV parse error: {e}"})
        ${PY_EMIT_CHECKPOINTS}
        exit(0)
    expected = json.loads(${JSON.stringify(expectedJson)})
    count_ok = len(actual) == len(expected)
    cp.append({"name": "parsing_correct", "score": 1.0 if count_ok else 0.0,
      "reason": None if count_ok else f"expected {len(expected)} rows, got {len(actual)}"})
    if count_ok:
        mismatches = []
        for exp, act in zip(expected, actual):
            name_key = [k for k in act.keys() if 'name' in k.lower()][0] if any('name' in k.lower() for k in act.keys()) else list(act.keys())[0]
            score_key = [k for k in act.keys() if 'score' in k.lower()][0] if any('score' in k.lower() for k in act.keys()) else list(act.keys())[1]
            if act[name_key].strip() != exp['name']:
                mismatches.append(f"name: expected {exp['name']}, got {act[name_key].strip()}")
            try:
                if int(act[score_key].strip()) != exp['score']:
                    mismatches.append(f"score: expected {exp['score']}, got {act[score_key].strip()}")
            except (ValueError, KeyError):
                mismatches.append(f"score parse error for {exp['name']}")
        ok = len(mismatches) == 0
        cp.append({"name": "extraction_correct", "score": 1.0 if ok else 0.0,
          "reason": None if ok else "; ".join(mismatches[:3])})`,
    }),
  }
}

/**
 * L3: Parse HTML with multiple pages (files), follow "links" between them,
 * collect data across all pages.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const totalPages = rng.randInt(3, 4)
  const allItems: string[] = []
  const setupFiles: Record<string, string> = {}

  for (let p = 1; p <= totalPages; p++) {
    const itemCount = rng.randInt(2, 4)
    const items: string[] = []
    for (let i = 0; i < itemCount; i++) {
      const item = `item_${rng.randInt(100, 999)}`
      items.push(item)
      allItems.push(item)
    }

    const nextLink = p < totalPages
      ? `<a href="page${p + 1}.html" class="next">Next</a>`
      : `<span class="next">No more pages</span>`

    const listItems = items.map(i => `    <li class="item">${i}</li>`).join("\n")

    const html = `<!DOCTYPE html>
<html>
<head><title>Page ${p}</title></head>
<body>
  <ul id="items">
${listItems}
  </ul>
  <nav>${nextLink}</nav>
</body>
</html>`

    setupFiles[`page${p}.html`] = html
  }

  const expectedJson = JSON.stringify(allItems.sort())

  return {
    prompt: `You have ${totalPages} HTML files (page1.html through page${totalPages}.html). Each page has a list of items in <li class="item"> elements inside a <ul id="items">. Each page (except the last) has a link to the next page via <a class="next">.

Starting from page1.html:
1. Parse the items from the current page
2. Check if there is a "next" link (an <a> tag with class "next")
3. If so, follow it to the next page and repeat
4. Collect ALL items across all pages
5. Sort them alphabetically and write as a JSON array to result.json in the current directory

Use any method you like (Python, command-line tools, etc.).`,
    setupFiles,
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('result.json')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.json not found"})
if exists:
    try:
        result = json.load(open('result.json'))
    except json.JSONDecodeError as e:
        cp.append({"name": "parsing_correct", "score": 0.0, "reason": f"invalid JSON: {e}"})
        ${PY_EMIT_CHECKPOINTS}
        exit(0)
    is_list = isinstance(result, list)
    cp.append({"name": "parsing_correct", "score": 1.0 if is_list else 0.0,
      "reason": None if is_list else f"expected array, got {type(result).__name__}"})
    if is_list:
        expected = json.loads(${JSON.stringify(expectedJson)})
        ok = sorted(result) == sorted(expected)
        cp.append({"name": "aggregation_correct", "score": 1.0 if ok else 0.0,
          "reason": None if ok else f"items mismatch: expected {len(expected)}, got {len(result)}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "tool.browser",
  descriptions: {
    L1: "Parse an HTML file and extract the text content of an element by its id attribute",
    L2: "Parse an HTML table, extract all data rows, and write them as a CSV file",
    L3: "Crawl multiple linked HTML pages by following next-page links, collect list items from each page, and write the sorted result as JSON",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
