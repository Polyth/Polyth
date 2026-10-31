import { connectPolyth } from "@polyth/package-sdk";

const polyth = await connectPolyth();

polyth.contributions.onInvoke(async (invocation) => {
  if (invocation.kind !== "tool-renderer" || invocation.contributionId !== "build-detail") return;
  const state = invocation.tool.error ? "Failed" : "Completed";
  return {
    ui: {
      type: "card",
      title: invocation.tool.name,
      subtitle: `Call ${invocation.tool.callId}`,
      children: [
        { type: "badge", text: state, tone: invocation.tool.error ? "danger" : "success" },
        invocation.tool.error
          ? { type: "text", text: invocation.tool.error, tone: "danger" }
          : {
            type: "code",
            language: "json",
            text: JSON.stringify({
              input: invocation.tool.input ?? {},
              output: invocation.tool.output ?? null,
            }, null, 2),
          },
      ],
    },
  };
});
