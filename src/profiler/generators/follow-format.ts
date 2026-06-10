import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: List K CATEGORY items as a JSON array.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const K = rng.randInt(4, 8)
  const categories = [
    "programming languages",
    "European countries",
    "fruits",
    "colors",
    "musical instruments",
    "dog breeds",
    "planets in our solar system",
    "ocean creatures",
  ]
  const category = rng.randChoice(categories)

  const prompt = `Respond with exactly ${K} ${category} as a JSON array of strings. Provide only the JSON array, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
match = re.search(r'\\[.*\\]', text, re.DOTALL)
cp.append({"name": "json_valid", "score": 1.0 if match else 0.0,
  "reason": None if match else "no JSON array found"})
if match:
    try:
        arr = json.loads(match.group())
        is_arr = isinstance(arr, list)
        cp.append({"name": "is_array", "score": 1.0 if is_arr else 0.0,
          "reason": None if is_arr else f"expected array, got {type(arr).__name__}"})
        if is_arr:
            count_ok = len(arr) == ${K}
            cp.append({"name": "item_count", "score": 1.0 if count_ok else 0.0,
              "reason": None if count_ok else f"expected ${K} items, got {len(arr)}"})
            all_str = all(isinstance(x, str) for x in arr)
            cp.append({"name": "field_types", "score": 1.0 if all_str else 0.0,
              "reason": None if all_str else "not all items are strings"})
    except json.JSONDecodeError as e:
        cp.append({"name": "is_array", "score": 0.0, "reason": f"invalid JSON: {e}"})`,
    }),
  }
}

/**
 * L2: Describe ENTITY as JSON with specified fields.
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const entities = [
    { name: "a car", fields: { make: "string", model: "string", year: "number", features: "array(>=3)", engine: "object" } },
    { name: "a book", fields: { title: "string", author: "string", pages: "number", genres: "array(>=2)", publisher: "object" } },
    { name: "a restaurant", fields: { name: "string", cuisine: "string", rating: "number", dishes: "array(>=3)", location: "object" } },
  ]

  const entity = rng.randChoice(entities)
  const minArrayItems = entity.fields.features ? 3 : entity.fields.genres ? 2 : 3

  const fieldsDesc = Object.entries(entity.fields).map(([k, v]) => {
    if (v === "string") return `"${k}" (string)`
    if (v === "number") return `"${k}" (number)`
    if (v.startsWith("array")) return `"${k}" (array with at least ${minArrayItems} items)`
    if (v === "object") return `"${k}" (nested object with at least 2 fields)`
    return `"${k}" (${v})`
  }).join(", ")

  const prompt = `Respond with a JSON object describing ${entity.name} with these fields: ${fieldsDesc}.

Provide only the JSON object, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
match = re.search(r'\\{[\\s\\S]*\\}', text)
cp.append({"name": "json_valid", "score": 1.0 if match else 0.0,
  "reason": None if match else "no JSON object found"})
if match:
    try:
        obj = json.loads(match.group())
        cp.append({"name": "is_object", "score": 1.0 if isinstance(obj, dict) else 0.0,
          "reason": None if isinstance(obj, dict) else f"expected object, got {type(obj).__name__}"})
        if isinstance(obj, dict):
            fields = ${JSON.stringify(entity.fields)}
            for key, typ in fields.items():
                if key not in obj:
                    cp.append({"name": f"field_{key}", "score": 0.0, "reason": f"missing field: {key}"})
                    continue
                val = obj[key]
                ok = True
                reason = None
                if typ == 'string' and not isinstance(val, str):
                    ok, reason = False, f"{key} should be string"
                elif typ == 'number' and not isinstance(val, (int, float)):
                    ok, reason = False, f"{key} should be number"
                elif typ.startswith('array'):
                    if not isinstance(val, list):
                        ok, reason = False, f"{key} should be array"
                    elif len(val) < ${minArrayItems}:
                        ok, reason = False, f"{key}: need >= ${minArrayItems} items, got {len(val)}"
                elif typ == 'object':
                    if not isinstance(val, dict):
                        ok, reason = False, f"{key} should be object"
                    elif len(val) < 2:
                        ok, reason = False, f"{key}: need >= 2 fields, got {len(val)}"
                cp.append({"name": f"field_{key}", "score": 1.0 if ok else 0.0, "reason": reason})
    except json.JSONDecodeError as e:
        cp.append({"name": "is_object", "score": 0.0, "reason": f"invalid JSON: {e}"})`,
    }),
  }
}

/**
 * L3: JSON conforming to schema with byte limit, alphabetical keys, case constraint.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const entities = ["a smartphone", "a laptop", "a bicycle"]
  const entity = rng.randChoice(entities)
  const maxBytes = rng.randChoice([300, 400, 500])
  const stringCase = rng.randChoice(["lowercase", "UPPERCASE"] as const)

  const prompt = `Respond with a JSON object describing ${entity} with at least 5 fields. Requirements:
1. Total JSON must be ${maxBytes} bytes or fewer
2. All object keys must be in alphabetical order
3. All string values must be in ${stringCase}
4. Must include at least one numeric field and one array field

Provide only the JSON object, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
match = re.search(r'\\{[\\s\\S]*\\}', text)
cp.append({"name": "json_valid", "score": 1.0 if match else 0.0,
  "reason": None if match else "no JSON object found"})
if match:
    raw = match.group()
    try:
        obj = json.loads(raw)
        is_obj = isinstance(obj, dict)
        cp.append({"name": "is_object", "score": 1.0 if is_obj else 0.0,
          "reason": None if is_obj else f"expected object, got {type(obj).__name__}"})
        if is_obj:
            byte_ok = len(raw.encode('utf-8')) <= ${maxBytes}
            cp.append({"name": "byte_size", "score": 1.0 if byte_ok else 0.0,
              "reason": None if byte_ok else f"exceeds ${maxBytes} bytes ({len(raw.encode('utf-8'))} bytes)"})
            field_ok = len(obj) >= 5
            cp.append({"name": "field_count", "score": 1.0 if field_ok else 0.0,
              "reason": None if field_ok else f"need >= 5 fields, got {len(obj)}"})
            keys = list(obj.keys())
            alpha_ok = keys == sorted(keys)
            cp.append({"name": "keys_alphabetical", "score": 1.0 if alpha_ok else 0.0,
              "reason": None if alpha_ok else "keys not in alphabetical order"})
            case_check = '${stringCase}'
            case_ok = True
            case_reason = None
            for k, v in obj.items():
                if isinstance(v, str):
                    if case_check == 'lowercase' and v != v.lower():
                        case_ok, case_reason = False, f"value for \\"{k}\\" not lowercase: {v}"
                        break
                    elif case_check == 'UPPERCASE' and v != v.upper():
                        case_ok, case_reason = False, f"value for \\"{k}\\" not uppercase: {v}"
                        break
            cp.append({"name": "string_case", "score": 1.0 if case_ok else 0.0, "reason": case_reason})
            has_number = any(isinstance(v, (int, float)) and not isinstance(v, bool) for v in obj.values())
            cp.append({"name": "has_number", "score": 1.0 if has_number else 0.0,
              "reason": None if has_number else "no numeric field"})
            has_array = any(isinstance(v, list) for v in obj.values())
            cp.append({"name": "has_array", "score": 1.0 if has_array else 0.0,
              "reason": None if has_array else "no array field"})
    except json.JSONDecodeError as e:
        cp.append({"name": "is_object", "score": 0.0, "reason": f"invalid JSON: {e}"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "follow.format",
  descriptions: {
    L1: "Output a JSON array of strings with an exact item count for a given category",
    L2: "Output a JSON object conforming to a schema with specific field types including nested objects and arrays",
    L3: "Output a JSON object satisfying multiple simultaneous constraints: byte-size limit, alphabetically ordered keys, string case rule, and required field types",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
