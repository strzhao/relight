import { Hono } from "hono";

export const scanRouter = new Hono()
  .post("/", (c) => c.json({ success: true, data: { message: "扫描任务已加入队列" } }))
  .get("/:id", (c) => {
    const id = c.req.param("id");
    return c.json({ success: true, data: { id, status: "pending" } });
  });
