import Foundation
import OSLog
import ServiceManagement

final class AutostartManager {
  private let logger: Logger

  init(logger: Logger = Logger(subsystem: "app.relight.mac", category: "autostart")) {
    self.logger = logger
  }

  /// enabled=true → SMAppService.mainApp.register()；false → unregister()
  /// 失败仅 OSLog warning，不抛
  func sync(enabled: Bool) {
    do {
      if enabled {
        try SMAppService.mainApp.register()
        logger.info("autostart registered")
      } else {
        try SMAppService.mainApp.unregister()
        logger.info("autostart unregistered")
      }
    } catch {
      logger.warning("autostart sync failed (enabled=\(enabled)): \(error.localizedDescription)")
    }
  }

  /// 当前状态查询（仅日志用，不返回错误）
  var status: SMAppService.Status {
    SMAppService.mainApp.status
  }
}
