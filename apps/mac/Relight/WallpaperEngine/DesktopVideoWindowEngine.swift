import AppKit
import AVFoundation
import OSLog

/// 桌面层视频窗口：贴在 Dock 壁纸背景之上、桌面图标之下，AVPlayerLayer 无缝循环当日视频。
/// 这是桌面动效的实际承载——Tahoe 原生 aerial 管线不加载用户注册资产（2026-11-11 实测：
/// Index 选择保留、catalog file:// 锚定，但扩展零下载动作、壁纸层只渲染 Apple 海报静帧）；
/// AerialMotion / Wallspace 同构方案，桌面动效一律走自有窗口播放器。
/// AerialVideoEngine 的原生注册保留，服务锁屏/屏保（Idle）管道。
final class DesktopVideoWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    let playerLayer = AVPlayerLayer()

    init(screen: NSScreen) {
        super.init(
            contentRect: screen.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        level = NSWindow.Level(Int(CGWindowLevelForKey(.desktopIconWindow)) - 1)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        ignoresMouseEvents = true
        isOpaque = true
        hasShadow = false
        // 纸色底：竖版/方图日在 16:9 桌面上走 contain 留白（与画廊 20261110 方图决策同构，
        // 不裁脸），横版日视频恰满屏
        backgroundColor = NSColor(srgbRed: 0.972, green: 0.961, blue: 0.929, alpha: 1.0)
        let content = DesktopVideoContentView(frame: NSRect(origin: .zero, size: screen.frame.size))
        content.playerLayer = playerLayer
        contentView = content
        setFrame(screen.frame, display: true)
    }
}

/// 窗口内容视图：持有 playerLayer 并挂进图层树（⚠️ 必须 addSublayer——只赋值不挂载
/// 会渲染纯黑，2026-11-11 黑屏判例），layout 时同步尺寸（避免 resize 撕裂/残影）
final class DesktopVideoContentView: NSView {
    var playerLayer: AVPlayerLayer? {
        didSet {
            oldValue?.removeFromSuperlayer()
            if let playerLayer {
                playerLayer.videoGravity = .resizeAspect
                playerLayer.frame = bounds
                layer?.addSublayer(playerLayer)
            }
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        autoresizingMask = [.width, .height]
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        guard let playerLayer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        playerLayer.frame = bounds
        CATransaction.commit()
    }
}

/// 桌面视频播放引擎（@MainActor；窗口与 AVPlayer 生命周期管理）
///
/// ⚠️ 不做桌面遮挡暂停（Wallspace 有此优化）：桌面机 GPU 占用可忽略，且全屏窗口
/// 日常存在——遮挡暂停会让壁纸「看似不动」制造伪故障（2026-11-11 验证教训）。
/// 保留锁屏/显示器休眠暂停（完全不可见时段省 GPU）。
@MainActor
final class DesktopVideoWindowEngine {
    static let shared = DesktopVideoWindowEngine()

    private let logger = Logger(subsystem: "app.relight.mac", category: "wallpaper.desktop-player")
    private var windows: [DesktopVideoWindow] = []
    private var player: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private var currentURL: URL?
    private var isDisplayAsleep = false
    private var isScreenLocked = false
    private var monitorsInstalled = false

    private init() {}

    /// 播放/切换当日视频（幂等：同 URL 已在播则只确保窗口在位）
    func play(url: URL) {
        guard FileManager.default.fileExists(atPath: url.path) else {
            logger.warning("桌面视频文件不存在，跳过播放: \(url.path)")
            return
        }
        installMonitorsOnce()

        if player != nil, currentURL == url {
            restoreWindowsIfNeeded()
            player?.play()
            return
        }

        let asset = AVURLAsset(url: url)
        let item = AVPlayerItem(asset: asset)
        let queuePlayer = AVQueuePlayer(playerItem: item)
        looper = AVPlayerLooper(player: queuePlayer, templateItem: item)
        queuePlayer.isMuted = true
        queuePlayer.preventsDisplaySleepDuringVideoPlayback = false
        player = queuePlayer
        currentURL = url

        rebuildWindows()
        evaluatePlaybackState()
        logger.info("桌面视频窗口已启动: \(url.lastPathComponent), \(self.windows.count) 屏")
    }

    /// Coordinator 自愈入口：窗口被意外关闭/播放中断时重建（幂等）
    func ensurePlaying(url: URL) {
        guard player != nil, currentURL == url else {
            play(url: url)
            return
        }
        restoreWindowsIfNeeded()
        evaluatePlaybackState()
    }

    func stop() {
        player?.pause()
        player?.removeAllItems()
        player = nil
        looper = nil
        currentURL = nil
        closeWindows()
    }

    // MARK: - 窗口管理

    private func rebuildWindows() {
        closeWindows()
        guard let queuePlayer = player else { return }
        for screen in NSScreen.screens {
            let win = DesktopVideoWindow(screen: screen)
            win.playerLayer.player = queuePlayer
            win.orderFrontRegardless()
            windows.append(win)
        }
    }

    private func restoreWindowsIfNeeded() {
        // 窗口可能被用户/系统关闭（orderOut / close），按需重建
        let alive = windows.filter { $0.isVisible }
        if alive.count != NSScreen.screens.count || player == nil {
            rebuildWindows()
        } else {
            for win in windows {
                win.orderFrontRegardless()
            }
        }
    }

    private func closeWindows() {
        for win in windows {
            win.playerLayer.player = nil
            win.orderOut(nil)
        }
        windows.removeAll()
    }

    // MARK: - 播放状态

    /// 锁屏 / 显示器休眠时暂停（完全不可见时段）；其余状态常播
    private func evaluatePlaybackState() {
        guard let queuePlayer = player else { return }
        if isDisplayAsleep || isScreenLocked {
            queuePlayer.pause()
        } else {
            queuePlayer.play()
        }
    }

    // MARK: - 环境监视（安装一次）

    private func installMonitorsOnce() {
        guard !monitorsInstalled else { return }
        monitorsInstalled = true

        let wsCenter = NSWorkspace.shared.notificationCenter
        wsCenter.addObserver(
            forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.isDisplayAsleep = true; self?.evaluatePlaybackState() }
        }
        wsCenter.addObserver(
            forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.isDisplayAsleep = false; self?.evaluatePlaybackState() }
        }
        wsCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.isDisplayAsleep = false; self?.evaluatePlaybackState() }
        }
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.isScreenLocked = true; self?.evaluatePlaybackState() }
        }
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.isScreenLocked = false; self?.evaluatePlaybackState() }
        }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.restoreWindowsIfNeeded() }
        }
    }
}
