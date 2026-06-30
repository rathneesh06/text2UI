// bff/chat-store.test.ts — offline (in-memory store; PG impl is typecheck-only).
import assert from "node:assert";
import { InMemoryChatStore } from "./chat-store";

{
  const s = new InMemoryChatStore();
  const id = await s.createConversation("My sales chat");
  assert.ok(id && typeof id === "string", "createConversation returns an id");

  await s.appendMessage(id, { role: "user", content: "show my sales" });
  await s.appendMessage(id, { role: "assistant", content: "Built a dashboard", briefJson: "{}", outputMode: "dashboard" });
  await s.appendMessage(id, { role: "user", content: "make it darker" });

  const hist = await s.getHistory(id);
  assert.equal(hist.length, 3, "history has all turns");
  assert.deepEqual(hist.map((m) => m.role), ["user", "assistant", "user"], "order preserved");
  assert.equal(hist[2].content, "make it darker");
  // history is {role, content} only — exactly what the orchestrator threads in
  assert.deepEqual(Object.keys(hist[0]).sort(), ["content", "role"]);

  const limited = await s.getHistory(id, 2);
  assert.equal(limited.length, 2, "limit returns the most recent N");
  assert.equal(limited[0].content, "Built a dashboard");

  // a second conversation is isolated and sorts first (more recent)
  const id2 = await s.createConversation("Finance");
  await s.appendMessage(id2, { role: "user", content: "hi" });
  const list = await s.listConversations();
  assert.equal(list.length, 2, "lists both conversations");
  assert.equal(list[0].id, id2, "most-recently-updated first");

  assert.deepEqual(await s.getHistory("nonexistent"), [], "unknown conversation -> empty");
}

console.log("ok bff/chat-store");
