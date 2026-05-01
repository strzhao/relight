import { Hono } from "hono";

export const tagsRouter = new Hono().get("/", (c) => c.json({ success: true, data: [] }));
