import type { NextConfig } from 'next';
import path from 'node:path';
const config: NextConfig = { output:process.env.NEXT_STANDALONE==='1'?'standalone':undefined, outputFileTracingRoot:path.resolve(process.cwd(),'..'), poweredByHeader:false, devIndicators:false, experimental:{proxyTimeout:1200000,proxyClientMaxBodySize:2050 * 1024 * 1024},
  async headers() { return [{source:'/:path*',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'X-Frame-Options',value:'DENY'},{key:'Referrer-Policy',value:'no-referrer'}]}]; },
  async rewrites() { return [{source:'/api/:path*',destination:`${process.env.BACKEND_URL || 'http://127.0.0.1:4100'}/api/:path*`}]; }
}; export default config;
