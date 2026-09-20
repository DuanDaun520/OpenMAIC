'use client';

import { useId, useMemo, useRef, useEffect } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import { visibleClientRect } from '@/lib/edit/visible-client-rect';
import type { ClientBox } from '@/lib/edit/visible-client-rect';

interface InteractiveRendererProps {
  readonly content: InteractiveContent;
  readonly sceneId: string;
}

function sameBox(a: ClientBox | null, b: ClientBox | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

// Frames the rect must hold steady before the rAF loop parks itself, mirroring
// use-tracked-rect. The stage layers deliberately carry no ancestor transforms
// (see stage.tsx), so a ResizeObserver on the slot plus window scroll (capture —
// scroll does not bubble past the stage's overflow containers) and resize are
// the only things that can move this slot's screen rect; those re-arm the loop.
const STABLE_FRAMES_BEFORE_IDLE = 20;

/**
 * Placeholder for an interactive scene. The actual iframe lives in the stable
 * `InteractiveIframeHost` (keyed by sceneId) so it survives remounts (#619);
 * this component only (1) registers the scene's content in the keep-alive pool,
 * (2) marks it active/visible while mounted, and (3) reports its on-screen rect
 * so the host can position the iframe over this slot. On unmount it hides the
 * iframe but never evicts it — that preserves the document for a zero-reload
 * return on the next mount.
 */
export function InteractiveRenderer({ content, sceneId }: InteractiveRendererProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  // Unique per mounted placeholder instance — its visibility ownership token, so
  // a stale unmount during the mode cross-fade can't hide a newer instance.
  const owner = useId();
  const mount = useInteractiveIframePool((s) => s.mount);
  const setRect = useInteractiveIframePool((s) => s.setRect);
  const claim = useInteractiveIframePool((s) => s.claim);
  const release = useInteractiveIframePool((s) => s.release);
  const setActive = useInteractiveIframePool((s) => s.setActive);

  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  // Register / activate / claim visibility while mounted; release (keep-alive) on
  // unmount. A content change re-runs this and rebuilds the iframe — the only
  // intended reload path.
  useEffect(() => {
    mount(sceneId, {
      srcDoc: patchedHtml,
      src: patchedHtml ? undefined : content.url,
    });
    setActive(sceneId);
    claim(sceneId, owner);
    return () => release(sceneId, owner);
  }, [sceneId, owner, patchedHtml, content.url, mount, setActive, claim, release]);

  // Track this slot's screen rect for the host. A plain rAF loop never parks,
  // and every frame here runs getBoundingClientRect PLUS visibleClientRect —
  // which walks every ancestor's computed style — for every mounted
  // placeholder. So the loop parks itself once the rect+clip hold steady
  // (same pattern as useTrackedRect) and re-arms on the events that can
  // actually move the slot: its own resize, scroll, and window resize.
  useEffect(() => {
    let raf = 0;
    let stableFrames = 0;
    let last: { r: ClientBox; clip: ClientBox } | null = null;
    const measure = () => {
      const node = slotRef.current;
      if (node) {
        const domRect = node.getBoundingClientRect();
        const r: ClientBox = {
          left: domRect.left,
          top: domRect.top,
          width: domRect.width,
          height: domRect.height,
        };
        const clip = visibleClientRect(node);
        if (last && sameBox(last.r, r) && sameBox(last.clip, clip)) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
          last = { r, clip };
          // The pool's own setRect equality-guards, so an unchanged call is a
          // no-op there; we publish only on real movement.
          setRect(sceneId, r, clip);
        }
        if (stableFrames >= STABLE_FRAMES_BEFORE_IDLE) {
          raf = 0;
          return;
        }
      }
      raf = requestAnimationFrame(measure);
    };
    const arm = () => {
      stableFrames = 0;
      if (!raf) raf = requestAnimationFrame(measure);
    };
    arm();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(arm) : null;
    if (ro && slotRef.current) ro.observe(slotRef.current);
    window.addEventListener('scroll', arm, true);
    window.addEventListener('resize', arm);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('scroll', arm, true);
      window.removeEventListener('resize', arm);
    };
  }, [sceneId, setRect]);

  return <div ref={slotRef} className="w-full h-full" aria-hidden />;
}
