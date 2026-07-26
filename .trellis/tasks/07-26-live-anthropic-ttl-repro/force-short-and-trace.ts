export default function (pi: any) {
  pi.on("before_provider_request", (event: any, ctx: any) => {
    if (ctx?.model?.api !== "anthropic-messages") return;
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") return;
    const controls: Array<{ path: string; ttl: unknown }> = [];
    const visit = (path: string, block: unknown): void => {
      if (!block || typeof block !== "object") return;
      const cc = (block as Record<string, unknown>).cache_control;
      if (!cc || typeof cc !== "object") return;
      const record = cc as Record<string, unknown>;
      if (record.type !== "ephemeral") return;
      if (record.ttl === "1h") delete record.ttl;
      controls.push({ path, ttl: record.ttl ?? "5m-default" });
    };
    if (Array.isArray((payload as any).tools)) (payload as any).tools.forEach((b: unknown, i: number) => visit(`tools[${i}]`, b));
    if (Array.isArray((payload as any).system)) (payload as any).system.forEach((b: unknown, i: number) => visit(`system[${i}]`, b));
    if (Array.isArray((payload as any).messages)) (payload as any).messages.forEach((m: any, mi: number) => {
      if (Array.isArray(m?.content)) m.content.forEach((b: unknown, ci: number) => visit(`messages[${mi}].content[${ci}]`, b));
    });
    console.error(`TTL_FORCE_SHORT ${JSON.stringify({ provider: ctx.model.provider, model: ctx.model.id, controls })}`);
  });
}
