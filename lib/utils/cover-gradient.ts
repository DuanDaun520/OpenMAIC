/**
 * Default-cover gradients, picked deterministically per course id so a shelf
 * of cards looks varied without per-course art. Shared by every course shelf
 * (home recommended, my-courses, explore) so the fallback looks the same
 * wherever a course appears.
 */
export const COVER_GRADIENTS = [
  'from-violet-500 to-indigo-500',
  'from-sky-500 to-cyan-400',
  'from-fuchsia-500 to-pink-500',
  'from-amber-500 to-orange-500',
  'from-emerald-500 to-teal-500',
  'from-blue-500 to-violet-500',
  'from-rose-500 to-red-500',
  'from-purple-500 to-blue-500',
] as const;

/** Stable per-id gradient: same course, same color, on every shelf. */
export function coverGradient(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COVER_GRADIENTS[hash % COVER_GRADIENTS.length];
}
