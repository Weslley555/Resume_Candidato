import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';
import {
    carregarFonte, resolverChave, prepararContexto, obterResumo, falha,
} from '../lib/resumos.js';

import { criarGuardaResumo, ErroLimiteResumo, LIMITES_RESUMO, opcoesRedis } from '../lib/limitesResumo.js';

let redis;
function obterCache() {
    const opcoes = opcoesRedis();
    if (!opcoes) return null;
    try { redis ??= new Redis(opcoes); }
    catch { throw new ErroLimiteResumo('redis'); }
    return redis;
}
async function gerarBloco({ modelo, paginas, systemInstruction }) {
    if (!process.env.GEMINI_API_KEY) throw falha('GEMINI_API_KEY não configurada.', 503);
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const resposta = await ai.models.generateContent({
        model: modelo,
        contents: JSON.stringify({ paginas }),
        config: { systemInstruction, responseMimeType: 'application/json', temperature: 0.2,
            abortSignal: AbortSignal.timeout(LIMITES_RESUMO.geminiTimeoutMs),
            maxOutputTokens: 8192, httpOptions: { timeout: LIMITES_RESUMO.geminiTimeoutMs,
                retryOptions: { attempts: 1 } } },
    });
    if (resposta.promptFeedback?.blockReason || resposta.candidates?.[0]?.finishReason !== 'STOP'
        || typeof resposta.text !== 'string') throw falha('Resposta do modelo bloqueada ou incompleta.', 502);
    return resposta.text;
}

// Dependências injetáveis permitem testar o contrato HTTP sem Gemini, Redis ou rede.
export function criarHandler(deps = {}) {
    const carregar = deps.carregarFonte ?? carregarFonte;
    return async function handler(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET,POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (!['GET', 'POST'].includes(req.method)) {
            res.setHeader('Allow', 'OPTIONS,GET,POST');
            return res.status(405).json({ estado: 'erro_geracao', erro: 'Método não permitido.', afirmacoes: [] });
        }
        try {
            const url = new URL(req.url, 'http://localhost');
            let body = req.body ?? {};
            if (req.method === 'POST') {
                if (typeof body === 'string') {
                    try { body = JSON.parse(body); } catch { throw falha('JSON inválido.', 400); }
                }
                if (!body || typeof body !== 'object' || Array.isArray(body)) throw falha('Corpo JSON inválido.', 400);
                if (Object.keys(body).some(k => !['id_candidato', 'chave', 'documentos', 'exportacao'].includes(k))) {
                    throw falha('Campos não permitidos; revisão e publicação são exclusivamente offline.', 400);
                }
            }
            const id = req.method === 'GET' ? url.searchParams.get('id') : body.chave ?? body.id_candidato;
            if (typeof id !== 'string' || !id) throw falha('Identificador obrigatório: GET id; POST chave ou id_candidato.', 400);
            const fonte = carregar();
            const versoes = url.searchParams.getAll('exportacao');
            if (req.method === 'POST' && Object.hasOwn(body, 'exportacao')) versoes.push(body.exportacao);
            if (versoes.some(v => typeof v !== 'string' || v !== fonte.exportacao)) {
                return res.status(409).json({ estado: 'revisao_necessaria', motivo: 'exportacao_divergente', exportacao: fonte.exportacao, afirmacoes: [] });
            }
            const chave = resolverChave(id, fonte);
            if (!chave || !Object.hasOwn(fonte.candidatos, chave)) throw falha('Candidatura não encontrada ou identificador ambíguo.', 404);
            if (req.method === 'POST' && body.chave !== undefined && body.id_candidato !== undefined
                && resolverChave(body.id_candidato, fonte) !== chave) throw falha('Identificadores divergentes.', 400);
            const selecao = req.method === 'GET'
                ? (url.searchParams.has('documentos') ? url.searchParams.getAll('documentos') : undefined)
                : body.documentos;
            const ctx = prepararContexto(fonte, chave, selecao);
            const cache = deps.cache !== undefined ? deps.cache : obterCache();
            const guarda = deps.antesDeGerar ?? criarGuardaResumo({ redis: cache });
            let cacheFalhou = false;
            const cacheMonitorado = cache && {
                get: async key => {
                    try { return await cache.get(key); }
                    catch (erro) { cacheFalhou = true; throw erro; }
                },
                set: (...args) => cache.set(...args),
            };
            let autorizado = false;
            const resultado = await obterResumo(ctx, {
                gerar: req.method === 'POST',
                cache: cacheMonitorado, publicado: deps.publicado, maxBlocos: 1, maxModelos: 1,
                antesDeGerar: async contexto => {
                    // O núcleo tolera falha de leitura para consultas, mas ela não
                    // deve ser confundida com cache miss e autorizar gasto público.
                    if (cacheFalhou && !deps.antesDeGerar) throw new ErroLimiteResumo('redis');
                    await guarda(contexto);
                    autorizado = true;
                },
                gerarBloco: async parametros => {
                    if (!autorizado) throw new ErroLimiteResumo('integracao');
                    return (deps.gerarBloco ?? gerarBloco)(parametros);
                },
            });
            return res.status(200).json(resultado);
        } catch (erro) {
            const status = [400, 404, 422, 429, 502, 503].includes(erro?.status) ? erro.status : 503;
            const retryAfter = Number(erro?.retryAfter);
            if ((status === 429 || status === 503) && Number.isFinite(retryAfter) && retryAfter > 0) {
                res.setHeader('Retry-After', String(Math.ceil(retryAfter)));
            }
            const bloqueioConfiguracao = status === 503 && (erro instanceof ErroLimiteResumo
                || /configurad|desabilitad|controle de geração/i.test(String(erro?.message ?? '')));
            const estado = status === 429 ? 'bloqueio_quota' : bloqueioConfiguracao ? 'bloqueio_configuracao'
                : status === 502 ? 'falha_geracao' : 'erro_geracao';
            return res.status(status).json({ estado, afirmacoes: [], retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
                erro: erro instanceof ErroLimiteResumo || status === 400 || status === 404
                    ? erro.message : status === 502 ? 'A geração não produziu uma saída completa e validada.'
                        : 'Fonte indisponível, snapshot inválido ou configuração de geração indisponível.' });
        }
    };
}
export default criarHandler();
