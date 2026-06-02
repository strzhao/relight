cask "relight" do
  version "0.1.0"
  sha256 "f9f66841eba92be97474ed3b6091b23282596c1027400157ec69de5d335ae52b"

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
