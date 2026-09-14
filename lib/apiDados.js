import * as jsonCache from './jsonCache.js';

export const dadosPadrao = jsonCache;
export { ehChaveCanonica, buscarPorChave } from './jsonCache.js';

const escalar = valor => ['string', 'number', 'boolean'].includes(typeof valor) ? valor : null;
function selecionar(objeto, campos) {
    return Object.fromEntries(campos.map(campo => [campo, escalar(objeto?.[campo])]));
}

export function metadadosPublicos(meta) {
    if (!meta || typeof meta !== 'object') return null;
    return {
        ...selecionar(meta, ['geradoEm', 'schemaVersion', 'status', 'idadeReferencia', 'totalCandidatos', 'totalFotos']),
        escopo: meta.escopo ? {
            ...selecionar(meta.escopo, ['ano', 'criterio', 'formatoMonetario']),
            ufs: Array.isArray(meta.escopo.ufs) ? meta.escopo.ufs.filter(uf => typeof uf === 'string') : [],
        } : null,
        arquivosFonte: Array.isArray(meta.arquivosFonte) ? meta.arquivosFonte.map(fonte => ({
            // Publica apenas o nome, mesmo se a origem contiver um caminho local.
            arquivo: typeof fonte?.arquivo === 'string' ? fonte.arquivo.split(/[\\/]/).pop() : null,
            geracaoDeclaradaTSE: Array.isArray(fonte?.geracaoDeclaradaTSE)
                ? fonte.geracaoDeclaradaTSE.map(data => selecionar(data, ['DT_GERACAO', 'HH_GERACAO'])) : [],
        })) : [],
    };
}

export function indisponivel(res) {
    return res.status(503).json({ erro: 'Exportação indisponível. Tente novamente mais tarde.' });
}

export function snapshotValido(exportacao) {
    return exportacao?.ok === true && typeof exportacao.versao === 'string'
        && /^[a-f0-9]{64}$/.test(exportacao.versao);
}

// A injeção troca apenas a fonte de dados, sem reabrir ou modificar o snapshot de produção.
export function criarHandlerGET(executar) {
    return async function handler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.status(200).end();
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET, OPTIONS');
            return res.status(405).json({ erro: 'Método não permitido.' });
        }
        let url;
        try {
            if (typeof req.url !== 'string' || !req.url || /[\s\u0000-\u001f\u007f]/.test(req.url)) throw new Error();
            url = new URL(req.url, 'http://localhost');
            // URLSearchParams tolera escapes inválidos; a API os rejeita explicitamente.
            decodeURIComponent(url.search);
        } catch {
            return res.status(400).json({ erro: 'URL inválida.' });
        }
        try {
            return await executar(url.searchParams, res);
        } catch (erro) {
            if (erro?.statusCode === 400) return res.status(400).json({ erro: erro.message });
            // Mensagens do leitor/validador podem conter caminhos privados.
            return indisponivel(res);
        }
    };
}
