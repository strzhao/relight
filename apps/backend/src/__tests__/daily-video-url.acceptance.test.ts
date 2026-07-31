/**
 * 验收测试（红队）：daily-video 推送 URL 改公网（场景 5：P18/P19/P20）
 *
 * 设计契约（state.md §验收场景 场景 5 + §契约规约 公网 URL 契约）：
 *   - P18 [negate] daily-video 推送代码无 localhost/127.0.0.1（注释/测试除外）
 *   - P19        推送代码含 config.galleryPublicUrl
 *   - P20        URL 形如 galleryPublicUrl + #/video/<id>
 *
 * 实现意图（state.md §组件设计 5 + §契约规约 接入点契约）：
 *   - daily-video.ts:321（pushVideoNotification 内构造 videoUrl）原为
 *     `http://localhost:${config.port}/api/videos/${videoId}/stream`
 *   - 蓝队应改为 `config.galleryPublicUrl + '/#/video/' + videoId`
 *
 * 红队铁律：本文件仅依据设计文档编写，不读蓝队实现 diff。
 *   - 未读 jobs/daily-video.ts 的实现改动（只读文本做字符串断言）
 *   - 通过读源码文件文本做 fs-grep 类静态断言（det-machine，零主观）
 *
 * 测试策略：
 *   - 读 jobs/daily-video.ts 全文（以文本形式，不解析 AST）
 *   - 提取 pushVideoNotification 函数体内构造 URL 的区域
 *   - P18 negate：全文件匹配 localhost/127.0.0.1 的行（排除注释/URL 字面量之外的真实残留）
 *   - P19：含 config.galleryPublicUrl 标识符
 *   - P20：匹配 `galleryPublicUrl ... #/video/` 模式（容忍模板字符串/拼接差异）
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BACKEND_ROOT = path.resolve(__dirname, "../..");
const DAILY_VIDEO_PATH = path.join(BACKEND_ROOT, "src/jobs/daily-video.ts");

/** 读取 daily-video.ts 源码文本（utf-8，统一换行） */
function readDailyVideoSource(): string {
  if (!fs.existsSync(DAILY_VIDEO_PATH)) {
    throw new Error(`daily-video.ts not found at ${DAILY_VIDEO_PATH}`);
  }
  return fs.readFileSync(DAILY_VIDEO_PATH, "utf-8").replace(/\r\n/g, "\n");
}

/**
 * 去除行内尾部 `// ...` 注释（但不误伤 URL schema `http://`）。
 *
 * 朴素 split('//')[0] 会把 URL 里的 `//`（http://）当注释切掉，
 * 导致 `http://localhost` 变成 `http:`，localhost 残留被漏检。
 *
 * 策略：只在 `//` 前面不是 `:`（URL schema 分隔符）时才视为注释起始。
 * 即 `http://` / `https://` / `ws://` 的 // 保留，`code // comment` 的 // 切掉。
 */
function stripInlineComment(line: string): string {
  // 从左往右扫，找第一个 "不在 schema(:) 后面" 的 //
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === "/" && line[i + 1] === "/") {
      // 前一个非空白字符是否是 ':'（URL schema）
      let j = i - 1;
      while (j >= 0 && /\s/.test(line[j]!)) j--;
      if (j >= 0 && line[j] === ":") {
        continue; // URL schema 的 //，保留
      }
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * 匹配 "残留的 localhost/127.0.0.1 URL 构造" 行。
 *
 * 规则（严格 det-machine）：
 *   - 命中 `localhost:` 或 `127.0.0.1` 且该行不在注释里（// 或 * 或 块注释内）
 *   - 关键：pushVideoNotification 内构造 videoUrl 的行不应再用 localhost
 *
 * 返回命中的行数组（非注释行）。
 */
function findLocalhostResidues(source: string): Array<{ lineNo: number; line: string }> {
  const lines = source.split("\n");
  const residues: Array<{ lineNo: number; line: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const trimmed = raw.trim();
    // 跳过注释行（// 单行注释 或 * 块注释续行 或 /* 起始）
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    // 去掉行内尾部注释（但保护 URL schema 的 //）
    const codePart = stripInlineComment(trimmed);
    // 命中 localhost: 或 127.0.0.1
    if (/localhost:/.test(codePart) || /127\.0\.0\.1/.test(codePart)) {
      residues.push({ lineNo: i + 1, line: raw });
    }
  }
  return residues;
}

/**
 * 提取 pushVideoNotification 函数体（粗略：从 export async function pushVideoNotification
 * 到下一个顶层 export/function 声明）。
 */
function extractPushVideoFunctionBody(source: string): string {
  const startMatch = /export\s+async\s+function\s+pushVideoNotification/.exec(source);
  if (!startMatch || startMatch.index == null) {
    // 函数找不到时返回全文（让后续断言在全文范围内做，更宽松）
    return source;
  }
  const start = startMatch.index;
  // 找下一个顶层 function/const/export（粗略）
  const rest = source.slice(start);
  const nextDecl = /\n(?:export\s+)?(?:async\s+)?(?:function|const|let)\s+\w/.exec(rest.slice(1));
  if (!nextDecl || nextDecl.index == null) {
    return rest;
  }
  return rest.slice(0, nextDecl.index + 1);
}

// ============================================================================
// P18：daily-video 推送代码无 localhost/127.0.0.1 残留【negate】
// ============================================================================

describe("P18 daily-video 推送代码无 localhost/127.0.0.1 残留【negate】", () => {
  it("P18.1 整个 daily-video.ts 源码非注释行不应命中 localhost: 或 127.0.0.1", () => {
    const src = readDailyVideoSource();
    const residues = findLocalhostResidues(src);

    // negate 谓词：残留应为 0
    expect(
      residues,
      `daily-video.ts 仍含 localhost/127.0.0.1 残留（非注释行）: ${JSON.stringify(residues, null, 2)}`,
    ).toHaveLength(0);
  });

  it("P18.2 pushVideoNotification 函数体内不应出现 localhost:（videoUrl 构造必须改公网）", () => {
    const src = readDailyVideoSource();
    const body = extractPushVideoFunctionBody(src);
    // 函数体内不应再构造 localhost URL（核心 bug 修复点）
    expect(
      body,
      "pushVideoNotification 内仍含 localhost: URL 构造（应改 config.galleryPublicUrl）",
    ).not.toMatch(/localhost:/);
  });
});

// ============================================================================
// P19：推送代码含 config.galleryPublicUrl
// ============================================================================

describe("P19 daily-video 推送代码含 config.galleryPublicUrl", () => {
  it("P19.1 daily-video.ts 源码应引用 config.galleryPublicUrl 标识符", () => {
    const src = readDailyVideoSource();
    // 必须命中 config.galleryPublicUrl（蓝队接通 config 字段）
    expect(src, "daily-video.ts 未引用 config.galleryPublicUrl（推送 URL 未接通公网配置）").toMatch(
      /config\.galleryPublicUrl/,
    );
  });

  it("P19.2 pushVideoNotification 函数体内应引用 config.galleryPublicUrl", () => {
    const src = readDailyVideoSource();
    const body = extractPushVideoFunctionBody(src);
    expect(
      body,
      "pushVideoNotification 内未引用 config.galleryPublicUrl（videoUrl 构造未用公网配置）",
    ).toMatch(/config\.galleryPublicUrl/);
  });
});

// ============================================================================
// P20：URL 形如 galleryPublicUrl + #/video/<id>
// ============================================================================

describe("P20 URL 形如 galleryPublicUrl + #/video/<id>", () => {
  it("P20.1 pushVideoNotification 内应构造含 '#/video/' 的 URL", () => {
    const src = readDailyVideoSource();
    const body = extractPushVideoFunctionBody(src);
    // 必须命中 #/video/ hash 路由（设计契约：gallery.stringzhao.life/#/video/<id>）
    expect(body, "pushVideoNotification 内未构造含 #/video/ 的 URL（hash 路由契约）").toMatch(
      /#\/video\//,
    );
  });

  it("P20.2 videoUrl 构造应在函数体内同时引用 galleryPublicUrl 和 videoId", () => {
    const src = readDailyVideoSource();
    const body = extractPushVideoFunctionBody(src);
    // 函数体内应同时出现 galleryPublicUrl、#/video/、videoId（URL 三要素）
    // 不要求同一行（容忍多行构造：先取 base 再拼 url 的写法）
    expect(body, "pushVideoNotification 内应引用 config.galleryPublicUrl").toMatch(
      /galleryPublicUrl/,
    );
    expect(body, "pushVideoNotification 内应含 #/video/ hash 路由").toMatch(/#\/video\//);
    expect(body, "pushVideoNotification 内应引用 videoId").toMatch(/videoId/);

    // 进一步：videoUrl 变量的赋值行附近应能关联三者
    // 找 videoUrl 赋值行（容忍 const/let/无声明）
    const urlAssignMatch = body.match(/videoUrl\s*=\s*([^;]+)/);
    expect(urlAssignMatch, "应存在 videoUrl 变量赋值").toBeTruthy();
    if (!urlAssignMatch) return;
    // videoUrl 赋值表达式应含 #/video/（核心契约：URL 里有 hash 路由）
    expect(urlAssignMatch[1], "videoUrl 赋值应含 #/video/").toMatch(/#\/video\//);
  });

  it("P20.3 mutation kill：不应回退为 /api/videos/<id>/stream 路径（旧 localhost 路径）", () => {
    const src = readDailyVideoSource();
    const body = extractPushVideoFunctionBody(src);
    // 防止蓝队只改域名不改路径（No-op mutation：domain 换成 gallery 但路径还是 stream API）
    expect(
      body,
      "pushVideoNotification 仍用 /api/videos/<id>/stream 路径（应改 #/video/<id> hash 路由）",
    ).not.toMatch(/\/api\/videos\/.*\/stream/);
  });
});
