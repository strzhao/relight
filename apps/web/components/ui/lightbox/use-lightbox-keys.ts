"use client";

import { useEffect } from "react";
import { useLightbox } from "./lightbox-context";

/**
 * 键盘快捷键：Escape 关闭 / ArrowLeft 上一张 / ArrowRight 下一张
 * 仅在 Lightbox 打开时激活，忽略 input/textarea 内的按键。
 */
export function useLightboxKeys() {
  const { goNext, goPrev, close } = useLightbox();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // 忽略输入框内的键盘事件
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          close();
          break;
        case "ArrowLeft":
          e.preventDefault();
          goPrev();
          break;
        case "ArrowRight":
          e.preventDefault();
          goNext();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [close, goNext, goPrev]);
}
