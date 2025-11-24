# DigitalPracticeTheoryExam
Practice exams for Theory
## How To Create A Multipart Question

Multipart questions are authored as normal items in `questions.json` with extra metadata so their parts stay together and in order while the exam shuffles blocks.

Required per part:
- `multipartGroupId`: stable string for the set (e.g., "motor-5kw-230v-50hz").
- `multipartPart`: 1-based index within the group.
- `multipartTotal`: total number of parts in the group.
- Optional: `groupTitle` for a shared heading, `shuffleOptions: false` to keep MCQ option order.

ID ranges:
- Use `30000–39999` for multipart items. Text-entry items use `20000–29999`. Items with images can be anywhere but 500–999 are commonly used. Others start at `10001`.

Answer types:
- Multiple-choice: add `options` (array) and `answer` (string or array). Options shuffle by default.
- Text-entry: set `type: "text"`, provide `answer`. For numeric answers, use:
  - `numeric: true`, `tolerance: 0.02` (±2% example),
  - `unitRequired: true`, `units: ["A","amp","amps"]` (base unit + synonyms). Metric prefixes (k, m, u/µ, n) and Ω are accepted.

Example (2-part set: current then apparent power):
```json
{
  "id": 30021,
  "type": "text",
  "multipartGroupId": "motor-5kw-230v",
  "multipartPart": 1,
  "multipartTotal": 2,
  "groupTitle": "5 kW Motor @ 230 V, 50 Hz",
  "question": "Part 1: Supply current at pf = 0.65. Include units (A).",
  "answer": "33.45",
  "numeric": true,
  "tolerance": 0.02,
  "unitRequired": true,
  "units": ["A","amp","amps"]
},
{
  "id": 30022,
  "type": "text",
  "multipartGroupId": "motor-5kw-230v",
  "multipartPart": 2,
  "multipartTotal": 2,
  "groupTitle": "5 kW Motor @ 230 V, 50 Hz",
  "question": "Part 2: Apparent power (VA). Include units (VA).",
  "answer": "7692.31",
  "numeric": true,
  "tolerance": 0.02,
  "unitRequired": true,
  "units": ["VA"]
}
```

Notes
- Exams include 1–3 multipart groups when available; parts stay contiguous and ordered, but groups are interleaved among singles.
- For unit-required numeric answers, missing units will be flagged with a note in results.
- Images can be attached via `images: [{ src, alt, caption }]` and will render under the question.
