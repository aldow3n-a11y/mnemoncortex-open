---
name: cortex-synthesis
description: "Auto-capture insights from conversations, extract structured triples via LLM, and distill them to daily logs. v3: semantic extraction + regex fallback."
metadata:
  { "openclaw": { "emoji": "🧠", "events": ["message:sent", "command:new", "gateway:startup"], "requires": { "bins": ["node"] } } }
---

# Cortex Synthesis Hook v3

Event-driven insight capture, semantic extraction, and distillation.

**On `message:sent`**: 
1. **Regex capture** — scans for 21 saliency patterns (fast, deterministic)
2. **LLM extraction** — sends content to Gemini Flash for structured triple extraction `(subject, relation, object)` with confidence scoring

**On `command:new` / `command:reset`**: Processes queued items, appends to daily log, clears queue.

**On `gateway:startup`**: Flushes any orphaned queue items.

## Pipeline Flow

```
Message → Regex Capture (21 patterns) ──→ Queue JSON
        → LLM Extraction (Gemini Flash) ──→ Queue JSON (with triples)
                                              ↓
                                    Distill → Daily Log
                                              ↓
                              Weekly consolidation → vault/Atlas/Notes/
```

## Saliency Patterns (regex)

### Explicit Markers
- `remember this:`, `core truth:`, `lesson learned:`, `critical decision:`
- `correction:`, `update memory:`, `important to note that`

### Implicit Insight Patterns
- Root cause: `root cause was/is`, `the issue was/is`, `the problem was/is`
- Fix markers: `fixed:`, `fix:`, `workaround:`
- Decisions: `decided`, `chose`, `went with`, `switching to`
- Imperatives: `never again/do/use`, `always use/do/prefer`, `make sure to/you`
- Insight: `key insight/finding/takeaway:`, `this means/implies/suggests`
- Gotchas: `gotcha:`, `don't forget:`

## LLM Triple Extraction (v3 NEW)

On each `message:sent`, after regex capture, the content is sent to **Gemini Flash** (free tier via Koda API key) for structured extraction:

- **Input**: Conversation snippet (up to 2000 chars)
- **Output**: JSON array of `{subject, relation, object, confidence, category}` triples
- **Filter**: Only triples with confidence ≥ 0.5 are kept
- **Timeout**: 10 seconds (fails gracefully if Gemini is slow/rate-limited)
- **Fallback**: Regex capture always runs first; LLM is additive

Example extraction:
```
Input: "the root cause was nginx prefix match priority — ^~ ensures longer prefix wins"
Output: [
  {"subject": "nginx", "relation": "root_cause", "object": "prefix match priority", "confidence": 0.95, "category": "bug"},
  {"subject": "nginx ^~", "relation": "ensures", "object": "longer prefix wins over root /", "confidence": 0.9, "category": "infrastructure"}
]
```

## Category Auto-Tagging

Each captured insight is auto-tagged:
- `infrastructure` — nginx, server, VPS, deploy, DNS, SSL, docker, systemd
- `bug` — root cause, fix, issue, error, 500, 401, crash
- `decision` — decided, chose, went with, will use, switching to
- `model` — model, provider, ollama, gemini, claude, gpt, glm
- `security` — secret, key, credential, password, auth, token, perm
- `pkm` — note, vault, memory, MOC, zettelkasten, obsidian
- `robotics` — robot, embodied, spatial reason, trajectory, bounding box
- `general` — default when no category matches

## Daily Log Format

Two sections in daily logs:

```markdown
## Distilled Insights
- [Distilled 14:30] [bug] root cause was nginx prefix match priority

## Extracted Triples
- [Triple 14:30] [infrastructure] **nginx** → ensures → **longer prefix wins** (conf: 0.9)
```

## Mnemon Integration (v3 NEW)

Every distilled insight and extracted triple is also written to Mnemon (the persistent graph memory system) during the distill phase:

1. **Distilled insights** → `mnemon remember` with category mapping and importance inference
2. **Extracted triples** → `mnemon remember` with subject/object as entities and confidence → importance mapping
3. **Consecutive insights from same batch** → `mnemon link --type temporal` to preserve batch ordering

Category mapping (cortex → Mnemon):
- `infrastructure` → `context`
- `bug` → `fact`
- `decision` → `decision`
- `model` → `context`
- `security` → `fact`
- `pkm` → `context`
- `robotics` → `context`
- `general` → `general`

Importance inference:
- Pattern matches `critical decision|always|never|root cause|security` → imp 5
- Pattern matches `decision|fix|issue|problem|lesson` → imp 4
- Pattern matches `insight|finding|note|important` → imp 3
- Default → imp 2

Triple confidence → importance:
- confidence ≥ 0.9 → imp 4
- confidence ≥ 0.7 → imp 3
- confidence < 0.7 → imp 2

Mnemon writes use `--no-diff` to avoid blocking on similarity checks during batch distillation. LLM-supervised linking (causal, semantic) happens separately when the agent evaluates candidates.

## Configuration

- `GEMINI_API_KEY`: Set via `KODA_GEMINI_KEY` env var, defaults to Koda key
- `GEMINI_MODEL`: `gemini-2.0-flash` (free tier, ~15 RPM)
- `EXTRACTION_ENABLED`: Set `false` to disable LLM extraction (regex-only mode)
- `EXTRACTION_TIMEOUT_MS`: 10000ms default
- `MNEMON_ENABLED`: Set `false` to disable Mnemon writes (default: true)
- `MNEMON_BIN`: Path to mnemon binary (default: `mnemon`)
- `MNEMON_TIMEOUT_MS`: Timeout for mnemon CLI calls (default: 5000ms)

## Cost

Gemini Flash free tier: ~10-30 calls/day at ~0.1 tokens each. Well within 15 RPM / 1500 RPD limits.
Mnemon: zero cost (local SQLite + optional local Ollama embeddings).