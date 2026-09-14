import { calcularChaveCache, MODELOS } from './resumos.js';

// Limites conservadores por implantação/Redis compartilhado, não uma garantia de
// gratuidade. Tentativas (inclusive falhas) consomem quota, sem reembolso.
// Janelas fixas começam na primeira admissão; não são janelas deslizantes.
export const LIMITES_RESUMO = Object.freeze({ dia: 20, minuto: 2, lockSegundos: 60,
    redisTimeoutMs: 1000, geminiTimeoutMs: 20000 });

export const LUA_RESERVAR_RESUMO = `
local lock = redis.call('TTL', KEYS[3])
if lock ~= -2 then return {1, math.max(1, lock)} end
local dia = tonumber(redis.call('GET', KEYS[1]) or '0')
local minuto = tonumber(redis.call('GET', KEYS[2]) or '0')
if dia >= tonumber(ARGV[1]) then
    return {2, math.max(1, redis.call('TTL', KEYS[1]))}
end
if minuto >= tonumber(ARGV[2]) then
    return {3, math.max(1, redis.call('TTL', KEYS[2]))}
end
redis.call('SET', KEYS[3], '1', 'EX', ARGV[3])
if redis.call('INCR', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], 86400) end
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], 60) end
return {0, 0}
`;

const mensagens = Object.freeze({
    desabilitada: 'Geração pública desabilitada. Consulte os resumos já disponíveis.',
    configuracao: 'Geração indisponível por configuração do serviço.',
    redis: 'Controle de geração indisponível. Tente novamente mais tarde.',
    lock: 'Já existe uma tentativa recente para esta candidatura e seleção. Aguarde.',
    dia: 'Limite global diário de geração atingido. Tente novamente mais tarde.',
    minuto: 'Limite global por minuto de geração atingido. Aguarde.',
    integracao: 'Geração indisponível: proteção de recursos não inicializada.',
});
export class ErroLimiteResumo extends Error {
    constructor(codigo, status = 503, retryAfter = 60) {
        super(mensagens[codigo]);
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

export function opcoesRedis(env = process.env) {
    if (!env.KV_REST_API_URL?.trim() || !env.KV_REST_API_TOKEN?.trim()) return null;
    return { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN,
        retry: { retries: 0 }, signal: () => AbortSignal.timeout(LIMITES_RESUMO.redisTimeoutMs),
        enableAutoPipelining: false };
}

export function criarGuardaResumo({ redis, env = process.env } = {}) {
    return async ctx => {
        // Opt-in também fora de produção: ambientes de preview não liberam gasto.
        if (env.GERACAO_PUBLICA_HABILITADA !== 'true') throw new ErroLimiteResumo('desabilitada');
        if (!env.GEMINI_API_KEY?.trim()) throw new ErroLimiteResumo('configuracao');
        if (!redis || typeof redis.eval !== 'function') throw new ErroLimiteResumo('redis');
        let resultado;
        try {
            resultado = await redis.eval(LUA_RESERVAR_RESUMO, [
                'resumos:limites:v1:{geracao}:dia',
                'resumos:limites:v1:{geracao}:minuto',
                `resumos:limites:v1:{geracao}:lock:${calcularChaveCache(ctx, MODELOS[0])}`,
            ], [LIMITES_RESUMO.dia, LIMITES_RESUMO.minuto, LIMITES_RESUMO.lockSegundos]);
        } catch {
            // Inclui timeout com resultado remoto incerto: nunca repetir/admitir.
            throw new ErroLimiteResumo('redis');
        }
        if (!Array.isArray(resultado) || resultado.length !== 2
            || !Number.isInteger(resultado[0]) || !Number.isInteger(resultado[1])
            || resultado[0] < 0 || resultado[0] > 3
            || (resultado[0] === 0 ? resultado[1] !== 0 : resultado[1] < 1 || resultado[1] > 86400)) {
            throw new ErroLimiteResumo('redis');
        }
        if (resultado[0]) throw new ErroLimiteResumo(['', 'lock', 'dia', 'minuto'][resultado[0]], 429, resultado[1]);
        // Não remover o lock: cooldown protege cache com gravação falha e não
        // permite que uma execução antiga remova o lock de uma nova execução.
    };
}
