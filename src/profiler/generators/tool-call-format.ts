import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, pyEval, PY_EMIT_CHECKPOINTS, type Rng } from "../generator-toolkit.ts"

/**
 * L1: Output JSON function call with simple args.
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const funcs = [
    { name: "send_email", args: { to: `user${rng.randInt(1, 99)}@example.com`, subject: `Report ${rng.randInt(100, 999)}` } },
    { name: "create_user", args: { username: `user_${rng.randInt(100, 999)}`, role: rng.randChoice(["admin", "editor", "viewer"]) } },
    { name: "set_config", args: { key: `timeout_${rng.randInt(1, 50)}`, value: String(rng.randInt(10, 300)) } },
  ]

  const fn = rng.randChoice(funcs)
  const argsStr = Object.entries(fn.args).map(([k, v]) => `${k}="${v}"`).join(", ")
  const expectedJson = JSON.stringify({ function: fn.name, arguments: fn.args })

  const prompt = `Output a JSON function call to "${fn.name}" with arguments: ${argsStr}.

The JSON should have the structure: {"function": "name", "arguments": {key: value, ...}}

Output only the JSON, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
json_match = re.search(r'\\{[\\s\\S]*\\}', text)
valid = json_match is not None
cp.append({"name": "json_valid", "score": 1.0 if valid else 0.0,
  "reason": None if valid else "no JSON found in response"})
if valid:
    try:
        parsed = json.loads(json_match.group())
    except json.JSONDecodeError as e:
        cp[-1] = {"name": "json_valid", "score": 0.0, "reason": f"invalid JSON: {e}"}
        ${PY_EMIT_CHECKPOINTS}
        exit(0)
    expected = json.loads(${JSON.stringify(expectedJson)})
    fn_ok = parsed.get('function') == expected['function']
    cp.append({"name": "function_name", "score": 1.0 if fn_ok else 0.0,
      "reason": None if fn_ok else f"expected {expected['function']}, got {parsed.get('function')}"})
    args_errors = []
    for k, v in expected['arguments'].items():
        if str(parsed.get('arguments', {}).get(k, '')) != str(v):
            args_errors.append(k)
    args_ok = len(args_errors) == 0
    cp.append({"name": "args_correct", "score": 1.0 if args_ok else 0.0,
      "reason": None if args_ok else f"mismatched args: {', '.join(args_errors)}"})`,
    }),
  }
}

/**
 * L2: Output JSON function call with nested args (arrays, objects).
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const items = Array.from({ length: rng.randInt(2, 4) }, () => ({
    id: rng.randInt(100, 999),
    name: rng.randChoice(["widget", "gadget", "gizmo", "doohickey"]) + "_" + rng.randInt(1, 99),
  }))

  const fnCall = {
    function: "create_order",
    arguments: {
      customer_id: `cust_${rng.randInt(100, 999)}`,
      items: items,
      shipping: {
        method: rng.randChoice(["express", "standard", "overnight"]),
        address: `${rng.randInt(100, 999)} Main St`,
      },
    },
  }

  const expectedJson = JSON.stringify(fnCall)
  const itemsDesc = items.map(i => `{id: ${i.id}, name: "${i.name}"}`).join(", ")

  const prompt = `Output a JSON function call to "create_order" with the following arguments:
- customer_id: "${fnCall.arguments.customer_id}"
- items: [${itemsDesc}]
- shipping: {method: "${fnCall.arguments.shipping.method}", address: "${fnCall.arguments.shipping.address}"}

The JSON should have the structure: {"function": "name", "arguments": {...}}

Output only the JSON, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
json_match = re.search(r'\\{[\\s\\S]*\\}', text)
valid = json_match is not None
cp.append({"name": "json_valid", "score": 1.0 if valid else 0.0,
  "reason": None if valid else "no JSON found in response"})
if valid:
    try:
        parsed = json.loads(json_match.group())
    except json.JSONDecodeError as e:
        cp[-1] = {"name": "json_valid", "score": 0.0, "reason": f"invalid JSON: {e}"}
        ${PY_EMIT_CHECKPOINTS}
        exit(0)
    expected = json.loads(${JSON.stringify(expectedJson)})
    fn_ok = parsed.get('function') == 'create_order'
    cp.append({"name": "function_name", "score": 1.0 if fn_ok else 0.0,
      "reason": None if fn_ok else f"expected create_order, got {parsed.get('function')}"})
    args = parsed.get('arguments', {})
    cid_ok = args.get('customer_id') == expected['arguments']['customer_id']
    cp.append({"name": "args_correct", "score": 1.0 if cid_ok else 0.0,
      "reason": None if cid_ok else f"wrong customer_id"})
    items_ok = isinstance(args.get('items'), list) and len(args.get('items', [])) == ${items.length}
    cp.append({"name": "nested_structure", "score": 1.0 if items_ok else 0.0,
      "reason": None if items_ok else "items: expected ${items.length} items"})
    ship = args.get('shipping')
    ship_ok = isinstance(ship, dict) and ship.get('method') == expected['arguments']['shipping']['method']
    cp.append({"name": "shipping_correct", "score": 1.0 if ship_ok else 0.0,
      "reason": None if ship_ok else "shipping method mismatch or not an object"})`,
    }),
  }
}

/**
 * L3: Output JSON function call with special characters and deep nesting.
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const depth = rng.randChoice([3, 4])
  const specialStr = `value with "quotes" and \\backslash and tab\\there`
  const specialKey = `field_${rng.randInt(1, 99)}`

  // Build a deeply nested object
  function buildNested(d: number, val: string): unknown {
    if (d <= 0) return val
    return { [`level_${d}`]: buildNested(d - 1, val) }
  }

  const fnCall = {
    function: "process_data",
    arguments: {
      id: `id_${rng.randInt(100, 999)}`,
      [specialKey]: specialStr,
      nested: buildNested(depth, `deep_value_${rng.randInt(1, 99)}`),
      tags: [`tag-${rng.randInt(1, 9)}`, `special "tag"`, `back\\slash`],
    },
  }

  // Build description of nested structure
  let nestingDesc = ""
  for (let d = depth; d >= 1; d--) {
    nestingDesc += `${"  ".repeat(depth - d)}level_${d}: {\n`
  }
  nestingDesc += `${"  ".repeat(depth)}(leaf value)\n`
  for (let d = 1; d <= depth; d++) {
    nestingDesc += `${"  ".repeat(depth - d)}}\n`
  }

  const prompt = `Output a JSON function call to "process_data" with these arguments:
- id: "${fnCall.arguments.id}"
- ${specialKey}: a string containing double quotes, backslash, and tab character: ${specialStr}
- nested: a ${depth}-level deep nested object, where each level has a key "level_N":
${nestingDesc.trim()}
  The leaf value is: "${(fnCall.arguments.nested as any)[`level_${depth}`] !== undefined ? JSON.stringify(fnCall.arguments.nested) : ""}"
- tags: an array with 3 strings, including strings with special characters: ${JSON.stringify(fnCall.arguments.tags)}

The JSON should have the structure: {"function": "name", "arguments": {...}}
All special characters must be properly escaped. Output only the JSON, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
json_match = re.search(r'\\{[\\s\\S]*\\}', text)
valid = json_match is not None
cp.append({"name": "json_valid", "score": 1.0 if valid else 0.0,
  "reason": None if valid else "no JSON found in response"})
if valid:
    try:
        parsed = json.loads(json_match.group())
    except json.JSONDecodeError as e:
        cp[-1] = {"name": "json_valid", "score": 0.0, "reason": f"invalid JSON: {e}"}
        ${PY_EMIT_CHECKPOINTS}
        exit(0)
    fn_ok = parsed.get('function') == 'process_data'
    cp.append({"name": "function_name", "score": 1.0 if fn_ok else 0.0,
      "reason": None if fn_ok else f"expected process_data, got {parsed.get('function')}"})
    args = parsed.get('arguments', {})
    id_ok = 'id' in args
    cp.append({"name": "args_correct", "score": 1.0 if id_ok else 0.0,
      "reason": None if id_ok else "missing id"})
    tags_ok = isinstance(args.get('tags'), list) and len(args.get('tags', [])) == 3
    cp.append({"name": "tags_correct", "score": 1.0 if tags_ok else 0.0,
      "reason": None if tags_ok else "tags should be array of 3"})
    nest_ok = True
    nest_reason = None
    if not isinstance(args.get('nested'), dict):
        nest_ok = False
        nest_reason = "nested should be object"
    else:
        obj = args['nested']
        for d in range(${depth}, 0, -1):
            key = 'level_%d' % d
            if not isinstance(obj, dict) or key not in obj:
                nest_ok = False
                nest_reason = f"missing nesting at level {d}"
                break
            obj = obj[key]
    cp.append({"name": "nested_structure", "score": 1.0 if nest_ok else 0.0,
      "reason": nest_reason})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "tool.call.format",
  descriptions: {
    L1: "Output a JSON function call object with simple string arguments matching exact values",
    L2: "Output a JSON function call object with nested arguments including arrays and sub-objects",
    L3: "Output a JSON function call object with deeply nested structures, special characters requiring proper escaping, and mixed types",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
