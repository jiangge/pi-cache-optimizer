export default function (pi: any) {
  pi.on("before_provider_request", (event: any, ctx: any) => {
    if (ctx?.model?.api !== "anthropic-messages") return;
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") return;
    const controls: Array<{ path: string; type?: unknown; ttl: unknown }> = [];
    const add = (path: string, block: unknown): void => {
      if (!block || typeof block !== "object") return;
      const cc = (block as Record<string, unknown>).cache_control;
      if (!cc || typeof cc !== "object") return;
      const record = cc as Record<string, unknown>;
      controls.push({ path, type: record.type, ttl: record.ttl ?? "5m-default" });
    };
    if (Array.isArray((payload as any).tools)) {
      (payload as any).tools.forEach((block: unknown, index: number) => add(`tools[${index}]`, block));
    }
    if (Array.isArray((payload as any).system)) {
      (payload as any).system.forEach((block: unknown, index: number) => add(`system[${index}]`, block));
    }
    if (Array.isArray((payload as any).messages)) {
      (payload as any).messages.forEach((message: any, messageIndex: number) => {
        if (!Array.isArray(message?.content)) return;
        message.content.forEach((block: unknown, contentIndex: number) => add(`messages[${messageIndex}].content[${contentIndex}]`, block));
      });
    }
    console.error(`TTL_TRACE ${JSON.stringify({ api: ctx.model.api, provider: ctx.model.provider, model: ctx.model.id, controls })}`);
  });
}
