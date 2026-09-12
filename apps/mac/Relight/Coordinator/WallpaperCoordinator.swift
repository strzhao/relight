import Foundation
import AppKit
import OSLog
import UserNotifications

actor WallpaperCoordinator {
  private let client: RelightClient
  private let imageEngine: any WallpaperEngine
  private let videoEngine: any WallpaperEngine
  /// Aerial 注入引擎（nil = 未注入，直接走静态链路；self-test 可注入故障 stub）
  private let aerialEngine: (any AerialVideoApplying)?
  // settings 是 @MainActor 的 AppSettings；coordinator 是 actor，访问 settings 需通过 MainActor.run
  nonisolated private let settings: AppSettings
  private let logger: Logger

  private let imageOptions: [NSWorkspace.DesktopImageOptionKey: Any] = [
    .imageScaling: NSImageScaling.scaleProportionallyUpOrDown.rawValue,
    .allowClipping: false,
    .fillColor: NSColor(srgbRed: 0.972, green: 0.961, blue: 0.929, alpha: 1.0),
  ]

  init(client: RelightClient, imageEngine: any WallpaperEngine,
       videoEngine: any WallpaperEngine, settings: AppSettings,
       aerialEngine: (any AerialVideoApplying)? = nil,
       logger: Logger = Logger(subsystem: "app.relight.mac", category: "coordinator")) {
    self.client = client
    self.imageEngine = imageEngine
    self.videoEngine = videoEngine
    self.aerialEngine = aerialEngine
    self.settings = settings
    self.logger = logger
  }

  /// 用户手动触发或定时触发（强制刷新，忽略 lastAppliedPickDate）
  func refreshNow() async {
    do {
      let pick = try await client.fetchTodayPick()
      guard let photo = pick.photo else {
        logger.warning("today pick has no photo")
        await sendNotification(title: "壁纸未更新", body: "今日精选暂无数据，请等待每日精选任务完成后重试")
        return
      }

      // 分支 0（动态视频壁纸）：wallpaperVideoUrl 有值 → 下载 → Aerial 注入。
      // 任何失败（无 assetID / 写失败 / 下载失败）→ 记录 aerial-fallback 标记 + fall through
      // 现有静态链路（行为与现状逐字一致，不崩溃、不阻塞）。
      if let videoURLString = pick.wallpaperVideoUrl, !videoURLString.isEmpty,
         let aerialEngine {
        do {
          let cachedURL = try await client.downloadWallpaperVideo(
            pickDate: pick.pickDate, downloadURL: videoURLString
          )
          _ = try await aerialEngine.apply(photo: photo, sourceURL: cachedURL, on: NSScreen.screens)
          await MainActor.run { [pick] in settings.lastAppliedPickDate = pick.pickDate }
          logger.info("壁纸已更新（Aerial 注入）: \(pick.pickDate) → \(cachedURL.path)")
          await sendNotification(title: "壁纸已更新", body: "今日精选视频 — \(pick.pickDate)")
          return
        } catch {
          // 固定标记 aerial-fallback（验收断言 s6p1/s6p2）
          logger.warning("aerial-fallback: Aerial 注入失败（\(String(describing: error))），回退静态壁纸链路")
          print("aerial-fallback: Aerial 注入失败（\(error)），回退静态壁纸链路")
          await MainActor.run { [error] in settings.lastFallbackReason = "aerial-fallback: \(error)" }
          // fall through 分支 1（静态合成图）
        }
      }

      // 图片 + 已有合成图 URL → 分屏下载合成图
      if !photo.isVideo, pick.composedImageUrl != nil {
        // 用户手动触发或定时刷新：清除本地壁纸缓存，强制从服务端重新下载
        WallpaperCache.shared.clearComposedCache(for: pick.pickDate)
        var failedScreens = 0
        for screen in NSScreen.screens {
          let scale = screen.backingScaleFactor
          let w = Int(screen.frame.width * scale)
          let h = Int(screen.frame.height * scale)
          do {
            let composedURL = try await client.downloadComposedWallpaper(
              pickDate: pick.pickDate, width: w, height: h
            )
            try NSWorkspace.shared.setDesktopImageURL(composedURL, for: screen, options: imageOptions)
            logger.info("屏幕 \(screen.localizedName) 壁纸已设置为合成图: \(composedURL.path)")
          } catch {
            logger.warning("screen \(screen.localizedName) 合成图失败: \(String(describing: error))，回退原图")
            do {
              let originalURL = try await client.downloadOriginal(photo)
              try NSWorkspace.shared.setDesktopImageURL(originalURL, for: screen, options: imageOptions)
            } catch {
              logger.error("screen \(screen.localizedName) 原图也失败: \(String(describing: error))")
              failedScreens += 1
            }
          }
        }
        await MainActor.run { [pick] in settings.lastAppliedPickDate = pick.pickDate }
        logger.info("壁纸已更新（合成图路径）: \(pick.pickDate)")
        if failedScreens > 0 {
          await sendNotification(title: "壁纸部分更新", body: "\(failedScreens) 个屏幕设置失败，已为其余屏幕更新壁纸")
        } else {
          await sendNotification(title: "壁纸已更新", body: "今日精选 — \(pick.pickDate)")
        }
        return
      }

      // 视频或无合成图 → 旧路径
      let sourceURL = try await client.downloadOriginal(photo)
      let engine: any WallpaperEngine = photo.isVideo ? videoEngine : imageEngine
      let url = try await engine.apply(photo: photo, sourceURL: sourceURL, on: NSScreen.screens)
      await MainActor.run { [pick] in settings.lastAppliedPickDate = pick.pickDate }
      logger.info("壁纸已更新: \(pick.pickDate) \(photo.isVideo ? "video" : "image") → \(url.path)")
      await sendNotification(title: "壁纸已更新", body: "今日精选 — \(pick.pickDate)")
    } catch RelightError.noPickAvailable {
      logger.warning("当天精选未生成")
      await sendNotification(title: "壁纸未更新", body: "当天精选尚未生成，请稍后再试")
    } catch {
      logger.error("刷新壁纸失败: \(String(describing: error))")
      await sendNotification(title: "壁纸更新失败", body: error.localizedDescription)
    }
  }

  /// 发送本地用户通知（所有结果路径都通知，确保用户感知）
  private func sendNotification(title: String, body: String) async {
    let center = UNUserNotificationCenter.current()
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    let request = UNNotificationRequest(
      identifier: "wallpaper-\(Date().timeIntervalSince1970)",
      content: content,
      trigger: nil  // 立即送达
    )
    do {
      try await center.add(request)
      logger.info("通知已发送: \(title) — \(body)")
    } catch {
      logger.error("发送通知失败: \(error.localizedDescription)")
    }
  }

  /// 启动时调用：如 lastAppliedPickDate ≠ 今天，触发 refreshNow
  func bootstrapOnLaunch() async {
    let today = BeijingTime.todayString()
    let last = await MainActor.run { settings.lastAppliedPickDate }
    if last != today {
      logger.info("bootstrap: today=\(today), last=\(last ?? "nil") → refreshing")
      await refreshNow()
    } else {
      logger.info("bootstrap: today \(today) already applied, skip")
    }
  }

  /// 后台 Timer（每小时检查；01:00 后未应用今天则触发；已应用日做 Aerial slot 自愈）
  func startScheduler() async {
    while !Task.isCancelled {
      try? await Task.sleep(for: .seconds(3600))
      let today = BeijingTime.todayString()
      let comp = BeijingTime.nowComponents()
      let last = await MainActor.run { settings.lastAppliedPickDate }
      if (comp.hour ?? 0) >= 1 && last != today {
        logger.info("scheduler tick: triggering refreshNow")
        await refreshNow()
      } else if last == today {
        // 已应用日：Aerial slot 自愈（系统 WallpaperAgent 可能重新下载原片覆盖 slot）
        await repairTick()
      }
    }
  }

  /// 已应用日的 Aerial slot 自愈：缓存文件与 slot 不一致 → 重新覆写（LiveDesk wake-refresh 同构）。
  /// 失败仅 log（不崩溃、不阻塞调度——桌面保持系统当前状态）。
  private func repairTick() async {
    guard let aerialEngine else { return }
    do {
      let pick = try await client.fetchTodayPick()
      guard let videoURLString = pick.wallpaperVideoUrl, !videoURLString.isEmpty else { return }
      let cachedURL = try await client.downloadWallpaperVideo(
        pickDate: pick.pickDate, downloadURL: videoURLString
      )
      let repaired = try await aerialEngine.repairIfNeeded(cachedURL: cachedURL)
      if repaired {
        logger.info("scheduler tick: aerial slot repaired")
      }
    } catch {
      logger.warning("aerial-fallback repair: \(String(describing: error))")
    }
  }
}
