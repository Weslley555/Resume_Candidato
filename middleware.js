import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Só inicializa o Redis se as variáveis de ambiente existirem
const redisUrl = process.env.KV_REST_API_URL;
const redisToken = process.env.KV_REST_API_TOKEN;

let ratelimit = null;

if (redisUrl && redisToken) {
  const redis = new Redis({ url: redisUrl, token: redisToken });
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(2, "60 s"),
    analytics: false,
  });
} else {
  console.warn("KV_REST_API_URL e KV_REST_API_TOKEN não configurados — rate limiting desabilitado.");
}

export default async function middleware(request) {
  // Se o rate limiting não está configurado, deixa passar direto
  if (!ratelimit) {
    return undefined;
  }

  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "127.0.0.1";

    const { success, limit, remaining, reset } = await ratelimit.limit(ip);

    if (!success) {
      return new Response(
        JSON.stringify({
          error: "Too Many Requests",
          message: "Você atingiu o limite de requisições. Tente novamente em instantes.",
          retryAfter: Math.ceil((reset - Date.now()) / 1000),
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": String(limit),
            "X-RateLimit-Remaining": String(remaining),
            "X-RateLimit-Reset": String(reset),
            "Retry-After": String(Math.ceil((reset - Date.now()) / 1000)),
          },
        }
      );
    }

    return undefined; // continua normalmente
  } catch (error) {
    console.error("Erro no rate limiting, deixando requisição passar:", error.message);
    return undefined; // fallback: se o Redis falhar, deixa passar
  }
}

export const config = {
  matcher: "/api/:path*",
};
