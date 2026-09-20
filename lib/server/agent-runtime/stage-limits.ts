/**
 * Shared limits for the stage HTTP routes.
 */

/**
 * Course-name cap; the publish dialog enforces the same 120-char rule
 * client-side (reference semantics).
 */
export const STAGE_NAME_MAX_LENGTH = 120;

/**
 * Course-description cap. The my-courses edit dialog generates the intro with
 * AI under the same 200-character product requirement.
 */
export const STAGE_DESCRIPTION_MAX_LENGTH = 200;
