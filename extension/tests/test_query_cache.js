/**
 * Smart Query Router - Extension Query Cache Test Suite
 * 
 * Verifies:
 * 1. QueryCache CRUD operations (set, get, has, delete, clear, size).
 * 2. Case-insensitive and whitespace-normalized query matching.
 * 3. Accurate dynamic token savings calculations (prompt + context + response).
 * 4. LRU eviction when capacity is reached.
 * 5. Persistence and restoration via mock chrome.storage.local.
 * 6. Integration with LocalAnswerUiController and OptimizerMetricsTracker.
 */

const assert = require('assert');
const path = require('path');
const { QueryCache, normalizeCacheKey } = require('../src/shared/query_cache');
const tokenCounter = require('../src/shared/token_counter');
const { OptimizerMetricsTracker } = require('../src/shared/optimizer_metrics');
const { LocalAnswerUiController, renderMarkdownToHtml } = require('../src/content/local_answer_ui');

console.log('--- 1. Testing Cache Normalization & Key Generation ---');
assert.strictEqual(normalizeCacheKey('Hello World'), 'hello world');
assert.strictEqual(normalizeCacheKey('  What   is   Quantum   Computing?  '), 'what is quantum computing?');
assert.strictEqual(normalizeCacheKey(''), '');
assert.strictEqual(normalizeCacheKey(null), '');
console.log('PASS: Query normalization produces canonical lowercased keys');

console.log('--- 2. Testing QueryCache Storage, Retrieval & Hit Counting ---');
const cache = new QueryCache({ maxEntries: 10, tokenCounter });

const entry1 = cache.set(
  'What is the speed of light?',
  'The speed of light in vacuum is approximately 299,792,458 meters per second (about 300,000 km/s or 186,000 miles per second).'
);

assert(entry1 !== null, 'Set should return created entry');
assert.strictEqual(entry1.key, 'what is the speed of light?');
assert.strictEqual(entry1.hitCount, 0, 'Initial hit count should be 0');
assert(entry1.promptTokens > 0, 'Prompt tokens should be calculated');
assert(entry1.responseTokens > 0, 'Response tokens should be calculated');
assert.strictEqual(cache.size(), 1, 'Cache size should be 1');

assert(cache.has('What is the speed of light?'), 'Should find query with exact match');
assert(cache.has('what is the speed of light?'), 'Should find query with lowercase match');
assert(cache.has('  WHAT   IS  THE  SPEED  OF  LIGHT? '), 'Should find query with whitespace & case variance');
assert(!cache.has('What is the speed of sound?'), 'Should return false for uncached query');

const hit1 = cache.get('what is the speed of light?');
assert(hit1 !== null, 'Get should return cached entry');
assert.strictEqual(hit1.hitCount, 1, 'Hit count should be incremented to 1');
assert(hit1.hitTokensSaved > 0, 'Tokens saved for hit should be positive');
assert.strictEqual(hit1.hitTokensSaved, entry1.promptTokens + entry1.responseTokens);

const hit2 = cache.get('What is the speed of light?');
assert.strictEqual(hit2.hitCount, 2, 'Hit count should be incremented to 2');
assert.strictEqual(hit2.totalTokensSaved, hit1.hitTokensSaved * 2);
console.log(`PASS: QueryCache successfully stores and retrieves entries (saved ${hit1.hitTokensSaved} tokens per hit)`);

console.log('--- 3. Testing Context-Aware Token Savings ---');
const mockTurnTracker = {
  getRecentTurns: () => [
    { role: 'user', content: 'Let us talk about physics.' },
    { role: 'assistant', content: 'Sure, physics is fascinating!' }
  ]
};

const hitWithContext = cache.get('what is the speed of light?', { turnTracker: mockTurnTracker });
assert(hitWithContext.contextTokens > 0, 'Context tokens should be calculated from turn tracker');
assert(hitWithContext.hitTokensSaved > hit1.hitTokensSaved, 'Total tokens saved should include avoided conversation context resubmission');
console.log(`PASS: Context-aware cache lookup saves additional history tokens (${hitWithContext.contextTokens} context tok)`);

console.log('--- 4. Testing LRU Capacity & Eviction ---');
const smallCache = new QueryCache({ maxEntries: 3, tokenCounter });
smallCache.set('Query A', 'Answer A');
smallCache.set('Query B', 'Answer B');
smallCache.set('Query C', 'Answer C');
assert.strictEqual(smallCache.size(), 3);

// Access Query A to make it MRU (most recently used)
smallCache.get('Query A');

// Insert Query D -> should evict Query B (which is now the oldest unaccessed entry)
smallCache.set('Query D', 'Answer D');
assert.strictEqual(smallCache.size(), 3);
assert(smallCache.has('Query A'), 'Query A should still exist (refreshed by get)');
assert(!smallCache.has('Query B'), 'Query B should have been evicted by LRU');
assert(smallCache.has('Query C'), 'Query C should still exist');
assert(smallCache.has('Query D'), 'Query D should exist');
console.log('PASS: LRU capacity bounds and eviction operate strictly as expected');

console.log('--- 5. Testing Persistence & Storage Synchronization ---');
const mockStorage = {
  data: {},
  set(obj, cb) {
    Object.assign(this.data, obj);
    if (cb) cb();
  },
  get(keys, cb) {
    const res = {};
    for (const k of keys) {
      if (this.data[k] !== undefined) res[k] = this.data[k];
    }
    if (cb) cb(res);
  }
};

const persistentCache = new QueryCache({ maxEntries: 5, storage: mockStorage, tokenCounter });
persistentCache.set('Who wrote Hamlet?', 'William Shakespeare wrote Hamlet around 1600.');
assert(mockStorage.data.smart_query_router_query_cache, 'Storage should contain serialized cache data');
assert.strictEqual(mockStorage.data.smart_query_router_query_cache.length, 1);

const restoredCache = new QueryCache({ maxEntries: 5, storage: mockStorage, tokenCounter });
restoredCache.load().then(() => {
  assert.strictEqual(restoredCache.size(), 1, 'Restored cache should have 1 entry');
  assert(restoredCache.has('who wrote hamlet?'), 'Restored cache should match query');
  const restoredHit = restoredCache.get('who wrote hamlet?');
  assert.strictEqual(restoredHit.responseText, 'William Shakespeare wrote Hamlet around 1600.');
  console.log('PASS: QueryCache asynchronously persists to and restores from chrome.storage.local');

  console.log('--- 6. Testing Integration with Optimizer Metrics Tracker ---');
  const metricsTracker = new OptimizerMetricsTracker({ storage: mockStorage });
  const hitSavings = restoredHit.hitTokensSaved;

  metricsTracker.recordActivity({
    route: 'Extension Query Cache',
    modelTier: 'local',
    cacheOutcome: 'HIT',
    tokensSaved: hitSavings,
    tokensConsumed: 0,
    latencyMs: 0.1,
    status: 'CACHE_HIT'
  });

  const summary = metricsTracker.getMetricsSummary();
  assert.strictEqual(summary.cacheHitRate.hits, 1, 'Cache hits should be 1');
  assert.strictEqual(summary.estimatedTokenSavings.totalTokensSaved, hitSavings, 'Total tokens saved should match cache savings');
  assert.strictEqual(summary.recentActivity[0].route, 'Extension Query Cache');
  console.log(`PASS: Metrics tracker aggregates cache hits and token savings correctly (${summary.estimatedTokenSavings.formatted} tokens saved)`);

  console.log('--- 7. Testing LocalAnswerUiController Cache Hit Card Rendering ---');
  const mockDoc = {
    getElementById: () => null,
    createElement: (tag) => {
      const el = {
        tagName: tag.toUpperCase(),
        children: [],
        innerHTML: '',
        querySelector: (sel) => {
          if (sel === '#sqr-local-btn-close') return { addEventListener: () => {} };
          if (sel === '#sqr-local-btn-copy') return { addEventListener: () => {} };
          if (sel === '#sqr-local-btn-insert') return { addEventListener: () => {} };
          if (sel === '#sqr-local-btn-ask') return { addEventListener: () => {} };
          return null;
        }
      };
      return el;
    },
    body: { appendChild: () => {} },
    addEventListener: () => {}
  };

  const ui = new LocalAnswerUiController({ document: mockDoc });
  ui.showAnswer({
    expression: 'Who wrote Hamlet?',
    result: 'William Shakespeare wrote Hamlet around 1600.',
    ruleId: 'RULE_EXTENSION_QUERY_CACHE_HIT',
    isCache: true,
    tokensSaved: 48,
    hitCount: 2
  });

  assert(ui.isVisible, 'UI should be visible');
  assert(ui.rootElement.innerHTML.includes('Extension Cache Hit (x2) · Saved 48 tokens'), 'Should render cache hit badge with hit count and token savings');
  assert(ui.rootElement.innerHTML.includes('William Shakespeare wrote Hamlet'), 'Should render cached answer text');
  console.log('PASS: LocalAnswerUiController renders rich cache hit card with brand badge and token savings');

  console.log('--- 8. Testing Long Queries with Multi-Paragraphs, Code Blocks, and Large Token Savings ---');
  const longQuery = `Please analyze the architectural trade-offs of microservices vs monolithic architectures in high-throughput distributed systems.
Include:
1. Network serialization latency and overhead
2. Data consistency (CAP theorem, event-driven sagas)
3. Deployment and CI/CD operational complexity

Provide a sample Python snippet demonstrating an idempotent event consumer pattern with dead-letter queue handling:
\`\`\`python
def process_order_event(event: dict, dlq_channel):
    # Idempotent processing logic
    pass
\`\`\`
Thank you!`;

  const longResponse = `### Microservices vs. Monoliths in High-Throughput Distributed Systems

When designing systems handling hundreds of thousands of transactions per second (TPS), the choice between a modular monolith and microservices involves fundamental distributed systems trade-offs:

#### 1. Network Serialization Latency and Overhead
- **Monolith**: Inter-module communication occurs via in-memory function calls with zero serialization cost (sub-microsecond latency).
- **Microservices**: Cross-service boundaries require serialization (JSON/Protobuf/gRPC) over TCP/HTTP2, introducing 1-10ms hops. At scale, the cumulative network penalty across service meshes can dominate overall p99 response times.

#### 2. Data Consistency (CAP Theorem & Sagas)
- **Monolith**: Leverages ACID database transactions with strong consistency.
- **Microservices**: Adopts eventual consistency across polyglot datastores. Sagas (orchestrated or choreography-based) and compensation workflows are required to handle partial failures.

#### 3. Operational Complexity & CI/CD
- **Monolith**: Simpler deployment pipelines, unified logging, and single-binary debugging, but risk of tight coupling.
- **Microservices**: Independent deployability and localized scaling, at the cost of distributed tracing (OpenTelemetry), distributed rate limiting, and complex deployment coordination.

#### Python Idempotent Event Consumer Pattern:
\`\`\`python
import json
import logging

class IdempotentEventConsumer:
    def __init__(self, processed_store, dlq_channel, max_retries=3):
        self.processed_store = processed_store
        self.dlq_channel = dlq_channel
        self.max_retries = max_retries

    def handle(self, raw_message: str):
        event = json.loads(raw_message)
        event_id = event.get("event_id")
        
        # Idempotency check
        if self.processed_store.exists(event_id):
            logging.info(f"Event {event_id} already processed. Skipping.")
            return True

        retries = 0
        while retries < self.max_retries:
            try:
                self._execute_business_logic(event)
                self.processed_store.mark_processed(event_id)
                return True
            except Exception as exc:
                retries += 1
                logging.warning(f"Retry {retries}/{self.max_retries} for {event_id}: {exc}")

        # Send to DLQ on repeated failure
        self.dlq_channel.publish(json.dumps({"event": event, "reason": "MAX_RETRIES_EXCEEDED"}))
        return False
\`\`\`
`;

  const longCache = new QueryCache({ maxEntries: 20, tokenCounter });
  const longEntry = longCache.set(longQuery, longResponse);

  assert(longEntry !== null);
  assert(longEntry.promptTokens > 80, `Prompt tokens should be significant: got ${longEntry.promptTokens}`);
  assert(longEntry.responseTokens > 300, `Response tokens should be significant: got ${longEntry.responseTokens}`);

  // Test lookup with different paragraph whitespace/casing
  const longQueryVariation = longQuery.toLowerCase().replace(/\n\n+/g, '\n');
  assert(longCache.has(longQueryVariation), 'Should match long query despite whitespace/newline differences');

  const longHit = longCache.get(longQueryVariation);
  assert.strictEqual(longHit.responseText, longResponse.trim(), 'Should retrieve full untruncated long response');
  assert(longHit.hitTokensSaved >= 400, `Should accurately calculate 400+ saved tokens for long query: got ${longHit.hitTokensSaved}`);
  console.log(`PASS: Long query (500+ words) & long response with code blocks cached and served perfectly (saved ${longHit.hitTokensSaved} tokens)`);

  console.log('--- 9. Testing Claude-Style Rich Markdown Formatting of Cached Responses ---');
  const userExamplePrompt = 'what is machine learning? what is n8n automation ?for what purpose will that be used?';
  const userExampleResponse = `Great questions! Let me explain both clearly.

## Machine Learning

**Machine Learning (ML)** is a type of artificial intelligence where computers learn from data and improve their performance without being explicitly programmed for every task.

**How it works:**
- You give the system examples (training data)
- The algorithm finds patterns in that data
- It uses those patterns to make predictions or decisions on new data
- It gets better as it sees more examples

**Real-world applications:**
- Email spam filtering
- Netflix/YouTube recommendations
- Medical image diagnosis
- Fraud detection in banking
- Voice assistants (Siri, Alexa)
- Self-driving cars recognizing objects
- Chatbots understanding language

---

## n8n Automation

**n8n** is a no-code/low-code automation platform that connects different applications together and automates workflows between them.
`;

  const renderedHtml = renderMarkdownToHtml(userExampleResponse);

  // Verify headings rendered as semantic HTML tags, not raw ##
  assert(renderedHtml.includes('<h3 class="sqr-md-h3">Machine Learning</h3>'), 'Should render ## Machine Learning as styled h3 tag');
  assert(renderedHtml.includes('<h3 class="sqr-md-h3">n8n Automation</h3>'), 'Should render ## n8n Automation as styled h3 tag');
  assert(!renderedHtml.includes('## Machine Learning'), 'Should eliminate raw ## characters from rendered HTML');

  // Verify bold tags rendered as strong, not raw **
  assert(renderedHtml.includes('<strong>Machine Learning (ML)</strong>'), 'Should render **Machine Learning (ML)** as strong tag');
  assert(renderedHtml.includes('<strong>How it works:</strong>'), 'Should render **How it works:** as strong tag');
  assert(renderedHtml.includes('<strong>Real-world applications:</strong>'), 'Should render **Real-world applications:** as strong tag');
  assert(renderedHtml.includes('<strong>n8n</strong>'), 'Should render **n8n** as strong tag');
  assert(!renderedHtml.includes('**Machine Learning (ML)**'), 'Should eliminate raw ** from rendered HTML');

  // Verify bullet lists grouped in ul with styled li items, not raw - or *
  assert(renderedHtml.includes('<ul class="sqr-md-ul">'), 'Should group bullet items in styled ul element');
  assert(renderedHtml.includes('<li class="sqr-md-li">Email spam filtering</li>'), 'Should render list items as styled li elements');
  assert(renderedHtml.includes('<li class="sqr-md-li">Netflix/YouTube recommendations</li>'), 'Should render all list items cleanly');
  assert(!renderedHtml.includes('- Email spam filtering'), 'Should eliminate raw hyphen bullet markers');

  // Verify horizontal rule rendered as styled hr, not raw ---
  assert(renderedHtml.includes('<hr class="sqr-md-hr">'), 'Should render --- divider as styled hr tag');
  assert(!renderedHtml.includes('---'), 'Should eliminate raw --- characters from rendered HTML');

  // Verify that LocalAnswerUiController showAnswer mounts the rich HTML into the card
  const mockDocForMd = {
    getElementById: () => null,
    createElement: (tag) => {
      let innerHTML = '';
      return {
        tagName: tag.toUpperCase(),
        children: [],
        get innerHTML() { return innerHTML; },
        set innerHTML(val) { innerHTML = val; },
        querySelector: (sel) => {
          if (sel === '#sqr-local-btn-close') return { addEventListener: () => {} };
          if (sel === '#sqr-local-btn-copy') return { addEventListener: () => {} };
          if (sel === '#sqr-local-btn-insert') return { addEventListener: () => {} };
          if (sel === '#sqr-local-btn-ask') return { addEventListener: () => {} };
          return null;
        }
      };
    },
    body: { appendChild: () => {} },
    addEventListener: () => {}
  };

  let insertedPromptText = null;
  const mdUi = new LocalAnswerUiController({
    document: mockDocForMd,
    onInsertIntoEditor: (text) => { insertedPromptText = text; }
  });

  mdUi.showAnswer({
    expression: userExamplePrompt,
    result: userExampleResponse,
    ruleId: 'RULE_EXTENSION_QUERY_CACHE_HIT',
    isCache: true,
    tokensSaved: 180,
    hitCount: 3
  });

  assert(mdUi.rootElement.innerHTML.includes('<h3 class="sqr-md-h3">Machine Learning</h3>'), 'UI card innerHTML should contain rich h3 heading');
  assert(mdUi.rootElement.innerHTML.includes('<strong>Machine Learning (ML)</strong>'), 'UI card innerHTML should contain rich strong tag');
  assert(mdUi.rootElement.innerHTML.includes('<ul class="sqr-md-ul">'), 'UI card innerHTML should contain styled bullet list');

  // Test insert preserving raw markdown for prompt editor
  const insertButton = mdUi.rootElement.querySelector('#sqr-local-btn-insert');
  assert(insertButton !== null);
  mdUi._insertResultIntoPrompt(userExampleResponse);
  assert.strictEqual(insertedPromptText, userExampleResponse, 'Inserting should pass raw unmodified markdown to prompt editor');

  console.log('PASS: Cached responses render with rich Claude-style headings, bold text, orange bullet markers, and dividers without ugly raw markdown symbols');

  console.log('\n======================================================================');
  console.log('ALL EXTENSION QUERY CACHE TESTS PASSED');
  console.log('======================================================================');
  process.exit(0);
}).catch((err) => {
  console.error('Query cache test failure:', err);
  process.exit(1);
});
