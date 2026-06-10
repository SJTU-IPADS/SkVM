import type { MicrobenchmarkInstance } from "../types.ts"
import { defineGenerator, fisherYatesShuffle, pyEval, type Rng } from "../generator-toolkit.ts"

/**
 * L1: Distance between two points
 */
function generateL1(rng: Rng): MicrobenchmarkInstance {
  const x1 = rng.randInt(-20, 20)
  const y1 = rng.randInt(-20, 20)
  const x2 = rng.randInt(-20, 20)
  const y2 = rng.randInt(-20, 20)

  const metric = rng.randChoice(["Euclidean", "Manhattan"] as const)
  let expected: number
  if (metric === "Euclidean") {
    expected = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
  } else {
    expected = Math.abs(x2 - x1) + Math.abs(y2 - y1)
  }
  const expectedStr = expected.toFixed(1)

  const prompt = `Point A is at (${x1}, ${y1}) and Point B is at (${x2}, ${y2}). What is the ${metric} distance between them? Answer with just the number rounded to 1 decimal place, nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
nums = re.findall(r'-?[\\d]+\\.?\\d*', text)
cp.append({"name": "number_found", "score": 1.0 if nums else 0.0,
  "reason": None if nums else "no number found in response"})
if nums:
    actual = float(nums[-1])
    expected = float('${expectedStr}')
    ok = abs(actual - expected) <= 0.15
    cp.append({"name": "value_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ${expectedStr}, got {actual}"})`,
    }),
  }
}

/**
 * L2: Compute property of a shape (area or perimeter)
 */
function generateL2(rng: Rng): MicrobenchmarkInstance {
  const shapeType = rng.randChoice(["triangle", "rectangle"] as const)
  let prompt: string
  let expected: number

  if (shapeType === "triangle") {
    // Triangle with 3 vertices, compute area using shoelace
    const x1 = rng.randInt(0, 10), y1 = rng.randInt(0, 10)
    const x2 = rng.randInt(0, 10), y2 = rng.randInt(0, 10)
    const x3 = rng.randInt(0, 10), y3 = rng.randInt(0, 10)

    const prop = rng.randChoice(["area", "perimeter"] as const)

    if (prop === "area") {
      expected = Math.abs((x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)) / 2)
    } else {
      const d1 = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
      const d2 = Math.sqrt((x3 - x2) ** 2 + (y3 - y2) ** 2)
      const d3 = Math.sqrt((x1 - x3) ** 2 + (y1 - y3) ** 2)
      expected = d1 + d2 + d3
    }

    prompt = `A triangle has vertices at (${x1},${y1}), (${x2},${y2}), and (${x3},${y3}). What is its ${prop}? Answer with just the number rounded to 2 decimal places, nothing else.`
  } else {
    // Rectangle with bottom-left and top-right
    const x1 = rng.randInt(0, 5), y1 = rng.randInt(0, 5)
    const x2 = x1 + rng.randInt(1, 10), y2 = y1 + rng.randInt(1, 10)

    const prop = rng.randChoice(["area", "perimeter", "diagonal"] as const)

    if (prop === "area") {
      expected = (x2 - x1) * (y2 - y1)
    } else if (prop === "perimeter") {
      expected = 2 * ((x2 - x1) + (y2 - y1))
    } else {
      expected = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
    }

    prompt = `A rectangle has corners at (${x1},${y1}) and (${x2},${y2}). What is its ${prop}? Answer with just the number rounded to 2 decimal places, nothing else.`
  }

  const expectedStr = expected.toFixed(2)

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip()
nums = re.findall(r'-?[\\d]+\\.?\\d*', text)
cp.append({"name": "number_found", "score": 1.0 if nums else 0.0,
  "reason": None if nums else "no number found in response"})
if nums:
    actual = float(nums[-1])
    expected = float('${expectedStr}')
    tol = max(0.02, abs(expected) * 0.005)
    ok = abs(actual - expected) <= tol
    cp.append({"name": "value_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ${expectedStr}, got {actual}"})`,
    }),
  }
}

/**
 * L3: Great-circle distance between two cities (lat/lon)
 */
function generateL3(rng: Rng): MicrobenchmarkInstance {
  const cities = [
    { name: "New York", lat: 40.7128, lon: -74.006 },
    { name: "London", lat: 51.5074, lon: -0.1278 },
    { name: "Tokyo", lat: 35.6762, lon: 139.6503 },
    { name: "Sydney", lat: -33.8688, lon: 151.2093 },
    { name: "Paris", lat: 48.8566, lon: 2.3522 },
    { name: "Cairo", lat: 30.0444, lon: 31.2357 },
    { name: "Mumbai", lat: 19.076, lon: 72.8777 },
    { name: "Sao Paulo", lat: -23.5505, lon: -46.6333 },
  ]

  const [cityA, cityB] = fisherYatesShuffle(rng, cities).slice(0, 2) as [typeof cities[0], typeof cities[0]]

  // Haversine formula
  const R = 6371 // Earth radius in km
  const dLat = (cityB.lat - cityA.lat) * Math.PI / 180
  const dLon = (cityB.lon - cityA.lon) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(cityA.lat * Math.PI / 180) * Math.cos(cityB.lat * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const expected = Math.round(R * c)

  const prompt = `City A (${cityA.name}) is at latitude ${cityA.lat}, longitude ${cityA.lon}. City B (${cityB.name}) is at latitude ${cityB.lat}, longitude ${cityB.lon}. What is the great-circle distance between them in kilometers? Answer with just the number (integer), nothing else.`

  return {
    prompt,
    eval: pyEval({
      imports: ["re"],
      body: `text = open('response.txt').read().strip().replace(',', '')
nums = re.findall(r'\\d+', text)
cp.append({"name": "number_found", "score": 1.0 if nums else 0.0,
  "reason": None if nums else "no number found in response"})
if nums:
    actual = int(nums[-1])
    expected = ${expected}
    ok = abs(actual - expected) <= max(5, expected * 0.005)
    cp.append({"name": "distance_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ~{expected} km, got {actual} km"})`,
    }),
  }
}

export default defineGenerator({
  primitiveId: "reason.spatial",
  descriptions: {
    L1: "Compute the Euclidean or Manhattan distance between two 2D points",
    L2: "Compute a geometric property (area, perimeter, or diagonal) of a triangle or rectangle given vertex coordinates",
    L3: "Compute the great-circle distance between two cities using the haversine formula given their latitude and longitude",
  },
  levels: { L1: generateL1, L2: generateL2, L3: generateL3 },
})
