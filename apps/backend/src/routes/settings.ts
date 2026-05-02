import { Hono } from "hono";

export const settingsRouter = new Hono()
  .get("/", (c) => c.json({ success: true, data: {} }))
  .put("/", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // body 为空或 JSON 解析失败，使用默认空对象
    }
    return c.json({ success: true, data: body });
  });
