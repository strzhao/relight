import type { MiddlewareHandler } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    isLocalhost: boolean;
  }
}

const LOCAL_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * 仅本机访问 middleware。
 *
 * 安全前提：本项目通过 @hono/node-server 以 **TCP** 模式监听。若未来改用
 * UNIX socket / cluster IPC，c.env.incoming.socket.remoteAddress 为 undefined，
 * 此 middleware 会把请求误判为 localhost。改 listen mode 时必须同步审查本文件。
 *
 * XFF 安全铁律：只读 socket 级 remoteAddress，完全忽略 X-Forwarded-For 等 HTTP 头。
 * XFF 可被 `curl -H "X-Forwarded-For: 127.0.0.1"` 任意伪造。
 */
export const localhostOnly: MiddlewareHandler = async (c, next) => {
  // @hono/node-server 在 c.env.incoming 上挂 Node IncomingMessage
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  const remoteAddr = incoming?.socket?.remoteAddress ?? "";

  // 无 socket（测试 / app.request()）→ 视为 localhost
  const isLocal = remoteAddr === "" || LOCAL_ADDRS.has(remoteAddr);

  c.set("isLocalhost", isLocal);

  if (!isLocal && c.req.method !== "GET") {
    return c.json({ success: false, error: "forbidden", message: "仅本机访问" }, 403);
  }

  await next();
};
