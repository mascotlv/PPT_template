import type { MetadataRoute } from 'next';
export default function sitemap(): MetadataRoute.Sitemap { const origin = process.env.PUBLIC_ORIGIN || 'http://localhost:3000'; return ['/', '/products', '/products/sage-strategy', '/products/coral-story', '/products/midnight-report'].map(p => ({ url: origin + p })); }
