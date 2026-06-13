import Foundation
import AppKit
import OSLog
import UserNotifications

actor WallpaperCoordinator {
  private let client: RelightClient
  private let imageEngine: any WallpaperEngine
  private let videoEngine: any WallpaperEngine
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
       logger: Logger = Logger(subsystem: "app.relight.mac", category: "coordinator")) {
    self.client = client
    self.imageEngine = imageEngine
    self.videoEngine = videoEngine
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

  /// 后台 Timer（每小时检查；01:00 后未应用今天则触发）
  func startScheduler() async {
    while !Task.isCancelled {
      try? await Task.sleep(for: .seconds(3600))
      let today = BeijingTime.todayString()
      let comp = BeijingTime.nowComponents()
      let last = await MainActor.run { settings.lastAppliedPickDate }
      if (comp.hour ?? 0) >= 1 && last != today {
        logger.info("scheduler tick: triggering refreshNow")
        await refreshNow()
      }
    }
  }
}
