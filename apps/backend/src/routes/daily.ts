import { Hono } from "hono";

export const dailyRouter = new Hono()
  .get("/today", (c) => c.json({ success: true, data: null }))
  .get("/", (c) => c.json({ success: true, data: [], total: 0, page: 1, pageSize: 20 }))
  .get("/:id", (c) => {
    const id = c.req.param("id");
    return c.json({ success: true, data: { id } });
  });
