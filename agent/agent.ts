import { defineAgent } from "eve";

export default defineAgent({
  defaultTools: false,
  tool: false,
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
});
