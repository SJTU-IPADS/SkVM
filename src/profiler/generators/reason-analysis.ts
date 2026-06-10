import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: What does this function do? Answer in <=5 words. Eval: contains expected keyword.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const functions = [
    {
      code: `def f(lst):\n    return [x for x in lst if x % 2 == 0]`,
      keyword: "even",
    },
    {
      code: `def f(s):\n    return s[::-1]`,
      keyword: "reverse",
    },
    {
      code: `def f(lst):\n    return max(lst) - min(lst)`,
      keyword: "range",
    },
    {
      code: `def f(n):\n    return n * (n + 1) // 2`,
      keyword: "sum",
    },
    {
      code: `def f(lst):\n    return len(set(lst))`,
      keyword: "unique",
    },
    {
      code: `def f(s):\n    return s.upper()`,
      keyword: "uppercase",
    },
    {
      code: `def f(lst):\n    return sorted(lst)`,
      keyword: "sort",
    },
    {
      code: `def f(d):\n    return list(d.keys())`,
      keyword: "key",
    },
  ]

  const fn = rng.randChoice(functions)

  const prompt = `What does this function do? Answer in 5 words or fewer.

\`\`\`python
${fn.code}
\`\`\``

  return {
    prompt,
    eval: pyEval({
      body: `text = open('response.txt').read().strip().lower()
keyword = '${fn.keyword}'
found = keyword in text
cp = [{"name": "keyword_found", "score": 1.0 if found else 0.0,
  "reason": None if found else f"expected keyword \\"${fn.keyword}\\" in response"}]`,
    }),
  }
}

/**
 * L2: Identify the bug in a function. Eval: contains keyword describing the bug.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const buggyFunctions = [
    {
      code: `def avg(lst):
    total = 0
    for x in lst:
        total += x
    return total / len(lst) - 1`,
      keyword: "len",
      bugDesc: "subtracts 1 from length instead of using actual length",
    },
    {
      code: `def factorial(n):
    result = 0
    for i in range(1, n + 1):
        result *= i
    return result`,
      keyword: "zero",
      bugDesc: "result initialized to 0 instead of 1, always returns 0",
    },
    {
      code: `def find_max(lst):
    max_val = 0
    for x in lst:
        if x > max_val:
            max_val = x
    return max_val`,
      keyword: "negative",
      bugDesc: "fails for all-negative lists because max_val starts at 0",
    },
    {
      code: `def is_palindrome(s):
    return s == s.reverse()`,
      keyword: "reverse",
      bugDesc: "strings don't have .reverse() method, should use [::-1]",
    },
    {
      code: `def binary_search(lst, target):
    lo, hi = 0, len(lst)
    while lo < hi:
        mid = (lo + hi) // 2
        if lst[mid] == target:
            return mid
        elif lst[mid] < target:
            lo = mid
        else:
            hi = mid
    return -1`,
      keyword: "loop",
      bugDesc: "lo = mid can cause infinite loop, should be lo = mid + 1",
    },
    {
      code: `def count_vowels(s):
    count = 0
    vowels = "aeiou"
    for c in s:
        if c in vowels:
            count += 1
    return count`,
      keyword: "upper",
      bugDesc: "doesn't handle uppercase vowels",
    },
  ]

  const fn = rng.randChoice(buggyFunctions)

  const prompt = `This function has a bug. What is the bug? Answer in one sentence.

\`\`\`python
${fn.code}
\`\`\``

  return {
    prompt,
    eval: pyEval({
      body: `text = open('response.txt').read().strip().lower()
keyword = '${fn.keyword}'.lower()
found = keyword in text
cp = [{"name": "keyword_found", "score": 1.0 if found else 0.0,
  "reason": None if found else f"expected keyword \\"${fn.keyword}\\" in response"}]`,
    }),
  }
}

/**
 * L3: Multi-file program with a bug. Identify root-cause file and buggy line.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const scenarios: Array<{
    files: Record<string, string>
    testOutput: string
    bugFile: string
    bugLine: number
    bugKeyword: string
    explanation: string
  }> = [
    {
      files: {
        "utils.py": `def parse_number(s):
    """Parse a numeric string, stripping whitespace."""
    return int(s.strip())
`,
        "calc.py": `from utils import parse_number

def compute_total(values):
    """Sum all parsed values."""
    total = 0
    for v in values:
        total += parse_number(v)
    return total
`,
        "main.py": `from calc import compute_total

data = ["10", "20", "30.5", "40"]
result = compute_total(data)
print(f"Total: {result}")
`,
      },
      testOutput: "The program crashes with ValueError when processing the data.",
      bugFile: "utils.py",
      bugLine: 3,
      bugKeyword: "int",
      explanation: "parse_number uses int() but data contains '30.5' which is a float string",
    },
    {
      files: {
        "data.py": `PRICES = {
    "apple": 1.50,
    "banana": 0.75,
    "cherry": 2.00,
}

def get_price(item):
    return PRICES[item]
`,
        "cart.py": `from data import get_price

def calculate_cart(items):
    total = 0
    for item, qty in items:
        price = get_price(item)
        total += price * qty
    return round(total, 2)
`,
        "main.py": `from cart import calculate_cart

orders = [("apple", 3), ("banana", 2), ("grape", 1)]
total = calculate_cart(orders)
print(f"Cart total: {total}")
`,
      },
      testOutput: "The program crashes with KeyError when processing orders.",
      bugFile: "data.py",
      bugLine: 8,
      bugKeyword: "KeyError",
      explanation: "get_price does not handle missing items (grape is not in PRICES)",
    },
    {
      files: {
        "config.py": `MAX_RETRIES = 3
TIMEOUT = 30
BASE_URL = "https://api.example.com"
`,
        "client.py": `from config import MAX_RETRIES, TIMEOUT

def fetch_data(url):
    for attempt in range(MAX_RETRIES):
        try:
            # Simulated fetch
            if attempt < 2:
                raise ConnectionError("timeout")
            return {"status": "ok", "data": [1, 2, 3]}
        except ConnectionError:
            continue
    return None
`,
        "process.py": `from client import fetch_data
from config import BASE_URL

def process():
    result = fetch_data(BASE_URL)
    items = result["data"]
    total = sum(items)
    return total
`,
      },
      testOutput: "The program sometimes crashes with TypeError: 'NoneType' object is not subscriptable.",
      bugFile: "process.py",
      bugLine: 6,
      bugKeyword: "None",
      explanation: "process() doesn't check if fetch_data returned None before accessing result['data']",
    },
  ]

  const scenario = rng.randChoice(scenarios)
  const fileNames = Object.keys(scenario.files)
  const filesDescription = fileNames.map(f =>
    `--- ${f} ---\n${scenario.files[f]}`
  ).join("\n")

  const prompt = `A program consists of ${fileNames.length} files:

${filesDescription}

When run, the following happens: ${scenario.testOutput}

Identify the root-cause file and the buggy line number. Answer in exactly two lines:
Line 1: filename (e.g., utils.py)
Line 2: line number
Nothing else.`

  return {
    prompt,
    setupFiles: { ...scenario.files },
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
lines = [l.strip() for l in text.split('\\n') if l.strip()]
has_lines = len(lines) >= 2
cp.append({"name": "format_correct", "score": 1.0 if has_lines else 0.0,
  "reason": None if has_lines else f"need 2 lines, got {len(lines)}"})
if has_lines:
    # The answer is the last two non-empty lines. Models often emit reasoning
    # before the final answer, so the filename/line number land at the end, not
    # at lines[0]/lines[1]. The prompt asks for filename then line number, so
    # the number is last.
    file_line = lines[-2]
    line_num_line = lines[-1]
    file_match = re.search(r'[\\w]+\\.py', file_line)
    file_found = file_match is not None
    if file_found:
        actual_file = file_match.group()
        file_ok = actual_file == '${scenario.bugFile}'
        cp.append({"name": "file_correct", "score": 1.0 if file_ok else 0.0,
          "reason": None if file_ok else f"expected ${scenario.bugFile}, got {actual_file}"})
    else:
        cp.append({"name": "file_correct", "score": 0.0,
          "reason": f"no .py file found in: {file_line}"})
    num_match = re.findall(r'\\d+', line_num_line)
    if num_match:
        actual_line = int(num_match[-1])
        line_ok = abs(actual_line - ${scenario.bugLine}) <= 2
        cp.append({"name": "line_correct", "score": 1.0 if line_ok else 0.0,
          "reason": None if line_ok else f"expected ${scenario.bugLine} +/-2, got {actual_line}"})
    else:
        cp.append({"name": "line_correct", "score": 0.0,
          "reason": f"no line number found in: {line_num_line}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "reason.analysis",
  descriptions: {
    L1: "Describe what a short Python function does in five words or fewer",
    L2: "Identify the bug in a single Python function and describe it in one sentence",
    L3: "Identify the root-cause file and buggy line number in a multi-file Python program given a runtime error description",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
