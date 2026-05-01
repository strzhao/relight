import { Hono } from "hono";

export const settingsRouter = new Hono()
  .get("/", (c) => c.json({ success: true, data: {} }))
  .put("/", async (c) => {
    const body = await c.req.json();
    return c.json({ success: true, data: body });
  });
