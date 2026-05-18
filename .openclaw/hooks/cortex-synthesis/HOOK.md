---
name: cortex-synthesis
description: "Adaptive batch insight capture: regex on every message (free), LLM extraction on threshold or idle. v5."
metadata:
  { "openclaw": { "emoji": "🧠", "events": ["message:sent", "command:new", "gateway:startup"], "requires": { "bins": ["node"] } } }
---

# Cortex Synthesis Hook v5 — Adaptive Batch

Zero-token capture on every message, batch LLM extraction on idle.

**On `message:sent`** (zero tokens):
1. **Regex capture** — 18 saliency patterns, instant, free
2. **Queue raw** — content queued for later LLM batch extraction
3. **Adaptive threshold** — if queue ≥ 8 raw items, auto-triggers batch LLM extraction + distill

**On `command:new` / `command:reset`** (idle trigger):
- Flushes all queued raw items through LLM batch extraction
- Distills regex + triple insights → daily log + Mnemon

**On `gateway:startup`**: Flushes orphaned items on restart.

## Pipeline Flow (v5 — Adaptive Batch)

```
Message → Regex Capture (free, instant) ──→ Queue (regex items)
        → Queue Raw Content ──────────────→ Queue (raw items)
                                                    ↓ (when queue ≥ 8 raw, or on idle)
                                          LLM Batch Extraction (Ollama → Gemini)
                                                    ↓
                                          Queue (triple items)
                                                    ↓
                                          Distill → Daily Log + Mnemon
```

**Token savings**: LLM calls happen only on batch threshold (8 items) or idle (command:new), not per message. ~90% fewer LLM calls vs per-message extraction.

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

## LLM Triple Extraction

On batch trigger, queued content is sent to **Ollama** (primary) or **Gemini Flash** (fallback) for structured extraction:

- **Input**: Concatenated conversation snippets (up to 2000 chars per batch)
- **Output**: JSON array of `{subject, relation, object, confidence, category}` triples
- **Filter**: Only triples with confidence ≥ 0.5 are kept
- **Timeout**: 15 seconds (fails gracefully)
- **Fallback chain**: Ollama → Gemini → skip

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

## Mnemon Integration

Every distilled insight and extracted triple is also written to [Mnemon](https://github.com/mnemon-dev/mnemon) (persistent graph memory) during the distill phase:

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

## Configuration

Environment variables:
- `EXTRACTION_BACKEND`: `ollama` (default) or `gemini`
- `OLLAMA_HOST`: Ollama API URL (default: `http://localhost:11434`)
- `OLLAMA_MODEL`: Model for extraction (default: `glm-5.1:cloud`)
- `GEMINI_API_KEY`: Required for Gemini fallback
- `GEMINI_MODEL`: Model for Gemini extraction (default: `gemini-2.0-flash`)
- `MNEMON_ENABLED`: Set `false` to disable Mnemon writes (default: `true`)
- `MNEMON_BIN`: Path to mnemon binary (default: `mnemon`)
- `EXTRACTION_ENABLED`: Set `false` to disable LLM extraction (regex-only mode)

## OpenClaw Event Format

OpenClaw internal hooks use separate `type` and `action` fields:
- `event.type = "message"`, `event.action = "sent"` → matched as `message:sent`
- `event.type = "command"`, `event.action = "new"` → matched as `command:new`
- `event.type = "gateway"`, `event.action = "startup"` → matched as `gateway:startup`

The handler constructs `const eventType = \`${event?.type}:${event?.action}\`` for matching.