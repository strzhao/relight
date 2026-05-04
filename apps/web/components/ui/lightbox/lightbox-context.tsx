"use client";

import type { Photo } from "@relight/shared";
import { createContext, useCallback, useContext, useMemo } from "react";

export interface LightboxContextValue {
  photos: Photo[];
  currentIndex: number;
  goTo: (index: number) => void;
  goNext: () => void;
  goPrev: () => void;
  close: () => void;
  canGoNext: boolean;
  canGoPrev: boolean;
}

const LightboxContext = createContext<LightboxContextValue | null>(null);

export function useLightbox(): LightboxContextValue {
  const ctx = useContext(LightboxContext);
  if (!ctx) {
    throw new Error("useLightbox must be used within a LightboxProvider");
  }
  return ctx;
}

interface LightboxProviderProps {
  photos: Photo[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  children: React.ReactNode;
}

export function LightboxProvider({
  photos,
  currentIndex,
  onIndexChange,
  onClose,
  children,
}: LightboxProviderProps) {
  const canGoNext = currentIndex < photos.length - 1;
  const canGoPrev = currentIndex > 0;

  const goTo = useCallback(
    (index: number) => {
      if (index >= 0 && index < photos.length) {
        onIndexChange(index);
      }
    },
    [photos.length, onIndexChange],
  );

  const goNext = useCallback(() => {
    if (canGoNext) {
      onIndexChange(currentIndex + 1);
    }
  }, [canGoNext, currentIndex, onIndexChange]);

  const goPrev = useCallback(() => {
    if (canGoPrev) {
      onIndexChange(currentIndex - 1);
    }
  }, [canGoPrev, currentIndex, onIndexChange]);

  const value = useMemo<LightboxContextValue>(
    () => ({
      photos,
      currentIndex,
      goTo,
      goNext,
      goPrev,
      close: onClose,
      canGoNext,
      canGoPrev,
    }),
    [photos, currentIndex, goTo, goNext, goPrev, onClose, canGoNext, canGoPrev],
  );

  return <LightboxContext.Provider value={value}>{children}</LightboxContext.Provider>;
}
