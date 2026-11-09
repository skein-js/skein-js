import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";

export class FixtureModel extends BaseChatModel {
  constructor(steps = []) {
    super({});
    this.steps = steps;
    this.seen = [];
    this.boundToolNames = [];
  }
  _llmType() {
    return "skein-candidate-fixture";
  }
  bindTools(tools) {
    this.boundToolNames = tools.map((tool) => tool.name);
    return this;
  }
  async _generate(messages) {
    this.seen.push(messages);
    const turn = messages.slice(
      messages.findLastIndex((message) => message.getType() === "human") + 1,
    );
    const step = this.steps[turn.filter((message) => message.getType() === "tool").length];
    const message = step
      ? new AIMessage({
          content: "",
          tool_calls: [{ id: `call-${this.seen.length}`, type: "tool_call", ...step }],
        })
      : new AIMessage("Fixture completed.");
    return {
      generations: [{ message, text: typeof message.content === "string" ? message.content : "" }],
    };
  }
}
