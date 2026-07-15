import { useSyncExternalStore } from 'react';

export interface ViewportSnapshot {
  width: number;
  height: number;
  isPortrait: boolean;
  isCompactLandscape: boolean;
}

const listeners = new Set<() => void>();
let listening = false;

function readViewport(): ViewportSnapshot {
  if (typeof window === 'undefined') {
    return {
      width: 1440,
      height: 900,
      isPortrait: false,
      isCompactLandscape: false,
    };
  }

  const viewport = window.visualViewport;
  const width = Math.round(viewport?.width ?? window.innerWidth);
  const height = Math.round(viewport?.height ?? window.innerHeight);
  return {
    width,
    height,
    isPortrait: height > width,
    isCompactLandscape: width > height && height <= 500,
  };
}

let snapshot = readViewport();

function updateViewport(): void {
  const next = readViewport();
  if (
    next.width === snapshot.width &&
    next.height === snapshot.height &&
    next.isPortrait === snapshot.isPortrait &&
    next.isCompactLandscape === snapshot.isCompactLandscape
  ) {
    return;
  }

  snapshot = next;
  document.documentElement.style.setProperty('--app-width', `${next.width}px`);
  document.documentElement.style.setProperty(
    '--app-height',
    `${next.height}px`,
  );
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('resize', updateViewport, { passive: true });
    window.addEventListener('orientationchange', updateViewport, {
      passive: true,
    });
    window.visualViewport?.addEventListener('resize', updateViewport, {
      passive: true,
    });
    updateViewport();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && listening) {
      listening = false;
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
      window.visualViewport?.removeEventListener('resize', updateViewport);
    }
  };
}

export function useViewport(): ViewportSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}
