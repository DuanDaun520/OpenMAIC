/**
 * Login-modal state — session-scoped, never persisted.
 *
 * Every surface that used to navigate to /login opens the modal instead
 * (header button, home generate gate, my-courses/profile gates); `next` is
 * the sanitized same-origin destination applied after a successful login.
 */
import { create } from 'zustand';

interface AuthModalState {
  open: boolean;
  /** Post-login destination (already sanitized by the opener), if any. */
  next: string | null;
  openLogin: (next?: string) => void;
  close: () => void;
}

export const useAuthModalStore = create<AuthModalState>()((set) => ({
  open: false,
  next: null,
  openLogin: (next) => set({ open: true, next: next ?? null }),
  close: () => set({ open: false, next: null }),
}));
