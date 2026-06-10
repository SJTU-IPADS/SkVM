import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, PY_EMIT_CHECKPOINTS, type Rng } from "../generator-toolkit.ts"

/**
 * L1: Fetch JSON from localhost:PORT, extract KEY field, write to result.txt.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const port = rng.randInt(18100, 18999)
  const key = rng.randChoice(["name", "status", "version", "message"])
  const value = `${rng.randChoice(["alpha", "bravo", "charlie"])}_${rng.randInt(100, 999)}`

  const serverData: Record<string, string> = {
    name: "test-service",
    status: "running",
    version: "1.0.0",
    message: "hello world",
  }
  serverData[key] = value

  const serverScript = `const server = Bun.serve({
  port: ${port},
  fetch(req) {
    return Response.json(${JSON.stringify(serverData)});
  },
});
console.log("Server running on port " + server.port);
`

  return {
    prompt: `A Bun HTTP server script is at server.js. Start it with \`bun server.js &\` (in background), note its PID (using $!), then fetch JSON from http://localhost:${port}/, extract the "${key}" field, and write its value to result.txt in the current directory. When done, stop the server using \`kill $PID\` (do NOT use pkill or killall).`,
    setupFiles: {
      "server.js": serverScript,
    },
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('result.txt')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.txt not found"})
if exists:
    actual = open('result.txt').read().strip()
    expected = '${value}'
    ok = actual == expected
    cp.append({"name": "data_extraction", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected {expected}, got {actual}"})`,
    }),
  }
}

/**
 * L2: Fetch with query params, extract total and IDs, write to result.json.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const port = rng.randInt(18100, 18999)
  const category = rng.randChoice(["books", "tools", "games", "music"])
  const items = Array.from({ length: rng.randInt(3, 6) }, (_, i) => ({
    id: rng.randInt(100, 999),
    name: `${category}_item_${i + 1}`,
  }))

  const serverScript = `const server = Bun.serve({
  port: ${port},
  fetch(req) {
    const url = new URL(req.url);
    const cat = url.searchParams.get("category");
    const data = ${JSON.stringify({ [category]: items })};
    const results = data[cat] || [];
    return Response.json({ total: results.length, items: results });
  },
});
console.log("Server running on port " + server.port);
`

  const expectedIds = items.map(i => i.id)
  const expectedJson = JSON.stringify({ total: items.length, ids: expectedIds })

  return {
    prompt: `A Bun HTTP server script is at server.js. Start it with \`bun server.js &\` and note its PID (using $!), then:

1. Fetch JSON from http://localhost:${port}/?category=${category}
2. Extract the "total" count and the "id" of each item from the "items" array
3. Write a JSON file result.json in the current directory with the structure: {"total": N, "ids": [id1, id2, ...]}

When done, stop the server using \`kill $PID\` (do NOT use pkill or killall).`,
    setupFiles: {
      "server.js": serverScript,
    },
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('result.json')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.json not found"})
if exists:
    try:
        result = json.load(open('result.json'))
    except json.JSONDecodeError as e:
        cp.append({"name": "json_valid", "score": 0.0, "reason": f"invalid JSON: {e}"})
        ${PY_EMIT_CHECKPOINTS}
        exit(0)
    expected = json.loads('${expectedJson}')
    total_ok = result.get('total') == expected['total']
    cp.append({"name": "data_extraction", "score": 1.0 if total_ok else 0.0,
      "reason": None if total_ok else f"total: expected {expected['total']}, got {result.get('total')}"})
    actual_ids = sorted(result.get('ids', []))
    expected_ids = sorted(expected['ids'])
    ids_ok = actual_ids == expected_ids
    cp.append({"name": "ids_correct", "score": 1.0 if ids_ok else 0.0,
      "reason": None if ids_ok else f"ids mismatch: expected {len(expected_ids)}, got {len(actual_ids)}"})`,
    }),
  }
}

/**
 * L3: Paginated API, fetch all pages, merge items, write to result.json.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const port = rng.randInt(18100, 18999)
  const totalItems = rng.randInt(8, 15)
  const pageSize = rng.randChoice([3, 4, 5])
  const totalPages = Math.ceil(totalItems / pageSize)

  const allItems = Array.from({ length: totalItems }, (_, i) => ({
    id: i + 1,
    value: `item_${rng.randInt(100, 999)}`,
  }))

  // Build pages
  const pages: Record<number, typeof allItems> = {}
  for (let p = 1; p <= totalPages; p++) {
    const start = (p - 1) * pageSize
    pages[p] = allItems.slice(start, start + pageSize)
  }

  const pagesJson = JSON.stringify(pages)

  const serverScript = `const pages = ${pagesJson};
const totalPages = ${totalPages};

const server = Bun.serve({
  port: ${port},
  fetch(req) {
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get("page") || "1");
    const items = pages[page] || [];
    return Response.json({
      page,
      totalPages,
      items,
    });
  },
});
console.log("Server running on port " + server.port);
`

  const allValues = allItems.map(i => i.value)
  const expectedJson = JSON.stringify(allValues)

  return {
    prompt: `A Bun HTTP server script is at server.js providing a paginated API. Start it with \`bun server.js &\` and note its PID (using $!), then:

1. Fetch page 1 from http://localhost:${port}/?page=1 - the response has {"page": N, "totalPages": N, "items": [...]}
2. Continue fetching all pages until you have all items
3. Merge all items across all pages and write a JSON array of all "value" fields to result.json

The result should be a JSON array of strings, e.g., ["item_123", "item_456", ...]
All files should be in the current directory. When done, stop the server using \`kill $PID\` (do NOT use pkill or killall).`,
    setupFiles: {
      "server.js": serverScript,
    },
    eval: pyEval({
      imports: ["os"],
      body: `exists = os.path.isfile('result.json')
cp.append({"name": "file_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "result.json not found"})
if exists:
    try:
        result = json.load(open('result.json'))
    except json.JSONDecodeError as e:
        cp.append({"name": "json_valid", "score": 0.0, "reason": f"invalid JSON: {e}"})
        ${PY_EMIT_CHECKPOINTS}
        exit(0)
    is_list = isinstance(result, list)
    cp.append({"name": "server_response", "score": 1.0 if is_list else 0.0,
      "reason": None if is_list else f"expected array, got {type(result).__name__}"})
    if is_list:
        expected = json.loads('${expectedJson}')
        ok = sorted(result) == sorted(expected)
        cp.append({"name": "pagination", "score": 1.0 if ok else 0.0,
          "reason": None if ok else f"items mismatch: expected {len(expected)}, got {len(result)}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "tool.web",
  descriptions: {
    L1: "Start a local HTTP server, fetch a JSON response, extract a specific field, and write it to a file",
    L2: "Fetch JSON from a local server with query parameters, extract nested data (total and item IDs), and write structured JSON output",
    L3: "Fetch all pages from a paginated local API, merge items across pages, and write the combined result to JSON",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
