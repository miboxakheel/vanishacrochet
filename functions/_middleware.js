// Social-share crawler fix (handoff §5 / Implementation Spec Task 5).
//
// WhatsApp/Facebook/etc. generate link previews with a bot that fetches raw
// HTML and NEVER runs JavaScript — so the JS that fills og:image/title from
// Supabase at page load never runs for them, and they'd only ever see the
// static <head> tags baked into index.html. This middleware detects those
// bots and serves THEM a tiny HTML document whose og/twitter tags are read
// live from Supabase settings at request time. Everyone else (real visitors,
// static assets, /api/* functions) falls straight through to the normal SPA,
// untouched.
//
// SAFETY: this runs on EVERY request to the project, so it fails open — any
// unexpected error, or a non-crawler / non-page / non-GET request, returns
// next() and serves the normal site. It can only ever ADD a response for a
// matched crawler page request; it can never break a real visitor.
import { sbSelect } from './_lib/supabase.js';

// Known social-preview / crawler user-agents that don't execute JS. Matched
// case-insensitively as substrings.
const BOT_UA = /facebookexternalhit|facebookcatalog|WhatsApp|Twitterbot|Slackbot|LinkedInBot|Pinterest|redditbot|Discordbot|TelegramBot|Googlebot|bingbot|Applebot|SkypeUriPreview|vkShare|Embedly|Iframely|Google-InspectionTool/i;

// Current default share image (before Vanisha uploads one via Admin → Settings
// → "Social Share Image"). Mirrors the static tag in index.html <head>; a
// value in settings.pageImages.ogImage overrides it. UPDATE HERE if you change
// the brand default. 1200×630 recommended for link previews.
const DEFAULT_OG_IMAGE = 'https://res.cloudinary.com/drdxejyid/image/upload/v1783192009/vanisha/products/blob_midxsc.jpg';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// A "page" request is a document navigation — not an /api call and not a
// static asset with a file extension (.js/.css/.png/…). Those must never be
// intercepted.
function isPageRequest(url) {
  const p = url.pathname;
  if (p.indexOf('/api/') === 0) return false;
  const last = p.split('/').pop();
  if (last && last.indexOf('.') !== -1) return false;
  return true;
}

export async function onRequest(context) {
  const { request, env, next } = context;

  let url;
  try {
    url = new URL(request.url);
    const ua = request.headers.get('User-Agent') || '';
    // Fast path: anything that isn't a crawler GET for a page route is the
    // normal site — hand it straight on.
    if (request.method !== 'GET' || !isPageRequest(url) || !BOT_UA.test(ua)) {
      return next();
    }
  } catch (e) {
    return next();
  }

  try {
    // Live share settings from Supabase — the same row the SPA reads at runtime.
    let s = {};
    try {
      const rows = await sbSelect(env, 'settings', 'id=eq.1&select=data');
      s = (rows[0] && rows[0].data) || {};
    } catch (e) {
      // Supabase unreachable — still return a valid preview with defaults
      // rather than failing the crawl (and better than the SPA's blank-to-bots).
      console.warn('[og-middleware] settings fetch failed:', e && e.message);
    }

    const storeName = s.storeName || 'Vanisha Crochet';
    const tagline   = s.tagline   || 'Handcrafted Goodies';
    const title     = storeName + ' — ' + tagline;

    const city    = (s.businessCity && s.businessCity.trim()) || '';
    const country = (s.businessCountry && s.businessCountry.trim()) || '';
    const where   = (city && country) ? (city + ', ' + country) : (country || '');
    const description = where
      ? 'Handcrafted crochet clothing, gifts and patterns, lovingly made in ' + where + '.'
      : 'Handcrafted crochet clothing, gifts and patterns, lovingly made with care.';

    // The one image: admin-set share image, else a page image, else the logo,
    // else the brand default. Mirrors index.html's own resolution order.
    const image = (s.pageImages && (s.pageImages.ogImage || s.pageImages.home)) || s.logoImage || DEFAULT_OG_IMAGE;
    const pageUrl = url.origin + '/';

    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<title>' + esc(title) + '</title>' +
      '<meta name="description" content="' + esc(description) + '">' +
      '<meta property="og:type" content="website">' +
      '<meta property="og:site_name" content="' + esc(storeName) + '">' +
      '<meta property="og:title" content="' + esc(title) + '">' +
      '<meta property="og:description" content="' + esc(description) + '">' +
      '<meta property="og:url" content="' + esc(pageUrl) + '">' +
      '<meta property="og:image" content="' + esc(image) + '">' +
      '<meta property="og:image:secure_url" content="' + esc(image) + '">' +
      '<meta property="og:image:width" content="1200">' +
      '<meta property="og:image:height" content="630">' +
      '<meta name="twitter:card" content="summary_large_image">' +
      '<meta name="twitter:title" content="' + esc(title) + '">' +
      '<meta name="twitter:description" content="' + esc(description) + '">' +
      '<meta name="twitter:image" content="' + esc(image) + '">' +
      '</head><body>' +
      '<h1>' + esc(title) + '</h1>' +
      '<p>' + esc(description) + '</p>' +
      '<p><a href="' + esc(pageUrl) + '">' + esc(pageUrl) + '</a></p>' +
      '</body></html>';

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // MUST NOT be shared-cached: this response depends on the User-Agent,
        // but the edge cache keys by URL only — a cached crawler page for "/"
        // could otherwise be served to a real visitor (or vice versa), showing
        // everyone the og-only stub instead of the SPA. Crawler hits are rare,
        // so reading Supabase per crawl is fine.
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'all'
      }
    });
  } catch (e) {
    // Any unexpected failure in the crawler branch: fail open to the real site.
    console.warn('[og-middleware] error, serving SPA:', e && e.message);
    return next();
  }
}
