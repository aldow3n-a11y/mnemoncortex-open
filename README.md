# MnemonCortex

**Graph memory for any AI agent.** Adds a 4-graph persistent memory layer (temporal, entity, causal, semantic) to your agent's insight capture pipeline, so it doesn't just store facts — it understands how they connect.

> **MnemonCortex** = [Mnemon](https://github.com/mnemon-dev/mnemon) (graph memory CLI) + Cortex-Synthesis (insight capture) + agent integration hooks

---

## Why?

Flat-file memory systems (daily logs, Markdown notes, wikilinks) work for storage, but they fail at **recall**. Asking "why did the deploy fail last week?" returns keyword matches, not causal chains. Asking "what's related to the payment system?" returns a list of files, not a connected graph of decisions, bugs, and fixes.

MnemonCortex fixes this by:

1. **Capturing** insights automatically from conversations (regex + LLM extraction)
2. **Structuring** them into a 4-graph database with typed edges
3. **Recalling** with intent-aware beam search (WHY, WHEN, ENTITY, GENERAL)
4. **Decaying** importance over time — old unused memories fade, frequently recalled ones stay fresh

---

## Architecture

```
                    ┌──────────────────────┐
                    │   Agent Conversation   │
                    └──────────┬─────────────┘
                               │
                    ┌──────────▼─────────────┐
                    │   Cortex-Synthesis Hook  │
                    │                          │
                    │  1. Regex Capture (21)  │
                    │  2. LLM Extraction       │
                    │     (subject, rel, obj)  │
                    └──────────┬───────────────┘
                               │
                    ┌──────────▼─────────────┐
                    │    Synthesis Queue       │
                    └──────────┬───────────────┘
                               │
                    ┌──────────▼─────────────┐
                    │       distill()          │
                    │                          │
                    │  ┌─────────┐            │
                    │  │Daily Log │ ← Markdown │
                    │  └─────────┘            │
                    │  ┌─────────────────┐     │
                    │  │  Mnemon Graph   │     │
                    │  │  (SQLite WAL)   │     │
                    │  │                  │     │
                    │  │ • remember()    │     │
                    │  │ • inferImportance│    │
                    │  │ • categoryMap   │     │
                    │  │ • temporal link  │     │
                    │  │ • entity extract │     │
                    │  └─────────────────┘    │
                    └──────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼──────┐  ┌─────▼──────┐  ┌──────▼──────┐
    │  Agent Context  │  │  Mnemon    │  │  Weekly      │
    │  Injection     │  │  Plugin    │  │  Consolidation│
    │  (bootstrap)   │  │ (remind/   │  │  (vault/MOCs)│
    │                │  │  nudge/    │  │              │
    │                │  │  compact)  │  │              │
    └────────────────┘  └────────────┘  └──────────────┘
```

---

## Components

### Mnemon (Graph Memory CLI)

- **Binary:** `mnemon` v0.1.5
- **Database:** SQLite WAL at `~/.mnemon/data/default/mnemon.db`
- **Embeddings:** Ollama nomic-embed-text (768-dim, local) or any compatible provider
- **4 Graph Types:** temporal, entity, causal, semantic
- **Recall:** Intent-aware beam search + Reciprocal Rank Fusion

### Cortex-Synthesis Hook

- **Path:** `hooks/cortex-synthesis/handler.ts`
- **Events:** `message:sent` (capture), `command:new`/`command:reset`/`gateway:startup` (distill)
- **Extraction:** Regex (21 patterns) + LLM (Ollama → Gemini fallback)
- **Output:** Daily log (`memory/YYYY-MM-DD.md`) + Mnemon graph writes

### Mnemon Plugin

- **Path:** `.openclaw/extensions/mnemon/`
- **Hooks:** `before_prompt_build` (remind/nudge), `before_compaction` (compact)
- **Config:** `remind: true`, `nudge: true`, `compact: false` (default)

### Mnemon-Prime Hook

- **Path:** `.openclaw/hooks/mnemon-prime/`
- **Event:** `agent:bootstrap`
- **Action:** Injects behavioral guide + Mnemon status summary into agent context

---

## 4-Graph Edge Types

| Edge Type | Auto? | Description | Example |
|-----------|-------|-------------|---------|
| **Temporal** | ✅ | Same-batch ordering, backbone links | "This fix came after the outage" |
| **Entity** | ✅ | Shared entity co-occurrence | "Nginx" appears in both insights |
| **Semantic** | ✅ (cos ≥ 0.80) | Meaningful similarity | "Gateway crashed" ↔ "502 errors" |
| **Causal** | ❌ (LLM-reviewed) | Cause → effect | "Wrong config" → "Gateway 502s" |

---

## Recall Intents

| Intent | Traversal Strategy | Use Case |
|--------|-------------------|----------|
| **WHY** | Follow causal edges first, then temporal | "Why did X break?" |
| **WHEN** | Temporal backbone, then entity | "When did we decide Y?" |
| **ENTITY** | Entity co-occurrence, then semantic | "What's related to Midtrans?" |
| **GENERAL** | RRF fusion of all strategies | Broad recall |

---

## Category Mapping

Cortex saliency categories map to Mnemon categories:

| Cortex Pattern | Mnemon Category | Default Importance |
|---------------|-----------------|-------------------|
| infrastructure | context | 2 |
| bug | fact | 2 |
| decision | decision | 4 |
| model | context | 2 |
| security | fact | 4 |
| pkm | context | 2 |
| general | general | 2 |

Importance is further refined by pattern content:
- `critical decision`, `always`, `never`, `root cause`, `security` → **5**
- `decision`, `fix`, `issue`, `lesson` → **4**
- `insight`, `finding`, `note`, `important` → **3**
- Default → **2**

---

## Installation

### Prerequisites

- [Ollama](https://ollama.ai) with `nomic-embed-text` model pulled
- Node.js 18+ (for cortex-synthesis hook)

### Install Mnemon

```bash
# Option 1: Homebrew (macOS/Linux)
brew install mnemon-dev/tap/mnemon

# Option 2: Go install
go install github.com/mnemon-dev/mnemon@latest

# Option 3: Download binary from releases
# https://github.com/mnemon-dev/mnemon/releases
```

### Quick Setup

```bash
# Deploy skill, hook, plugin, and prompts for OpenClaw
mnemon setup --target openclaw --yes

# Pull embedding model
ollama pull nomic-embed-text

# Verify
mnemon status

# Restart your agent runtime to activate hooks
```

### Standalone Usage (Any Agent)

Mnemon is a CLI tool. Use it from any agent that can run shell commands:

```bash
# Store a decision
mnemon remember "Switched to pm2 for process management" \
  --cat decision --imp 4 --entities "pm2,systemd,process"

# Recall with intent
mnemon recall "why did the deploy fail" --intent WHY --limit 5
mnemon recall "Midtrans" --intent ENTITY --limit 3
mnemon recall "security credentials" --limit 3

# Link insights
mnemon link <cause-id> <effect-id> --type causal --weight 0.8

# Explore relationships
mnemon related <insight-id> --edge causal --depth 2

# Garbage collection
mnemon gc --threshold 0.4
```

---

## Configuration

### OpenClaw Plugin (`~/.openclaw/openclaw.json`)

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

| Setting | Default | Description |
|---------|---------|-------------|
| `remind` | `true` | Inject recall hint before each response |
| `nudge` | `true` | Suggest remember sub-agent after each reply |
| `compact` | `false` | Save key insights before context compaction |

### Cortex-Synthesis Handler

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `EXTRACTION_BACKEND` | `ollama` | LLM backend (`ollama` or `gemini`) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `glm-5.1:cloud` | Ollama model for extraction |
| `GEMINI_API_KEY` | — | Gemini API key (fallback) |
| `MNEMON_BIN` | `mnemon` | Path to mnemon binary |
| `MNEMON_ENABLED` | `true` | Enable/disable Mnemon writes |

---

## Data Flow

### Capture Path

```
Agent receives/sends message
    ↓
Cortex-synthesis hook fires (on message event)
    ↓
Regex patterns (21) match saliency markers
    ↓
LLM extracts (subject, relation, object) triples
    ↓
Items queued in synthesis_queue.json
    ↓
On flush trigger (session reset, startup)
    ↓
┌─────────────────┬──────────────────────┐
│ Daily Log        │ Mnemon Graph          │
│ (Markdown)       │ mnemon remember       │
│                  │ --no-diff (batch)     │
│                  │ mnemon link temporal  │
└─────────────────┴──────────────────────┘
```

### Recall Path

```
Agent receives query
    ↓
Bootstrap hook injects Mnemon guide + status
    ↓
Plugin injects remind/nudge prompts
    ↓
Agent calls mnemon recall with intent
    ↓
Beam search traverses relevant graph edges
    ↓
Multi-factor re-ranking (recency, importance, access)
    ↓
Returns scored, intent-appropriate results
```

### Decay Path

```
Time passes
    ↓
Effective importance decreases per insight
    ↓
Access count boosts retention
    ↓
mnemon gc --threshold 0.4 prunes low-retention insights
    ↓
Consolidation updates vault notes + indexes
```

---

## Comparison

| Feature | Flat Files / FTS5 | MnemonCortex | MemGPT | LangChain Memory |
|---------|-----------|-------------|--------|-----------------|
| Storage format | Markdown | SQLite WAL + 4-graph | Proprietary | Various |
| Recall type | Keyword search | Intent-aware graph traversal | Conversation window | Buffer/window |
| Relationships | Wikilinks (manual) | 4 typed edges (auto + manual) | None | None |
| Dedup | Manual | Auto (sim-based) | Manual | None |
| Importance decay | None | Built-in | None | None |
| Causal chains | None | WHY intent traversal | None | None |
| Local-first | ✅ | ✅ | ❌ (cloud) | Varies |
| Open source | ✅ | ✅ | ✅ | ✅ |
| Agent-agnostic | ❌ | ✅ | ❌ | ❌ |

---

## Project Structure

```
mnemoncortex/
├── README.md                        ← This file
├── index.html                       ← Landing page
├── .gitignore
├── hooks/
│   └── cortex-synthesis/
│       ├── handler.ts               ← Main handler with Mnemon integration
│       └── HOOK.md                  ← Hook documentation
└── .openclaw/
    ├── openclaw.json                ← Plugin configuration
    ├── extensions/mnemon/
    │   ├── index.js                 ← Plugin hooks (remind/nudge/compact)
    │   ├── openclaw.plugin.json     ← Plugin manifest
    │   └── package.json
    ├── hooks/mnemon-prime/
    │   ├── handler.js               ← Bootstrap hook (inject guide + status)
    │   └── HOOK.md
    └── skills/mnemon/
        └── SKILL.md                 ← Agent skill command reference
```

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'Add my feature'`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Acknowledgments

- **[Mnemon](https://github.com/mnemon-dev/mnemon)** — Graph memory CLI for LLM agents
- **[Ollama](https://ollama.ai)** — Local LLM inference and embeddings
- **nomic-embed-text** — Local embedding model for vector similarity

---

<p align="center">
  <strong>Memories with structure, not just storage.</strong><br>
  <a href="https://github.com/aldow3n-a11y/mnemoncortex-open">View on GitHub</a> · <a href="https://github.com/mnemon-dev/mnemon">Mnemon CLI</a>
</p>