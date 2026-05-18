# MnemonCortex

**Graph memory for any AI agent.** A 4-graph persistent memory system (temporal, entity, causal, semantic) with intent-aware recall, adaptive batch capture, and importance decay.

Built on [Mnemon](https://github.com/mnemon-dev/mnemon) — the graph memory CLI for LLM agents.

---

## Why?

Flat-file memory (daily logs, Markdown notes, wikilinks) stores facts but can't **recall relationships**. Asking "why did the deploy fail?" returns keyword matches, not causal chains. Asking "what's related to the payment system?" returns files, not connected decisions and fixes.

MnemonCortex adds structure:

1. **Temporal edges** — backbone and proximity links between events
2. **Entity edges** — co-occurrence through shared entities
3. **Causal edges** — cause → effect chains (LLM-reviewed)
4. **Semantic edges** — meaning similarity (cos ≥ 0.80 auto-linked)

## v5 — Adaptive Batch Capture

Previous versions called LLM extraction on **every outbound message** — burning tokens on isolated snippets out of context.

**v5 is different:**

| Trigger | What happens | Token cost |
|---------|-------------|------------|
| `message:sent` | Regex capture (21 patterns) + queue raw content | **Zero** |
| Queue reaches ≥ 8 raw items | Batch LLM extraction (concatenated context) | ~1 call per batch |
| `command:new` / idle | Flush all queued items through LLM + distill | ~1 call per flush |
| `gateway:startup` | Flush orphans left from restart | ~1 call |

**Result: ~90% fewer LLM calls** compared to per-message extraction. Better context too — batched content gives the LLM more to work with.

---

## Quickstart

```bash
# Install Mnemon
brew install mnemon-dev/tap/mnemon
# or: go install github.com/mnemon-dev/mnemon@latest

# Deploy hooks, plugin, and skill
mnemon setup --target openclaw --yes

# Pull embedding model
ollama pull nomic-embed-text

# Verify
mnemon status
```

### Standalone Usage (Any Agent)

```bash
# Store a decision
mnemon remember "Switched to pm2 for process management" \
  --cat decision --imp 4 --entities "pm2,systemd,process"

# Recall with intent
mnemon recall "why did the deploy fail" --intent WHY --limit 5

# Link a cause
mnemon link <cause-id> <effect-id> --type causal --weight 0.8

# Explore relationships
mnemon related <id> --edge causal --depth 2

# Garbage collection
mnemon gc --threshold 0.4
```

---

## 4-Graph Edge Types

| Edge Type | Auto? | Description | Example |
|-----------|-------|-------------|---------|
| **Temporal** | ✅ | Same-batch ordering, backbone links | "This fix came after the outage" |
| **Entity** | ✅ | Shared entity co-occurrence | "Nginx" appears in both insights |
| **Semantic** | ✅ (cos ≥ 0.80) | Meaningful similarity | "Gateway crashed" ↔ "502 errors" |
| **Causal** | ❌ (LLM-reviewed) | Cause → effect | "Wrong config" → "Gateway 502s" |

## Recall Intents

| Intent | Traversal Strategy | Use Case |
|--------|-------------------|----------|
| **WHY** | Causal edges first, then temporal | "Why did X break?" |
| **WHEN** | Temporal backbone, then entity | "When did we decide Y?" |
| **ENTITY** | Entity co-occurrence, then semantic | "What's related to Midtrans?" |
| **GENERAL** | RRF fusion of all strategies | Broad recall |

## Categories & Importance

| Category | Use For | Default Importance |
|----------|---------|-------------------|
| `decision` | Choices, preferences | 4 |
| `fact` | Bugs, security findings | 2–4 |
| `insight` | Learnings, observations | 3 |
| `context` | Infrastructure, environment | 2 |
| `preference` | User preferences | 4 |
| `general` | Everything else | 2 |

Importance auto-boosts for: `critical`, `always`, `never`, `root cause`, `security` → **5**

---

## Data Flow (v5 Adaptive Batch)

```
Every message:sent
    ↓ (zero tokens)
Regex capture (21 patterns) ──→ Queue (regex items)
Queue raw content            ──→ Queue (raw items)
                                    │
                    ┌───────────────┼───────────────┐
                    ↓               ↓               ↓
              Queue ≥ 8        command:new      gateway:startup
              (adaptive)        (idle)          (restart)
                    │               │               │
                    └───────────────┼───────────────┘
                                    ↓
                          Batch LLM Extraction
                          (Ollama → Gemini fallback)
                                    ↓
                          Queue (triple items)
                                    ↓
                          Distill → Daily Log + Mnemon
                                    ↓
                    Auto-edges: temporal + entity + semantic
                    Causal candidates → LLM review
```

---

## Components

### Cortex-Synthesis Hook (v5)

The capture pipeline running inside OpenClaw's gateway process:

- **`message:sent`** — Regex saliency capture (free) + queue raw content
- **`command:new` / `command:reset`** — Idle trigger: batch LLM extraction + distill
- **`gateway:startup`** — Flush orphans on restart
- **Adaptive threshold** — Auto-processes when ≥ 8 raw items accumulate

### Mnemon Plugin (`.openclaw/extensions/mnemon/`)

Injects behavioral prompts into the agent's context:

| Hook | Default | Description |
|------|---------|-------------|
| `remind` | on | Evaluate whether recall is needed before responding |
| `nudge` | on | Suggest remembering after each reply |
| `compact` | off | Save key insights before context compaction |

### Mnemon-Prime Hook (`.openclaw/hooks/mnemon-prime/`)

Runs on `agent:bootstrap` — injects the recall behavioral guide and current graph status into session context.

### Mnemon Skill (`.openclaw/skills/mnemon/SKILL.md`)

Full command reference for the agent: `remember`, `recall`, `link`, `related`, `forget`, `gc`, `status`, `log`.

---

## Configuration

```json
{
  "plugins": {
    "entries": {
      "mnemon": {
        "enabled": true,
        "config": {
          "remind": true,
          "nudge": true,
          "compact": false
        }
      }
    }
  }
}
```

---

## Comparison

| Feature | Flat Files / FTS5 | MnemonCortex | MemGPT | LangChain Memory |
|---------|-----------|-------------|--------|-----------------|
| Storage | Markdown | SQLite WAL + 4-graph | Proprietary | Various |
| Capture | Manual or per-msg LLM | Regex (free) + adaptive batch LLM | Per-msg LLM | Buffer/window |
| Token cost per msg | 0 (no extraction) | 0 (regex only) | High | Medium |
| Recall | Keyword search | Intent-aware graph traversal | Conversation window | Buffer/window |
| Relationships | Wikilinks (manual) | 4 typed edges (auto + manual) | None | None |
| Dedup | Manual | Auto (sim-based) | Manual | None |
| Importance decay | None | Built-in | None | None |
| Causal chains | None | WHY intent traversal | None | None |
| Local-first | ✅ | ✅ | ❌ (cloud) | Varies |
| Agent-agnostic | ❌ | ✅ | ❌ | ❌ |

---

## Project Structure

```
mnemocortex-open/
├── README.md
├── index.html          # Landing page
├── LICENSE
├── .gitignore
└── .openclaw/
    ├── extensions/mnemon/        # Plugin (remind/nudge/compact hooks)
    │   ├── index.js
    │   ├── openclaw.plugin.json
    │   └── package.json
    ├── hooks/mnemon-prime/       # Bootstrap hook (inject guide + status)
    │   ├── handler.js
    │   └── HOOK.md
    └── skills/mnemon/            # Agent skill command reference
        └── SKILL.md
```

---

## License

MIT