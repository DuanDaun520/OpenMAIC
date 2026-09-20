import { resolveAuthAwareOwnerId } from './auth-owner';

/**
 * Resolve the request's owner identity and run a handler with its response
 * headers.
 *
 * Authenticated requests run under `user:<id>` (no anonymous cookie is
 * minted for them); everyone else keeps the anonymous cookie identity. The
 * Set-Cookie minted by the anonymous path must ride every response,
 * including 4xx and 5xx: a client that retries after an error keeps the same
 * owner partition, while a 500 that dropped the cookie would silently make
 * the retry a different anonymous owner.
 */
export async function withRequestOwnerId(
  req: Pick<Request, 'headers'>,
  handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
): Promise<Response> {
  const responseHeaders = new Headers();
  const { ownerId } = await resolveAuthAwareOwnerId(req, responseHeaders);
  try {
    return await handler(ownerId, responseHeaders);
  } catch (error) {
    console.error('[agent-runtime] request failed under an anonymous owner', error);
    return new Response('Internal Server Error', { status: 500, headers: responseHeaders });
  }
}
