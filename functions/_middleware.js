// Pages Functions 中间件
// 将 /api/* 请求代理到 Workers

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // 如果是 API 请求，转发到 Workers
  if (url.pathname.startsWith('/api/')) {
    // 这里需要配置你的 Workers URL
    const WORKER_URL = env.WORKER_URL || 'https://cloudflare-rag.你的子域名.workers.dev';
    
    const workerUrl = new URL(url.pathname + url.search, WORKER_URL);
    
    return fetch(workerUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  }
  
  // 其他请求正常处理
  return context.next();
}
