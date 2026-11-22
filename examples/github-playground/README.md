# Shared GitHub agent for the UI playgrounds

The [json-render](../json-render/README.md) and [A2UI](../a2ui/README.md) examples use this private
server package. Each demo supplies a prompt, the previous saved UI, and its own rendering instructions.

1. In [the lookup graph](./src/index.ts), the `selectTools` node calls the configured model with the
   [GitHub tools](./src/github-tools.ts). The model can request a profile, up to six recently pushed
   public repositories, or repository details.
2. The conditional edge sends tool calls to the `tools` node. LangGraph's `ToolNode` runs them as one
   batch. If the model needs more information from the user, the graph ends without a lookup.
3. The same model receives the tool results in a fresh call and streams the demo's rendering
   format. The outer demo graph owns validation, UI streaming, saved state, and review.

Tool and model requests share the active run's abort signal. The lookup graph is scoped to one
generation, so its messages stay out of the saved chat. Each tool uses a fixed public GitHub REST
path, allows eight seconds for the request, and passes only the fields the UI uses to the model.
The [LangGraph TypeScript guide](https://docs.langchain.com/oss/javascript/langgraph/graph-api)
describes the graph primitives used here.
