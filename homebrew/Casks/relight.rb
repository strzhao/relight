cask "relight" do
  version "0.3.0"
  sha256 "c1ed344bef780b016d8592545077fd0881033fe77ad7ab76ef0e9d511c347d84"

  url "https://github.com/strzhao/relight/releases/download/v#{version}/Relight-v#{version}.zip"
  name "Relight"
  desc "拾光 — AI 驱动的照片精选桌面伴侣"
  homepage "https://github.com/strzhao/relight"

  depends_on macos: ">= :ventura"
  depends_on arch: :arm64

  app "Relight.app"

  zap trash: [
    "~/Library/Preferences/app.relight.mac.plist",
    "~/Library/Caches/app.relight.mac",
    "~/Library/Application Support/app.relight.mac",
    "~/Library/Saved Application State/app.relight.mac.savedState",
  ]
end
