import { AIMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { createDeskTools } from "desklatch";
import { createLangChainTools } from "desklatch/langchain";
import { openDeskSession } from "./browser-host.mjs";

// A real ToolNode, without requiring an API key. The host owns the graph.
const session = await openDeskSession();
try {
  const node = new ToolNode(createLangChainTools(createDeskTools(session)));
  const result = await node.invoke({ messages: [new AIMessage({ content: "", tool_calls: [{
    id: "form-edit", type: "tool_call", name: "act",
    args: { steps: [{ kind: "type", target: { name: "Title" }, text: "Review",
      expect: { target: { name: "Title" }, valueEquals: "Review" } }] },
  }] })] });
  console.log(result.messages[0].content);
} finally { await session.close(); }
