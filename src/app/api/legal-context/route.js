const QUERY = 'Consumer Rights Act 2015 section 9 repair replacement refund technical failure';

export async function GET() {
  const baseUrl = process.env.LEGIPRO_API_URL;
  const token = process.env.LEGIPRO_API_TOKEN;
  if (!baseUrl || !token) {
    return Response.json({ message: 'LegiPro API credentials have not been configured for this environment.' }, { status: 503 });
  }

  try {
    const url = new URL('/v0/search/routed', baseUrl);
    url.searchParams.set('q', QUERY);
    url.searchParams.set('limit', '3');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) return Response.json({ message: 'LegiPro API did not return usable legal research.' }, { status: 502 });
    const payload = await response.json();
    return Response.json({ results: payload.results || [], disclaimer: 'Sources may be incomplete or not applicable. A qualified reviewer must assess the facts and applicable law before any decision.' });
  } catch {
    return Response.json({ message: 'LegiPro API is unavailable. No legal research was used.' }, { status: 502 });
  }
}
