import { Hono } from "hono";

export const photosRouter = new Hono()
  .get("/", (c) => c.json({ success: true, data: [], total: 0, page: 1, pageSize: 20 }))
  .get("/:id", (c) => {
    const id = c.req.param("id");
    return c.json({ success: true, data: { id } });
  })
  .get("/:id/thumbnail", (c) => {
    return c.text("thumbnail placeholder", 200);
  });
