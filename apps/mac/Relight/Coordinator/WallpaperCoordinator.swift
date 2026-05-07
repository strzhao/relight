import Foundation
import AppKit
import OSLog

actor WallpaperCoordinator {
  private let client: RelightClient
  private let imageEngine: any WallpaperEngine
  private let videoEngine: any WallpaperEngine
  // settings 是 @MainActor 的 AppSettings；coordinator 是 actor，访问 settings 需通过 MainActor.run
  nonisolated private let settings: AppSettings
  private let logger: Logger

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
        return
      }
      let sourceURL = try await client.downloadOriginal(photo)
      let engine: any WallpaperEngine = photo.isVideo ? videoEngine : imageEngine
      let url = try await engine.apply(photo: photo, sourceURL: sourceURL, on: NSScreen.screens)
      await MainActor.run { [pick] in settings.lastAppliedPickDate = pick.pickDate }
      logger.info("壁纸已更新: \(pick.pickDate) \(photo.isVideo ? "video" : "image") → \(url.path)")
    } catch RelightError.noPickAvailable {
      logger.warning("当天精选未生成")
    } catch {
      logger.error("刷新壁纸失败: \(String(describing: error))")
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

  /// 后台 Timer（每小时检查；07:00 后未应用今天则触发）
  func startScheduler() async {
    while !Task.isCancelled {
      try? await Task.sleep(for: .seconds(3600))
      let today = BeijingTime.todayString()
      let comp = BeijingTime.nowComponents()
      let last = await MainActor.run { settings.lastAppliedPickDate }
      if (comp.hour ?? 0) >= 7 && last != today {
        logger.info("scheduler tick: triggering refreshNow")
        await refreshNow()
      }
    }
  }
}
