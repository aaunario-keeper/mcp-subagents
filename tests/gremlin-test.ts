/**
 * Test gremlin containment: prevents exponential agent spawning
 */
import { AgentOrchestrator } from '../src/agents/orchestrator.js';
import { LocalHybridMemoryStore } from '../src/memory/localMemoryStore.js';
import type { ChatMessage, AgentResult } from '../src/types.js';

// Mock LLM that returns valid JSON with no delegations
const mockLlm = async (messages: ChatMessage[]) => ({
  content: JSON.stringify({
    summary: 'Test completed',
    delegations: [],
  }),
  model: 'test',
  usage: { promptTokens: 10, completionTokens: 5 },
});

// Mock LLM that tries to spawn more agents (greedy spawner)
const greedyLlm = async (messages: ChatMessage[]) => ({
  content: JSON.stringify({
    summary: 'Spawning more agents...',
    delegations: [
      { role: 'code', objective: 'Do task 1' },
      { role: 'analysis', objective: 'Do task 2' },
    ],
  }),
  model: 'test',
  usage: { promptTokens: 10, completionTokens: 5 },
});

async function testAgentLimit() {
  console.log('\n=== Test 1: Agent count limit ===\n');

  const memory = new LocalHybridMemoryStore('./test-data');
  const orchestrator = new AgentOrchestrator({
    llm: mockLlm,
    memory,
    defaults: { model: 'test', temperature: 0, maxDepth: 5 },
    maxAgentsPerSession: 3, // Very low limit for testing
  });

  const sessionId = 'gremlin-test-' + Date.now();
  let agentCount = 0;

  // Should succeed 3 times
  for (let i = 0; i < 3; i++) {
    try {
      await orchestrator.run({
        role: 'planner',
        objective: `Task ${i + 1}`,
        sessionId,
      });
      agentCount++;
      console.log(`  ✓ Agent ${agentCount} spawned successfully`);
    } catch (error) {
      console.log(`  ✗ Agent ${i + 1} failed: ${(error as Error).message}`);
    }
  }

  // 4th should fail
  try {
    await orchestrator.run({
      role: 'planner',
      objective: 'Task 4',
      sessionId,
    });
    console.log('  ✗ FAIL: 4th agent should have been blocked!');
    return false;
  } catch (error) {
    const msg = (error as Error).message;
    if (msg.includes('Agent limit exceeded')) {
      console.log(`  ✓ 4th agent blocked correctly: ${msg}`);
      return true;
    } else {
      console.log(`  ✗ Wrong error: ${msg}`);
      return false;
    }
  }
}

async function testDepthLimit() {
  console.log('\n=== Test 2: Depth limit prevents infinite recursion ===\n');

  const memory = new LocalHybridMemoryStore('./test-data');
  const orchestrator = new AgentOrchestrator({
    llm: greedyLlm,
    memory,
    defaults: { model: 'test', temperature: 0, maxDepth: 2 }, // depth 0 and 1 only
    maxAgentsPerSession: 100,
  });

  const sessionId = 'depth-test-' + Date.now();

  const result = await orchestrator.run({
    role: 'planner',
    objective: 'Start task',
    sessionId,
    maxDepth: 2,
  });

  // With maxDepth=2, root is at depth 0, children at depth 1
  // Children at depth 1 should NOT delegate further (depth+1 >= maxDepth)
  const totalAgents = countAgents(result);
  console.log(`  Total agents spawned: ${totalAgents}`);

  // Root (1) + up to 2 children (MAX_DELEGATIONS_PER_AGENT=2) = max 3
  if (totalAgents <= 3) {
    console.log('  ✓ Depth limit prevented exponential growth');
    return true;
  } else {
    console.log('  ✗ FAIL: Too many agents spawned!');
    return false;
  }
}

function countAgents(result: AgentResult): number {
  let count = 1;
  for (const child of result.children ?? []) {
    count += countAgents(child);
  }
  return count;
}

async function testSessionReset() {
  console.log('\n=== Test 3: Session reset clears agent count ===\n');

  const memory = new LocalHybridMemoryStore('./test-data');
  const orchestrator = new AgentOrchestrator({
    llm: mockLlm,
    memory,
    defaults: { model: 'test', temperature: 0, maxDepth: 5 },
    maxAgentsPerSession: 2,
  });

  const sessionId = 'reset-test-' + Date.now();

  // Use up the limit
  await orchestrator.run({ role: 'planner', objective: 'Task 1', sessionId });
  await orchestrator.run({ role: 'planner', objective: 'Task 2', sessionId });

  // Should fail
  try {
    await orchestrator.run({ role: 'planner', objective: 'Task 3', sessionId });
    console.log('  ✗ FAIL: Should have been blocked');
    return false;
  } catch {
    console.log('  ✓ Blocked as expected after limit reached');
  }

  // Reset and try again
  orchestrator.resetSessionAgentCount(sessionId);
  console.log('  → Reset session agent count');

  try {
    await orchestrator.run({ role: 'planner', objective: 'Task 3 after reset', sessionId });
    console.log('  ✓ Agent spawned successfully after reset');
    return true;
  } catch (error) {
    console.log(`  ✗ FAIL: Should work after reset: ${(error as Error).message}`);
    return false;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║      GREMLIN CONTAINMENT TEST SUITE        ║');
  console.log('╚════════════════════════════════════════════╝');

  const results: boolean[] = [];

  results.push(await testAgentLimit());
  results.push(await testDepthLimit());
  results.push(await testSessionReset());

  console.log('\n════════════════════════════════════════════');
  const passed = results.filter(Boolean).length;
  const total = results.length;

  if (passed === total) {
    console.log(`✓ ALL TESTS PASSED (${passed}/${total})`);
    console.log('Gremlins are contained! 🧟‍♂️🔒');
  } else {
    console.log(`✗ TESTS FAILED (${passed}/${total})`);
    console.log('WARNING: Gremlins may escape! 🧟‍♂️💨');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
