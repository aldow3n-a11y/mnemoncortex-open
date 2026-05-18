import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// ─── Configuration ───────────────────────────────────────────────────────────
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || join(process.env.HOME || "/home/manager", ".openclaw/workspace");
const QUEUE_FILE = join(WORKSPACE, "PROJECTS/cortex-v2/synthesis_queue.json");
const DAILY_LOG_DIR = join(WORKSPACE, "memory");

// LLM extraction config — Ollama (primary) or Gemini (fallback)
const EXTRACTION_BACKEND = process.env.EXTRACTION_BACKEND || "ollama";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "glm-5.1:cloud";

// Gemini fallback
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const EXTRACTION_ENABLED = true;
const EXTRACTION_TIMEOUT_MS = 15000;

// ─── Mnemon Integration ────────────────────────────────────────────────────
const MNEMON_ENABLED = process.env.MNEMON_ENABLED !== "false";
const MNEMON_BIN = process.env.MNEMON_BIN || "mnemon";
const MNEMON_TIMEOUT_MS = 5000;

// Map cortex categories → Mnemon categories
const MNEMON_CATEGORY_MAP: Record<string, string> = {
  infrastructure: "context",
  bug: "fact",
  decision: "decision",
  model: "context",
  security: "fact",
  pkm: "context",
  robotics: "context",
  general: "general",
};

function inferImportance(tags: string[], pattern: string): number {
  if (/critical decision|always |never |root cause|security/i.test(pattern)) return 5;
  if (/decision|fix|issue|problem|lesson/i.test(pattern)) return 4;
  if (/insight|finding|note|important/i.test(pattern)) return 3;
  return 2;
}

function mnemonRemember(content: string, category: string, importance: number, entities: string[], source: string = "agent"): string | null {
  if (!MNEMON_ENABLED) return null;
  try {
    const cat = MNEMON_CATEGORY_MAP[category] || category;
    const entitiesFlag = entities.length > 0 ? `--entities "${entities.join(",")}"` : "";
    const cmd = `${MNEMON_BIN} remember ${JSON.stringify(content)} --cat ${cat} --imp ${importance} ${entitiesFlag} --source ${source} --no-diff 2>/dev/null`;
    const result = execSync(cmd, { timeout: MNEMON_TIMEOUT_MS, encoding: "utf-8" });
    const parsed = JSON.parse(result);
    console.log(`[cortex-synthesis] Mnemon remembered: ${parsed.action} (${cat}/imp${importance}) [${parsed.id?.slice(0,8)}]`);
    return parsed.id || null;
  } catch (err: any) {
    console.log(`[cortex-synthesis] Mnemon remember failed: ${err?.message?.slice(0,100) || err}`);
    return null;
  }
}

function mnemonLink(sourceId: string, targetId: string, type: string, weight: number, meta?: Record<string, string>): void {
  if (!MNEMON_ENABLED) return;
  try {
    const metaFlag = meta ? `--meta '${JSON.stringify(meta)}'` : "";
    const cmd = `${MNEMON_BIN} link ${sourceId} ${targetId} --type ${type} --weight ${weight} ${metaFlag} 2>/dev/null`;
    execSync(cmd, { timeout: MNEMON_TIMEOUT_MS, encoding: "utf-8" });
    console.log(`[cortex-synthesis] Mnemon linked: ${sourceId.slice(0,8)} → ${targetId.slice(0,8)} (${type})`);
  } catch (err: any) {
    console.log(`[cortex-synthesis] Mnemon link failed: ${err?.message?.slice(0,80) || err}`);
  }
}

// ─── Saliency Patterns (regex only — cheap, no tokens) ───────────────────────
const SALIENCY_PATTERNS = [
  /remember this[:]/i, /core truth[:]/i, /lesson learned[:]/i, /critical decision[:]/i,
  /correction[:]/i, /update memory[:]/i, /important to note that/i,
  /root cause(?: was| is|:)/i, /fix(?:ed|):?\s/i, /the issue (?:was|is)\s/i,
  /key (?:insight|finding|takeaway):/i, /this (?:means|implies|suggests)\s/i,
  /never (?:again|do|use)\s/i, /always (?:use|do|prefer)\s/i,
  /gotcha[:\s]/i, /workaround[:\s]/i, /the problem (?:was|is)\s/i,
  /make sure (?:to|you)\s/i, /don't forget[:\s]/i,
];

const CATEGORY_PATTERNS = [
  { category: "infrastructure", pattern: /(?:nginx|server|vps|deploy|dns|ssl|docker|systemd)/i },
  { category: "bug", pattern: /(?:root cause|fix(?:ed)?|issue was|bug|error|500|401|403|crash)/i },
  { category: "decision", pattern: /(?:decided|decision|chose|went with|will use|switching to)/i },
  { category: "model", pattern: /(?:model|provider|ollama|gemini|claude|gpt|glm)/i },
  { category: "security", pattern: /(?:secret|key|credential|password|auth|token|perm)/i },
  { category: "pkm", pattern: /(?:note|vault|memory|moc|zettelkasten|obsidian)/i },
  { category: "robotics", pattern: /(?:robot|embodied|spatial reason|trajectory|bounding box|pointing)/i },
];

const EXTRACTION_PROMPT = `You are a knowledge extraction engine. Given a conversation snippet, extract atomic facts as structured triples.

For each fact, output a JSON object with:
- subject: the entity or concept (short noun phrase)
- relation: the relationship (short verb phrase like "root_cause", "is", "prevents", "requires", "located_at")
- object: the value or target (short noun phrase)
- confidence: 0.0-1.0 how certain this fact is
- category: one of [infrastructure, bug, decision, model, security, pkm, robotics, general]

Rules:
- Extract ONLY facts, not questions or commands
- Each triple should be atomic (one fact per entry)
- Keep subject/relation/object short (under 50 chars each)
- If no facts found, return empty array

Output ONLY a JSON array, no other text.

Snippet:
`;

// ─── Queue Types ─────────────────────────────────────────────────────────────
interface QueueItem {
  timestamp: string;
  source: string;
  pattern?: string;
  content: string;
  tags: string[];
  type: "regex" | "triple" | "raw";
  triple?: { subject: string; relation: string; object: string; confidence: number };
}

interface Triple {
  subject: string; relation: string; object: string; confidence: number; category: string;
}

function loadQueue(): QueueItem[] {
  try { if (!existsSync(QUEUE_FILE)) return []; return JSON.parse(readFileSync(QUEUE_FILE, "utf-8")); }
  catch { return []; }
}

function saveQueue(queue: QueueItem[]) {
  const dir = join(QUEUE_FILE, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

function categorize(text: string): string[] {
  const tags: string[] = [];
  for (const { category, pattern } of CATEGORY_PATTERNS) { if (pattern.test(text)) tags.push(category); }
  return tags.length > 0 ? tags : ["general"];
}

// ─── LLM Extraction (Ollama → Gemini fallback) ─────────────────────────────
async function extractTriples(content: string): Promise<Triple[]> {
  if (!EXTRACTION_ENABLED || content.length < 50) return [];

  if (EXTRACTION_BACKEND === "ollama") {
    const result = await extractTriplesOllama(content);
    if (result.length > 0) return result;
    console.log("[cortex-synthesis] Ollama extraction empty/failed, falling back to Gemini");
    return extractTriplesGemini(content);
  }
  return extractTriplesGemini(content);
}

async function extractTriplesOllama(content: string): Promise<Triple[]> {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: "user", content: EXTRACTION_PROMPT + content.slice(0, 2000) }],
        stream: false,
        options: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
    });

    if (!response.ok) { console.log(`[cortex-synthesis] Ollama extraction failed: ${response.status}`); return []; }
    const data = await response.json();
    const text = data?.message?.content;
    if (!text) return [];
    return parseTripleResponse(text);
  } catch (err: any) {
    console.log(`[cortex-synthesis] Ollama extraction error: ${err?.message || err}`);
    return [];
  }
}

async function extractTriplesGemini(content: string): Promise<Triple[]> {
  if (!GEMINI_API_KEY) { console.log("[cortex-synthesis] No GEMINI_API_KEY, skipping Gemini fallback"); return []; }
  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": GEMINI_API_KEY },
      signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [{ parts: [{ text: EXTRACTION_PROMPT + content.slice(0, 2000) }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    if (!response.ok) { console.log(`[cortex-synthesis] Gemini extraction failed: ${response.status}`); return []; }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return [];
    return parseTripleResponse(text);
  } catch (err: any) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      console.log("[cortex-synthesis] Gemini extraction timed out");
    } else {
      console.log(`[cortex-synthesis] Gemini extraction error: ${err?.message || err}`);
    }
    return [];
  }
}

function parseTripleResponse(text: string): Triple[] {
  let jsonStr = text.trim();
  if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
  if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
  if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
  jsonStr = jsonStr.trim();

  try {
    const triples = JSON.parse(jsonStr);
    if (!Array.isArray(triples)) return [];
    return triples.filter((t: any) =>
      t.subject && t.relation && t.object && typeof t.confidence === "number" && t.confidence >= 0.5
    ).map((t: any) => ({
      subject: String(t.subject).slice(0, 80),
      relation: String(t.relation).slice(0, 80),
      object: String(t.object).slice(0, 120),
      confidence: Number(t.confidence),
      category: CATEGORY_PATTERNS.some(cp => cp.pattern.test(`${t.subject} ${t.relation} ${t.object}`))
        ? categorize(`${t.subject} ${t.relation} ${t.object}`)[0]
        : (t.category || "general"),
    }));
  } catch { return []; }
}

// ─── Capture (cheap — regex only, no LLM) ───────────────────────────────────
function captureRegex(content: string, source: string): number {
  const queue = loadQueue();
  let captured = 0;
  for (const pattern of SALIENCY_PATTERNS) {
    const matches = content.matchAll(new RegExp(pattern.source, pattern.flags + (pattern.flags.includes('g') ? '' : 'g')));
    for (const match of matches) {
      const start = match.index!;
      const end = content.indexOf("\n", start);
      const insight = (end === -1 ? content.slice(start) : content.slice(start, end)).trim();
      const tags = categorize(insight);
      queue.push({ timestamp: new Date().toISOString(), source, pattern: pattern.source, content: insight, tags, type: "regex" });
      captured++;
    }
  }
  if (captured > 0) {
    saveQueue(queue);
    console.log(`[cortex-synthesis] Regex captured ${captured} insights (tags: ${queue.slice(-captured).flatMap(q => q.tags).join(", ")})`);
  }
  return captured;
}

// ─── Batch LLM extraction (processes all queued raw items) ────────────────────
async function batchExtractFromQueue(): Promise<number> {
  const queue = loadQueue();
  const rawItems = queue.filter(item => item.type === "raw");
  if (rawItems.length === 0) return 0;

  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentLen = 0;

  for (const item of rawItems) {
    if (currentLen + item.content.length > 1800 && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLen = 0;
    }
    currentBatch.push(item.content);
    currentLen += item.content.length;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  let totalExtracted = 0;
  for (const batch of batches) {
    const combinedContent = batch.join("\n---\n");
    const triples = await extractTriples(combinedContent);
    for (const triple of triples) {
      queue.push({
        timestamp: new Date().toISOString(), source: "batch-llm", pattern: "llm-extraction",
        content: `${triple.subject} → ${triple.relation} → ${triple.object}`,
        tags: [triple.category], type: "triple",
        triple: { subject: triple.subject, relation: triple.relation, object: triple.object, confidence: triple.confidence },
      });
      totalExtracted++;
    }
  }

  const processedQueue = queue.filter(item => item.type !== "raw");
  processedQueue.push(...queue.filter(item => item.type === "triple"));
  saveQueue(processedQueue);

  if (totalExtracted > 0) {
    console.log(`[cortex-synthesis] Batch LLM extracted ${totalExtracted} triples from ${rawItems.length} raw items`);
  }
  return totalExtracted;
}

// ─── Distill (flush queue → daily log + Mnemon) ──────────────────────────────
function distill() {
  const queue = loadQueue();
  if (queue.length === 0) { console.log("[cortex-synthesis] Queue empty, nothing to distill"); return 0; }

  const today = new Date().toISOString().slice(0, 10);
  const dailyLogPath = join(DAILY_LOG_DIR, `${today}.md`);
  let processed = 0;
  const distilledEntries: string[] = [];
  const tripleEntries: string[] = [];
  const mnemonIds: string[] = [];

  for (const item of queue) {
    if (item.type === "triple" && item.triple) {
      const t = item.triple;
      const tags = item.tags ? ` [${item.tags.join(",")}]` : "";
      tripleEntries.push(`- [Triple ${new Date().toISOString().slice(11, 16)}]${tags} **${t.subject}** → ${t.relation} → **${t.object}** (conf: ${t.confidence})`);

      const cat = t.category || "general";
      const content = `${t.subject} ${t.relation} ${t.object}`;
      const imp = t.confidence >= 0.9 ? 4 : t.confidence >= 0.7 ? 3 : 2;
      const id = mnemonRemember(content, cat, imp, [t.subject, t.object], "agent");
      if (id) mnemonIds.push(id);
    } else if (item.type !== "raw") {
      const content = SALIENCY_PATTERNS.reduce((text, pattern) => text.replace(pattern, "").trim(), item.content);
      if (!content) continue;
      const tags = item.tags ? ` [${item.tags.join(",")}]` : "";
      distilledEntries.push(`- [Distilled ${new Date().toISOString().slice(11, 16)}]${tags} ${content}`);

      const cat = item.tags?.[0] || "general";
      const imp = inferImportance(item.tags || [], item.pattern || "");
      const id = mnemonRemember(content, cat, imp, [], "agent");
      if (id) mnemonIds.push(id);
    }
    processed++;
  }

  // Link consecutive Mnemon insights with temporal edges (same distill batch)
  for (let i = 1; i < mnemonIds.length; i++) {
    mnemonLink(mnemonIds[i - 1], mnemonIds[i], "temporal", 0.5);
  }

  if (distilledEntries.length > 0 || tripleEntries.length > 0) {
    let block = "";
    if (distilledEntries.length > 0) block += `\n\n## Distilled Insights\n${distilledEntries.join("\n")}`;
    if (tripleEntries.length > 0) block += `\n\n## Extracted Triples\n${tripleEntries.join("\n")}`;

    if (existsSync(dailyLogPath)) {
      writeFileSync(dailyLogPath, readFileSync(dailyLogPath, "utf-8") + block);
      console.log(`[cortex-synthesis] Distilled ${processed} items to daily log: ${dailyLogPath}`);
    } else {
      mkdirSync(DAILY_LOG_DIR, { recursive: true });
      writeFileSync(dailyLogPath, `# ${today} Daily Log${block}`);
      console.log(`[cortex-synthesis] Created daily log with ${processed} items: ${dailyLogPath}`);
    }
  }

  const remaining = queue.filter(item => item.type === "raw");
  saveQueue(remaining);
  return processed;
}

// ─── Adaptive Batch Triggers ──────────────────────────────────────────────────
const BATCH_THRESHOLD = 8;

async function maybeBatchProcess(queue: QueueItem[]): Promise<boolean> {
  const rawCount = queue.filter(i => i.type === "raw").length;
  if (rawCount >= BATCH_THRESHOLD) {
    console.log(`[cortex-synthesis] Threshold reached: ${rawCount} raw items ≥ ${BATCH_THRESHOLD}, processing batch`);
    try { await batchExtractFromQueue(); } catch (err) { console.log(`[cortex-synthesis] Batch extraction error: ${err}`); }
    distill();
    return true;
  }
  return false;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
// v5: Adaptive batch — message:sent does regex + queue (zero tokens).
// LLM extraction triggers on: queue threshold (adaptive) OR command:new (idle) OR gateway:startup.
const handler = async (event: any) => {
  const eventType = `${event?.type}:${event?.action}`;

  if (eventType === "message:sent" && event.context?.content) {
    const content = event.context.content;
    captureRegex(content, "message:sent");
    const queue = loadQueue();
    queue.push({
      timestamp: new Date().toISOString(),
      source: "message:sent",
      content: content.slice(0, 2000),
      tags: categorize(content),
      type: "raw",
    });
    saveQueue(queue);
    await maybeBatchProcess(queue);
  }

  if (eventType === "command:new" || eventType === "command:reset") {
    const queue = loadQueue();
    const rawCount = queue.filter(i => i.type === "raw").length;
    if (rawCount > 0) {
      console.log(`[cortex-synthesis] Idle trigger: ${rawCount} raw items queued, processing batch`);
      try { await batchExtractFromQueue(); } catch (err) { console.log(`[cortex-synthesis] Batch extraction error: ${err}`); }
    }
    distill();
  }

  if (eventType === "gateway:startup") {
    const queue = loadQueue();
    if (queue.length > 0) {
      console.log(`[cortex-synthesis] Gateway startup: ${queue.length} queued items`);
      try { await batchExtractFromQueue(); } catch (err) { console.log(`[cortex-synthesis] Batch extraction error: ${err}`); }
      distill();
    }
  }
};

export default handler;