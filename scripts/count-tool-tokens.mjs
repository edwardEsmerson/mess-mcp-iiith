#!/usr/bin/env node
// Prints how much context the tool definitions cost: the size of what a client receives in
// tools/list (per tool and in total) plus the server instructions. With ANTHROPIC_API_KEY set,
// also asks the token-counting API for the exact token cost. Run `npm run build` first.
//
//   npm run count-tokens
//   ANTHROPIC_API_KEY=... npm run count-tokens

import { connect, unreachableApi } from "./lib/in-process.mjs";

const MODEL = "claude-sonnet-5-5";
const COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens";

export async function measure() {
  const session = await connect(unreachableApi);
  try {
    const tools = await session.listTools();
    const perTool = tools.map((tool) => ({ name: tool.name, chars: JSON.stringify(tool).length }));
    return {
      tools,
      instructions: session.instructions,
      perTool,
      toolsChars: JSON.stringify(tools).length,
      instructionsChars: session.instructions.length,
    };
  } finally {
    await session.close();
  }
}

// Tokens for tools + instructions = a request that has them minus one that has neither.
async function countTokens(apiKey, { tools, instructions }) {
  const call = async (body) => {
    const response = await fetch(COUNT_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], ...body }),
    });
    if (!response.ok) throw new Error(`count_tokens returned ${response.status}: ${await response.text()}`);
    return (await response.json()).input_tokens;
  };
  const bare = await call({});
  const withTools = await call({
    system: instructions,
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })),
  });
  return withTools - bare;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await measure();
  const width = Math.max(...result.perTool.map((t) => t.name.length));
  for (const { name, chars } of [...result.perTool].sort((a, b) => b.chars - a.chars)) {
    console.log(`${name.padEnd(width)}  ${String(chars).padStart(5)}`);
  }
  console.log();
  console.log(`${result.tools.length} tools, tools/list JSON: ${result.toolsChars} chars`);
  console.log(`server instructions: ${result.instructionsChars} chars`);
  console.log(`total: ${result.toolsChars + result.instructionsChars} chars`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    console.log(`tokens (${MODEL}, tools + instructions): ${await countTokens(apiKey, result)}`);
  } else {
    console.log("Set ANTHROPIC_API_KEY to also get the exact token count.");
  }
}
