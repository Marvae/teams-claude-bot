/**
 * Test: Can we send PromptResponse via streamInput()?
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("Testing PromptResponse via streamInput...\n");
  
  const q = query({
    prompt: "Ask me a yes/no question, then wait for my answer before proceeding.",
    options: {
      cwd: "/tmp",
      maxTurns: 5,
    },
  });
  
  for await (const msg of q) {
    console.log(`[${(msg as any).type}]`, JSON.stringify(msg).slice(0, 200));
    
    // Check for PromptRequest
    if (msg && typeof msg === "object" && "prompt" in msg && "message" in msg && "options" in msg) {
      const req = msg as { prompt: string; message: string; options: any[] };
      console.log(`\n>>> PromptRequest detected!`);
      console.log(`    ID: ${req.prompt}`);
      console.log(`    Message: ${req.message}`);
      console.log(`    Options: ${JSON.stringify(req.options)}`);
      
      // Try to send PromptResponse via streamInput
      console.log(`\n>>> Attempting to send PromptResponse...`);
      try {
        const response = {
          prompt_response: req.prompt,
          selected: req.options[0]?.key ?? "yes",
        };
        
        // Create async generator that yields the response
        async function* responseStream() {
          yield response as any;  // Type hack
        }
        
        await q.streamInput(responseStream());
        console.log(`>>> PromptResponse sent!`);
      } catch (e) {
        console.log(`>>> Failed to send: ${e}`);
      }
    }
  }
  
  console.log("\nDone.");
}

main().catch(console.error);
